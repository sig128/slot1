import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceKind, SourceLabel } from "@slot1/contracts";
import {
  detectBlackSegments,
  detectSceneChanges,
  detectSilence,
  extractFrameAt,
  extractIntervalFrames,
  planSampleTimes,
  probeFile,
  validateProbe,
  type MediaProbe,
  type MediaTools,
  type ProbeLimits,
} from "./media";
import { jpegSize, MjpegSplitter } from "./mjpeg";
import { ema } from "./state";

export interface SourceCapabilities {
  video: boolean;
  audio: boolean;
  /** Frames keep arriving over time (live) vs. a finite file. */
  continuous: boolean;
  /** We possess the media and can seek / render clips from it. */
  seekable: boolean;
  /** The source supplies wall-clock capture timestamps. */
  captureTimestamps: boolean;
}

export interface SourceIdentity {
  sourceId: string;
  broadcasterId: string;
  sessionId: string;
  kind: SourceKind;
  label: SourceLabel;
}

export interface SampledFrame {
  ptsMs: number;
  receivedAt: Date;
  /** Only set when the source provides it. Never manufactured. */
  capturedAt: Date | null;
  jpeg: Buffer;
  width: number | null;
  height: number | null;
  reason: "interval" | "scene" | "live";
}

export interface SourceHealthSnapshot {
  connected: boolean;
  framesReceived: number;
  framesDropped: number;
  lastFrameAt: Date | null;
  cadenceMs: number | null;
  error: string | null;
}

/** Every media input — upload, downloaded clip, live ingest — goes through this interface. */
export interface MediaSourceAdapter {
  readonly identity: SourceIdentity;
  readonly capabilities: SourceCapabilities;
  authorize(): Promise<{ ok: true } | { ok: false; reason: string }>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  frames(): AsyncIterable<SampledFrame>;
  health(): SourceHealthSnapshot;
}

/* ------------------------------------------------------------------------------------------ */
/* File-backed source (uploads and downloaded Twitch clips)                                   */
/* ------------------------------------------------------------------------------------------ */

export interface FileDetections {
  scenes: { ptsMs: number; score: number }[];
  black: { startMs: number; endMs: number }[];
  silence: { startMs: number; endMs: number }[];
}

export class FileSourceAdapter implements MediaSourceAdapter {
  readonly capabilities: SourceCapabilities;
  private probeResult: MediaProbe | null = null;
  private detected: FileDetections | null = null;
  private stats: SourceHealthSnapshot = { connected: false, framesReceived: 0, framesDropped: 0, lastFrameAt: null, cadenceMs: null, error: null };

  constructor(
    readonly identity: SourceIdentity,
    private readonly file: string,
    private readonly tools: MediaTools,
    private readonly workDir: string,
    private readonly opts: { baseIntervalMs: number; maxFrames: number; maxEdge: number; limits: ProbeLimits },
  ) {
    this.capabilities = { video: true, audio: false, continuous: false, seekable: true, captureTimestamps: false };
  }

  get probe(): MediaProbe {
    if (!this.probeResult) throw new Error("Source not connected");
    return this.probeResult;
  }

  get detections(): FileDetections {
    if (!this.detected) throw new Error("Source not connected");
    return this.detected;
  }

  /** Files we hold are authorized by construction (user-owned upload or authorized clip download). */
  async authorize() {
    return { ok: true as const };
  }

  async connect() {
    this.probeResult = await probeFile(this.tools, this.file);
    const problems = validateProbe(this.probeResult, this.opts.limits);
    if (problems.length > 0) {
      this.stats.error = problems.join(" ");
      throw new Error(problems.join(" "));
    }
    (this.capabilities as { audio: boolean }).audio = this.probeResult.audio !== null;
    const demuxer = this.probeResult.demuxer;
    const [scenes, black, silence] = await Promise.all([
      detectSceneChanges(this.tools, this.file, demuxer),
      detectBlackSegments(this.tools, this.file, demuxer),
      this.probeResult.audio ? detectSilence(this.tools, this.file, demuxer) : Promise.resolve([]),
    ]);
    this.detected = { scenes, black, silence };
    this.stats.connected = true;
  }

  async disconnect() {
    this.stats.connected = false;
  }

  health() {
    return { ...this.stats };
  }

