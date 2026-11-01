import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASPECT_SIZE,
  edlDurationMs,
  edlOutputTime,
  interpolateKeys,
  outputSize,
  segmentOutputMs,
  segmentPieces,
  segmentStartsMs,
  transitionOverlapMs,
  type CaptionCue,
  type Edl,
  type EdlAspect,
  type EdlEffect,
  type EdlSegment,
  type EdlText,
  type ExportFormat,
  type MediaRef,
  type OverlayItem,
  type OverlayKey,
  type OverlayTextItem,
  type OverlayTrack,
  type TransitionKind,
  type VolumeKey,
} from "@slot1/contracts";

/** One resolved segment source: a local file plus where the segment's in-point sits in it. */
export interface EdlSegmentMedia {
  path: string;
  /** Subtract from the segment's inMs/outMs to get file time (e.g. an assembled window). */
  offsetMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** A library item or upload the edit references, resolved to a file the worker can read. */
export interface ResolvedRef {
  path: string;
  /** image: a still (png, jpg, webp). video: an animated visual (gif, webm, mov, mp4). audio: a sound. */
  kind: "image" | "video" | "audio";
  durationMs?: number | null;
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

export interface RenderOutputOptions {
  /** Export preset's shape; defaults to the edit's own aspect. */
  aspect?: EdlAspect;
  height?: 720 | 1080;
  fps?: 24 | 30 | 60;
  quality?: "high" | "standard" | "small";
  /** Upper bound for the video bitrate (platform preset). */
  maxrateKbps?: number;
  format?: ExportFormat;
}

export interface RenderPlan {
  args: string[];
  durationMs: number;
  width: number;
  height: number;
  /** Text files (drawtext) and subtitle scripts (ASS) to write before running. */
  textFiles: { path: string; content: string }[];
  /** mp4, gif or m4a. */
  container: "mp4" | "gif" | "m4a";
}

/** Even sizes (yuv420p needs them), at least 2 px. */
const evenSize = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
/** Even offsets, never negative (an offset of 0 must stay 0). */
const evenOffset = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);
const num = (n: number) => String(Math.round(n * 10_000) / 10_000);

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
  parts.push(`atempo=${num(s)}`);
  return `,${parts.join(",")}`;
}

/**
 * A piecewise-linear ffmpeg expression of `t` (seconds) through keyframes [seconds, value],
 * clamped at both ends. Keys must be sorted by time.
 */
