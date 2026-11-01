import {
  edlLocate,
  interpolateKeys,
  segmentStartsMs,
  type EdlCaptionTrack,
  type Edl,
  type EdlGrade,
  type EdlSegment,
  type EdlText,
  type MediaRef,
  type OverlayItem,
  type OverlayTextItem,
} from "@slot1/contracts";

/**
 * The browser preview: draws one frame of the edit onto a canvas. It mirrors the server render's
 * layout, keyframes, overlays, captions and effects closely, but colour grades, transitions and
 * ducking are approximations; the editor says so next to the preview.
 */

export interface FrameSource {
  src: CanvasImageSource;
  w: number;
  h: number;
}

export interface DrawInputs {
  edl: Edl;
  /** Output-timeline time. */
  t: number;
  total: number;
  /** The current segment's picture. */
  main: FrameSource | null;
  /** A held frame for an active WASTED freeze, when one was captured. */
  frozen: FrameSource | null;
  pip: (itemId: string) => FrameSource | null;
  image: (ref: MediaRef) => FrameSource | null;
  noise: HTMLCanvasElement | null;
  /** Seed that changes every frame while playing (grain, glitch). */
  jitter: number;
}

const GOLD = "#ffc94d";
const INK = "#0b0b0e";
const IVORY = "#f5efe6";
const CORAL = "#ff4f87";
const WASTED_RED = "#e0565b";
const POSTER = '"Passion One", "Barlow Condensed", Impact, sans-serif';
const SANS = '"Inter Variable", Inter, system-ui, sans-serif';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** CSS filter approximating a grade (the render uses ffmpeg colour filters). */
export function gradeFilter(g: EdlGrade, extra = ""): string {
  const preset: Record<EdlGrade["preset"], string> = {
    none: "",
    "vice-night": "saturate(1.18) contrast(1.06) hue-rotate(-8deg) brightness(0.96)",
    "golden-hour": "sepia(0.22) saturate(1.2) brightness(1.04) contrast(1.04)",
    noir: "grayscale(1) contrast(1.28) brightness(0.96)",
    neon: "saturate(1.6) contrast(1.12)",
    bleach: "saturate(0.55) contrast(1.3) brightness(1.06)",
  };
  const manual = [
    g.brightness !== 0 ? `brightness(${(1 + g.brightness).toFixed(3)})` : "",
    g.contrast !== 1 ? `contrast(${g.contrast.toFixed(3)})` : "",
    g.saturation !== 1 ? `saturate(${g.saturation.toFixed(3)})` : "",
  ].join(" ");
  const f = `${preset[g.preset]} ${manual} ${extra}`.trim().replace(/\s+/g, " ");
  return f || "none";
}

/** Reframe (crop centre and zoom) of a segment at a source time, keyframes included. */
export function reframeAt(s: EdlSegment, sourceMs: number): { x: number; y: number; zoom: number } {
  if (s.keys.length === 0) return s.reframe;
  return { x: interpolateKeys(s.keys, sourceMs, (k) => k.x), y: interpolateKeys(s.keys, sourceMs, (k) => k.y), zoom: interpolateKeys(s.keys, sourceMs, (k) => k.zoom) };
}

/** The source rectangle for a crop of `aspect` (w/h) centred on the reframe, clamped inside. */
export function cropRect(w: number, h: number, aspect: number, r: { x: number; y: number; zoom: number }) {
  const cw = Math.min(w, h * aspect) / Math.max(1, r.zoom);
  const ch = cw / aspect;
  return { sx: clamp(r.x * w - cw / 2, 0, w - cw), sy: clamp(r.y * h - ch / 2, 0, h - ch), sw: cw, sh: ch };
}

function coverInto(ctx: CanvasRenderingContext2D, m: FrameSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
  const a = dw / dh;
  let w = sw;
  let h = sw / a;
  if (h > sh) {
    h = sh;
    w = sh * a;
  }
  ctx.drawImage(m.src, sx + (sw - w) / 2, sy + (sh - h) / 2, w, h, dx, dy, dw, dh);
}

