import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Capabilities } from "@slot1/contracts";

/**
 * Environment configuration. Optional integrations are allowed to be absent: the app keeps
 * running and reports the exact missing requirement instead of substituting demo output.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? null : v.trim()));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  SLOT1_PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
  SLOT1_API_PORT: int(4000),
  SLOT1_API_HOST: z.string().default("127.0.0.1"),
  SLOT1_TRUST_PROXY: bool(false),

  DATABASE_URL: z.string().default("postgres://slot1:slot1@127.0.0.1:5432/slot1"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  SLOT1_SESSION_SECRET: optStr,
  SLOT1_TOKEN_ENCRYPTION_KEYS: optStr,
  SLOT1_ALLOW_LOCAL_LOGIN: bool(false),

  STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  STORAGE_FS_ROOT: z.string().default(".data/storage"),
  S3_ENDPOINT: optStr,
  S3_PUBLIC_ENDPOINT: optStr,
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: optStr,
  S3_ACCESS_KEY_ID: optStr,
  S3_SECRET_ACCESS_KEY: optStr,
  S3_FORCE_PATH_STYLE: bool(true),
  MEDIA_URL_TTL_SECONDS: int(300),

  UPLOAD_MAX_BYTES: int(1024 * 1024 * 1024),
  UPLOAD_MAX_DURATION_SEC: int(3 * 3600),
  UPLOAD_TMP_DIR: z.string().default(".data/uploads"),

  TWITCH_CLIENT_ID: optStr,
  TWITCH_CLIENT_SECRET: optStr,
  TWITCH_REDIRECT_URI: optStr,
  TWITCH_EVENTSUB_CALLBACK_URL: optStr,
  TWITCH_EVENTSUB_SECRET: optStr,
  TWITCH_EMBED_PARENTS: z.string().default("localhost"),
  TWITCH_API_BASE: z.url().default("https://api.twitch.tv/helix"),
  TWITCH_ID_BASE: z.url().default("https://id.twitch.tv/oauth2"),
  SLOT1_BOT_TWITCH_LOGIN: optStr,
  SLOT1_OPERATOR_TWITCH_LOGINS: z.string().default(""),

  VISION_PROVIDER: z.enum(["none", "anthropic", "openai"]).default("none"),
  ANTHROPIC_API_KEY: optStr,
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  ANTHROPIC_VISION_MODEL: optStr,
  ANTHROPIC_TEXT_MODEL: optStr,
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_VISION_MODEL: optStr,
  OPENAI_TEXT_MODEL: optStr,
  VISION_PRICE_INPUT_PER_MTOK: optStr,
  VISION_PRICE_OUTPUT_PER_MTOK: optStr,
  VISION_FRAMES_PER_CALL: int(4),
  VISION_MAX_EDGE_PX: int(1280),

  TRANSCRIPTION_PROVIDER: z.enum(["none", "openai_compatible"]).default("none"),
  TRANSCRIPTION_BASE_URL: z.string().default("https://api.openai.com/v1"),
  TRANSCRIPTION_API_KEY: optStr,
  TRANSCRIPTION_MODEL: optStr,
  TRANSCRIPTION_PRICE_PER_MINUTE: optStr,

  OCR_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
  TESSERACT_PATH: z.string().default("tesseract"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FFMPEG_TIMEOUT_SEC: int(1800),

  INGEST_GATEWAY: z.enum(["none", "nginx-rtmp", "mediamtx"]).default("none"),
  INGEST_PUBLIC_RTMP_URL: optStr,
  INGEST_READ_URL_TEMPLATE: optStr,
  INGEST_READ_USER: z.string().default("slot1-worker"),
  INGEST_READ_PASSWORD: optStr,
  INGEST_HOOK_SECRET: optStr,
  /** Browser-facing MediaMTX WebRTC base (WHEP playback, WHIP publishing), e.g. https://live.example.com. */
  INGEST_PUBLIC_WEBRTC_URL: optStr,
  /** Optional SRT address shown to creators, e.g. srt://live.example.com:8890. */
  INGEST_PUBLIC_SRT_URL: optStr,
  INGEST_SEGMENT_DIR: z.string().default(".data/ingest-buffer"),
  /** Twitch's documented global ingest (https://ingest.twitch.tv/ingests, "Default", secure template). */
  RELAY_TWITCH_INGEST_URL: z.string().default("rtmps://ingest.global-contribute.live-video.net/app"),
  /** YouTube's primary RTMPS ingest as listed in OBS's services list; creators can override it. */
  RELAY_YOUTUBE_INGEST_URL: z.string().default("rtmps://a.rtmps.youtube.com:443/live2"),
  /** Development/tests only: allow forwarding to loopback/private addresses (SSRF guard off). */
  RELAY_ALLOW_PRIVATE_DESTINATIONS: bool(false),
  RELAY_MAX_DESTINATIONS: int(4),
  /**
   * CA bundle ffmpeg verifies RTMPS servers against (the stream key travels inside that TLS
   * connection). Unset: the first system bundle found, else the TLS library's default trust.
   */
  RELAY_TLS_CA_FILE: optStr,

  WORKER_MEDIA_CONCURRENCY: int(1),
  /** Library jobs (screenshots, renders, recording finalization) run beside upload analysis. */
  WORKER_LIBRARY_CONCURRENCY: int(2),
  /** Encoder for edit renders: libx264 (default, CPU) or h264_nvenc (NVIDIA GPU). */
  FFMPEG_ENCODER: z.enum(["libx264", "h264_nvenc"]).default("libx264"),
  WORKER_LIVE_MAX_SOURCES: int(4),

  /** Hardware video decoding for live readers: none | cuda | vaapi | videotoolbox. */
  FFMPEG_HWACCEL: z.enum(["none", "cuda", "vaapi", "videotoolbox"]).default("none"),
  /** Optional decode device, e.g. /dev/dri/renderD128 for vaapi or a GPU index for cuda. */
  FFMPEG_HWACCEL_DEVICE: optStr,

  /** Shared GTA-model inference service. When set, workers send frames there instead of loading the model. */
  INFERENCE_URL: optStr,
  /** Required by the inference service on every request; workers send it as a bearer token. */
  INFERENCE_SHARED_SECRET: optStr,
  /** Live frames wait at most this long for the service; then the frame is skipped (never stalls the stream). */
  INFERENCE_TIMEOUT_MS: int(1500),
  INFERENCE_HOST: z.string().default("127.0.0.1"),
  INFERENCE_PORT: int(4100),
  /** Dynamic batching: run as soon as this many frames are queued, or after the wait below. */
  INFERENCE_MAX_BATCH: int(16),
  INFERENCE_MAX_WAIT_MS: int(8),
  /** Bounded queue: beyond this the service answers 429 at once. Per stream, the oldest frame is replaced. */
  INFERENCE_MAX_QUEUE: int(512),
  INFERENCE_MAX_PER_STREAM: int(4),
  /** Batches run in parallel (keep 1 per GPU). */
  INFERENCE_CONCURRENCY: int(1),
  /** ONNX Runtime execution providers in order of preference, e.g. "cuda,cpu". */
  INFERENCE_EXECUTION_PROVIDERS: z.string().default("cpu"),
  /** How often the service re-checks the model registry (activation also notifies it immediately). */
  INFERENCE_MODEL_POLL_MS: int(15_000),
  /** Demo broadcast (docs/DEMO.md): a public channel fed by a synthetic test video. Off by default. */
  SLOT1_DEMO: bool(false),
  /** Publishing key the demo generator uses (random hex; the server script generates it). */
  SLOT1_DEMO_STREAM_KEY: optStr,
  /** Send demo frames to the paid vision provider too (strictly rate-capped). Off by default. */
  SLOT1_DEMO_VISION: bool(false),
  /** How often the worker samples the demo stream for analysis. */
  SLOT1_DEMO_SAMPLE_MS: int(3000),
  BOT_GLOBAL_KILL: bool(false),
  BOT_GLOBAL_MESSAGES_PER_30S: int(60),
  /** Cookieless visitor counting for /admin (docs/ADMIN.md). false = nothing is counted. */
  SLOT1_ANALYTICS: bool(true),
  /** Build or commit shown in /admin → System (the server script sets it on each update). */
  SLOT1_VERSION: optStr,
  /** scrypt hash of the /admin password (docs/ADMIN.md); `slot1 admin-password` sets it. Never the password itself. */
  SLOT1_ADMIN_PASSWORD_HASH: optStr,
});

