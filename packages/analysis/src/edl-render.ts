import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASPECT_SIZE, edlDurationMs, edlOutputTime, type Edl, type EdlText } from "@slot1/contracts";

/** One resolved segment source: a local file plus where the segment's in-point sits in it. */
export interface EdlSegmentMedia {
  path: string;
  /** Subtract from the segment's inMs/outMs to get file time (e.g. an assembled window). */
  offsetMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface CaptionLine {
  segmentIndex: number;
  /** Source-media times of the transcript line. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface RenderFonts {
  poster: string | null;
  caption: string | null;
}

export interface RenderPlan {
  args: string[];
  durationMs: number;
  width: number;
  height: number;
  /** drawtext reads text from files (no escaping pitfalls); write these before running. */
  textFiles: { path: string; content: string }[];
}

/** Even sizes (yuv420p needs them), at least 2 px. */
const evenSize = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
/** Even offsets, never negative (an offset of 0 must stay 0). */
const evenOffset = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Largest crop of the target aspect inside the source, zoomed and centred on the reframe point. */
export function cropFor(src: { width: number; height: number }, target: { width: number; height: number }, r: { x: number; y: number; zoom: number }) {
  const aspect = target.width / target.height;
  const full = Math.min(src.width, src.height * aspect);
  const w = Math.min(evenSize(full / r.zoom), evenSize(src.width));
  const h = Math.min(evenSize(full / aspect / r.zoom), evenSize(src.height));
  const x = evenOffset(Math.min(Math.max(r.x * src.width - w / 2, 0), src.width - w));
  const y = evenOffset(Math.min(Math.max(r.y * src.height - h / 2, 0), src.height - h));
  return { w, h, x, y };
}

/** atempo accepts 0.5–100 per instance in current ffmpeg; chain for anything outside. */
function atempo(speed: number): string {
  if (speed === 1) return "";
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s}`);
  return `,${parts.join(",")}`;
}

function textStyle(style: EdlText["style"], H: number, fonts: RenderFonts): string {
  const poster = fonts.poster ?? fonts.caption;
  switch (style) {
    case "poster": {
      const size = Math.round(H * 0.07);
      return `fontfile='${poster}':fontsize=${size}:fontcolor=0xFFC94D:borderw=${Math.max(2, Math.round(size * 0.07))}:bordercolor=0x0B0B0E:shadowx=0:shadowy=${Math.round(size * 0.06)}:shadowcolor=0x000000@0.55`;
    }
    case "banner": {
      const size = Math.round(H * 0.05);
      return `fontfile='${poster}':fontsize=${size}:fontcolor=0x101014:box=1:boxcolor=0xFF4F87@0.96:boxborderw=${Math.round(size * 0.35)}`;
    }
    case "caption": {
      const size = Math.round(H * 0.035);
      return `fontfile='${fonts.caption ?? poster}':fontsize=${size}:fontcolor=white:box=1:boxcolor=0x000000@0.6:boxborderw=${Math.round(size * 0.4)}`;
    }
  }
}

function textY(position: EdlText["position"], H: number): string {
  if (position === "top") return `${Math.round(H * 0.09)}`;
  if (position === "center") return "(h-text_h)/2";
  return `${Math.round(H * 0.8)}-text_h`;
}

/**
 * Build one ffmpeg invocation for an edit decision list: per-segment accurate seeks, reframing
 * to the output aspect (crop or fit-over-blur), speed changes with matching audio, concat,
 * burned-in text and captions, fades and volume. Pure function: no I/O, unit-tested.
 */
export function buildEdlRender(input: {
  edl: Edl;
  media: EdlSegmentMedia[];
  output: string;
  workDir: string;
  fonts: RenderFonts;
  captions?: CaptionLine[];
  encoder?: "libx264" | "h264_nvenc";
  fps?: number;
}): RenderPlan {
  const { edl, media } = input;
  if (media.length !== edl.segments.length) throw new Error("Every segment needs a resolved media source");
  const { width: W, height: H } = ASPECT_SIZE[edl.aspect];
  const fps = input.fps ?? 30;
  const total = edlDurationMs(edl);
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];
  const textFiles: RenderPlan["textFiles"] = [];

  edl.segments.forEach((s, i) => {
    const m = media[i]!;
    const start = Math.max(0, s.inMs - m.offsetMs);
    const dur = s.outMs - s.inMs;
    // Stored media is read in place: a local path (fs storage) or a short-lived signed URL (S3).
    const remote = /^https?:\/\//.test(m.path);
    args.push("-protocol_whitelist", remote ? "file,http,https,tcp,tls,crypto" : "file", "-ss", sec(start), "-t", sec(dur), "-i", m.path);
    const outDur = dur / s.speed;
    const speed = s.speed === 1 ? "" : `,setpts=PTS/${s.speed}`;
    if (edl.layout === "fit") {
      filters.push(
        `[${i}:v]setpts=PTS-STARTPTS${speed},split=2[bg${i}][fg${i}]`,
        `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12[bgb${i}]`,
        `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${i}]`,
        `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps},format=yuv420p,trim=duration=${sec(outDur)}[v${i}]`,
      );
    } else {
      const c = cropFor({ width: m.width, height: m.height }, { width: W, height: H }, s.reframe);
      filters.push(`[${i}:v]setpts=PTS-STARTPTS${speed},crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p,trim=duration=${sec(outDur)}[v${i}]`);
    }
    if (m.hasAudio) {
      filters.push(`[${i}:a]asetpts=PTS-STARTPTS${atempo(s.speed)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${sec(outDur)}[a${i}]`);
    } else {
      filters.push(`aevalsrc=0|0:c=stereo:s=48000:d=${sec(outDur)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  });

  const n = edl.segments.length;
  filters.push(`${edl.segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vcat][acat]`);

  // Video finishing: text overlays, captions, fades.
  const video: string[] = [];
  const draw = (text: string, style: EdlText["style"], position: EdlText["position"], fromMs: number, toMs: number) => {
    const file = path.join(input.workDir, `text-${textFiles.length}.txt`);
    textFiles.push({ path: file, content: text });
    video.push(
      `drawtext=textfile='${file}':expansion=none:${textStyle(style, H, input.fonts)}:x=(w-text_w)/2:y=${textY(position, H)}:enable='between(t,${sec(fromMs)},${sec(Math.min(toMs, total))})'`,
    );
  };
  if (input.fonts.poster || input.fonts.caption) {
    for (const t of edl.texts) draw(t.text, t.style, t.position, t.startMs, t.endMs);
    if (edl.captions) {
      for (const c of input.captions ?? []) {
        const seg = edl.segments[c.segmentIndex];
        if (!seg || c.endMs <= seg.inMs || c.startMs >= seg.outMs) continue;
        draw(c.text.slice(0, 120), "caption", "bottom", edlOutputTime(edl, c.segmentIndex, c.startMs), edlOutputTime(edl, c.segmentIndex, c.endMs));
      }
    }
  }
  if (edl.fadeInMs > 0) video.push(`fade=t=in:st=0:d=${sec(edl.fadeInMs)}`);
  if (edl.fadeOutMs > 0) video.push(`fade=t=out:st=${sec(Math.max(0, total - edl.fadeOutMs))}:d=${sec(edl.fadeOutMs)}`);
  filters.push(`[vcat]${video.length ? video.join(",") : "null"}[vout]`);

  const audio: string[] = [`volume=${edl.volume}`];
  if (edl.fadeInMs > 0) audio.push(`afade=t=in:st=0:d=${sec(edl.fadeInMs)}`);
  if (edl.fadeOutMs > 0) audio.push(`afade=t=out:st=${sec(Math.max(0, total - edl.fadeOutMs))}:d=${sec(edl.fadeOutMs)}`);
  filters.push(`[acat]${audio.join(",")}[aout]`);

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");
  if (input.encoder === "h264_nvenc") args.push("-c:v", "h264_nvenc", "-preset", "p4", "-cq", "21", "-b:v", "0");
  else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high");
  args.push("-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-t", sec(total));
  args.push("-progress", "pipe:1", "-nostats", input.output);
  return { args, durationMs: total, width: W, height: H, textFiles };
}