function drawBase(ctx: CanvasRenderingContext2D, W: number, H: number, edl: Edl, seg: EdlSegment, srcMs: number, m: FrameSource, filter: string) {
  ctx.filter = filter;
  if (edl.layout === "fit") {
    const cover = Math.max(W / m.w, H / m.h);
    ctx.filter = `${filter === "none" ? "" : filter} blur(${Math.max(4, Math.round(W / 36))}px) brightness(0.8)`.trim();
    ctx.drawImage(m.src, (W - m.w * cover) / 2, (H - m.h * cover) / 2, m.w * cover, m.h * cover);
    ctx.filter = filter;
    const fit = Math.min(W / m.w, H / m.h);
    ctx.drawImage(m.src, (W - m.w * fit) / 2, (H - m.h * fit) / 2, m.w * fit, m.h * fit);
  } else if (edl.layout === "split" && edl.aspect === "9:16") {
    const camH = Math.round(H * edl.split.camShare);
    const gameH = H - camH;
    const camY = edl.split.camOnTop ? 0 : gameH;
    const gameY = edl.split.camOnTop ? camH : 0;
    const b = edl.split.cam;
    coverInto(ctx, m, b.x * m.w, b.y * m.h, b.w * m.w, b.h * m.h, 0, camY, W, camH);
    const c = cropRect(m.w, m.h, W / gameH, reframeAt(seg, srcMs));
    ctx.drawImage(m.src, c.sx, c.sy, c.sw, c.sh, 0, gameY, W, gameH);
    ctx.filter = "none";
    const u = Math.min(W, H) / 1080;
    const edge = edl.split.camOnTop ? camH : gameH;
    ctx.fillStyle = INK;
    ctx.fillRect(0, edge - 4 * u, W, 8 * u);
    ctx.fillStyle = GOLD;
    ctx.fillRect(0, edge - 1.5 * u, W, 3 * u);
  } else {
    const c = cropRect(m.w, m.h, W / H, reframeAt(seg, srcMs));
    ctx.drawImage(m.src, c.sx, c.sy, c.sw, c.sh, 0, 0, W, H);
  }
  ctx.filter = "none";
}

/* ------------------------------------------- text ------------------------------------------ */

const STYLE_SIZE: Record<string, number> = { poster: 120, banner: 84, caption: 54, mission: 150, wasted: 170, "lower-third": 76, "title-card": 140, sub: 64 };