export type Env = z.infer<typeof EnvSchema>;

export interface EncryptionKey {
  id: string;
  key: Buffer;
}

export interface AppConfig {
  env: Env;
  isProduction: boolean;
  publicOrigin: string;
  sessionSecret: Buffer;
  encryptionKeys: EncryptionKey[];
  embedParents: string[];
  operatorLogins: Set<string>;
  allowLocalLogin: boolean;
  capabilities: Capabilities;
  problems: string[];
}

export function parseEncryptionKeys(spec: string | null): EncryptionKey[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx <= 0) throw new Error("SLOT1_TOKEN_ENCRYPTION_KEYS entries must look like <keyId>:<base64 32 bytes>");
      const id = part.slice(0, idx);
      const key = Buffer.from(part.slice(idx + 1), "base64");
      if (key.length !== 32) throw new Error(`Encryption key ${id} must decode to exactly 32 bytes`);
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error(`Encryption key id ${id} is invalid`);
      return { id, key };
    });
}

let tesseractCache: boolean | null = null;
function tesseractAvailable(path: string): boolean {
  if (tesseractCache !== null) return tesseractCache;
  try {
    execFileSync(path, ["--version"], { stdio: "ignore", timeout: 5000 });
    tesseractCache = true;
  } catch {
    tesseractCache = false;
  }
  return tesseractCache;
}