export function keyExpr(keys: readonly (readonly [number, number])[]): string {
  if (keys.length === 0) return "0";
  if (keys.length === 1 || keys.every((k) => k[1] === keys[0]![1])) return num(keys[0]![1]);
  let expr = num(keys.at(-1)![1]);
  for (let i = keys.length - 1; i >= 1; i--) {
    const [t0, v0] = keys[i - 1]!;
    const [t1, v1] = keys[i]!;
    const seg = t1 <= t0 ? num(v1) : `${num(v0)}+(${num(v1 - v0)})*(t-${num(t0)})/${num(t1 - t0)}`;
    expr = `if(lt(t,${num(t1)}),${seg},${expr})`;
  }
  return `if(lt(t,${num(keys[0]![0])}),${num(keys[0]![1])},${expr})`;
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

/* ------------------------------------------------------------------------------------------ */
/* ASS subtitles: animated text, titles, lower thirds, effect banners and captions            */
/* ------------------------------------------------------------------------------------------ */

/** ASS colour from 0xRRGGBB and an opacity (ASS stores alpha inverted, as &HAABBGGRR). */
function assColor(rgb: number, opacity = 1): string {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const a = Math.round((1 - opacity) * 255);
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `&H${h(a)}${h(b)}${h(g)}${h(r)}`;
}
const assAlpha = (opacity: number) => `&H${Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255).toString(16).toUpperCase().padStart(2, "0")}&`;

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Text as ASS dialogue: no override blocks, no escapes, one line. */
export function assText(text: string): string {
  return text.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

const GOLD = 0xffc94d;
const INK = 0x0b0b0e;
const IVORY = 0xf5efe6;
const CORAL = 0xff4f87;
const WASTED_RED = 0xe0565b;

/** Font size of each overlay text style at 1080p (see assStyles). */
const TEXT_SIZE: Record<string, number> = { poster: 120, banner: 84, caption: 54, mission: 150, wasted: 170, "lower-third": 76, "title-card": 140 };

/** Styles in output pixels, sized from the frame height so 720p and 1080p look the same. */
function assStyles(W: number, H: number): string[] {
  const u = Math.min(W, H) / 1080;
  const fs = (n: number) => Math.round(n * u);
  const row = (name: string, font: string, size: number, primary: string, secondary: string, outline: string, back: string, bold: 0 | -1, spacing: number, borderStyle: 1 | 3, outlineW: number, shadow: number, align: number, mv: number) =>
    `Style: ${name},${font},${size},${primary},${secondary},${outline},${back},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineW},${shadow},${align},${fs(60)},${fs(60)},${mv},1`;
  return [
    row("poster", "Passion One", fs(120), assColor(GOLD), assColor(GOLD), assColor(INK), assColor(0, 0.55), 0, 1, 1, fs(8), fs(6), 5, 0),
    row("banner", "Passion One", fs(84), assColor(0x101014), assColor(0x101014), assColor(CORAL), assColor(CORAL), 0, 1, 3, fs(18), 0, 5, 0),
    row("caption", "DejaVu Sans", fs(54), assColor(0xffffff), assColor(0xffffff), assColor(0, 0.4), assColor(0, 0.4), -1, 0, 3, fs(14), 0, 5, 0),
    row("mission", "Passion One", fs(150), assColor(GOLD), assColor(GOLD), assColor(INK), assColor(0, 0.6), 0, 2, 1, fs(10), fs(8), 5, 0),
    row("wasted", "Passion One", fs(170), assColor(WASTED_RED), assColor(WASTED_RED), assColor(INK), assColor(0, 0.6), 0, 6, 1, fs(10), fs(8), 5, 0),
    row("lower-third", "Passion One", fs(76), assColor(0x101014), assColor(0x101014), assColor(GOLD), assColor(GOLD), 0, 1, 3, fs(16), 0, 4, 0),
    row("title-card", "Passion One", fs(140), assColor(IVORY), assColor(IVORY), assColor(INK), assColor(GOLD, 0.9), 0, 1, 1, fs(9), fs(10), 5, 0),
    row("sub", "Passion One", fs(64), assColor(IVORY), assColor(IVORY), assColor(INK), assColor(0, 0.5), 0, 2, 1, fs(6), fs(4), 5, 0),
    row("cap-karaoke", "Passion One", fs(92), assColor(GOLD), assColor(0xffffff), assColor(INK), assColor(0, 0.5), 0, 1, 1, fs(8), fs(4), 2, fs(300)),
    row("cap-line", "DejaVu Sans", fs(54), assColor(0xffffff), assColor(0xffffff), assColor(0, 0.45), assColor(0, 0.45), -1, 0, 3, fs(14), 0, 2, fs(300)),
    row("cap-pop", "Passion One", fs(130), assColor(0xffffff), assColor(0xffffff), assColor(INK), assColor(0, 0.5), 0, 1, 1, fs(10), fs(6), 5, 0),
  ];
}

function assHeader(W: number, H: number): string {
  return [
    "[Script Info]",
    "; Generated by SLOT1 from an edit decision list",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...assStyles(W, H),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

const dialogue = (layer: number, start: number, end: number, style: string, text: string) => `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;

/** One overlay text item as ASS events: position, keyframes, the arrival animation, sub-line. */
function textItemEvents(it: OverlayTextItem, W: number, H: number, layer: number): string[] {
  const out: string[] = [];
  const style = it.style;
  const text = assText(it.text);
  const sub = assText(it.subtext);
  const px = (x: number) => Math.round(x * W);
  const py = (y: number) => Math.round(y * H);
  const keys = [...it.keys].sort((a, b) => a.atMs - b.atMs);
  const base = { x: it.x, y: it.y, scale: it.scale, rotation: it.rotation, opacity: it.opacity };
  const at = (t: number) =>
    keys.length === 0
      ? base
      : {
          x: interpolateKeys(keys, t, (k) => k.x),
          y: interpolateKeys(keys, t, (k) => k.y),
          scale: interpolateKeys(keys, t, (k) => k.scale),
          rotation: interpolateKeys(keys, t, (k) => k.rotation),
          opacity: interpolateKeys(keys, t, (k) => k.opacity),
        };
  const look = (v: ReturnType<typeof at>) => `\\fscx${Math.round(v.scale * 100)}\\fscy${Math.round(v.scale * 100)}\\frz${num(-v.rotation)}\\alpha${assAlpha(v.opacity)}`;
  const alignTag = style === "lower-third" ? "\\an4" : "\\an5";
  const intro = (v: ReturnType<typeof at>, d: number): string => {
    switch (it.animation) {
      case "fade":
        return `\\fad(${Math.min(250, d / 3) | 0},${Math.min(200, d / 3) | 0})`;
      case "pop": {
        const s = Math.round(v.scale * 100);
        return `\\fscx${Math.round(s * 0.4)}\\fscy${Math.round(s * 0.4)}\\t(0,170,\\fscx${Math.round(s * 1.12)}\\fscy${Math.round(s * 1.12)})\\t(170,290,\\fscx${s}\\fscy${s})\\fad(80,160)`;
      }
      default:
        return "\\fad(0,120)";
    }
  };
  // Time slices: before the first key, between keys, after the last key.
  const cuts = [it.startMs, ...keys.map((k) => k.atMs).filter((t) => t > it.startMs && t < it.endMs), it.endMs];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (b - a < 20) continue;
    const va = at(a);
    const vb = at(b);
    const first = i === 0;
    const moving = va.x !== vb.x || va.y !== vb.y;
    let pos = moving ? `\\move(${px(va.x)},${py(va.y)},${px(vb.x)},${py(vb.y)})` : `\\pos(${px(va.x)},${py(va.y)})`;
    if (first && it.animation === "slide" && !moving) pos = `\\move(${px(Math.max(-0.4, va.x - 0.45))},${py(va.y)},${px(va.x)},${py(va.y)},0,320)`;
    const change = va.scale !== vb.scale || va.rotation !== vb.rotation || va.opacity !== vb.opacity ? `\\t(${look(vb)})` : "";
    const head = `{${alignTag}${pos}${look(va)}${first ? intro(va, b - a) : ""}${change}}`;
    if (first && it.animation === "typewriter" && text.length > 1) {
      // Typewriter: the text grows one character at a time, then stays.
      const step = Math.max(25, Math.min(70, Math.floor(700 / text.length)));
      for (let k = 1; k <= text.length; k++) {
        const s0 = a + (k - 1) * step;
        if (s0 >= b) break;
        const s1 = k === text.length ? b : Math.min(b, s0 + step);
        out.push(dialogue(layer, s0, s1, style, `{${alignTag}${pos}${look(va)}${change && k === text.length ? change : ""}}${text.slice(0, k)}`));
      }
    } else {
      out.push(dialogue(layer, a, b, style, `${head}${text}`));
    }
    if (sub) {
      const subStyle = style === "lower-third" ? "banner" : "sub";
      // Below the main line: half of each line's height plus a small gap, in style units.
      const u = Math.min(W, H) / 1080;
      const offset = style === "lower-third" ? Math.round(u * 122 * va.scale) : Math.round(u * ((TEXT_SIZE[style] ?? 120) * 0.56 + 64 * 0.56 + 8) * va.scale);
      const sx = px(va.x) + (style === "lower-third" ? Math.round(W * 0.01) : 0);
      out.push(dialogue(layer, a, b, subStyle, `{${alignTag}\\pos(${sx},${py(va.y) + offset})\\alpha${assAlpha(va.opacity)}${first ? "\\fad(200,120)" : ""}}${sub}`));
    }
  }
  return out;
}

/** Banners that belong to effects (WASTED, MISSION PASSED). */
function effectEvents(f: EdlEffect, W: number, H: number): string[] {
  const cx = Math.round(W / 2);
  const cy = Math.round(H * 0.45);
  if (f.kind === "wasted") {
    const t = assText(f.text || "WASTED");
    return [dialogue(30, f.startMs + 250, f.endMs, "wasted", `{\\an5\\pos(${cx},${cy})\\fad(350,150)\\fscx115\\fscy115\\t(0,600,\\fscx100\\fscy100)}${t}`)];
  }
  if (f.kind === "passed") {
    const t = assText(f.text || "MISSION PASSED");
    return [dialogue(30, f.startMs, f.endMs, "mission", `{\\an5\\pos(${cx},${cy})\\fscx40\\fscy40\\t(0,160,\\fscx112\\fscy112)\\t(160,300,\\fscx100\\fscy100)\\fad(60,220)}${t}`)];
  }
  return [];
}

/** Caption cues as ASS: karaoke word highlight, plain lines, or big words that pop in one by one. */
function captionEvents(cues: readonly CaptionCue[], style: Edl["captionTrack"]["style"], position: Edl["captionTrack"]["position"], W: number, H: number): string[] {
  const out: string[] = [];
  const y = position === "top" ? Math.round(H * 0.16) : position === "center" ? Math.round(H * 0.5) : Math.round(H * 0.78);
  const pos = `\\an5\\pos(${Math.round(W / 2)},${y})`;
  for (const c of cues) {
    const words = wordsOf(c);
    if (style === "line") {
      out.push(dialogue(40, c.startMs, c.endMs, "cap-line", `{${pos}}${assText(c.text)}`));
    } else if (style === "bold-pop") {
      for (const w of words) out.push(dialogue(40, w.startMs, Math.max(w.endMs, w.startMs + 120), "cap-pop", `{${pos}\\fscx60\\fscy60\\t(0,120,\\fscx108\\fscy108)\\t(120,200,\\fscx100\\fscy100)}${assText(w.text)}`));
    } else {
      let cursor = c.startMs;
      const parts = words.map((w) => {
        const lead = Math.max(0, w.startMs - cursor);
        const dur = Math.max(1, w.endMs - Math.max(w.startMs, cursor));
        cursor = Math.max(cursor, w.endMs);
        return `{\\k${Math.round(lead / 10)}}{\\k${Math.round(dur / 10)}}${assText(w.text)} `;
      });
      out.push(dialogue(40, c.startMs, c.endMs, "cap-karaoke", `{${pos}}${parts.join("").trim()}`));
    }
  }
  return out;
}

/** Word timings for a cue: given ones, or the cue's time spread over its words by length. */
export function wordsOf(c: Pick<CaptionCue, "text" | "startMs" | "endMs" | "words">): { text: string; startMs: number; endMs: number }[] {
  if (c.words.length > 0) return c.words.map((w) => ({ text: w.text, startMs: Math.max(c.startMs, w.startMs), endMs: Math.min(c.endMs, w.endMs) }));
  const words = c.text.split(/\s+/).filter(Boolean);
  const weight = words.reduce((n, w) => n + w.length + 1, 0);
  let t = c.startMs;
  return words.map((w) => {
    const d = ((c.endMs - c.startMs) * (w.length + 1)) / Math.max(1, weight);
    const word = { text: w, startMs: Math.round(t), endMs: Math.round(t + d) };
    t += d;
    return word;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Looks: grades and effects                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Original grade presets (no LUT files): curves, colour balance and eq. */
function gradeFilters(g: Edl["grade"]): string[] {
  const f: string[] = [];
  switch (g.preset) {
    case "vice-night":
      f.push("colorbalance=rs=0.08:gs=-0.04:bs=0.14:rm=0.06:bm=0.08:rh=0.04:bh=0.02", "eq=saturation=1.18:contrast=1.06");
      break;
    case "golden-hour":
      f.push("colorbalance=rs=0.10:gs=0.03:bs=-0.08:rm=0.10:gm=0.02:bm=-0.10:rh=0.06:bh=-0.06", "eq=saturation=1.12:gamma=1.04");
      break;
    case "noir":
      f.push("hue=s=0", "eq=contrast=1.35:brightness=-0.03", "curves=preset=increase_contrast");
      break;
    case "neon":
      f.push("eq=saturation=1.5:contrast=1.12", "colorbalance=bs=0.06:rh=0.05");
      break;
    case "bleach":
      f.push("eq=saturation=0.55:contrast=1.3:brightness=0.03");
      break;
    default:
      break;
  }
  if (g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1) f.push(`eq=brightness=${num(g.brightness)}:contrast=${num(g.contrast)}:saturation=${num(g.saturation)}`);
  if (g.vignette > 0) f.push(`vignette=angle=${num(0.25 + g.vignette * 0.75)}`);
  // Temporal grain is expensive to encode; it stays subtle and the bitrate is capped.
  if (g.grain > 0) f.push(`noise=alls=${Math.round(2 + g.grain * 12)}:allf=t`);
  return f;
}

/* ------------------------------------------------------------------------------------------ */
/* The render                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const XFADE: Record<Exclude<TransitionKind, "cut">, string> = {
  crossfade: "fade",
  flash: "fadewhite",
  dip: "fadeblack",
  whip: "smoothleft",
  glitch: "pixelize",
};

/** Ref key for `refs`: one per library item or upload. */
export const refKey = (r: MediaRef) => `${r.kind}:${r.assetId}`;

/** Library items, uploads and picture-in-picture sources an edit needs resolved before rendering. */
export function edlMediaNeeds(edl: Edl): { refs: MediaRef[]; pips: { itemId: string; sessionId: string }[] } {
  const refs = new Map<string, MediaRef>();
  const pips: { itemId: string; sessionId: string }[] = [];
  for (const t of edl.overlays) {
    if (t.hidden) continue;
    for (const it of t.items) {
      if (it.type === "image") refs.set(refKey(it.source), it.source);
      if (it.type === "pip") pips.push({ itemId: it.id, sessionId: it.sessionId });
    }
  }
  for (const t of edl.audioTracks) for (const c of t.clips) refs.set(refKey(c.source), c.source);
  return { refs: [...refs.values()], pips };
}

function soloActive(edl: Edl): boolean {
  return edl.sourceAudio.solo || edl.audioTracks.some((t) => t.solo);
}

/** Does this edit use anything beyond the original single-track format? */
function usesMultiTrack(edl: Edl): boolean {
  return (
    edl.layout === "split" ||
    edl.segments.some((s, i) => (s.rampTo !== null && s.rampTo !== s.speed) || s.keys.length > 0 || s.volume !== 1 || (i > 0 && s.transitionIn.kind !== "cut")) ||
    edl.grade.preset !== "none" ||
    edl.grade.brightness !== 0 ||
    edl.grade.contrast !== 1 ||
    edl.grade.saturation !== 1 ||
    edl.grade.vignette > 0 ||
    edl.grade.grain > 0 ||
    edl.effects.length > 0 ||
    edl.overlays.some((t) => !t.hidden && t.items.length > 0) ||
    (!edl.captionTrack.hidden && edl.captionTrack.cues.length > 0) ||
    edl.audioTracks.some((t) => t.clips.length > 0) ||
    edl.sourceAudio.muted ||
    edl.sourceAudio.solo ||
    edl.sourceAudio.denoise ||
    edl.sourceAudio.voiceBoost ||
    edl.sourceAudio.envelope.length > 0 ||
    edl.normalize
  );
}

/** Segment-local output time (ms) of a source time inside the segment. */
function localOutMs(s: EdlSegment, sourceMs: number): number {
  return edlOutputTime({ segments: [s] }, 0, sourceMs);
}

/**
 * Build one ffmpeg invocation for an edit decision list: the main track (accurate seeks,
 * reframing, speed and ramps, transitions), the look (grade, effects), overlay tracks (images,
 * picture-in-picture, animated text), captions, and the audio mix (source audio processing,
 * music and sound-effect tracks with ducking, loudness). Pure function: no I/O, unit-tested.
 * Edits that use only the original single-track fields produce exactly the original command.
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
  options?: RenderOutputOptions;
  /** Resolved library items and uploads, keyed by refKey(). */
  refs?: Record<string, ResolvedRef>;
  /** Resolved stored media for picture-in-picture items, keyed by overlay item id. */
  pips?: Record<string, EdlSegmentMedia>;
  /** Folder with the OFL render fonts, for animated text (ASS). */
  fontsDir?: string | null;
}): RenderPlan {
  const { edl, media } = input;
  if (media.length !== edl.segments.length) throw new Error("Every segment needs a resolved media source");
  const opts = input.options ?? {};
  const aspect = opts.aspect ?? edl.aspect;
  const { width: W, height: H } = opts.aspect || opts.height ? outputSize(aspect, opts.height ?? 1080) : ASPECT_SIZE[edl.aspect];
  const fps = opts.fps ?? input.fps ?? 30;
  const format: ExportFormat = opts.format ?? "mp4";
  const total = edlDurationMs(edl);
  const multi = usesMultiTrack(edl);
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];
  const textFiles: RenderPlan["textFiles"] = [];
  const wantVideo = format !== "audio";
  const split = edl.layout === "split" && aspect === "9:16";
  const layout = edl.layout === "split" && !split ? "crop" : edl.layout;
  let inputIndex = 0;

  /* -------------------------------- main track: per segment -------------------------------- */

  edl.segments.forEach((s, i) => {
    const m = media[i]!;
    const start = Math.max(0, s.inMs - m.offsetMs);
    const dur = s.outMs - s.inMs;
    // Stored media is read in place: a local path (fs storage) or a short-lived signed URL (S3).
    const remote = /^https?:\/\//.test(m.path);
    args.push("-protocol_whitelist", remote ? "file,http,https,tcp,tls,crypto" : "file", "-ss", sec(start), "-t", sec(dur), "-i", m.path);
    inputIndex++;
    const outDur = segmentOutputMs(s);
    const pieces = segmentPieces(s);
    const ramp = pieces.length > 1;

    if (wantVideo) {
      // Speed: one constant speed, or a ramp played as short constant-speed steps.
      let pre: string;
      if (!ramp) {
        pre = `[${i}:v]setpts=PTS-STARTPTS${s.speed === 1 ? "" : `,setpts=PTS/${num(s.speed)}`}`;
      } else {
        const names = pieces.map((_, k) => `[r${i}_${k}]`);
        filters.push(`[${i}:v]setpts=PTS-STARTPTS,split=${pieces.length}${names.join("")}`);
        pieces.forEach((p, k) => filters.push(`[r${i}_${k}]trim=start=${sec(p.inMs - s.inMs)}:end=${sec(p.outMs - s.inMs)},setpts=(PTS-STARTPTS)/${num(p.speed)}[q${i}_${k}]`));
        filters.push(`${pieces.map((_, k) => `[q${i}_${k}]`).join("")}concat=n=${pieces.length}:v=1:a=0[sp${i}]`);
        pre = `[sp${i}]null`;
      }
      const tail = `setsar=1,fps=${fps},format=yuv420p,trim=duration=${sec(outDur)}[v${i}]`;
      const target = { width: W, height: split ? H - evenSize(H * edl.split.camShare) : H };
      const reframe = (label: string, out: string, tw: number, th: number) => {
        // Static crop, or keyframed pan and zoom (t = seconds into this segment's output).
        if (s.keys.length === 0) {
          const c = cropFor({ width: m.width, height: m.height }, { width: tw, height: th }, s.reframe);
          filters.push(`${label}crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${tw}:${th}:flags=lanczos${out}`);
          return;
        }
        const keys = [...s.keys].sort((a, b) => a.atMs - b.atMs);
        const kt = (pick: (k: (typeof keys)[number]) => number) => keys.map((k) => [localOutMs(s, k.atMs) / 1000, pick(k)] as const);
        const base = cropFor({ width: m.width, height: m.height }, { width: tw, height: th }, { x: 0.5, y: 0.5, zoom: 1 });
        const zoomVaries = keys.some((k) => k.zoom !== keys[0]!.zoom);
        const X = keyExpr(kt((k) => k.x));
        const Y = keyExpr(kt((k) => k.y));
        if (zoomVaries) {
          const Z = keyExpr(kt((k) => k.zoom));
          filters.push(
            `${label}scale=w='2*trunc(${m.width}*(${Z})/2)':h='2*trunc(${m.height}*(${Z})/2)':eval=frame,` +
              `crop=${base.w}:${base.h}:x='clip((${X})*${m.width}*(${Z})-${base.w / 2},0,${m.width}*(${Z})-${base.w})':y='clip((${Y})*${m.height}*(${Z})-${base.h / 2},0,${m.height}*(${Z})-${base.h})',` +
              `scale=${tw}:${th}:flags=lanczos${out}`,
          );
        } else {
          const c = cropFor({ width: m.width, height: m.height }, { width: tw, height: th }, { x: 0.5, y: 0.5, zoom: keys[0]!.zoom });
          filters.push(`${label}crop=${c.w}:${c.h}:x='clip((${X})*${m.width}-${c.w / 2},0,${m.width - c.w})':y='clip((${Y})*${m.height}-${c.h / 2},0,${m.height - c.h})',scale=${tw}:${th}:flags=lanczos${out}`);
        }
      };

      if (layout === "fit") {
        filters.push(
          `${pre},split=2[bg${i}][fg${i}]`,
          `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12[bgb${i}]`,
          `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${i}]`,
          `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,${tail}`,
        );
      } else if (split) {
        const camH = evenSize(H * edl.split.camShare);
        const gameH = H - camH;
        const b = edl.split.cam;
        const cx = evenOffset(b.x * m.width);
        const cy = evenOffset(b.y * m.height);
        const cw = Math.min(evenSize(b.w * m.width), evenSize(m.width - cx));
        const ch = Math.min(evenSize(b.h * m.height), evenSize(m.height - cy));
        filters.push(`${pre},split=2[cam${i}][game${i}]`);
        filters.push(`[cam${i}]crop=${cw}:${ch}:${cx}:${cy},scale=${W}:${camH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${camH}[camS${i}]`);
        reframe(`[game${i}]`, `[gameS${i}]`, W, gameH);
        const sepY = edl.split.camOnTop ? camH : gameH;
        filters.push(
          `${edl.split.camOnTop ? `[camS${i}][gameS${i}]` : `[gameS${i}][camS${i}]`}vstack=inputs=2,` +
            `drawbox=x=0:y=${Math.max(0, sepY - 4)}:w=${W}:h=8:color=0x0B0B0E:t=fill,drawbox=x=0:y=${Math.max(0, sepY - 1)}:w=${W}:h=3:color=0xFFC94D:t=fill,${tail}`,
        );
      } else if (s.keys.length === 0 && !ramp) {
        const c = cropFor({ width: m.width, height: m.height }, { width: W, height: H }, s.reframe);
        filters.push(`${pre},crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos,${tail}`);
      } else {
        filters.push(`${pre}[pre${i}]`);
        reframe(`[pre${i}]`, `[rf${i}]`, W, H);
        filters.push(`[rf${i}]${tail}`);
      }
    }

    // Audio: same speed changes, this segment's volume, then exactly the segment's length.
    const vol = s.volume === 1 ? "" : `,volume=${num(s.volume)}`;
    if (m.hasAudio) {
      if (!ramp) {
        filters.push(`[${i}:a]asetpts=PTS-STARTPTS${atempo(s.speed)}${vol},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${sec(outDur)}[a${i}]`);
      } else {
        const names = pieces.map((_, k) => `[ra${i}_${k}]`);
        filters.push(`[${i}:a]asetpts=PTS-STARTPTS,asplit=${pieces.length}${names.join("")}`);
        pieces.forEach((p, k) => filters.push(`[ra${i}_${k}]atrim=start=${sec(p.inMs - s.inMs)}:end=${sec(p.outMs - s.inMs)},asetpts=PTS-STARTPTS${atempo(p.speed)}[qa${i}_${k}]`));
        filters.push(`${pieces.map((_, k) => `[qa${i}_${k}]`).join("")}concat=n=${pieces.length}:v=0:a=1${vol},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${sec(outDur)}[a${i}]`);
      }
    } else {
      filters.push(`aevalsrc=0|0:c=stereo:s=48000:d=${sec(outDur)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  });

  /* -------------------------------- join the main track ------------------------------------ */

  const n = edl.segments.length;
  const transitions = edl.segments.some((s, i) => i > 0 && s.transitionIn.kind !== "cut");
  if (!transitions) {
    if (wantVideo) filters.push(`${edl.segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vcat][acat]`);
    else filters.push(`${edl.segments.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1[acat]`);
  } else {
    // Join pairwise: concat for cuts, xfade/acrossfade where a transition overlaps two segments.
    let accV = "[v0]";
    let accA = "[a0]";
    let accMs = segmentOutputMs(edl.segments[0]!);
    for (let i = 1; i < n; i++) {
      const s = edl.segments[i]!;
      const d = transitionOverlapMs(edl.segments, i);
      const nv = i === n - 1 ? "[vcat]" : `[j${i}]`;
      const na = i === n - 1 ? "[acat]" : `[ja${i}]`;
      if (d === 0) {
        if (wantVideo) filters.push(`${accV}${accA}[v${i}][a${i}]concat=n=2:v=1:a=1[jc${i}]${na}`, `[jc${i}]settb=1/${fps}${nv}`);
        else filters.push(`${accA}[a${i}]concat=n=2:v=0:a=1${na}`);
      } else {
        if (wantVideo) filters.push(`${accV}[v${i}]xfade=transition=${XFADE[s.transitionIn.kind as Exclude<TransitionKind, "cut">]}:duration=${sec(d)}:offset=${sec(accMs - d)}${nv}`);
        filters.push(`${accA}[a${i}]acrossfade=d=${sec(d)}:c1=tri:c2=tri${na}`);
      }
      accV = nv;
      accA = na;
      accMs += segmentOutputMs(s) - d;
    }
  }

  /* -------------------------------- inputs for overlays and audio -------------------------- */

  const refs = input.refs ?? {};
  const need = (r: MediaRef): ResolvedRef => {
    const v = refs[refKey(r)];
    if (!v) throw new Error(r.kind === "library" ? `Unknown Studio library item: ${r.assetId}` : "An uploaded file this edit uses is missing");
    return v;
  };

  /* -------------------------------- video finishing ---------------------------------------- */

  let assIndex = 0;
  const assFile = (events: string[]): string => {
    const file = path.join(input.workDir, `overlay-${assIndex++}.ass`);
    textFiles.push({ path: file, content: `${assHeader(W, H)}\n${events.join("\n")}\n` });
    const fontsdir = input.fontsDir ? `:fontsdir='${input.fontsDir}'` : "";
    return `ass='${file}'${fontsdir}`;
  };

  if (wantVideo) {
    const video: string[] = [];
    let label = "[vcat]";
    let step = 0;
    const next = () => `[vf${step++}]`;
    const chain = (f: string) => {
      const out = next();
      filters.push(`${label}${f}${out}`);
      label = out;
    };

    // Look: grade, then effects in order.
    const grade = gradeFilters(edl.grade);
    if (grade.length) chain(grade.join(","));
    const banners: string[] = [];
    for (const f of edl.effects) {
      const a = f.startMs / 1000;
      const b = Math.min(f.endMs, total) / 1000;
      const win = `enable='between(t,${num(a)},${num(b)})'`;
      switch (f.kind) {
        case "wasted": {
          const first = Math.round(a * fps);
          const last = Math.max(first, Math.round(b * fps) - 1);
          // Freeze: repeat the window's first frame over the window, in one linear chain. (A
          // split into freezeframes stalls ffmpeg 6 when other inputs are still being read.)
          // loop's `start` counts from 1 here: start=first+1 repeats frame `first`.
          const n = last - first + 1;
          if (n > 1) chain(`loop=loop=${n - 1}:size=1:start=${first + 1},select='lt(n,${last + 1})+gte(n,${last + n})',setpts=N/(${fps}*TB)`);
          chain(`hue=s=0:${win},eq=brightness=-0.06:contrast=1.18:${win},vignette=angle=0.95:${win}`);
          banners.push(...effectEvents(f, W, H));
          break;
        }
        case "passed":
          chain(`eq=brightness='0.32*max(0,1-(t-${num(a)})/0.35)':eval=frame:enable='between(t,${num(a)},${num(Math.min(b, a + 0.35))})'`);
          banners.push(...effectEvents(f, W, H));
          break;
        case "flash":
          chain(`eq=brightness='0.6*max(0,1-(t-${num(a)})/${num(Math.max(0.05, b - a))})':eval=frame:${win}`);
          break;
        case "glitch": {
          const px = Math.round((4 + f.amount * 18) * (W / 1080));
          chain(`rgbashift=rh=-${px}:bh=${px}:${win},noise=alls=18:allf=t:${win}`);
          break;
        }
        case "punch": {
          const z = 1.15 + f.amount * 0.45;
          const cw = evenSize(W / z);
          const ch = evenSize(H / z);
          const i = step;
          filters.push(`${label}split=2[pa${i}][pb${i}]`, `[pb${i}]crop=${cw}:${ch}:${evenOffset((W - cw) / 2)}:${evenOffset((H - ch) / 2)},scale=${W}:${H}:flags=lanczos[pz${i}]`);
          const out = next();
          filters.push(`[pa${i}][pz${i}]overlay=0:0:${win}${out}`);
          label = out;
          break;
        }
        case "shake": {
          const amp = Math.round((6 + f.amount * 30) * (W / 1080));
          const i = step;
          const bw = evenSize(W * 1.12);
          const bh = evenSize(H * 1.12);
          filters.push(
            `${label}split=2[sa${i}][sb${i}]`,
            `[sb${i}]scale=${bw}:${bh},crop=${W}:${H}:x='(iw-${W})/2+${amp}*sin(2*PI*t*11)':y='(ih-${H})/2+${amp}*cos(2*PI*t*13)'[sz${i}]`,
          );
          const out = next();
          filters.push(`[sa${i}][sz${i}]overlay=0:0:${win}${out}`);
          label = out;
          break;
        }
      }
    }

    // Legacy single-track text and transcript captions (drawtext), unchanged.
    const draw = (text: string, style: EdlText["style"], position: EdlText["position"], fromMs: number, toMs: number) => {
      const file = path.join(input.workDir, `text-${textFiles.filter((f) => f.path.endsWith(".txt")).length}.txt`);
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
    // Old single-track edits keep their text in the final filter, exactly as before.
    if (multi && video.length) {
      chain(video.join(","));
      video.length = 0;
    }

    // Overlay tracks, bottom to top: pictures (images, picture-in-picture), then the track's text.
    edl.overlays.forEach((track: OverlayTrack, ti) => {
      if (track.hidden) return;
      for (const it of track.items) {
        if (it.type === "text") continue;
        const startS = it.startMs / 1000;
        const endS = Math.min(it.endMs, total) / 1000;
        const durS = Math.max(0.05, endS - startS);
        const ix = inputIndex++;
        let src: string;
        if (it.type === "image") {
          const r = need(it.source);
          if (r.kind === "image") args.push("-loop", "1", "-framerate", String(fps), "-t", num(durS), "-i", r.path);
          else args.push("-stream_loop", "-1", "-t", num(durS), "-i", r.path);
          src = `[${ix}:v]`;
        } else {
          const pm = input.pips?.[it.id];
          if (!pm) throw new Error("A picture-in-picture source is no longer stored");
          const remote = /^https?:\/\//.test(pm.path);
          args.push("-protocol_whitelist", remote ? "file,http,https,tcp,tls,crypto" : "file", "-ss", sec(Math.max(0, it.sourceInMs - pm.offsetMs)), "-t", num(durS), "-i", pm.path);
          const b = it.box;
          const cx = evenOffset(b.x * pm.width);
          const cy = evenOffset(b.y * pm.height);
          const cw = Math.min(evenSize(b.w * pm.width), evenSize(pm.width - cx));
          const ch = Math.min(evenSize(b.h * pm.height), evenSize(pm.height - cy));
          const border = it.border ? `,pad=iw+${Math.round(10 * (W / 1080))}:ih+${Math.round(10 * (W / 1080))}:(ow-iw)/2:(oh-ih)/2:color=0x0B0B0E` : "";
          filters.push(`[${ix}:v]crop=${cw}:${ch}:${cx}:${cy}${border}[pipc${ix}]`);
          src = `[pipc${ix}]`;
        }
        const keys = [...it.keys].sort((a, b) => a.atMs - b.atMs) as OverlayKey[];
        const kt = (pick: (k: OverlayKey) => number) => keys.map((k) => [k.atMs / 1000, pick(k)] as const);
        const widthPx = Math.max(8, evenSize(W * it.widthPct * it.scale));
        const scaleVaries = keys.length > 1 && keys.some((k) => k.scale !== keys[0]!.scale);
        const S = keys.length ? keyExpr(kt((k) => k.scale)) : num(it.scale);
        const rot = keys.length ? keyExpr(kt((k) => k.rotation)) : num(it.rotation);
        const op = keys.length ? keyExpr(kt((k) => k.opacity)) : num(it.opacity);
        const X = keys.length ? keyExpr(kt((k) => k.x)) : num(it.x);
        const Y = keys.length ? keyExpr(kt((k) => k.y)) : num(it.y);
        const rotates = rot !== "0";
        const fadesOpacity = op !== "1";
        const prep = [
          `setpts=PTS-STARTPTS+${num(startS)}/TB`,
          "format=rgba",
          scaleVaries ? `scale=w='max(8,2*trunc(${num(W * it.widthPct)}*(${S})/2))':h=-2:eval=frame:flags=lanczos` : `scale=${keys.length ? Math.max(8, evenSize(W * it.widthPct * keys[0]!.scale)) : widthPx}:-2:flags=lanczos`,
          ...(rotates ? [`rotate=a='(${rot})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none`] : []),
          ...(fadesOpacity ? [keys.length ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${op.replace(/\bt\b/g, "T")})'` : `colorchannelmixer=aa=${op}`] : []),
        ];
        filters.push(`${src}${prep.join(",")}[ov${ix}]`);
        const out = next();
        filters.push(`${label}[ov${ix}]overlay=x='(${X})*W-w/2':y='(${Y})*H-h/2':eval=frame:enable='between(t,${num(startS)},${num(endS)})'${out}`);
        label = out;
      }
      const texts = track.items.filter((it): it is OverlayTextItem => it.type === "text");
      if (texts.length) chain(assFile(texts.flatMap((it) => textItemEvents(it, W, H, ti * 2))));
    });

    // Effect banners and the caption track, on top of everything.
    const capEvents = !edl.captionTrack.hidden ? captionEvents(edl.captionTrack.cues, edl.captionTrack.style, edl.captionTrack.position, W, H) : [];
    if (banners.length || capEvents.length) chain(assFile([...banners, ...capEvents]));

    if (edl.fadeInMs > 0) video.push(`fade=t=in:st=0:d=${sec(edl.fadeInMs)}`);
    if (edl.fadeOutMs > 0) video.push(`fade=t=out:st=${sec(Math.max(0, total - edl.fadeOutMs))}:d=${sec(edl.fadeOutMs)}`);
    if (label === "[vcat]") filters.push(`[vcat]${video.length ? video.join(",") : "null"}[vout]`);
    else filters.push(`${label}${video.length ? video.join(",") : "null"}[vout]`);
  }

  /* -------------------------------- audio mix ---------------------------------------------- */

  const fades: string[] = [];
  if (edl.fadeInMs > 0) fades.push(`afade=t=in:st=0:d=${sec(edl.fadeInMs)}`);
  if (edl.fadeOutMs > 0) fades.push(`afade=t=out:st=${sec(Math.max(0, total - edl.fadeOutMs))}:d=${sec(edl.fadeOutMs)}`);
  if (!multi) {
    filters.push(`[acat]${[`volume=${edl.volume}`, ...fades].join(",")}[aout]`);
  } else {
    const solo = soloActive(edl);
    const sa = edl.sourceAudio;
    const srcAudible = !sa.muted && (!solo || sa.solo);
    const envExpr = (keys: readonly VolumeKey[]) => keyExpr([...keys].sort((a, b) => a.atMs - b.atMs).map((k) => [k.atMs / 1000, k.volume] as const));
    const srcChain = [`volume=${edl.volume}`];
    if (sa.envelope.length) srcChain.push(`volume='${envExpr(sa.envelope)}':eval=frame`);
    if (sa.denoise) srcChain.push("afftdn=nf=-28");
    if (sa.voiceBoost) srcChain.push("highpass=f=90,equalizer=f=2800:t=q:w=1.2:g=5,acompressor=threshold=0.1:ratio=3:attack=10:release=180:makeup=2");
    const ducking = edl.audioTracks.some((t) => t.duck && t.clips.length > 0 && !t.muted && (!solo || t.solo));
    filters.push(`[acat]${srcChain.join(",")}${ducking ? ",asplit=2[srcmix][srcsc0]" : "[srcmix]"}`);
    if (ducking) filters.push("[srcsc0]highpass=f=300,lowpass=f=3400[srcsc]");
    const mix: string[] = [];
    if (srcAudible) mix.push("[srcmix]");
    else filters.push("[srcmix]anullsink");
    let scUsed = 0;
    const duckers = edl.audioTracks.filter((t) => t.duck && t.clips.length > 0 && !t.muted && (!solo || t.solo)).length;
    if (ducking && duckers > 1) {
      filters.push(`[srcsc]asplit=${duckers}${Array.from({ length: duckers }, (_, k) => `[sc${k}]`).join("")}`);
    }
    edl.audioTracks.forEach((t, ti) => {
      if (t.muted || (solo && !t.solo) || t.clips.length === 0) return;
      const clipLabels: string[] = [];
      t.clips.forEach((c, ci) => {
        if (c.startMs >= total) return;
        const r = need(c.source);
        const ix = inputIndex++;
        const dur = Math.min(c.durationMs, total - c.startMs);
        // A looping input is limited too: an endless input would keep ffmpeg reading forever.
        if (c.loop) args.push("-stream_loop", "-1", "-t", sec(c.offsetMs + dur), "-i", r.path);
        else args.push("-ss", sec(c.offsetMs), "-t", sec(dur), "-i", r.path);
        const parts = [
          ...(c.loop ? [`atrim=start=${sec(c.offsetMs)}:duration=${sec(dur)}`] : []),
          "asetpts=PTS-STARTPTS",
          "aresample=48000",
          "aformat=sample_fmts=fltp:channel_layouts=stereo",
          ...(c.fadeInMs > 0 ? [`afade=t=in:st=0:d=${sec(Math.min(c.fadeInMs, dur))}`] : []),
          ...(c.fadeOutMs > 0 ? [`afade=t=out:st=${sec(Math.max(0, dur - c.fadeOutMs))}:d=${sec(Math.min(c.fadeOutMs, dur))}`] : []),
          ...(c.volume !== 1 ? [`volume=${num(c.volume)}`] : []),
          `adelay=${Math.round(c.startMs)}:all=1`,
          ...(c.envelope.length ? [`volume='${envExpr(c.envelope)}':eval=frame`] : []),
        ];
        filters.push(`[${ix}:a]${parts.join(",")}[c${ti}_${ci}]`);
        clipLabels.push(`[c${ti}_${ci}]`);
      });
      if (!clipLabels.length) return;
      const trackOut = `[tr${ti}]`;
      const vol = `volume=${num(t.volume)}`;
      const mixed = clipLabels.length > 1 ? `${clipLabels.join("")}amix=inputs=${clipLabels.length}:normalize=0:duration=longest,${vol}` : `${clipLabels[0]}${vol}`;
      if (t.duck && ducking) {
        const sc = duckers > 1 ? `[sc${scUsed++}]` : "[srcsc]";
        filters.push(`${mixed}[trp${ti}]`, `[trp${ti}]${sc}sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350${trackOut}`);
      } else {
        filters.push(`${mixed}${trackOut}`);
      }
      mix.push(trackOut);
    });
    if (mix.length === 0) {
      mix.push("[sil]");
      filters.push(`aevalsrc=0|0:c=stereo:s=48000:d=${sec(total)}[sil]`);
    }
    const master = [
      `apad`,
      `atrim=duration=${sec(total)}`,
      ...fades,
      ...(edl.normalize ? ["loudnorm=I=-14:TP=-1.5:LRA=11", "aresample=48000"] : []),
      ...(mix.length > 1 ? ["alimiter=limit=0.97"] : []),
    ];
    filters.push(`${mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=first,` : mix[0]}${master.join(",")}[aout]`);
  }

  /* -------------------------------- encode ------------------------------------------------- */

  const tail = ["-progress", "pipe:1", "-nostats", input.output];
  if (format === "audio") {
    args.push("-filter_complex", filters.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", sec(total), ...tail);
    return { args, durationMs: total, width: 0, height: 0, textFiles, container: "m4a" };
  }
  if (format === "gif") {
    const gifFps = Math.min(fps, 15);
    const gw = evenSize(Math.min(W, H >= W ? 480 : 640));
    filters.push(`[vout]fps=${gifFps},scale=${gw}:-2:flags=lanczos,split=2[g1][g2]`, `[g1]palettegen=max_colors=128:stats_mode=diff[gpal]`, `[g2][gpal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[gif]`);
    filters.push(`[aout]anullsink`);
    args.push("-filter_complex", filters.join(";"), "-map", "[gif]", "-loop", "0", "-t", sec(total), ...tail);
    return { args, durationMs: total, width: gw, height: Math.round((gw * H) / W / 2) * 2, textFiles, container: "gif" };
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]");
  const crf = opts.quality === "small" ? "27" : opts.quality === "standard" ? "23" : "20";
  if (input.encoder === "h264_nvenc") args.push("-c:v", "h264_nvenc", "-preset", "p4", "-cq", String(Number(crf) + 1), "-b:v", "0");
  else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-profile:v", "high");
  // Multi-track edits (grain, effects) get a bitrate ceiling even without a platform preset.
  const maxrate = opts.maxrateKbps ?? (multi ? 12_000 : null);
  if (maxrate) args.push("-maxrate", `${maxrate}k`, "-bufsize", `${maxrate * 2}k`);
  args.push("-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", opts.quality === "high" || !opts.quality ? "160k" : "128k", "-ar", "48000", "-movflags", "+faststart", "-t", sec(total));
  args.push(...tail);
  return { args, durationMs: total, width: W, height: H, textFiles, container: "mp4" };
}

/**
 * A 1280×720 thumbnail from one source frame: fill and crop to 16:9, then big styled text
 * (ASS, so the same fonts and looks as the edit). Pure; the caller extracts the frame first.
 */
export function buildThumbnailRender(input: {
  frame: string;
  output: string;
  workDir: string;
  fontsDir: string | null;
  text: string;
  subtext: string;
  style: "poster" | "mission" | "wasted" | "title-card" | "banner";
  position: "top" | "center" | "bottom";
  grade?: Edl["grade"];
}): { args: string[]; textFiles: { path: string; content: string }[] } {
  const W = 1280;
  const H = 720;
  const y = input.position === "top" ? 0.22 : input.position === "center" ? 0.48 : 0.74;
  const events: string[] = [];
  const item: OverlayTextItem = {
    type: "text",
    id: "thumb",
    startMs: 0,
    endMs: 10_000,
    x: 0.5,
    y,
    scale: input.style === "banner" ? 1.1 : 1.25,
    rotation: 0,
    opacity: 1,
    keys: [],
    text: input.text,
    subtext: input.subtext,
    style: input.style,
    animation: "none",
  };
  events.push(...textItemEvents(item, W, H, 0).map((l) => l.replace("\\fad(0,120)", "")));
  const file = path.join(input.workDir, "thumbnail.ass");
  const fontsdir = input.fontsDir ? `:fontsdir='${input.fontsDir}'` : "";
  const grade = input.grade ? gradeFilters(input.grade) : [];
  const vf = [`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${W}:${H}`, ...grade, `ass='${file}'${fontsdir}`].join(",");
  return {
    args: ["-hide_banner", "-nostdin", "-y", "-i", input.frame, "-vf", vf, "-frames:v", "1", input.output],
    textFiles: [{ path: file, content: `${assHeader(W, H)}\n${events.join("\n")}\n` }],
  };
}

/** Audio of an edit only (for transcription): same cuts and speeds, mono 16 kHz. */
export function buildEdlAudioRender(input: { edl: Edl; media: EdlSegmentMedia[]; output: string; workDir: string }): { args: string[]; durationMs: number } {
  const plan = buildEdlRender({ edl: { ...input.edl, audioTracks: [], normalize: false, effects: [], overlays: [] }, media: input.media, output: input.output, workDir: input.workDir, fonts: { poster: null, caption: null }, options: { format: "audio" } });
  const args = plan.args.slice(0, plan.args.indexOf("-c:a"));
  args.push("-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-t", sec(plan.durationMs), input.output);
  return { args, durationMs: plan.durationMs };
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

function fontDirs(): string[] {
  return [process.env.SLOT1_RENDER_FONTS_DIR, path.resolve(here, "fonts"), path.resolve(here, "../fonts")].filter((d): d is string => Boolean(d));
}

/** Passion One (SIL OFL 1.1) converted losslessly from the web app's WOFF2 by scripts/build-render-fonts.py. */
export function findRenderFonts(): RenderFonts {
  const dirs = fontDirs();
  const pick = (name: string) => dirs.map((d) => path.join(d, name)).find((f) => existsSync(f)) ?? null;
  const system = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"].find((f) => existsSync(f)) ?? null;
  return { poster: pick("PassionOne-Black.ttf") ?? system, caption: system ?? pick("PassionOne-Bold.ttf") };
}

/** The folder holding the OFL render fonts (for libass `fontsdir`), or null. */
export function findRenderFontsDir(): string | null {
  return fontDirs().find((d) => existsSync(path.join(d, "PassionOne-Black.ttf"))) ?? null;
}

/** Overlay text item helper for tests and previews. */
export function overlayTextEvents(it: OverlayItem, W: number, H: number): string[] {
  return it.type === "text" ? textItemEvents(it, W, H, 0) : [];
}

/** Starts of each segment in the finished edit (ms, rounded): used by previews and tests. */
export function segmentStartsRounded(edl: Edl): number[] {
  return segmentStartsMs(edl).map((t) => Math.round(t));
}
