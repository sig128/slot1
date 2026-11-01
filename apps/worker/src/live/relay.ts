import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  getRelayDestination,
  listActiveRelayPairs,
  markIdleRelayDestinations,
  setRelayStatus,
  type RelayDestinationRow,
} from "@slot1/db";
import { RedisLease, sanitizeErrorMessage } from "@slot1/platform";
import { resolveRelayTarget, sanitizeRelayText, type ServerContext } from "@slot1/services";
import { buildReadUrl } from "./supervisor";

const LEASE_TTL_MS = 10_000;
const TICK_MS = 3000;
/** A connection that stayed up this long counts as healthy; the next failure starts backoff over. */
const HEALTHY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** System CA bundles (Debian/Ubuntu, RHEL/Fedora, Alpine/macOS, SUSE). */
const CA_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem", "/etc/ssl/ca-bundle.pem"];

/** The CA bundle RTMPS destinations are verified against; null means the TLS library's default trust. */
export function relayCaFile(configured: string | null | undefined, exists: (p: string) => boolean = existsSync): string | null {
  return configured || CA_BUNDLES.find((p) => exists(p)) || null;
}

export function relayBackoffMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

/**
 * ffmpeg's last words, shortened for the creator: "[out#0/flv @ 0x…] … : Connection refused" and
 * "Error opening output files: Connection refused" both become "Connection refused".
 */
export function relayErrorSummary(lines: string[]): string | null {
  const cleaned = lines.map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).filter((l) => l && !/^Conversion failed!?$/i.test(l));
  // ffmpeg's TLS layer says why before the generic "Input/output error" that follows.
  if (cleaned.some((l) => /certificate/i.test(l))) return "The server's TLS certificate couldn't be verified";
  const last = cleaned.at(-1);
  if (!last) return null;
  const reason = /:\s*([^:]+?)\.?$/.exec(last)?.[1];
  return (reason && /^[A-Za-z][A-Za-z /,'-]{3,}$/.test(reason) ? reason : last).slice(0, 160);
}

/**
 * ffmpeg arguments for one destination: read the creator's stream from SLOT1's gateway and send
 * the exact same audio and video on, copy-only (no re-encoding, so quality is identical).
 */
export function relayFfmpegArgs(readUrl: string, outputUrl: string, caFile: string | null = null): string[] {
  // ffmpeg doesn't verify TLS certificates by default; the key travels inside this connection.
  const tls = /^rtmps:/i.test(outputUrl) ? ["-tls_verify", "1", ...(caFile ? ["-ca_file", caFile] : [])] : [];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-rw_timeout",
    "15000000",
    "-i",
    readUrl,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-progress",
    "pipe:1",
    ...tls,
    "-f",
    "flv",
    outputUrl,
  ];
}

/**
 * Forwards every enabled destination while its creator is publishing a LIVE source to SLOT1.
 * One ffmpeg per destination, owned by exactly one worker through a Redis lease. A failing
 * destination never affects recording, analysis or the other destinations.
 */
export class RelaySupervisor {
  private relays = new Map<string, Relay>();
  private timer: NodeJS.Timeout | null = null;
  private readonly lease: RedisLease;
  private readonly caFile: string | null;

  constructor(
    private readonly ctx: ServerContext,
    owner: string,
    private readonly maxRelays = 32,
  ) {
    this.lease = new RedisLease(ctx.redis, `${owner}:relay`);
    this.caFile = relayCaFile(ctx.config.env.RELAY_TLS_CA_FILE);
  }

  start() {
    if (!this.ctx.config.capabilities.relay.available) {
      this.ctx.log.info({ reason: this.ctx.config.capabilities.relay.reason }, "forwarding disabled");
      return;
    }
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.ctx.log.error({ err: sanitizeErrorMessage((err as Error).message) }, "relay tick failed")), TICK_MS);
    void this.tick();
  }

  async tick() {
    const pairs = await listActiveRelayPairs(this.ctx.db);
    const wanted = new Map(pairs.map((p) => [p.destination.id, p]));
    for (const [id, relay] of this.relays) {
      const p = wanted.get(id);
      if (!p || p.sourceId !== relay.sourceId || relay.finished) {
        this.relays.delete(id);
        await relay.stop();
      }
    }
    await markIdleRelayDestinations(this.ctx.db, [...wanted.keys()]);
    for (const p of pairs) {
      if (this.relays.has(p.destination.id) || this.relays.size >= this.maxRelays) continue;
      if (!(await this.lease.acquire(`relay:${p.destination.id}`, LEASE_TTL_MS))) continue;
      const relay = new Relay(this.ctx, p.destination, p.sourceId, p.publishPath, this.lease, this.caFile);
      this.relays.set(p.destination.id, relay);
      void relay.run().catch((err: unknown) => this.ctx.log.error({ err: sanitizeErrorMessage((err as Error).message), destination: p.destination.id }, "relay crashed"));
    }
  }

  /** Destination ids this worker is forwarding right now (for tests and health checks). */
  active(): string[] {
    return [...this.relays.keys()];
  }

  async stopAll() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.relays.values()].map((r) => r.stop()));
    this.relays.clear();
  }
}

