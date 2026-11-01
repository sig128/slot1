/**
 * Geometry for SLOT1's original skyline artwork ("a Vice City broadcast station after dark").
 * Everything is drawn from these numbers: no third-party or game assets. Deterministic (seeded),
 * so server and client renders match exactly.
 *
 * Coordinates are in the artwork's own space: 1600 × 640, horizon at y = 470.
 */
export const VB = { w: 1600, h: 640, horizon: 470 } as const;

/** Where the station's transmitter stands (on the hill, right of downtown). Lights spread from here. */
export const MAST = { x: 1252, base: 352, top: 258 } as const;

/** The rooftop "ON AIR" sign SLOT1 "reads" in the intro. */
export const SIGN = { x: 720, y: 296, w: 84, h: 24 } as const;

export const WHEEL = { cx: 1466, cy: 390, r: 70 } as const;

/** Causeway deck (light trails travel along its top edge). */
export const CAUSEWAY_Y = 554;

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

type Shape = "flat" | "parapet" | "step" | "dome" | "zig" | "spire" | "moderneL" | "moderneR";

export interface Building {
  x: number;
  w: number;
  top: number;
  shape: Shape;
  /** Height of a spire/antenna above the crown, if any. */
  mast?: number;
  /** Share of windows lit (0–1). */
  lit: number;
  /** Horizontal ledges (moderne "eyebrows"). */
  ledges?: boolean;
  /** A vertical neon fin or strip. */
  neon?: { x: number; y1: number; y2: number; color: "coral" | "apricot" | "gold" };
  /** Neon along the setbacks (the focal tower). */
  outline?: boolean;
}

/** The city, left to right. Low beachfront on the left (under the copy), downtown right of center. */
export const CITY: Building[] = [
  { x: 14, w: 150, top: 402, shape: "moderneR", lit: 0.5, ledges: true, neon: { x: 92, y1: 362, y2: 414, color: "apricot" } },
  { x: 170, w: 96, top: 420, shape: "parapet", lit: 0.42 },
  { x: 272, w: 124, top: 394, shape: "step", lit: 0.46, ledges: true },
  { x: 402, w: 78, top: 414, shape: "flat", lit: 0.38 },
  { x: 486, w: 128, top: 388, shape: "moderneL", lit: 0.5, ledges: true, neon: { x: 538, y1: 350, y2: 400, color: "gold" } },
  { x: 620, w: 70, top: 408, shape: "parapet", lit: 0.4 },
  // SLOT1's station building, with the ON AIR sign on the roof.
  { x: 698, w: 128, top: 330, shape: "flat", lit: 0.6, ledges: true },
  { x: 834, w: 66, top: 282, shape: "parapet", lit: 0.44 },
  { x: 906, w: 92, top: 226, shape: "dome", mast: 18, lit: 0.46, neon: { x: 952, y1: 248, y2: 450, color: "coral" } },
  // The focal tower: deco setbacks outlined in neon, a long spire.
  { x: 1004, w: 88, top: 172, shape: "step", mast: 66, lit: 0.5, outline: true },
  { x: 1098, w: 62, top: 236, shape: "zig", mast: 30, lit: 0.44 },
  { x: 1166, w: 74, top: 294, shape: "parapet", lit: 0.4 },
  { x: 1272, w: 38, top: 304, shape: "spire", mast: 22, lit: 0.36 },
  { x: 1316, w: 106, top: 382, shape: "moderneL", lit: 0.46, ledges: true, neon: { x: 1352, y1: 344, y2: 396, color: "gold" } },
  { x: 1428, w: 56, top: 412, shape: "flat", lit: 0.32 },
  { x: 1494, w: 110, top: 400, shape: "parapet", lit: 0.4, ledges: true },
];