/** Run an ffmpeg command built with `-progress pipe:1`, reporting 0..1 as it encodes. */
export function runWithProgress(ffmpeg: string, args: string[], totalMs: number, onProgress: (p: number) => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let tail = "";
    let last = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (!m) continue;
        const p = Math.min(0.99, Number(m[1]) / 1000 / Math.max(1, totalMs));
        if (p - last >= 0.02) {
          last = p;
          onProgress(p);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (tail = (tail + c).slice(-4000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg render failed (${code ?? signal}): ${tail.trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 300)}`));
    });
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Fonts for burned-in text (OFL only; never Pricedown)                                       */
/* ------------------------------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Passion One (SIL OFL 1.1) converted losslessly from the web app's WOFF2 by scripts/build-render-fonts.py. */
export function findRenderFonts(): RenderFonts {
  const dirs = [process.env.SLOT1_RENDER_FONTS_DIR, path.resolve(here, "fonts"), path.resolve(here, "../fonts")].filter((d): d is string => Boolean(d));
  const pick = (name: string) => dirs.map((d) => path.join(d, name)).find((f) => existsSync(f)) ?? null;
  const system = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"].find((f) => existsSync(f)) ?? null;
  return { poster: pick("PassionOne-Black.ttf") ?? system, caption: system ?? pick("PassionOne-Bold.ttf") };
}