class Relay {
  finished = false;
  private running = true;
  private child: ChildProcess | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly ctx: ServerContext,
    private readonly destination: RelayDestinationRow,
    readonly sourceId: string,
    private readonly publishPath: string,
    private readonly lease: RedisLease,
    private readonly caFile: string | null,
  ) {}

  private get leaseKey() {
    return `relay:${this.destination.id}`;
  }

  async run() {
    const { ctx } = this;
    const id = this.destination.id;
    let failures = 0;
    try {
      while (this.running) {
        if (!(await this.lease.renew(this.leaseKey, LEASE_TTL_MS))) break;
        const row = await getRelayDestination(ctx.db, id);
        if (!row?.enabled) break;
        const target = await resolveRelayTarget(ctx, row);
        if (!target.ok) {
          // A setup problem: say exactly what's needed, check again later (permission may arrive).
          await setRelayStatus(ctx.db, id, target.status, target.detail);
          if (!(await this.pause(target.status === "needs_permission" ? 20_000 : 30_000))) break;
          continue;
        }
        // While retrying, the status keeps saying why the last attempt failed.
        if (failures === 0) await setRelayStatus(ctx.db, id, "connecting", `Connecting to ${target.host}`);
        const started = Date.now();
        const result = await this.forward(buildReadUrl(ctx, this.publishPath), target.url, target.secrets, target.host);
        if (!this.running) break;
        failures = Date.now() - started > HEALTHY_AFTER_MS ? 1 : failures + 1;
        const wait = relayBackoffMs(failures);
        const reason = result.error ? sanitizeRelayText(result.error, target.secrets) : "the connection closed";
        await setRelayStatus(ctx.db, id, "retrying", `Lost ${target.host}: ${reason}. Retrying in ${Math.round(wait / 1000)}s`.slice(0, 300));
        ctx.log.warn({ destination: id, host: target.host, failures, reason }, "relay disconnected");
        if (!(await this.pause(wait))) break;
      }
    } finally {
      this.finished = true;
      await this.lease.release(this.leaseKey).catch(() => undefined);
    }
  }

  /** Run ffmpeg until it exits. Status turns "live" once data is actually flowing out. */
  private forward(readUrl: string, outputUrl: string, secrets: string[], host: string): Promise<{ error: string | null }> {
    const { ctx } = this;
    return new Promise((resolve) => {
      const child = spawn(ctx.config.env.FFMPEG_PATH, relayFfmpegArgs(readUrl, outputUrl, this.caFile), { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      const tail: string[] = [];
      let live = false;
      let outTimeUs = 0;
      let totalSize = 0;
      const renew = setInterval(() => {
        void this.lease.renew(this.leaseKey, LEASE_TTL_MS).then((ok) => {
          if (!ok) child.kill("SIGINT");
        });
      }, 3000);
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const [k, v] = line.split("=");
        if (k === "out_time_us") outTimeUs = Number(v) || 0;
        if (k === "total_size") totalSize = Number(v) || 0;
        if (k === "progress" && !live && outTimeUs > 0 && totalSize > 0) {
          live = true;
          void setRelayStatus(ctx.db, this.destination.id, "live", `Forwarding to ${host}`, true);
        }
      });
      createInterface({ input: child.stderr! }).on("line", (line) => {
        tail.push(sanitizeRelayText(line, secrets));
        if (tail.length > 6) tail.shift();
      });
      child.on("error", (err) => {
        clearInterval(renew);
        resolve({ error: sanitizeRelayText(err.message, secrets) });
      });
      child.on("close", (code) => {
        clearInterval(renew);
        this.child = null;
        resolve({ error: code === 0 ? null : (relayErrorSummary(tail) ?? `ffmpeg exited with code ${code}`) });
      });
    });
  }

  /** Wait, renewing the lease so a long backoff isn't lost to a fresh attempt. False: stop now. */
  private async pause(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(3000, Math.max(0, until - Date.now())));
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      if (this.running && !(await this.lease.renew(this.leaseKey, LEASE_TTL_MS))) return false;
    }
    return this.running;
  }

  async stop() {
    this.running = false;
    this.wake?.();
    const child = this.child;
    if (child) {
      child.kill("SIGINT");
      await Promise.race([new Promise((r) => child.once("close", r)), sleep(3000)]);
      if (this.child) this.child.kill("SIGKILL");
    }
    for (let waited = 0; !this.finished && waited < 10_000; waited += 50) await sleep(50);
  }
}
