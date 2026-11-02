import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  AdminPasswordChange,
  SettingsPatch,
  settingsEntries,
  type AdminSettingsView,
  type PublicStatus,
  type SettingEntry,
  type SettingsRequestResult,
  type TwitchSignInEvent,
} from "@slot1/contracts";
import type { ServerContext } from "@slot1/services";
import { requireAdmin } from "../lib/admin-access";
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH, adminPasswordConfigured, hashAdminPassword, passwordLength, verifyAdminPassword } from "../lib/admin-password";
import { ApiProblem } from "../lib/errors";
import { inboxStatus, readDeployLog, readDeployStatus, recentResults, requestResult, writeSettingsRequest } from "../lib/settings-inbox";
import { listSignInEvents } from "../lib/signin-events";

const WRITE_LIMIT = { max: 10, timeWindow: "1 minute" };
const READ_LIMIT = { max: 120, timeWindow: "1 minute" };
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

/** What a saved request changes, kept so /admin shows it before the API itself restarts. */
const shownKey = (id: string) => `slot1:settings:req:${id}`;
const SECRET_KEYS = new Set(["TWITCH_CLIENT_SECRET", "ANTHROPIC_API_KEY", "SLOT1_ADMIN_PASSWORD_HASH"]);

type Values = AdminSettingsView["values"];

/** Applies one saved request's settings to the values shown (secrets only as "saved"). */
function overlay(values: Values, entries: { key: string; value: string | null }[]): Values {
  const v = { ...values };
  for (const { key, value } of entries) {
    switch (key) {
      case "TWITCH_CLIENT_ID":
        if (value) v.twitchClientId = value;
        break;
      case "TWITCH_CLIENT_SECRET":
        if (value) v.twitchClientSecretSet = true;
        break;
      case "SLOT1_OPERATOR_TWITCH_LOGINS":
        v.adminTwitchLogins = value ?? "";
        break;
      case "SLOT1_BOT_TWITCH_LOGIN":
        v.botTwitchLogin = value;
        break;
      case "ANTHROPIC_API_KEY":
        v.anthropicApiKeySet = Boolean(value);
        break;
      case "VISION_PROVIDER":
        if (value === "anthropic" || value === "none") v.aiProvider = value;
        break;
      case "SLOT1_AUTODEPLOY":
        v.autodeploy = value !== "false";
        break;
      case "SLOT1_GOOGLE_SITE_VERIFICATION":
        v.googleVerification = value;
        break;
      case "SLOT1_BING_SITE_VERIFICATION":
        v.bingVerification = value;
        break;
      case "SLOT1_CONTACT_EMAIL":
        v.contactEmail = value;
        break;
      case "SLOT1_LEGAL_NAME":
        v.legalName = value;
        break;
      case "SLOT1_LEGAL_ADDRESS":
        v.legalAddress = value;
        break;
      case "SLOT1_GOVERNING_LAW":
        v.governingLaw = value;
        break;
      case "SLOT1_ADMIN_PASSWORD_HASH":
        if (value) v.adminPasswordSet = true;
        break;
    }
  }
  return v;
}

/**
 * /admin → Settings (docs/DEPLOY_HETZNER.md, "Automatic updates"): the API shows what the server
 * runs with and leaves changes in the shared inbox; the server's `slot1 tick` checks and applies
 * them within a minute and restarts what reads them. Values are logged by key name only.
 */