/** Silhouette path of one building, from the horizon up. */
export function buildingPath(b: Building): string {
  const { x, w, top } = b;
  const r = x + w;
  const base = VB.horizon;
  const cx = x + w / 2;
  switch (b.shape) {
    case "parapet": {
      const pw = w * 0.36;
      return `M${x} ${base}V${top}H${r1(cx - pw / 2)}V${top - 10}H${r1(cx + pw / 2)}V${top}H${r}V${base}Z`;
    }
    case "step": {
      // Art-deco setbacks: three tiers and an optional spire.
      const t2 = w * 0.74;
      const t3 = w * 0.48;
      const h1 = 26;
      const h2 = 22;
      const s = b.mast ? `V${top - h1 - h2 - 10}H${r1(cx - 1.5)}V${top - h1 - h2 - 10 - b.mast}H${r1(cx + 1.5)}V${top - h1 - h2 - 10}` : "";
      return [
        `M${x} ${base}V${top}`,
        `H${r1(cx - t2 / 2)}V${top - h1}`,
        `H${r1(cx - t3 / 2)}V${top - h1 - h2}`,
        `H${r1(cx - 4)}${s}`,
        `H${r1(cx + 4)}V${top - h1 - h2}`,
        `H${r1(cx + t3 / 2)}V${top - h1}`,
        `H${r1(cx + t2 / 2)}V${top}H${r}V${base}Z`,
      ].join("");
    }
    case "dome": {
      const rr = w / 2 - 6;
      const m = b.mast ? `V${top - rr - b.mast}H${r1(cx + 1.2)}V${top - rr}` : "";
      return `M${x} ${base}V${top}H${x + 6}A${r1(rr)} ${r1(rr)} 0 0 1 ${r1(cx - 1.2)} ${r1(top - rr)}${m ? m : ""}A${r1(rr)} ${r1(rr)} 0 0 1 ${r - 6} ${top}H${r}V${base}Z`;
    }
    case "zig": {
      const st = 9;
      const m = b.mast ? `V${top - st * 3 - b.mast}H${r1(cx + 1.2)}V${top - st * 3}` : "";
      return [
        `M${x} ${base}V${top}`,
        `H${x + 8}V${top - st}H${x + 16}V${top - st * 2}H${x + 24}V${top - st * 3}`,
        `H${r1(cx - 1.2)}${m}`,
        `H${r - 24}V${top - st * 2}H${r - 16}V${top - st}H${r - 8}V${top}H${r}V${base}Z`,
      ].join("");
    }
    case "spire": {
      const m = b.mast ?? 30;
      return `M${x} ${base}V${top}L${r1(cx - 3)} ${top - 26}V${top - 26 - m}H${r1(cx + 3)}V${top - 26}L${r} ${top}V${base}Z`;
    }
    case "moderneR": {
      // Streamline moderne: rounded right end.
      const rr = 30;
      return `M${x} ${base}V${top}H${r - rr}A${rr} ${rr} 0 0 1 ${r} ${top + rr}V${base}Z`;
    }
    case "moderneL": {
      const rr = 30;
      return `M${x} ${base}V${top + rr}A${rr} ${rr} 0 0 1 ${x + rr} ${top}H${r}V${base}Z`;
    }
    default:
      return `M${x} ${base}V${top}H${r}V${base}Z`;
  }
}

/**
 * The focal tower's neon crown as two halves (left side up to the spire tip, right side up to
 * the spire tip), so the intro can trace both sides at once until they meet at the top.
 */
export function crownTrace(b: Building): [string, string] {
  const { x, w, top } = b;
  const r = x + w;
  const cx = x + w / 2;
  const t2 = w * 0.74;
  const t3 = w * 0.48;
  const h1 = 26;
  const h2 = 22;
  const crown = top - h1 - h2 - 10;
  const tip = crown - (b.mast ?? 0);
  const side = (s: 1 | -1, edge: number) =>
    [
      `M${edge} ${top + 44}V${top}`,
      `H${r1(cx + (s * t2) / 2)}V${top - h1}`,
      `H${r1(cx + (s * t3) / 2)}V${top - h1 - h2}`,
      `H${r1(cx + s * 4)}V${crown}`,
      `H${r1(cx + s * 1.5)}V${tip}`,
    ].join("");
  return [side(-1, x), side(1, r)];
}

