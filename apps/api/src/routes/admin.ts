import { statfs } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { Queue } from "bullmq";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  AdminLoginInput,
  AdminMessageUpdate,
  ContactMessageStatus,
  type AdminHealth,
  type AdminLoginStatus,
  type AdminMessagesResponse,
  type AdminOverview,
  type AdminQueue,
  type AdminUsage,
} from "@slot1/contracts";
import {
  activeModels,
  aiUsageSince,
  allTimeViews,
  contactCounts,
  dailyVisitors,
  databaseInfo,
  deleteContactMessage,
  liveSessionsNow,
  listContactMessages,
  platformCounts,
  rankedVisitors,
  recentFailures,
  setContactStatus,
  visitorTotals,
  type UsageRow,
} from "@slot1/db";
import { createBullConnection, QUEUES } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import {
  adminLoginStats,
  adminPasswordConfigured,
  beginLoginAttempt,
  LOGIN_FAILURE_MIN_MS,
  loginAddressKey,
  recordLoginFailure,
  recordLoginSuccess,
  verifyAdminPassword,
} from "../lib/admin-password";
import { consumeLink, endAdminSession, linkUnused, readAdminSession, readLinkToken, startAdminSession, trackAdminPasswordHash } from "../lib/admin-session";
import { ApiProblem, conflict, notFound } from "../lib/errors";
import { ONLINE_WINDOW_SEC, readPresence } from "../lib/visitors";

type Access = AdminOverview["access"];

/** Slow-moving totals are cached briefly; presence, queues and health are read on every call. */
const AGG_TTL_MS = 30_000;
const aggCache = new Map<string, { at: number; value: Promise<Aggregates> }>();

/** Tests that insert rows and read the dashboard right away clear the short cache. */
export function clearAdminCache() {
  aggCache.clear();
}

type Aggregates = Awaited<ReturnType<typeof loadAggregates>>;

async function loadAggregates(ctx: ServerContext, range: 7 | 30) {
  const db = ctx.db;
  const [today, last7, last30, allTime, days, pages, referrers, devices, browsers, platform, usage24, usage30, models, failures, dbInfo] = await Promise.all([
    visitorTotals(db, 0),
    visitorTotals(db, 6),
    visitorTotals(db, 29),
    allTimeViews(db),
    dailyVisitors(db, 30),
    rankedVisitors(db, "path", range, 12),
    rankedVisitors(db, "referrer_host", range, 10),
    rankedVisitors(db, "device", range, 3),
    rankedVisitors(db, "browser", range, 7),
    platformCounts(db),
    aiUsageSince(db, 24),
    aiUsageSince(db, 24 * 30),
    activeModels(db),
    recentFailures(db, 8),
    databaseInfo(db).catch(() => null),
  ]);
  return { today, last7, last30, allTime, days, pages, referrers, devices, browsers, platform, usage24, usage30, models, failures, dbInfo };
}

function aggregates(ctx: ServerContext, range: 7 | 30): Promise<Aggregates> {
  const key = String(range);
  const hit = aggCache.get(key);
  if (hit && Date.now() - hit.at < AGG_TTL_MS) return hit.value;
  const value = loadAggregates(ctx, range);
  aggCache.set(key, { at: Date.now(), value });
  value.catch(() => aggCache.delete(key));
  return value;
}

const usageView = (rows: UsageRow[]): AdminUsage[] =>
  rows.map((r) => ({
    kind: r.kind,
    calls: r.calls,
    frames: r.frames,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    audioSeconds: Math.round(Number(r.audio_seconds) * 10) / 10,
    estimatedCostUsd: r.cost === null ? null : Math.round(Number(r.cost) * 10_000) / 10_000,
  }));

function tcpReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const finish = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