  async *frames(): AsyncIterable<SampledFrame> {
    const probe = this.probe;
    const durationMs = probe.durationMs ?? 0;
    const plan = planSampleTimes(durationMs, {
      baseIntervalMs: this.opts.baseIntervalMs,
      sceneTimesMs: this.detections.scenes.map((s) => s.ptsMs),
      maxFrames: this.opts.maxFrames,
    });
    const interval = await extractIntervalFrames(
      this.tools,
      this.file,
      probe.demuxer,
      path.join(this.workDir, "interval"),
      this.opts.baseIntervalMs,
      this.opts.maxEdge,
      this.opts.maxFrames,
    );
    const byTime = new Map(interval.map((f) => [f.ptsMs, f.file]));
    let prevAt: number | null = null;
    for (const p of plan) {
      let file = p.reason === "interval" ? nearest(byTime, p.t, this.opts.baseIntervalMs / 2) : null;
      if (!file) {
        file = path.join(this.workDir, "scene", `s${String(p.t).padStart(10, "0")}.jpg`);
        try {
          await extractFrameAt(this.tools, this.file, probe.demuxer, p.t, file, this.opts.maxEdge);
        } catch {
          this.stats.framesDropped += 1;
          continue;
        }
      }
      const jpeg = await readFile(file);
      const size = jpegSize(jpeg);
      const now = Date.now();
      this.stats.cadenceMs = prevAt === null ? null : ema(this.stats.cadenceMs, now - prevAt);
      prevAt = now;
      this.stats.framesReceived += 1;
      this.stats.lastFrameAt = new Date(now);
      yield { ptsMs: p.t, receivedAt: new Date(now), capturedAt: null, jpeg, width: size?.width ?? null, height: size?.height ?? null, reason: p.reason };
    }
  }
}