export const WINDOW_COLORS = ["#ffe6c2", "#ffc94d", "#ffad72", "#ff8fb0"] as const;

/**
 * Windows of one building: lit windows as one path per colour (so a building lights up as a
 * unit in the intro), plus the unlit panes as a faint texture.
 */
export function windows(b: Building, seed: number): { lit: string[]; dark: string } {
  const rand = rng(seed);
  const lit = ["", "", "", ""];
  let dark = "";
  const moderne = Boolean(b.ledges) && b.shape !== "step" && b.shape !== "flat";
  const crown = b.shape === "dome" ? 0 : b.shape === "step" ? 4 : 6;
  const startY = b.top + crown + (moderne ? 10 : 8);
  const endY = VB.horizon - 10;
  const pad = moderne ? 7 : 6;
  const colW = moderne ? 17 : 7;
  const ww = moderne ? 12 : 3;
  const rowH = moderne ? 16 : 9;
  const wh = moderne ? 3 : 4.4;
  const pick = () => {
    const r = rand();
    return r < 0.32 ? 0 : r < 0.72 ? 1 : r < 0.95 ? 2 : 3;
  };
  for (let y = startY; y < endY; y += rowH) {
    const occupied = rand() < 0.35 + b.lit * 0.6;
    const color = pick();
    let on = false;
    for (let x = b.x + pad; x < b.x + b.w - pad - ww + 0.5; x += colW) {
      on = occupied && (on ? rand() < 0.72 : rand() < b.lit * 0.7);
      const pane = `M${r1(x)} ${r1(y)}h${ww}v${wh}h-${ww}z`;
      if (on) lit[rand() < 0.8 ? color : pick()] += pane;
      else dark += pane;
    }
  }
  return { lit, dark };
}

/** Faint windows of the far skyline. */
export function farTowers(seed: number) {
  const rand = rng(seed);
  const towers: { d: string; win: string }[] = [];
  let x = 90;
  while (x < 1560) {
    const w = 22 + Math.floor(rand() * 34);
    const top = 300 + Math.floor(rand() * 96);
    const shape = rand();
    let d: string;
    if (shape < 0.18) {
      // little crown
      d = `M${x} ${VB.horizon}V${top}H${x + w * 0.3}V${top - 8}H${x + w * 0.7}V${top}H${x + w}V${VB.horizon}Z`;
    } else if (shape < 0.3) {
      d = `M${x} ${VB.horizon}V${top}L${r1(x + w / 2)} ${top - 18}L${x + w} ${top}V${VB.horizon}Z`;
    } else {
      d = `M${x} ${VB.horizon}V${top}H${x + w}V${VB.horizon}Z`;
    }
    let win = "";
    for (let y = top + 8; y < VB.horizon - 30; y += 12) {
      for (let wx = x + 4; wx < x + w - 5; wx += 8) if (rand() < 0.16) win += `M${wx} ${y}h3v4h-3z`;
    }
    towers.push({ d, win });
    x += w + 6 + Math.floor(rand() * 26);
  }
  return towers;
}

export function stars(seed: number, count: number) {
  const rand = rng(seed);
  return Array.from({ length: count }, () => ({
    x: r1(rand() * VB.w),
    y: r1(8 + rand() * 250),
    r: r1(0.5 + rand() * 0.9),
    o: r1(0.18 + rand() * 0.42),
  }));
}

/** The intro's lights spread outward from the station mast. */
export function lightsDelay(b: Building): number {
  const cx = b.x + b.w / 2;
  return Math.round(260 + Math.abs(cx - MAST.x) * 0.95);
}