async function gatewayHealth(ctx: ServerContext): Promise<AdminHealth> {
  const env = ctx.config.env;
  if (env.INGEST_GATEWAY === "none" || !env.INGEST_READ_URL_TEMPLATE) return { status: "off", detail: "No ingest gateway configured" };
  try {
    const u = new URL(env.INGEST_READ_URL_TEMPLATE.replaceAll("{path}", "live/check").replaceAll("{name}", "check").replaceAll("{user}", "u").replaceAll("{password}", "p"));
    const port = Number(u.port || (u.protocol === "rtsp:" ? 554 : 1935));
    const ok = await tcpReachable(u.hostname, port);
    return ok ? { status: "ok", detail: `${env.INGEST_GATEWAY} answers on port ${port}` } : { status: "down", detail: `${env.INGEST_GATEWAY} doesn't answer on port ${port}` };
  } catch {
    return { status: "down", detail: "INGEST_READ_URL_TEMPLATE isn't a valid URL" };
  }
}

async function inferenceHealth(ctx: ServerContext): Promise<AdminHealth> {
  const env = ctx.config.env;
  if (!env.INFERENCE_URL) return { status: "off", detail: "No shared service: each worker runs the GTA model itself" };
  try {
    const r = await fetch(`${env.INFERENCE_URL.replace(/\/$/, "")}/metrics`, {
      headers: { authorization: `Bearer ${env.INFERENCE_SHARED_SECRET ?? ""}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return { status: "down", detail: `The service answered ${r.status}` };
    const m = (await r.json()) as { model?: { active?: boolean; label?: string | null; version?: string | null }; latencyMs?: { p95?: number | null }; queue?: { depth?: number } };
    const model = m.model?.active ? `model ${m.model.label ?? m.model.version ?? "loaded"}` : "no model loaded yet";
    const p95 = typeof m.latencyMs?.p95 === "number" ? `, p95 ${Math.round(m.latencyMs.p95)} ms` : "";
    return { status: m.model?.active ? "ok" : "degraded", detail: `Running, ${model}${p95}, ${m.queue?.depth ?? 0} frames queued` };
  } catch {
    return { status: "down", detail: "Not reachable" };
  }
}

/** Free space where media is stored (the nearest existing folder of STORAGE_FS_ROOT). */
async function diskInfo(ctx: ServerContext): Promise<AdminOverview["system"]["disk"]> {
  const env = ctx.config.env;
  if (env.STORAGE_DRIVER !== "fs") return { driver: env.STORAGE_DRIVER, freeBytes: null, totalBytes: null };
  let dir = path.resolve(env.STORAGE_FS_ROOT);
  for (let i = 0; i < 8; i++) {
    try {
      const s = await statfs(dir);
      return { driver: "fs", freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { driver: "fs", freeBytes: null, totalBytes: null };
}

async function redisInfo(redis: Redis): Promise<AdminOverview["system"]["redis"]> {
  try {
    const info = await redis.info("memory");
    const used = /used_memory:(\d+)/.exec(info)?.[1];
    return { ok: true, usedMemoryBytes: used ? Number(used) : null };
  } catch {
    return { ok: false, usedMemoryBytes: null };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The small page served at the one-time link. A button, not an automatic sign-in, so link previews can't use the link up. */
function linkPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} — SLOT1</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101014;color:#f4ede2;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:30rem;padding:2rem 1.25rem}h1{font:900 2.4rem/1 Impact,"Arial Narrow",system-ui,sans-serif;letter-spacing:.01em;margin:0 0 1rem}p{color:#b8b0a4;margin:0 0 1.5rem}button{font:600 1.05rem/1 system-ui,sans-serif;background:#ff4f87;color:#101014;border:0;border-radius:2px;height:2.75rem;padding:0 1.25rem;cursor:pointer}button:focus-visible{outline:2px solid #ffad72;outline-offset:3px}code{color:#f4ede2}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

function sendPage(reply: FastifyReply, status: number, html: string) {
  return reply
    .status(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-robots-tag", "noindex, nofollow")
    // same-origin, not no-referrer: with no-referrer the browser sends "Origin: null" on the
    // button's POST, and the token never leaves this origin either way.
    .header("referrer-policy", "same-origin")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .send(html);
}

const EXPIRED = linkPage(
  "Link expired",
  `<p>This admin link has expired or has already been used. Each link works once, within 15 minutes.</p><p>Make a new one on the server: <code>slot1 admin-link</code></p>`,
);

const MessagesQuery = z.object({
  status: z.union([ContactMessageStatus, z.literal("all")]).default("open"),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** "3 minutes", "a minute", "40 seconds". */
function inAbout(sec: number): string {
  if (sec < 60) return sec === 1 ? "1 second" : `${sec} seconds`;
  const min = Math.ceil(sec / 60);
  return min === 1 ? "a minute" : `${min} minutes`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Password sign-ins handled at once by this process; more are turned away before they count. */
const LOGIN_MAX_IN_FLIGHT = 32;

/**
 * The operator dashboard API. Only operators (Twitch accounts listed in
 * SLOT1_OPERATOR_TWITCH_LOGINS) and holders of an admin session (admin password or one-time
 * link) get in; everyone else, signed in or not, gets the same 404 as for a page that doesn't
 * exist. The /admin page itself shows the password form to them.
 */
export const adminRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4096 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    // Admin sessions are checked against the password configured now (lib/admin-session.ts).
    trackAdminPasswordHash(ctx.redis, () => ctx.config.env.SLOT1_ADMIN_PASSWORD_HASH);
    let loginsInFlight = 0;

    let bull: { conn: Redis; queues: Queue[] } | null = null;
    const queues = () => {
      if (!bull) {
        const conn = createBullConnection(ctx.config.env.REDIS_URL);
        bull = { conn, queues: Object.values(QUEUES).map((name) => new Queue(name, { connection: conn })) };
      }
      return bull.queues;
    };
    app.addHook("onClose", async () => {
      if (!bull) return;
      await Promise.all(bull.queues.map((q) => q.close().catch(() => undefined)));
      await bull.conn.quit().catch(() => undefined);
    });

    async function access(req: FastifyRequest): Promise<Access | null> {
      if (req.auth.user?.is_operator) return "operator";
      const session = await readAdminSession(ctx.redis, req);
      if (session) return session.via === "password" ? "admin_password" : "admin_link";
      return null;
    }
    async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<Access> {
      const a = await access(req);
      if (!a) throw notFound();
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
      return a;
    }

    async function queueCounts(): Promise<{ list: AdminQueue[]; worker: AdminHealth }> {
      try {
        const list = await Promise.all(
          queues().map(async (q) => {
            const [c, workers] = await Promise.all([q.getJobCounts("waiting", "prioritized", "active", "delayed", "failed"), q.getWorkersCount().catch(() => 0)]);
            return {
              name: q.name.replace(/^slot1-/, ""),
              waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
              active: c.active ?? 0,
              delayed: c.delayed ?? 0,
              failed: c.failed ?? 0,
              workers,
            };
          }),
        );
        const connected = list.reduce((n, q) => n + q.workers, 0);
        const missing = list.filter((q) => q.workers === 0).map((q) => q.name);
        const worker: AdminHealth =
          connected === 0
            ? { status: "down", detail: "No worker is connected to the job queues" }
            : missing.length
              ? { status: "degraded", detail: `No worker on: ${missing.join(", ")}` }
              : { status: "ok", detail: `${connected} worker connections across ${list.length} queues` };
        return { list, worker };
      } catch {
        return { list: [], worker: { status: "down", detail: "Couldn't read the job queues" } };
      }
    }

    app.get("/api/admin/overview", async (req, reply): Promise<AdminOverview> => {
      const who = await requireAdmin(req, reply);
      const range = (req.query as { range?: string }).range === "7" ? 7 : 30;
      const [agg, presence, live, q, inference, gateway, redis, disk, messages, logins] = await Promise.all([
        aggregates(ctx, range),
        readPresence(ctx.redis).catch(() => ({ online: 0, byPath: [] })),
        liveSessionsNow(ctx.db),
        queueCounts(),
        inferenceHealth(ctx),
        gatewayHealth(ctx),
        redisInfo(ctx.redis),
        diskInfo(ctx),
        contactCounts(ctx.db),
        adminLoginStats(ctx.redis),
      ]);
      const watching = new Map<string, number>();
      for (const p of presence.byPath) {
        const m = /^\/watch\/([^/]+)$/i.exec(p.path);
        if (m) watching.set(m[1]!.toLowerCase(), (watching.get(m[1]!.toLowerCase()) ?? 0) + p.visitors);
      }
      const caps = ctx.config.capabilities;
      return {
        generatedAt: new Date().toISOString(),
        access: who,
        analyticsEnabled: ctx.config.env.SLOT1_ANALYTICS,
        now: {
          online: presence.online,
          windowSec: ONLINE_WINDOW_SEC,
          byPath: presence.byPath.slice(0, 20),
          live: live.map((s) => ({
            sessionId: s.session_id,
            login: s.login,
            displayName: s.display_name,
            title: s.title,
            source: s.publishing ? "ingest" : "twitch",
            label: s.label,
            visibility: s.visibility,
            analysisState: s.analysis_state,
            startedAt: s.started_at.toISOString(),
            framesAnalyzed: s.frames_analyzed,
            lastResultAt: s.last_result_at ? s.last_result_at.toISOString() : null,
            viewers: watching.get(s.login.toLowerCase()) ?? 0,
          })),
        },
        visitors: {
          today: agg.today,
          last7: agg.last7,
          last30: agg.last30,
          allTimeViews: agg.allTime.views,
          since: agg.allTime.since,
          days: agg.days,
          range: { days: range, pages: agg.pages, referrers: agg.referrers, devices: agg.devices, browsers: agg.browsers },
        },
        platform: {
          users: agg.platform.users,
          creators: agg.platform.creators,
          botChannels: agg.platform.botChannels,
          botLinked: agg.platform.botLinked,
          liveSources: agg.platform.liveSources,
          sessions: { ...agg.platform.sessions, liveNow: live.length },
          observations24h: agg.platform.observations24h,
          clips: agg.platform.clips,
          library: agg.platform.library,
          storage: agg.platform.storage,
          relay: agg.platform.relay,
        },
        ai: {
          vision: { available: caps.vision.available, provider: caps.vision.provider, model: caps.vision.model, reason: caps.vision.reason },
          transcription: { available: caps.transcription.available, reason: caps.transcription.reason },
          ocr: { available: caps.ocr.available, reason: caps.ocr.reason },
          usage24h: usageView(agg.usage24),
          usage30d: usageView(agg.usage30),
          models: agg.models.models.map((m) => ({ task: m.task, name: m.name, version: m.version, activatedAt: m.activated_at ? m.activated_at.toISOString() : null })),
          candidateModels: agg.models.candidates,
        },
        system: {
          version: ctx.config.env.SLOT1_VERSION ?? null,
          node: process.version,
          apiUptimeSec: Math.round(process.uptime()),
          database: { ok: agg.dbInfo !== null, version: agg.dbInfo?.version ?? null, sizeBytes: agg.dbInfo?.sizeBytes ?? null },
          redis,
          disk,
          queues: q.list,
          worker: q.worker,
          inference,
          gateway,
          failedJobs24h: agg.failures.count,
          recentFailures: agg.failures.items.map((f) => ({ at: f.at.toISOString(), where: f.place, message: f.message })),
          adminLogin: { passwordSet: adminPasswordConfigured(ctx.config.env.SLOT1_ADMIN_PASSWORD_HASH), ...logins },
        },
        messages: { open: messages.open, total: messages.open + messages.closed },
      };
    });

    app.get("/api/admin/messages", async (req, reply): Promise<AdminMessagesResponse> => {
      await requireAdmin(req, reply);
      const q = MessagesQuery.parse(req.query);
      const [page, counts] = await Promise.all([listContactMessages(ctx.db, { status: q.status, before: q.before ?? null, limit: q.limit }), contactCounts(ctx.db)]);
      return { messages: page.messages, counts, nextBefore: page.nextBefore };
    });

    app.patch("/api/admin/messages/:id", async (req, reply) => {
      await requireAdmin(req, reply);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { status } = AdminMessageUpdate.parse(req.body);
      const updated = await setContactStatus(ctx.db, id, status);
      if (!updated) throw notFound("That message no longer exists");
      return updated;
    });

    app.delete("/api/admin/messages/:id", async (req, reply) => {
      await requireAdmin(req, reply);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      if (!(await deleteContactMessage(ctx.db, id))) throw notFound("That message no longer exists");
      return reply.status(204).send();
    });

    /* Admin password (docs/ADMIN.md) -------------------------------------------------------- */

    // Public: the /admin page asks this to choose between the password form and "no password set",
    // and (from the browser) whether it has a session the page request didn't carry (SameSite=Strict).
    app.get("/api/admin/login", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<AdminLoginStatus> => {
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
      return { passwordSet: adminPasswordConfigured(ctx.config.env.SLOT1_ADMIN_PASSWORD_HASH), signedIn: (await access(req)) !== null };
    });

    // CSRF-protected like every other mutation: the page sends the session's token header.
    // logLevel "warn" keeps Fastify's per-request lines (with the client address) out of the log
    // for this route; the events below are logged without addresses or passwords.
    app.post("/api/admin/login", { logLevel: "warn", config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow");
      const hash = ctx.config.env.SLOT1_ADMIN_PASSWORD_HASH;
      if (!adminPasswordConfigured(hash)) throw conflict("No admin password is set on this server yet.");
      const { password } = AdminLoginInput.parse(req.body);
      if (loginsInFlight >= LOGIN_MAX_IN_FLIGHT) {
        reply.header("retry-after", "5");
        throw new ApiProblem(429, "login_busy", "Too many sign-in attempts at once. Try again in a moment.");
      }
      loginsInFlight += 1;
      try {
        // Attempts are counted under an HMAC of the address; the address itself is never stored.
        const addressKey = loginAddressKey(ctx.config.sessionSecret, req.ip);
        const block = await beginLoginAttempt(ctx.redis, addressKey);
        if (block) {
          ctx.log.warn({ adminLogin: "blocked", scope: block.scope }, "admin password sign-in refused by the attempt limits");
          reply.header("retry-after", String(block.retryAfterSec));
          throw new ApiProblem(
            429,
            "login_paused",
            block.scope === "address"
              ? `Too many wrong passwords from this connection. Try again in ${inAbout(block.retryAfterSec)}.`
              : `Password sign-in is paused for everyone for ${inAbout(block.retryAfterSec)} after many wrong passwords.`,
          );
        }
        const started = Date.now();
        if (await verifyAdminPassword(password, hash)) {
          await recordLoginSuccess(ctx.redis, addressKey);
          await startAdminSession(ctx, reply, "password");
          ctx.log.info({ adminLogin: "ok" }, "admin session started with the admin password");
          return { ok: true, redirect: "/admin" };
        }
        await recordLoginFailure(ctx.redis);
        ctx.log.warn({ adminLogin: "failed" }, "admin password sign-in failed");
        // Every failure takes at least as long, whatever made it fail.
        const rest = LOGIN_FAILURE_MIN_MS - (Date.now() - started);
        if (rest > 0) await sleep(rest);
        throw new ApiProblem(401, "wrong_password", "That didn't work. Check the password and try again.");
      } finally {
        loginsInFlight -= 1;
      }
    });

    /* One-time admin link ---------------------------------------------------------------- */

    app.get("/api/admin/link", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const token = (req.query as { token?: string }).token;
      const nonce = readLinkToken(ctx.config, token);
      if (!nonce || !(await linkUnused(ctx.redis, nonce))) return sendPage(reply, 410, EXPIRED);
      return sendPage(
        reply,
        200,
        linkPage(
          "Open the SLOT1 admin",
          `<p>This one-time link signs this browser in to the admin dashboard for 12 hours. It works once.</p>
<form method="post" action="/api/admin/link"><input type="hidden" name="token" value="${esc(token!)}"><button type="submit">Open the admin</button></form>`,
        ),
      );
    });

    app.post("/api/admin/link", { config: { csrf: false, rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && origin !== ctx.config.publicOrigin) return sendPage(reply, 403, linkPage("Not allowed", "<p>Open the link in this browser directly.</p>"));
      const token = (req.body as { token?: string } | undefined)?.token;
      const nonce = readLinkToken(ctx.config, token);
      if (!nonce || !(await consumeLink(ctx.redis, nonce))) return sendPage(reply, 410, EXPIRED);
      await startAdminSession(ctx, reply);
      req.log.info("admin session started from a one-time link");
      return reply.header("cache-control", "no-store").redirect("/admin", 303);
    });

    app.post("/api/admin/logout", async (req, reply) => {
      await endAdminSession(ctx, req, reply);
      return reply.status(204).send();
    });
  };
