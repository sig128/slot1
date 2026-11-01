import type { EdlBox, ReframeKey } from "@slot1/contracts";

/**
 * "Follow the action": measures where the picture actually moves (frame differences on a small
 * grid) and places reframe keyframes over it. It never invents motion: with no clear movement it
 * changes nothing and says so. Static HUD elements don't move, so they don't attract the crop;
 * the facecam box is left out because a moving face isn't the action.
 */

export type FollowResult = { ok: true; keys: ReframeKey[]; samples: number; moving: number } | { ok: false; reason: string };

const GRID_W = 64;

function once(el: HTMLMediaElement, ok: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("error"));
    };
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ok, done);
      el.removeEventListener("error", fail);
    };
    el.addEventListener(ok, done, { once: true });
    el.addEventListener("error", fail, { once: true });
  });
}

export async function followAction(opts: { url: string; inMs: number; outMs: number; exclude: EdlBox | null; zoom?: number; signal?: AbortSignal }): Promise<FollowResult> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = opts.url;
  try {
    await once(v, "loadedmetadata", 20_000);
  } catch {
    return { ok: false, reason: "The browser couldn't load this video for measuring (its storage may not allow it). Set keyframes by hand." };
  }
  const gw = GRID_W;
  const gh = Math.max(8, Math.round((GRID_W * (v.videoHeight || 9)) / (v.videoWidth || 16)));
  const c = document.createElement("canvas");
  c.width = gw;
  c.height = gh;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return { ok: false, reason: "This browser can't measure video frames." };
  const span = opts.outMs - opts.inMs;
  const step = Math.max(200, Math.min(600, span / 40));
  const times: number[] = [];
  for (let t = opts.inMs; t <= opts.outMs; t += step) times.push(Math.round(t));
  const ex = opts.exclude;
  const inEx = (x: number, y: number) => ex !== null && x >= ex.x * gw && x <= (ex.x + ex.w) * gw && y >= ex.y * gh && y <= (ex.y + ex.h) * gh;

  let prev: Uint8ClampedArray | null = null;
  const points: { atMs: number; x: number; y: number; energy: number }[] = [];
  for (const t of times) {
    if (opts.signal?.aborted) return { ok: false, reason: "Stopped." };
    v.currentTime = t / 1000;
    try {
      await once(v, "seeked", 8000);
    } catch {
      return { ok: false, reason: "The video didn't seek in time; try again." };
    }
    g.drawImage(v, 0, 0, gw, gh);
    let data: Uint8ClampedArray;
    try {
      data = g.getImageData(0, 0, gw, gh).data;
    } catch {
      return { ok: false, reason: "This video's storage doesn't let the browser read its pixels, so motion can't be measured here. Set keyframes by hand." };
    }
    const grey = new Uint8ClampedArray(gw * gh);
    for (let i = 0; i < gw * gh; i++) grey[i] = (data[i * 4]! * 3 + data[i * 4 + 1]! * 6 + data[i * 4 + 2]!) / 10;
    if (prev) {
      let sum = 0;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++) {
          if (inEx(x, y)) continue;
          const d = Math.abs(grey[y * gw + x]! - prev[y * gw + x]!);
          n++;
          if (d < 18) continue;
          sum += d;
          sx += x * d;
          sy += y * d;
        }
      const energy = n ? sum / (n * 255) : 0;
      // A scene cut changes everything at once: no direction to follow there.
      if (energy > 0.004 && energy < 0.35) points.push({ atMs: t, x: (sx / sum + 0.5) / gw, y: (sy / sum + 0.5) / gh, energy });
    }
    prev = grey;
  }
  v.removeAttribute("src");
  v.load();
  const samples = Math.max(0, times.length - 1);
  if (points.length < Math.max(2, samples * 0.3)) {
    return { ok: false, reason: `No clear movement in this segment (${points.length} of ${samples} moments moved), so nothing was changed.` };
  }
  // Smooth (moving average of 3) and keep at most 12 evenly spread keys.
  const smooth = points.map((p, i) => {
    const w = points.slice(Math.max(0, i - 1), i + 2);
    return { atMs: p.atMs, x: w.reduce((a, q) => a + q.x, 0) / w.length, y: w.reduce((a, q) => a + q.y, 0) / w.length };
  });
  const pick = smooth.length <= 12 ? smooth : Array.from({ length: 12 }, (_, k) => smooth[Math.round((k * (smooth.length - 1)) / 11)]!);
  const zoom = opts.zoom ?? 1.3;
  const r3 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const keys: ReframeKey[] = pick.map((p) => ({ atMs: Math.min(opts.outMs, Math.max(opts.inMs, p.atMs)), x: r3(p.x), y: r3(p.y), zoom }));
  return { ok: true, keys, samples, moving: points.length };
}
