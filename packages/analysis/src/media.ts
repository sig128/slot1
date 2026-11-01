import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runChecked, runProcess } from "./process";

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  /** Per-invocation wall-clock limit. */
  timeoutMs: number;
}

export interface MediaProbe {
  formatName: string;
  demuxer: string;
  durationMs: number | null;
  sizeBytes: number | null;
  video: { codec: string; width: number; height: number; fps: number | null; pixFmt: string | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
}

/** Container formats we accept for uploads, mapped to the demuxer we force on every call. */
const ALLOWED_FORMATS: { match: RegExp; demuxer: string }[] = [
  { match: /^mov,mp4,m4a,3gp,3g2,mj2$/, demuxer: "mov" },
  { match: /^matroska,webm$/, demuxer: "matroska" },
  { match: /^mpegts$/, demuxer: "mpegts" },
  { match: /^flv$/, demuxer: "flv" },
  { match: /^avi$/, demuxer: "avi" },
];

const ALLOWED_VIDEO_CODECS = new Set(["h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mpeg2video", "prores", "mjpeg"]);

let prlimitPath: string | null | undefined;
function prlimit(): string | null {
  if (prlimitPath !== undefined) return prlimitPath;
  prlimitPath = null;
  if (process.platform === "linux") {
    try {
      prlimitPath = execFileSync("which", ["prlimit"], { encoding: "utf8" }).trim() || null;
    } catch {
      prlimitPath = null;
    }
  }
  return prlimitPath;
}

/** Wrap ffmpeg/ffprobe with an address-space and CPU limit when the OS supports it. */
function limited(bin: string, args: string[], memoryMb = 3072, cpuSec = 3600): [string, string[]] {
  const pl = prlimit();
  if (!pl) return [bin, args];
  return [pl, [`--as=${memoryMb * 1024 * 1024}`, `--cpu=${cpuSec}`, "--", bin, ...args]];
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return null;
  const v = n / d;
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 100) / 100 : null;
}

/**
 * Inspect a LOCAL file. Only the `file` protocol is allowed so a crafted playlist cannot make
 * ffprobe fetch URLs or read other files.
 */
export async function probeFile(tools: MediaTools, file: string): Promise<MediaProbe> {
  const [bin, args] = limited(tools.ffprobe, [
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const res = await runChecked(bin, args, { timeoutMs: Math.min(tools.timeoutMs, 60_000), maxStdoutBytes: 4 * 1024 * 1024 });
  const json = JSON.parse(res.stdout.toString("utf8")) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      pix_fmt?: string;
      sample_rate?: string;
      channels?: number;
      disposition?: { attached_pic?: number };
    }[];
  };
  const formatName = json.format?.format_name ?? "unknown";
  const allowed = ALLOWED_FORMATS.find((f) => f.match.test(formatName));
  const v = json.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = json.streams?.find((s) => s.codec_type === "audio");
  const duration = json.format?.duration ? Math.round(Number.parseFloat(json.format.duration) * 1000) : null;
  return {
    formatName,
    demuxer: allowed?.demuxer ?? "",
    durationMs: duration !== null && Number.isFinite(duration) ? duration : null,
    sizeBytes: json.format?.size ? Number(json.format.size) : null,
    video: v
      ? {
          codec: v.codec_name ?? "unknown",
          width: v.width ?? 0,
          height: v.height ?? 0,
          fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
          pixFmt: v.pix_fmt ?? null,
        }
      : null,
    audio: a ? { codec: a.codec_name ?? "unknown", sampleRate: a.sample_rate ? Number(a.sample_rate) : null, channels: a.channels ?? null } : null,
  };
}

export interface ProbeLimits {
  maxDurationMs: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
}

export const DEFAULT_PROBE_LIMITS: ProbeLimits = { maxDurationMs: 3 * 3600_000, maxWidth: 4096, maxHeight: 2304, maxFps: 144 };