/** Draw one line in a SLOT1 text style, centred on (0,0) (lower thirds: left edge at 0). */
function styledLine(ctx: CanvasRenderingContext2D, text: string, style: string, u: number) {
  const size = (STYLE_SIZE[style === "banner-left" ? "banner" : style] ?? 100) * u;
  const left = style === "lower-third" || style === "banner-left";
  ctx.textBaseline = "middle";
  ctx.textAlign = left ? "left" : "center";
  ctx.lineJoin = "round";
  const boxed = (bg: string, fg: string, pad: number, font: string) => {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const x = left ? 0 : -w / 2;
    ctx.fillStyle = bg;
    ctx.fillRect(x - pad, -size / 2 - pad * 0.6, w + pad * 2, size + pad * 1.2);
    ctx.fillStyle = fg;
    ctx.fillText(text, 0, size * 0.04);
  };
  const outlined = (fill: string, stroke: number, shadow?: string) => {
    ctx.font = `${Math.round(size)}px ${POSTER}`;
    if (shadow) {
      ctx.fillStyle = shadow;
      ctx.fillText(text, 7 * u, 9 * u);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = stroke * u;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
  };
  switch (style) {
    case "banner":
    case "banner-left":
      return boxed(CORAL, "#101014", 18 * u, `${Math.round(size)}px ${POSTER}`);
    case "lower-third":
      return boxed(GOLD, "#101014", 16 * u, `${Math.round(size)}px ${POSTER}`);
    case "caption":
      return boxed("rgba(0,0,0,0.6)", "#ffffff", 14 * u, `700 ${Math.round(size)}px ${SANS}`);
    case "mission":
      return outlined(GOLD, 18, "rgba(0,0,0,0.55)");
    case "wasted":
      ctx.letterSpacing = `${Math.round(6 * u)}px`;
      outlined(WASTED_RED, 18, "rgba(0,0,0,0.55)");
      ctx.letterSpacing = "0px";
      return;
    case "title-card":
      return outlined(IVORY, 16, "rgba(255,201,77,0.9)");
    case "sub":
      return outlined(IVORY, 11);
    default:
      return outlined(GOLD, 15, "rgba(0,0,0,0.5)");
  }
}

function overlayProps(it: OverlayItem, t: number) {
  if (it.keys.length === 0) return { x: it.x, y: it.y, scale: it.scale, rotation: it.rotation, opacity: it.opacity };
  return {
    x: interpolateKeys(it.keys, t, (k) => k.x),
    y: interpolateKeys(it.keys, t, (k) => k.y),
    scale: interpolateKeys(it.keys, t, (k) => k.scale),
    rotation: interpolateKeys(it.keys, t, (k) => k.rotation),
    opacity: interpolateKeys(it.keys, t, (k) => k.opacity),
  };
}

function drawTextItem(ctx: CanvasRenderingContext2D, W: number, H: number, it: OverlayTextItem, t: number, u: number) {
  const p = overlayProps(it, t);
  const local = t - it.startMs;
  const left = it.endMs - t;
  const d = it.endMs - it.startMs;
  let s = p.scale;
  let alpha = p.opacity;
  let dx = 0;
  let text = it.text;
  switch (it.animation) {
    case "fade":
      alpha *= clamp(Math.min(local / 250, left / 200), 0, 1);
      break;
    case "pop":
      s *= local < 170 ? 0.4 + 0.72 * (local / 170) : local < 290 ? 1.12 - 0.12 * ((local - 170) / 120) : 1;
      alpha *= clamp(Math.min(local / 80, left / 160), 0, 1);
      break;
    case "slide":
      dx = local < 260 ? -(1 - local / 260) ** 2 * 0.4 * W : 0;
      alpha *= clamp(Math.min(local / 120, left / 160), 0, 1);
      break;
    case "typewriter": {
      const n = Math.ceil(text.length * clamp(local / Math.min(1200, d * 0.6), 0, 1));
      text = text.slice(0, Math.max(1, n));
      break;
    }
    default:
      break;
  }
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.translate(p.x * W + dx, p.y * H);
  ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(s, s);
  styledLine(ctx, text, it.style, u);
  if (it.subtext) {
    const off = it.style === "lower-third" ? 122 * u : ((STYLE_SIZE[it.style] ?? 120) * 0.56 + 64 * 0.56 + 8) * u;
    ctx.translate(it.style === "lower-third" ? 10 * u : 0, off);
    styledLine(ctx, it.subtext, it.style === "lower-third" ? "banner-left" : "sub", u);
  }
  ctx.restore();
}

function drawLegacyText(ctx: CanvasRenderingContext2D, W: number, H: number, t: EdlText, u: number) {
  const y = t.position === "top" ? 0.12 * H : t.position === "center" ? 0.5 * H : 0.78 * H;
  ctx.save();
  ctx.translate(W / 2, y);
  styledLine(ctx, t.text, t.style === "poster" ? "poster" : t.style === "banner" ? "banner" : "caption", u * (t.style === "poster" ? 0.9 : 1));
  ctx.restore();
}

/** Caption cue words with times (spread evenly when the cue has no word timings). */
export function cueWords(c: { startMs: number; endMs: number; text: string; words: { text: string; startMs: number; endMs: number }[] }) {
  if (c.words.length) return c.words;
  const parts = c.text.split(/\s+/).filter(Boolean);
  const step = (c.endMs - c.startMs) / Math.max(1, parts.length);
  return parts.map((w, i) => ({ text: w, startMs: Math.round(c.startMs + i * step), endMs: Math.round(c.startMs + (i + 1) * step) }));
}

function drawCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, ct: EdlCaptionTrack, t: number, u: number) {
  if (ct.hidden) return;
  const cue = ct.cues.find((c) => t >= c.startMs && t < c.endMs);
  if (!cue) return;
  const words = cueWords(cue);
  const y = ct.position === "top" ? 0.14 * H : ct.position === "center" ? 0.5 * H : H - 300 * u;
  ctx.save();
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  if (ct.style === "line") {
    ctx.translate(W / 2, y);
    styledLine(ctx, cue.text, "caption", u);
    ctx.restore();
    return;
  }
  if (ct.style === "bold-pop") {
    const w = words.find((x) => t >= x.startMs && t < x.endMs) ?? words.at(-1)!;
    const local = t - w.startMs;
    const k = local < 120 ? 0.6 + 0.5 * (local / 120) : local < 220 ? 1.1 - 0.1 * ((local - 120) / 100) : 1;
    ctx.translate(W / 2, y);
    ctx.scale(k, k);
    ctx.font = `${Math.round(130 * u)}px ${POSTER}`;
    ctx.textAlign = "center";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 18 * u;
    ctx.strokeText(w.text.toUpperCase(), 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(w.text.toUpperCase(), 0, 0);
    ctx.restore();
    return;
  }
  // Karaoke: every word, the spoken ones in gold; wraps to the frame.
  ctx.font = `${Math.round(92 * u)}px ${POSTER}`;
  const space = ctx.measureText(" ").width;
  const maxW = W * 0.86;
  const lines: { w: (typeof words)[number]; width: number }[][] = [[]];
  let lineW = 0;
  for (const w of words) {
    const width = ctx.measureText(w.text).width;
    if (lineW > 0 && lineW + space + width > maxW) {
      lines.push([]);
      lineW = 0;
    }
    lines.at(-1)!.push({ w, width });
    lineW += (lineW > 0 ? space : 0) + width;
  }
  const lh = 100 * u;
  const top = y - ((lines.length - 1) * lh) / 2 - (ct.position === "bottom" ? (lines.length - 1) * lh * 0.5 : 0);
  ctx.textAlign = "left";
  lines.forEach((line, li) => {
    const total = line.reduce((n, x) => n + x.width, 0) + space * (line.length - 1);
    let x = (W - total) / 2;
    for (const { w, width } of line) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 16 * u;
      ctx.strokeText(w.text, x, top + li * lh);
      ctx.fillStyle = t >= w.startMs ? GOLD : "#ffffff";
      ctx.fillText(w.text, x, top + li * lh);
      x += width + space;
    }
  });
  ctx.restore();
}

