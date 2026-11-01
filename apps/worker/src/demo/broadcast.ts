import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { findRenderFonts } from "@slot1/analysis";
import { sanitizeErrorMessage } from "@slot1/platform";
import { buildDemoScene, demoEncodeArgs, demoPublishUrl } from "./scene";

/**
 * SLOT1's demo broadcaster (docker compose service `demo`): generates the synthetic demo scene
 * with ffmpeg and publishes it over RTMP to this server's own ingest gateway, forever, exactly
 * like OBS would. The gateway checks the key with the API like any other publisher.
 */

const bool = z.enum(["true", "false"]).optional().transform((v) => v === "true");
const Env = z.object({
  INGEST_GATEWAY: z.enum(["mediamtx", "nginx-rtmp"], { message: "INGEST_GATEWAY must be mediamtx or nginx-rtmp" }),
  SLOT1_DEMO: bool,
  SLOT1_DEMO_STREAM_KEY: z.string().min(16, "SLOT1_DEMO_STREAM_KEY must be set (16+ characters)").regex(/^[A-Za-z0-9_-]+$/, "SLOT1_DEMO_STREAM_KEY must be letters, digits, - or _"),
  /** Gateway RTMP base on the private network. Default: the compose service of the gateway. */
  SLOT1_DEMO_RTMP_URL: z.string().regex(/^rtmps?:\/\//).optional(),
  SLOT1_DEMO_VIDEO_SIZE: z
    .string()
    .regex(/^\d{3,4}x\d{3,4}$/)
    .default("1280x720"),
  SLOT1_DEMO_FPS: z.coerce.number().int().min(10).max(60).default(30),
  SLOT1_DEMO_BITRATE_KBPS: z.coerce.number().int().min(300).max(12_000).default(2500),
  SLOT1_DEMO_PRESET: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]).default("veryfast"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
});

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "slot1-demo", msg, ...extra }));
}

async function main() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    log("error", `Demo broadcaster can't start: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(2);
  }
  const env = parsed.data;
  if (!env.SLOT1_DEMO) {
    log("warn", "SLOT1_DEMO is not true: the API keeps the demo channel hidden and refuses this key. Exiting.");
    process.exit(0);
  }
  const [width, height] = env.SLOT1_DEMO_VIDEO_SIZE.split("x").map((n) => Math.max(2, Math.floor(Number(n) / 2) * 2)) as [number, number];
  const base = env.SLOT1_DEMO_RTMP_URL ?? (env.INGEST_GATEWAY === "mediamtx" ? "rtmp://mediamtx:1935/live" : "rtmp://ingest:1935/live");
  const url = demoPublishUrl(env.INGEST_GATEWAY, base, env.SLOT1_DEMO_STREAM_KEY);
  const work = await mkdtemp(path.join(tmpdir(), "slot1-demo-"));
  const scene = await buildDemoScene(work, { width, height, fps: env.SLOT1_DEMO_FPS, font: findRenderFonts().caption });
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    ...scene.args,
    ...demoEncodeArgs({ fps: env.SLOT1_DEMO_FPS, bitrateKbps: env.SLOT1_DEMO_BITRATE_KBPS, preset: env.SLOT1_DEMO_PRESET }),
    "-flvflags",
    "no_duration_filesize",
    "-f",
    "flv",
    url,
  ];

  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = async () => {
    stopping = true;
    child?.kill("SIGTERM");
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

  log("info", "demo broadcaster starting", { gateway: env.INGEST_GATEWAY, size: `${width}x${height}`, fps: env.SLOT1_DEMO_FPS, kbps: env.SLOT1_DEMO_BITRATE_KBPS, preset: env.SLOT1_DEMO_PRESET });
  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      let tail = "";
      child = spawn(env.FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (d: Buffer) => {
        tail = (tail + d.toString("utf8")).slice(-2000);
      });
      child.on("error", (err) => {
        log("error", `ffmpeg could not start: ${sanitizeErrorMessage(err.message)}`);
        resolve(null);
      });
      child.on("close", (c) => {
        // The publish URL carries the key; the sanitizer redacts RTMP URLs before logging.
        if (!stopping) log("warn", "demo stream ended", { code: c, ffmpeg: sanitizeErrorMessage(tail.trim().split(/\r?\n/).slice(-3).join(" | ")).slice(0, 400) });
        resolve(c);
      });
    });
    child = null;
    if (stopping) break;
    // A run that lasted a while resets the backoff (e.g. the gateway restarted).
    failures = Date.now() - started > 60_000 ? 1 : failures + 1;
    const wait = Math.min(30_000, 2000 * 2 ** Math.min(failures - 1, 4));
    log("info", `reconnecting in ${Math.round(wait / 1000)} s`, { code });
    await new Promise((r) => setTimeout(r, wait));
  }
}

void main().catch((err: unknown) => {
  log("error", `demo broadcaster failed: ${sanitizeErrorMessage((err as Error).message)}`);
  process.exit(1);
});