/** Returns a list of human-readable problems; empty means the media is acceptable. */
export function validateProbe(p: MediaProbe, limits: ProbeLimits = DEFAULT_PROBE_LIMITS): string[] {
  const problems: string[] = [];
  if (!p.demuxer) problems.push(`Unsupported container (${p.formatName}). Use MP4, MOV, MKV/WebM, MPEG-TS, FLV or AVI.`);
  if (!p.video) problems.push("No video stream found.");
  else {
    if (!ALLOWED_VIDEO_CODECS.has(p.video.codec)) problems.push(`Unsupported video codec (${p.video.codec}).`);
    if (p.video.width <= 0 || p.video.height <= 0) problems.push("Video has no valid dimensions.");
    if (p.video.width > limits.maxWidth || p.video.height > limits.maxHeight)
      problems.push(`Video is larger than ${limits.maxWidth}×${limits.maxHeight}.`);
    if (p.video.fps !== null && p.video.fps > limits.maxFps) problems.push(`Frame rate above ${limits.maxFps} fps is not supported.`);
  }
  if (p.durationMs === null || p.durationMs <= 0) problems.push("Could not determine the duration.");
  else if (p.durationMs > limits.maxDurationMs) problems.push(`Video is longer than ${Math.round(limits.maxDurationMs / 60000)} minutes.`);
  return problems;
}

/** Common input arguments for an already-validated local upload. */
function inputArgs(file: string, demuxer: string, seekMs?: number): string[] {
  const args = ["-hide_banner", "-nostdin", "-protocol_whitelist", "file"];
  if (seekMs !== undefined) args.push("-ss", (seekMs / 1000).toFixed(3));
  if (demuxer) args.push("-f", demuxer);
  args.push("-i", file);
  return args;
}

/* ------------------------------------------------------------------------------------------ */
/* Deterministic detectors (local, no AI)                                                     */
/* ------------------------------------------------------------------------------------------ */

export async function detectSceneChanges(tools: MediaTools, file: string, demuxer: string, threshold = 0.42): Promise<{ ptsMs: number; score: number }[]> {
  const scenes: { ptsMs: number; score: number }[] = [];
  let pendingScore: number | null = null;
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer),
    "-an",
    "-vf",
    `scale=320:-2,select='gt(scene\\,${threshold})',metadata=print,showinfo`,
    "-f",
    "null",
    "-",
  ]);
  await runChecked(bin, args, {
    timeoutMs: tools.timeoutMs,
    onStderrLine: (line) => {
      const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
      if (s) pendingScore = Number(s[1]);
      const m = /\bpts_time:([\d.]+)/.exec(line);
      if (m && line.includes("showinfo")) {
        scenes.push({ ptsMs: Math.round(Number(m[1]) * 1000), score: pendingScore ?? threshold });
        pendingScore = null;
      }
    },
  });
  return scenes;
}

export async function detectBlackSegments(tools: MediaTools, file: string, demuxer: string, minDurSec = 1.5): Promise<{ startMs: number; endMs: number }[]> {
  const out: { startMs: number; endMs: number }[] = [];
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer),
    "-an",
    "-vf",
    `scale=320:-2,blackdetect=d=${minDurSec}:pix_th=0.10`,
    "-f",
    "null",
    "-",
  ]);
  await runChecked(bin, args, {
    timeoutMs: tools.timeoutMs,
    onStderrLine: (line) => {
      const m = /black_start:([\d.]+)\s+black_end:([\d.]+)/.exec(line);
      if (m) out.push({ startMs: Math.round(Number(m[1]) * 1000), endMs: Math.round(Number(m[2]) * 1000) });
    },
  });
  return out;
}