/* ----------------------------------------- the frame --------------------------------------- */

/** Draw the edit at time `t` onto a W×H canvas. */
export function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number, d: DrawInputs) {
  const { edl, t } = d;
  const u = Math.min(W, H) / 1080;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const { index, sourceMs } = edlLocate(edl, t);
  const seg = edl.segments[index]!;
  const active = edl.effects.filter((f) => t >= f.startMs && t < f.endMs);
  const wasted = active.find((f) => f.kind === "wasted");
  const punch = active.find((f) => f.kind === "punch");
  const shake = active.find((f) => f.kind === "shake");

  // Transition into this segment (approximated: the preview has one picture at a time).
  const starts = segmentStartsMs(edl);
  const tr = index > 0 && seg.transitionIn.kind !== "cut" && seg.transitionIn.durationMs > 0 ? seg.transitionIn : null;
  const trP = tr ? (t - starts[index]!) / tr.durationMs : -1;
  const inTr = tr !== null && trP >= 0 && trP <= 1;

  const pic = wasted && d.frozen ? d.frozen : d.main;
  if (pic) {
    ctx.save();
    if (punch) {
      const z = 1.15 + punch.amount * 0.45;
      ctx.translate(W / 2, H / 2);
      ctx.scale(z, z);
      ctx.translate(-W / 2, -H / 2);
    }
    if (shake) {
      const a = (0.012 + shake.amount * 0.03) * W;
      const s = t / 1000;
      ctx.translate(W / 2, H / 2);
      ctx.scale(1.12, 1.12);
      ctx.translate(-W / 2 + a * Math.sin(2 * Math.PI * s * 11), -H / 2 + a * Math.cos(2 * Math.PI * s * 13));
    }
    if (inTr && tr!.kind === "whip") ctx.translate((1 - trP) * W * 0.25, 0);
    const extra = `${wasted ? "grayscale(1) brightness(0.94) contrast(1.18)" : ""} ${inTr && tr!.kind === "whip" ? `blur(${Math.round((1 - trP) * 14 * u + 1)}px)` : ""}`;
    drawBase(ctx, W, H, edl, seg, sourceMs, pic, gradeFilter(edl.grade, extra));
    ctx.restore();
  }

  // Look: vignette (grade + WASTED) and grain.
  const vig = Math.max(edl.grade.vignette, wasted ? 0.6 : 0);
  if (vig > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${(0.78 * vig).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (edl.grade.grain > 0 && d.noise) {
    ctx.save();
    ctx.globalAlpha = 0.12 + edl.grade.grain * 0.3;
    ctx.globalCompositeOperation = "overlay";
    const pat = ctx.createPattern(d.noise, "repeat");
    if (pat) {
      ctx.translate(((d.jitter * 97) % 128) - 64, ((d.jitter * 53) % 128) - 64);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W + 128, H + 128);
    }
    ctx.restore();
  }

  // Glitch (effect or transition): offset slices of the picture.
  const glitch = active.find((f) => f.kind === "glitch");
  if (glitch || (inTr && tr!.kind === "glitch")) {
    const amount = glitch ? glitch.amount : 1 - Math.abs(2 * trP - 1);
    const canvas = ctx.canvas;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = "lighter";
    const off = (4 + amount * 18) * u;
    ctx.drawImage(canvas, off, 0);
    ctx.restore();
    const slices = 3 + Math.floor(amount * 4);
    for (let i = 0; i < slices; i++) {
      const y = ((d.jitter * (i + 3) * 131) % 1000) / 1000;
      const h = (8 + ((d.jitter * (i + 7)) % 40)) * u;
      ctx.drawImage(canvas, 0, y * H, W, h, ((i % 2 ? 1 : -1) * off * 2), y * H, W, h);
    }
  }

  // Flashes: transitions through white/black, flash and passed effects.
  let white = 0;
  let black = 0;
  if (inTr) {
    const peak = 1 - Math.abs(2 * trP - 1);
    if (tr!.kind === "flash") white = Math.max(white, peak);
    if (tr!.kind === "dip") black = Math.max(black, peak);
    if (tr!.kind === "crossfade") black = Math.max(black, peak * 0.3);
  }
  for (const f of active) {
    const p = (t - f.startMs) / Math.max(1, f.endMs - f.startMs);
    if (f.kind === "flash") white = Math.max(white, 0.6 * (1 - p));
    if (f.kind === "passed") white = Math.max(white, 0.32 * Math.max(0, 1 - (t - f.startMs) / 350));
  }

  // Older (classic) text, then overlay tracks bottom to top.
  for (const tx of edl.texts) if (t >= tx.startMs && t < tx.endMs) drawLegacyText(ctx, W, H, tx, u);
  for (const track of edl.overlays) {
    if (track.hidden) continue;
    for (const it of track.items) {
      if (t < it.startMs || t >= it.endMs) continue;
      if (it.type === "text") {
        drawTextItem(ctx, W, H, it, t, u);
        continue;
      }
      const p = overlayProps(it, t);
      const src = it.type === "image" ? d.image(it.source) : d.pip(it.id);
      ctx.save();
      ctx.globalAlpha = clamp(p.opacity, 0, 1);
      ctx.translate(p.x * W, p.y * H);
      ctx.rotate((p.rotation * Math.PI) / 180);
      const w = it.widthPct * W * p.scale;
      if (it.type === "image") {
        if (src) {
          const h = (w * src.h) / Math.max(1, src.w);
          ctx.drawImage(src.src, -w / 2, -h / 2, w, h);
        } else {
          ctx.strokeStyle = "rgba(244,237,226,0.5)";
          ctx.setLineDash([6 * u, 6 * u]);
          ctx.lineWidth = 3 * u;
          ctx.strokeRect(-w / 2, -w / 4, w, w / 2);
        }
      } else {
        const b = it.box;
        const sw = src ? b.w * src.w : 16;
        const sh = src ? b.h * src.h : 9;
        const h = (w * sh) / Math.max(1, sw);
        if (it.border) {
          ctx.fillStyle = INK;
          ctx.fillRect(-w / 2 - 5 * u, -h / 2 - 5 * u, w + 10 * u, h + 10 * u);
        }
        if (src) ctx.drawImage(src.src, b.x * src.w, b.y * src.h, sw, sh, -w / 2, -h / 2, w, h);
        else {
          ctx.fillStyle = "#1c1c23";
          ctx.fillRect(-w / 2, -h / 2, w, h);
        }
      }
      ctx.restore();
    }
  }

  // Effect banners.
  for (const f of active) {
    if (f.kind !== "wasted" && f.kind !== "passed") continue;
    const local = t - f.startMs;
    const k = local < 220 ? 1.35 - 0.35 * (local / 220) : 1;
    ctx.save();
    ctx.globalAlpha = clamp(local / 160, 0, 1);
    ctx.translate(W / 2, H * (f.kind === "wasted" ? 0.46 : 0.42));
    ctx.scale(k, k);
    styledLine(ctx, f.text || (f.kind === "wasted" ? "WASTED" : "MISSION PASSED"), f.kind === "wasted" ? "wasted" : "mission", u);
    ctx.restore();
  }

  drawCaptions(ctx, W, H, edl.captionTrack, t, u);

  if (white > 0) {
    ctx.fillStyle = `rgba(255,255,255,${clamp(white, 0, 1).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  // Fades to and from black.
  const fade = edl.fadeInMs > 0 && t < edl.fadeInMs ? 1 - t / edl.fadeInMs : edl.fadeOutMs > 0 && t > d.total - edl.fadeOutMs ? (t - (d.total - edl.fadeOutMs)) / edl.fadeOutMs : 0;
  black = Math.max(black, fade);
  if (black > 0) {
    ctx.fillStyle = `rgba(0,0,0,${clamp(black, 0, 1).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

/** A small tile of random grey for film grain. */
export function makeNoise(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(Math.random() * 255);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  return c;
}
