/**
 * Geometry for SLOT1's original artwork: a golden-hour bay city drawn like a game loading
 * screen (heavy outlines, flat cel shading, halftone). Original shapes only: no third-party or
 * game assets, logos or likenesses. Deterministic (seeded) so server and client renders match.
 *
 * Coordinates are in the artwork's own space: 1600 × 800, ground line at y = 600.
 */
export const VB = { w: 1600, h: 800, ground: 600 } as const;

export const INK = "#140715";

export const SUN = { cx: 912, cy: 522, r: 150 } as const;

/** The hill with the SLOT1 letters, and where the letters stand. */
export const SIGN_LETTERS = ["S", "L", "O", "T", "1"] as const;
export const SIGN_X0 = 1086;
export const SIGN_STEP = 54;
/** The letters stand along a contour of the hill face, below the ridge. */
export const signBase = (x: number) => 432 - (x - 1086) * 0.09;

/** The elevated freeway's deck top, sloping slightly up to the right. */
export const FREEWAY = { x0: -20, y0: 664, x1: 1620, y1: 632 } as const;
export const freewayY = (x: number) => FREEWAY.y0 + ((x - FREEWAY.x0) * (FREEWAY.y1 - FREEWAY.y0)) / (FREEWAY.x1 - FREEWAY.x0);
export const FREEWAY_ANGLE = (Math.atan2(FREEWAY.y1 - FREEWAY.y0, FREEWAY.x1 - FREEWAY.x0) * 180) / Math.PI;

/** Percent helpers for positioning HTML effects over the artwork. */
export const px = (x: number) => `${((x / VB.w) * 100).toFixed(3)}%`;
export const py = (y: number) => `${((y / VB.h) * 100).toFixed(3)}%`;

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A puffy cel-shaded cloud: flat bottom, semicircle bumps across the top. */
export function cloudPath(x: number, y: number, w: number, chords: number[]): string {
  const total = chords.reduce((a, b) => a + b, 0);
  let d = `M${x} ${y}`;
  let cx = x;
  const base = y - w * 0.07;
  d += `L${x} ${r1(base)}`;
  for (const c of chords) {
    const chord = (c / total) * w;
    const r = chord / 2;
    cx += chord;
    d += `A${r1(r)} ${r1(r)} 0 0 1 ${r1(cx)} ${r1(base)}`;
  }
  d += `L${r1(x + w)} ${y}Z`;
  return d;
}

export type Kind = "flat" | "step" | "dome" | "spire" | "moderne";

export interface Building {
  x: number;
  w: number;
  top: number;
  kind: Kind;
  mast?: number;
  /** Which two-tone pair (face + sunlit edge) the building uses. */
  tone: 0 | 1 | 2;
}

/** The city, left of the sun; the left part stays low so the copy can sit over it. */
export const CITY: Building[] = [
  { x: -12, w: 118, top: 486, kind: "moderne", tone: 1 },
  { x: 102, w: 80, top: 452, kind: "step", tone: 0 },
  { x: 178, w: 66, top: 500, kind: "flat", tone: 2 },
  { x: 240, w: 104, top: 470, kind: "moderne", tone: 1 },
  { x: 340, w: 58, top: 426, kind: "spire", mast: 30, tone: 0 },
  { x: 394, w: 92, top: 478, kind: "flat", tone: 2 },
  { x: 482, w: 74, top: 410, kind: "step", mast: 26, tone: 0 },
  { x: 552, w: 112, top: 446, kind: "dome", mast: 14, tone: 1 },
  { x: 660, w: 56, top: 362, kind: "spire", mast: 44, tone: 0 },
  { x: 712, w: 82, top: 452, kind: "step", tone: 2 },
  { x: 790, w: 66, top: 506, kind: "flat", tone: 1 },
  { x: 852, w: 84, top: 534, kind: "moderne", tone: 2 },
];

export const TONES = [
  { face: "#2b1338", rim: "#ff9a52" },
  { face: "#351741", rim: "#ffb067" },
  { face: "#24102f", rim: "#ff8a4c" },
] as const;

export function buildingPath(b: Building): string {
  const { x, w, top } = b;
  const r = x + w;
  const g = VB.ground;
  const cx = x + w / 2;
  switch (b.kind) {
    case "step": {
      const t2 = w * 0.72;
      const t3 = w * 0.44;
      const m = b.mast ? `V${top - 44 - b.mast}H${r1(cx + 1.6)}V${top - 44}` : "";
      return `M${x} ${g}V${top}H${r1(cx - t2 / 2)}V${top - 22}H${r1(cx - t3 / 2)}V${top - 44}H${r1(cx - 1.6)}${m}H${r1(cx + t3 / 2)}V${top - 22}H${r1(cx + t2 / 2)}V${top}H${r}V${g}Z`;
    }
    case "dome": {
      const rr = w / 2 - 8;
      const m = b.mast ? `V${top - rr - b.mast}H${r1(cx + 1.4)}V${r1(top - rr)}` : "";
      return `M${x} ${g}V${top}H${x + 8}A${r1(rr)} ${r1(rr)} 0 0 1 ${r1(cx - 1.4)} ${r1(top - rr)}${m}A${r1(rr)} ${r1(rr)} 0 0 1 ${r - 8} ${top}H${r}V${g}Z`;
    }
    case "spire": {
      const m = b.mast ?? 30;
      return `M${x} ${g}V${top}L${r1(cx - 4)} ${top - 30}V${top - 30 - m}H${r1(cx + 4)}V${top - 30}L${r} ${top}V${g}Z`;
    }
    case "moderne": {
      const rr = 22;
      return `M${x} ${g}V${top}H${r - rr}A${rr} ${rr} 0 0 1 ${r} ${top + rr}V${g}Z`;
    }
    default:
      return `M${x} ${g}V${top}H${r}V${g}Z`;
  }
}

/** Windows catching the sunset: short vertical runs, as one path per building. */
export function windowsPath(b: Building, seed: number): string {
  const rand = rng(seed);
  const g = VB.ground;
  let d = "";
  const startY = b.top + (b.kind === "dome" ? 10 : 12);
  for (let x = b.x + 9; x < b.x + b.w - 12; x += 13) {
    if (rand() < 0.35) continue;
    for (let y = startY; y < g - 14; y += 15) {
      if (rand() < 0.58) d += `M${r1(x)} ${r1(y)}h5v8h-5z`;
    }
  }
  return d;
}