export async function detectSilence(tools: MediaTools, file: string, demuxer: string, minDurSec = 8): Promise<{ startMs: number; endMs: number }[]> {
  const out: { startMs: number; endMs: number }[] = [];
  let start: number | null = null;
  const [bin, args] = limited(tools.ffmpeg, [...inputArgs(file, demuxer), "-vn", "-af", `silencedetect=n=-50dB:d=${minDurSec}`, "-f", "null", "-"]);
  await runChecked(bin, args, {
    timeoutMs: tools.timeoutMs,
    onStderrLine: (line) => {
      const s = /silence_start:\s*([\d.]+)/.exec(line);
      if (s) start = Math.round(Number(s[1]) * 1000);
      const e = /silence_end:\s*([\d.]+)/.exec(line);
      if (e && start !== null) {
        out.push({ startMs: start, endMs: Math.round(Number(e[1]) * 1000) });
        start = null;
      }
    },
  });
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Frame sampling                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface ExtractedFrame {
  ptsMs: number;
  file: string;
  reason: "interval" | "scene";
}

/**
 * Plan sample times: a regular base interval plus extra frames right after scene changes,
 * de-duplicated (min spacing) and capped by a hard budget. Returns sorted times in ms.
 */
export function planSampleTimes(durationMs: number, opts: { baseIntervalMs: number; sceneTimesMs: number[]; maxFrames: number; minSpacingMs?: number }) {
  const minSpacing = opts.minSpacingMs ?? Math.min(1500, opts.baseIntervalMs / 2);
  const base: number[] = [];
  for (let t = 0; t < durationMs; t += opts.baseIntervalMs) base.push(Math.round(t));
  const scenes = opts.sceneTimesMs.map((t) => Math.min(durationMs - 1, t + 250)).filter((t) => t >= 0);
  const all = [...base.map((t) => ({ t, reason: "interval" as const })), ...scenes.map((t) => ({ t, reason: "scene" as const }))].sort((a, b) => a.t - b.t);
  const picked: { t: number; reason: "interval" | "scene" }[] = [];
  for (const c of all) {
    const last = picked[picked.length - 1];
    if (last && c.t - last.t < minSpacing) {
      if (c.reason === "scene" && last.reason === "interval") picked[picked.length - 1] = c;
      continue;
    }
    picked.push(c);
  }
  if (picked.length <= opts.maxFrames) return picked;
  // Over budget: keep scene frames first, then thin interval frames uniformly.
  const scenesPicked = picked.filter((p) => p.reason === "scene").slice(0, Math.floor(opts.maxFrames / 3));
  const remaining = opts.maxFrames - scenesPicked.length;
  const intervals = picked.filter((p) => p.reason === "interval");
  const step = intervals.length / Math.max(1, remaining);
  const thinned: typeof picked = [];
  for (let i = 0; i < remaining && Math.floor(i * step) < intervals.length; i++) thinned.push(intervals[Math.floor(i * step)]!);
  return [...scenesPicked, ...thinned].sort((a, b) => a.t - b.t);
}

/** Extract a single frame at an exact media time as JPEG, scaled to fit `maxEdge`. */
export async function extractFrameAt(tools: MediaTools, file: string, demuxer: string, ptsMs: number, out: string, maxEdge = 1280): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer, ptsMs),
    "-frames:v",
    "1",
    "-an",
    "-vf",
    `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-q:v",
    "3",
    "-y",
    out,
  ]);
  await runChecked(bin, args, { timeoutMs: Math.min(tools.timeoutMs, 60_000) });
  if (!existsSync(out)) throw new Error(`No frame decoded at ${ptsMs}ms`);
}

/**
 * Extract frames at a regular interval in ONE decoding pass; timestamps come from showinfo
 * (the fps filter's output PTS), so every frame carries a real media timestamp.
 */
export async function extractIntervalFrames(
  tools: MediaTools,
  file: string,
  demuxer: string,
  outDir: string,
  intervalMs: number,
  maxEdge = 1280,
  maxFrames = 2000,
): Promise<ExtractedFrame[]> {
  await mkdir(outDir, { recursive: true });
  const pts: number[] = [];
  const fps = (1000 / intervalMs).toFixed(6);
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer),
    "-an",
    "-vf",
    // round=up: each sample is the last frame at or before its timestamp, so the PTS names the
    // moment shown (round=near emitted the frame from half an interval later).
    `fps=${fps}:round=up,scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,showinfo`,
    "-frames:v",
    String(maxFrames),
    "-q:v",
    "3",
    "-y",
    path.join(outDir, "f%06d.jpg"),
  ]);
  await runChecked(bin, args, {
    timeoutMs: tools.timeoutMs,
    onStderrLine: (line) => {
      if (!line.includes("showinfo")) return;
      const m = /\bpts_time:([\d.]+)/.exec(line);
      if (m) pts.push(Math.round(Number(m[1]) * 1000));
    },
  });
  const files = (await readdir(outDir)).filter((f) => /^f\d{6}\.jpg$/.test(f)).sort();
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < files.length; i++) {
    const t = pts[i];
    if (t === undefined) break; // never invent a timestamp
    frames.push({ ptsMs: t, file: path.join(outDir, files[i]!), reason: "interval" });
  }
  return frames;
}

/* ------------------------------------------------------------------------------------------ */
/* Playback rendition, poster, audio                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Produce a browser-playable MP4 (H.264/AAC, faststart). Remuxes when possible to keep quality. */
export async function makePlaybackRendition(tools: MediaTools, file: string, probe: MediaProbe, out: string): Promise<"remux" | "transcode"> {
  await mkdir(path.dirname(out), { recursive: true });
  const canRemux =
    probe.demuxer === "mov" && probe.video?.codec === "h264" && (probe.video.pixFmt === "yuv420p" || probe.video.pixFmt === null) && (!probe.audio || probe.audio.codec === "aac");
  const common = [...inputArgs(file, probe.demuxer), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"];
  const args = canRemux
    ? [...common, "-c", "copy", "-movflags", "+faststart", "-y", out]
    : [
        ...common,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        "-y",
        out,
      ];
  const [bin, a] = limited(tools.ffmpeg, args);
  await runChecked(bin, a, { timeoutMs: tools.timeoutMs });
  return canRemux ? "remux" : "transcode";
}

export async function extractAudioChunk(tools: MediaTools, file: string, demuxer: string, startMs: number, durationMs: number, out: string): Promise<boolean> {
  await mkdir(path.dirname(out), { recursive: true });
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer, startMs),
    "-t",
    (durationMs / 1000).toFixed(3),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    "-y",
    out,
  ]);
  const res = await runProcess(bin, args, { timeoutMs: Math.min(tools.timeoutMs, 120_000) });
  return res.code === 0 && existsSync(out);
}

/* ------------------------------------------------------------------------------------------ */
/* Clip rendering from media we possess                                                        */
/* ------------------------------------------------------------------------------------------ */

export const DEFAULT_CAPTION_FONTS = [
  "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
  "/usr/share/fonts/truetype/inter/Inter-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

export function findCaptionFont(candidates = DEFAULT_CAPTION_FONTS): string | null {
  return candidates.find((f) => existsSync(f)) ?? null;
}

export async function renderLandscapeClip(tools: MediaTools, file: string, demuxer: string, startMs: number, endMs: number, out: string) {
  await mkdir(path.dirname(out), { recursive: true });
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer, startMs),
    "-t",
    ((endMs - startMs) / 1000).toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-y",
    out,
  ]);
  await runChecked(bin, args, { timeoutMs: tools.timeoutMs });
}

/**
 * Vertical 9:16 layout that never crops the action: the full landscape frame sits in the
 * middle at full width over a blurred, darkened fill of itself, with an optional caption.
 * The caption is passed through a text FILE (textfile=) with expansion disabled, so user text
 * never becomes filtergraph syntax.
 */
export async function renderVerticalClip(
  tools: MediaTools,
  file: string,
  demuxer: string,
  startMs: number,
  endMs: number,
  out: string,
  caption: string | null,
  fontFile: string | null,
): Promise<{ captioned: boolean }> {
  await mkdir(path.dirname(out), { recursive: true });
  let captionFilter = "";
  let captioned = false;
  if (caption && fontFile) {
    const textFile = `${out}.caption.txt`;
    await writeFile(textFile, caption.replace(/[\r\n]+/g, " ").slice(0, 90), "utf8");
    const esc = (p: string) => p.replace(/\\/g, "/").replace(/'/g, "");
    captionFilter = `,drawtext=fontfile='${esc(fontFile)}':textfile='${esc(textFile)}':expansion=none:fontsize=58:fontcolor=0xF4EDE2:line_spacing=8:x=(w-text_w)/2:y=h*0.17:box=1:boxcolor=0x101014@0.55:boxborderw=24`;
    captioned = true;
  }
  const graph =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.18:saturation=0.8[bg];` +
    `[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${captionFilter}[v]`;
  const [bin, args] = limited(tools.ffmpeg, [
    ...inputArgs(file, demuxer, startMs),
    "-t",
    ((endMs - startMs) / 1000).toFixed(3),
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-y",
    out,
  ]);
  await runChecked(bin, args, { timeoutMs: tools.timeoutMs });
  return { captioned };
}