function nearest(map: Map<number, string>, t: number, tolerance: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [k, v] of map) {
    const d = Math.abs(k - t);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD <= tolerance ? best : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Continuous live ingest (pull from the authenticated media gateway)                          */
/* ------------------------------------------------------------------------------------------ */

export interface LiveIngestOptions {
  readUrl: string;
  intervalMs: number;
  maxEdge: number;
  /** Max frames waiting for analysis. When full, the OLDEST frame is dropped and counted. */
  queueSize: number;
  /** Optional bounded rolling buffer of the received stream (creator consent required). */
  rollingBuffer: { dir: string; segmentSeconds: number; segments: number } | null;
  /** Abort the read when no data arrives for this long. */
  ioTimeoutSec: number;
  /**
   * Full-stream recording (creator opt-in): copy-only segments for this reader run. Segment times
   * in `<runId>.csv` share the frame PTS clock, so observations map onto the recording exactly.
   */
  recording?: { dir: string; runId: string; segmentSeconds: number } | null;
  /** Hardware decoding (FFMPEG_HWACCEL). Decoded frames come back to system memory for the filters. */
  hwaccel?: HwAccel;
  hwaccelDevice?: string | null;
}

export type HwAccel = "none" | "cuda" | "vaapi" | "videotoolbox";

/**
 * ffmpeg input options for hardware decoding. Without -hwaccel_output_format, ffmpeg copies the
 * decoded frames back to system memory, so the CPU filter chain (fps first, then the downscale)
 * stays identical; only the expensive decode moves to the GPU.
 */
export function hwaccelInputArgs(mode: HwAccel | undefined, device?: string | null): string[] {
  switch (mode ?? "none") {
    case "none":
      return [];
    case "cuda":
      return device ? ["-hwaccel", "cuda", "-hwaccel_device", device] : ["-hwaccel", "cuda"];
    case "vaapi":
      return ["-hwaccel", "vaapi", "-hwaccel_device", device ?? "/dev/dri/renderD128"];
    case "videotoolbox":
      return ["-hwaccel", "videotoolbox"];
    default:
      throw new Error(`Unknown FFMPEG_HWACCEL value: ${String(mode)}`);
  }
}

/**
 * Reads the creator's authenticated ingest stream from the gateway with ffmpeg, samples frames
 * at the configured interval and emits them with their media PTS (from showinfo).
 */
export class LiveIngestAdapter implements MediaSourceAdapter {
  readonly capabilities: SourceCapabilities = { video: true, audio: true, continuous: true, seekable: false, captureTimestamps: false };
  private child: ChildProcess | null = null;
  private queue: SampledFrame[] = [];
  private waiters: ((v: IteratorResult<SampledFrame>) => void)[] = [];
  private ended = false;
  private pts: number[] = [];
  private stats: SourceHealthSnapshot = { connected: false, framesReceived: 0, framesDropped: 0, lastFrameAt: null, cadenceMs: null, error: null };
  private stderrTail = "";

  constructor(
    readonly identity: SourceIdentity,
    private readonly tools: MediaTools,
    private readonly opts: LiveIngestOptions,
    private readonly onDrop?: (count: number, atPtsMs: number | null) => void,
  ) {
    if (opts.rollingBuffer) (this.capabilities as { seekable: boolean }).seekable = true;
  }

  async authorize() {
    // Publishing was authorized by the gateway auth hook; reading uses internal worker credentials.
    return { ok: true as const };
  }

  buildArgs(): string[] {
    const o = this.opts;
    const fps = (1000 / o.intervalMs).toFixed(6);
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-rw_timeout",
      String(o.ioTimeoutSec * 1_000_000),
      ...hwaccelInputArgs(o.hwaccel, o.hwaccelDevice),
      "-i",
      o.readUrl,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      // round=up: each sample is the last frame at or before its timestamp, so the PTS names the
      // moment shown (round=near emitted the frame from half an interval later).
      `fps=${fps}:round=up,scale='min(${o.maxEdge},iw)':'min(${o.maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,showinfo`,
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-q:v",
      "4",
      "pipe:1",
    ];
    if (o.rollingBuffer) {
      args.push(
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        String(o.rollingBuffer.segmentSeconds),
        "-segment_wrap",
        String(o.rollingBuffer.segments),
        "-segment_list",
        path.join(o.rollingBuffer.dir, "segments.csv"),
        "-segment_list_type",
        "csv",
        "-reset_timestamps",
        "1",
        path.join(o.rollingBuffer.dir, "seg%04d.ts"),
      );
    }
    if (o.recording) {
      args.push(
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        String(o.recording.segmentSeconds),
        "-segment_list",
        path.join(o.recording.dir, `${o.recording.runId}.csv`),
        "-segment_list_type",
        "csv",
        "-reset_timestamps",
        "1",
        path.join(o.recording.dir, `${o.recording.runId}-%05d.ts`),
      );
    }
    return args;
  }

  async connect() {
    const child = spawn(this.tools.ffmpeg, this.buildArgs(), { stdio: ["ignore", "pipe", "pipe"], shell: false });
    this.child = child;
    this.stats.connected = true;
    const splitter = new MjpegSplitter();
    let prevAt: number | null = null;
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) {
        const pts = this.pts.shift();
        if (pts === undefined) continue; // no timestamp → do not invent one; skip frame
        const now = Date.now();
        this.stats.cadenceMs = prevAt === null ? null : ema(this.stats.cadenceMs, now - prevAt);
        prevAt = now;
        this.stats.framesReceived += 1;
        this.stats.lastFrameAt = new Date(now);
        const size = jpegSize(jpeg);
        this.enqueue({ ptsMs: pts, receivedAt: new Date(now), capturedAt: null, jpeg, width: size?.width ?? null, height: size?.height ?? null, reason: "live" });
      }
    });
    let lineBuf = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8000);
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.search(/[\r\n]/)) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.includes("showinfo") && line.includes("pts_time:")) {
          const m = /\bpts_time:([\d.]+)/.exec(line);
          if (m) this.pts.push(Math.round(Number(m[1]) * 1000));
        }
      }
    });
    child.on("close", (code) => {
      this.stats.connected = false;
      if (code !== 0 && code !== null && !this.ended) {
        const last = this.stderrTail.trim().split(/\r?\n/).slice(-2).join(" | ");
        this.stats.error = `Ingest reader exited (${code}): ${last.slice(0, 200)}`;
      }
      this.finish();
    });
    child.on("error", (err) => {
      this.stats.error = `Ingest reader failed to start: ${err.message}`;
      this.finish();
    });
  }

  private enqueue(frame: SampledFrame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
    while (this.queue.length > this.opts.queueSize) {
      const dropped = this.queue.shift();
      this.stats.framesDropped += 1;
      this.onDrop?.(1, dropped?.ptsMs ?? null);
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  async disconnect() {
    this.ended = true;
    this.child?.kill("SIGTERM");
    setTimeout(() => this.child?.kill("SIGKILL"), 3000).unref();
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  health() {
    return { ...this.stats };
  }

  frames(): AsyncIterable<SampledFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const f = this.queue.shift();
          if (f) return Promise.resolve({ value: f, done: false });
          if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<SampledFrame>>((resolve) => this.waiters.push(resolve));
        },
      }),
    };
  }
}