const cap = (available: boolean, reason: string | null, detail: string | null = null) => ({
  available,
  reason: available ? null : reason,
  detail,
});

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(source);
  const problems: string[] = [];
  const isProduction = env.NODE_ENV === "production";

  let sessionSecret: Buffer;
  if (env.SLOT1_SESSION_SECRET && env.SLOT1_SESSION_SECRET.length >= 32) {
    sessionSecret = Buffer.from(env.SLOT1_SESSION_SECRET, "utf8");
  } else if (isProduction) {
    throw new Error("SLOT1_SESSION_SECRET (>= 32 chars) is required in production");
  } else {
    // Development only: an ephemeral secret. Sessions and signed URLs reset on restart.
    sessionSecret = Buffer.from(`dev-insecure-session-secret-${env.NODE_ENV}-change-me-please`, "utf8");
    problems.push("SLOT1_SESSION_SECRET is not set; using a development-only secret.");
  }

  const encryptionKeys = parseEncryptionKeys(env.SLOT1_TOKEN_ENCRYPTION_KEYS);
  if (encryptionKeys.length === 0 && isProduction) {
    throw new Error("SLOT1_TOKEN_ENCRYPTION_KEYS is required in production");
  }

  const allowLocalLogin = env.SLOT1_ALLOW_LOCAL_LOGIN && !isProduction;
  if (env.SLOT1_ALLOW_LOCAL_LOGIN && isProduction) problems.push("SLOT1_ALLOW_LOCAL_LOGIN is ignored in production.");
  if (env.INFERENCE_URL && !env.INFERENCE_SHARED_SECRET) {
    if (isProduction) throw new Error("INFERENCE_URL is set but INFERENCE_SHARED_SECRET is missing");
    problems.push("INFERENCE_URL is set without INFERENCE_SHARED_SECRET; the inference service will refuse every request.");
  }

  const embedParents = env.TWITCH_EMBED_PARENTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h));

  const twitchMissing: string[] = [];
  if (!env.TWITCH_CLIENT_ID) twitchMissing.push("TWITCH_CLIENT_ID");
  if (!env.TWITCH_CLIENT_SECRET) twitchMissing.push("TWITCH_CLIENT_SECRET");
  if (!env.TWITCH_REDIRECT_URI) twitchMissing.push("TWITCH_REDIRECT_URI");
  if (encryptionKeys.length === 0) twitchMissing.push("SLOT1_TOKEN_ENCRYPTION_KEYS");
  const twitchOk = twitchMissing.length === 0;

  const eventsubMissing: string[] = [];
  if (!twitchOk) eventsubMissing.push("Twitch app credentials");
  if (!env.TWITCH_EVENTSUB_CALLBACK_URL) eventsubMissing.push("TWITCH_EVENTSUB_CALLBACK_URL");
  else if (!env.TWITCH_EVENTSUB_CALLBACK_URL.startsWith("https://")) eventsubMissing.push("an HTTPS (port 443) EventSub callback URL");
  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (!secret) eventsubMissing.push("TWITCH_EVENTSUB_SECRET");
  else if (secret.length < 10 || secret.length > 100 || !/^[\x20-\x7e]+$/.test(secret))
    eventsubMissing.push("TWITCH_EVENTSUB_SECRET must be 10–100 ASCII characters");
  const eventsubOk = eventsubMissing.length === 0;

  const botMissing: string[] = [];
  if (!twitchOk) botMissing.push("Twitch app credentials");
  if (!env.SLOT1_BOT_TWITCH_LOGIN) botMissing.push("SLOT1_BOT_TWITCH_LOGIN");
  if (!eventsubOk) botMissing.push("EventSub webhooks (chat messages arrive via channel.chat.message)");

  let visionProvider: string | null = null;
  let visionModel: string | null = null;
  let visionReason: string | null = null;
  if (env.VISION_PROVIDER === "anthropic") {
    visionProvider = "anthropic";
    visionModel = env.ANTHROPIC_VISION_MODEL;
    if (!env.ANTHROPIC_API_KEY) visionReason = "ANTHROPIC_API_KEY is not set";
    else if (!env.ANTHROPIC_VISION_MODEL) visionReason = "ANTHROPIC_VISION_MODEL is not set";
  } else if (env.VISION_PROVIDER === "openai") {
    visionProvider = "openai";
    visionModel = env.OPENAI_VISION_MODEL;
    if (!env.OPENAI_API_KEY) visionReason = "OPENAI_API_KEY is not set";
    else if (!env.OPENAI_VISION_MODEL) visionReason = "OPENAI_VISION_MODEL is not set";
  } else {
    visionReason = "AI not configured: set VISION_PROVIDER and the provider's API key and vision model";
  }
  const visionOk = visionReason === null;

  let transcriptionReason: string | null = null;
  if (env.TRANSCRIPTION_PROVIDER === "none") transcriptionReason = "Transcription not configured: set TRANSCRIPTION_PROVIDER";
  else if (!env.TRANSCRIPTION_MODEL) transcriptionReason = "TRANSCRIPTION_MODEL is not set";

  const ocrEnabled = env.OCR_ENABLED === "false" ? false : env.OCR_ENABLED === "true" ? true : tesseractAvailable(env.TESSERACT_PATH);

  const storageMissing: string[] = [];
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_ENDPOINT && !env.S3_REGION) storageMissing.push("S3_ENDPOINT");
    if (!env.S3_BUCKET) storageMissing.push("S3_BUCKET");
    if (!env.S3_ACCESS_KEY_ID) storageMissing.push("S3_ACCESS_KEY_ID");
    if (!env.S3_SECRET_ACCESS_KEY) storageMissing.push("S3_SECRET_ACCESS_KEY");
  }

  const ingestMissing: string[] = [];
  if (env.INGEST_GATEWAY === "none") ingestMissing.push("INGEST_GATEWAY");
  if (!env.INGEST_PUBLIC_RTMP_URL) ingestMissing.push("INGEST_PUBLIC_RTMP_URL");
  if (!env.INGEST_READ_URL_TEMPLATE) ingestMissing.push("INGEST_READ_URL_TEMPLATE");
  if (!env.INGEST_HOOK_SECRET) ingestMissing.push("INGEST_HOOK_SECRET");
  // The worker authenticates as a reader on both gateways; without it nobody may read a stream.
  if (!env.INGEST_READ_PASSWORD) ingestMissing.push("INGEST_READ_PASSWORD");

  // SLOT1-hosted live video needs MediaMTX's WebRTC server; nginx-rtmp can't serve WebRTC.
  const liveVideoMissing: string[] = [];
  if (env.INGEST_GATEWAY !== "mediamtx") liveVideoMissing.push("INGEST_GATEWAY=mediamtx");
  if (!env.INGEST_PUBLIC_WEBRTC_URL) liveVideoMissing.push("INGEST_PUBLIC_WEBRTC_URL");
  else if (!/^https?:\/\//.test(env.INGEST_PUBLIC_WEBRTC_URL)) liveVideoMissing.push("an http(s) INGEST_PUBLIC_WEBRTC_URL");
  if (ingestMissing.length) liveVideoMissing.push(...ingestMissing.filter((m) => m !== "INGEST_GATEWAY"));
  const liveVideoReason =
    env.INGEST_GATEWAY === "nginx-rtmp"
      ? "Live video not configured: nginx-rtmp can't serve WebRTC. Missing INGEST_GATEWAY=mediamtx" +
        (liveVideoMissing.length > 1 ? `, ${liveVideoMissing.filter((m) => m !== "INGEST_GATEWAY=mediamtx").join(", ")}` : "")
      : `Live video not configured: missing ${liveVideoMissing.join(", ")}`;

  const capabilities: Capabilities = {
    environment: env.NODE_ENV,
    twitch: cap(twitchOk, `Twitch not configured: missing ${twitchMissing.join(", ")}`),
    bot: cap(botMissing.length === 0, `Bot unavailable: missing ${botMissing.join(", ")}`),
    eventsub: cap(eventsubOk, `EventSub unavailable: missing ${eventsubMissing.join(", ")}`),
    vision: { ...cap(visionOk, visionReason), provider: visionProvider, model: visionModel },
    transcription: {
      ...cap(transcriptionReason === null, transcriptionReason),
      provider: env.TRANSCRIPTION_PROVIDER === "none" ? null : env.TRANSCRIPTION_PROVIDER,
      model: env.TRANSCRIPTION_MODEL,
    },
    ocr: cap(ocrEnabled, `OCR unavailable: ${env.TESSERACT_PATH} not found (install tesseract-ocr)`, "Local tesseract"),
    storage: { ...cap(storageMissing.length === 0, `Storage misconfigured: missing ${storageMissing.join(", ")}`), driver: env.STORAGE_DRIVER },
    ingest: {
      ...cap(ingestMissing.length === 0, `Continuous ingest not configured: missing ${ingestMissing.join(", ")}`),
      gateway: env.INGEST_GATEWAY === "none" ? null : env.INGEST_GATEWAY,
    },
    liveVideo: cap(liveVideoMissing.length === 0, liveVideoReason, "WebRTC (WHEP) through MediaMTX"),
    // Forwarding re-sends the creator's own ingest stream, so it needs exactly what ingest needs.
    relay: cap(ingestMissing.length === 0, `Forwarding needs continuous ingest: missing ${ingestMissing.join(", ")}`, "Copy-only forwarding with ffmpeg"),
    localLogin: allowLocalLogin,
    ps5ChatDisplay: "needs_console_verification",
  };

  return {
    env,
    isProduction,
    publicOrigin: env.SLOT1_PUBLIC_ORIGIN.replace(/\/$/, ""),
    sessionSecret,
    encryptionKeys,
    embedParents,
    operatorLogins: new Set(
      env.SLOT1_OPERATOR_TWITCH_LOGINS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowLocalLogin,
    capabilities,
    problems,
  };
}