export const settingsRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const env = ctx.config.env;
    const stateDir = env.SLOT1_STATE_DIR;

    async function leaveRequest(entries: SettingEntry[], why: string): Promise<{ id: string }> {
      const inbox = await inboxStatus(stateDir);
      if (!inbox.available) throw new ApiProblem(409, "settings_unavailable", inbox.reason ?? "Saving settings isn't available on this server.");
      const id = await writeSettingsRequest(stateDir, entries);
      // Secrets are kept only as "set", never their values.
      const shown = entries.map((e) => (SECRET_KEYS.has(e.key) ? { key: e.key, value: e.value === null ? null : "set" } : e));
      await ctx.redis.set(shownKey(id), JSON.stringify(shown), "EX", 30 * 86400).catch(() => undefined);
      ctx.log.info({ settingsRequest: id, keys: entries.map((e) => e.key), why }, "settings saved in /admin, waiting for the server to apply them");
      return { id };
    }

    app.get("/api/admin/settings", { config: { rateLimit: READ_LIMIT } }, async (req, reply): Promise<AdminSettingsView> => {
      await requireAdmin(ctx, req, reply);
      const [inbox, deploy, requests] = await Promise.all([inboxStatus(stateDir), readDeployStatus(stateDir), recentResults(stateDir)]);
      const caps = ctx.config.capabilities;
      let values: Values = {
        twitchClientId: env.TWITCH_CLIENT_ID,
        twitchClientSecretSet: Boolean(env.TWITCH_CLIENT_SECRET),
        adminTwitchLogins: [...ctx.config.operatorLogins].join(","),
        botTwitchLogin: env.SLOT1_BOT_TWITCH_LOGIN,
        anthropicApiKeySet: Boolean(env.ANTHROPIC_API_KEY),
        aiProvider: env.VISION_PROVIDER,
        autodeploy: env.SLOT1_AUTODEPLOY,
        googleVerification: env.SLOT1_GOOGLE_SITE_VERIFICATION,
        bingVerification: env.SLOT1_BING_SITE_VERIFICATION,
        contactEmail: env.SLOT1_CONTACT_EMAIL,
        legalName: env.SLOT1_LEGAL_NAME,
        legalAddress: env.SLOT1_LEGAL_ADDRESS,
        governingLaw: env.SLOT1_GOVERNING_LAW,
        adminPasswordSet: adminPasswordConfigured(env.SLOT1_ADMIN_PASSWORD_HASH),
      };
      // Applied since this API started (e.g. legal details, which restart only the website): the
      // server runs with them already, so show them.
      const since = requests.filter((r) => r.status === "applied" && r.at && Date.parse(r.at) >= STARTED_AT.getTime()).reverse();
      for (const r of since) {
        const raw = await ctx.redis.get(shownKey(r.id)).catch(() => null);
        if (!raw) continue;
        try {
          values = overlay(values, JSON.parse(raw) as { key: string; value: string | null }[]);
        } catch {
          // Unreadable: skip it.
        }
      }
      return {
        available: inbox.available,
        unavailableReason: inbox.reason,
        values,
        working: {
          twitch: caps.twitch.available,
          twitchReason: caps.twitch.available ? null : caps.twitch.reason,
          ai: caps.vision.available,
          aiReason: caps.vision.available ? null : caps.vision.reason,
        },
        twitchRedirectUrl: `${ctx.config.publicOrigin}/api/auth/twitch/callback`,
        version: env.SLOT1_VERSION,
        apiStartedAt: STARTED_AT.toISOString(),
        deploy,
        requests,
      };
    });

    app.post("/api/admin/settings", { config: { rateLimit: WRITE_LIMIT } }, async (req, reply) => {
      await requireAdmin(ctx, req, reply);
      const patch = SettingsPatch.parse(req.body ?? {});
      const checked = settingsEntries(patch);
      if (!checked.ok) {
        return reply.status(422).send({
          error: { code: "invalid_settings", message: `Check ${Object.keys(checked.errors).join(", ")}`, requirement: null, fields: checked.errors },
        });
      }
      if (checked.entries.length === 0) throw new ApiProblem(400, "nothing_to_save", "Nothing changed.");
      return leaveRequest(checked.entries, "settings");
    });

    app.get("/api/admin/settings/requests/:id", { config: { rateLimit: READ_LIMIT } }, async (req, reply): Promise<SettingsRequestResult> => {
      await requireAdmin(ctx, req, reply);
      const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
      return requestResult(stateDir, id);
    });

    // A new password needs the current one (a link or operator session alone isn't enough to lock
    // the owner out), except when none is set yet. Changing it signs out every admin session.
    app.post("/api/admin/password", { logLevel: "warn", config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
      await requireAdmin(ctx, req, reply);
      const body = AdminPasswordChange.parse(req.body ?? {});
      const hash = env.SLOT1_ADMIN_PASSWORD_HASH;
      if (adminPasswordConfigured(hash)) {
        const started = Date.now();
        if (!(await verifyAdminPassword(body.current ?? "", hash))) {
          const rest = 750 - (Date.now() - started);
          if (rest > 0) await new Promise((r) => setTimeout(r, rest));
          ctx.log.warn({ adminPassword: "change refused" }, "admin password change refused: wrong current password");
          throw new ApiProblem(401, "wrong_password", "The current password isn't right.");
        }
      }
      const n = passwordLength(body.next);
      if (n < ADMIN_PASSWORD_MIN_LENGTH) throw new ApiProblem(400, "too_short", `Use at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`);
      if (n > ADMIN_PASSWORD_MAX_LENGTH || /[\r\n]/.test(body.next)) throw new ApiProblem(400, "invalid_password", "Use one line of at most 1024 characters.");
      const next = await hashAdminPassword(body.next);
      return leaveRequest([{ key: "SLOT1_ADMIN_PASSWORD_HASH", value: next }], "password");
    });

    app.get("/api/admin/deploy-log", { config: { rateLimit: READ_LIMIT } }, async (req, reply) => {
      await requireAdmin(ctx, req, reply);
      return { log: await readDeployLog(stateDir, 200) };
    });

    app.get("/api/admin/signins", { config: { rateLimit: READ_LIMIT } }, async (req, reply): Promise<{ events: TwitchSignInEvent[] }> => {
      await requireAdmin(ctx, req, reply);
      return { events: await listSignInEvents(ctx.redis, 20) };
    });
  };

/** /status: whether the site's parts work, for anyone. No secrets, no Twitch error texts, no visitors. */
export const statusRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    let cached: { at: number; body: PublicStatus } | null = null;
    app.get("/api/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_req, reply): Promise<PublicStatus> => {
      reply.header("cache-control", "public, max-age=15");
      if (cached && Date.now() - cached.at < 15_000) return cached.body;
      const [database, redis, deploy, last] = await Promise.all([
        ctx.db.query("SELECT 1").then(
          () => "ok" as const,
          () => "down" as const,
        ),
        ctx.redis.ping().then(
          () => "ok" as const,
          () => "down" as const,
        ),
        readDeployStatus(ctx.config.env.SLOT1_STATE_DIR),
        listSignInEvents(ctx.redis, 1),
      ]);
      const caps = ctx.config.capabilities;
      const e = last[0];
      const body: PublicStatus = {
        generatedAt: new Date().toISOString(),
        version: ctx.config.env.SLOT1_VERSION,
        deploy: deploy ? { state: deploy.state, commit: deploy.commit.slice(0, 7), at: deploy.at } : null,
        services: { website: "ok", database, redis },
        twitchSignIn: { configured: caps.twitch.available, last: e ? { outcome: e.outcome, why: e.why, at: e.at } : null },
        ai: { configured: caps.vision.available },
        streaming: { available: caps.ingest.available },
      };
      cached = { at: Date.now(), body };
      return body;
    });
  };
