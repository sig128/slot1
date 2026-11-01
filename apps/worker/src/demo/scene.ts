import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DEMO_CAMERA_TILE, DEMO_STREAM_NAME } from "@slot1/contracts";

/**
 * SLOT1's demo broadcast: a synthetic "Vice City after dark" scene generated live by ffmpeg.
 * No game footage and no third-party artwork: the background and cars are drawn here as SVG,
 * and the HUD text uses a free system font (DejaVu Sans Bold; never Pricedown). HUD lines are
 * placed inside the GTA V profile's OCR regions
 * (packages/analysis/src/profiles.ts) so SLOT1's real OCR reads them like it would read a game.
 * The scene carries a permanent "SYNTHETIC TEST VIDEO" watermark outside every OCR region.
 */

export const DEMO_CYCLE_SEC = 150;

export type DemoEventKind = "mission_title" | "subtitle" | "objective" | "place" | "passed" | "wasted" | "busted";

export interface DemoEvent {
  /** Seconds into the cycle. */
  start: number;
  end: number;
  kind: DemoEventKind;
  text: string;
}

/** One cycle of the demo "mission". Every line is original text; names and places are invented. */
export const DEMO_EVENTS: readonly DemoEvent[] = [
  { start: 0, end: 7, kind: "mission_title", text: "THE NEON PIER JOB" },
  { start: 2, end: 9, kind: "subtitle", text: "Rico: Keep the engine running. We go at midnight." },
  { start: 10, end: 17, kind: "objective", text: "Go to the Neon Pier." },
  { start: 18, end: 24, kind: "place", text: "NEON PIER" },
  { start: 24, end: 32, kind: "subtitle", text: "Vanessa: Cops are all over the boardwalk tonight." },
  { start: 33, end: 40, kind: "objective", text: "Lose the cops." },
  { start: 41, end: 47, kind: "subtitle", text: "Rico: Nice driving. Get us to the garage." },
  { start: 48, end: 54, kind: "passed", text: "MISSION PASSED" },
  { start: 55, end: 62, kind: "subtitle", text: "Vanessa: That was too close. Lay low for a while." },
  { start: 63, end: 69, kind: "place", text: "PALM ROW" },
  { start: 70, end: 77, kind: "objective", text: "Drive to the safehouse." },
  { start: 80, end: 86, kind: "wasted", text: "WASTED" },
  { start: 87, end: 94, kind: "subtitle", text: "Rico: Hospital bills again. Let's try that again." },
  { start: 95, end: 101, kind: "place", text: "SUNSET DOCKS" },
  { start: 102, end: 109, kind: "objective", text: "Collect the package." },
  { start: 112, end: 118, kind: "busted", text: "BUSTED" },
  { start: 119, end: 126, kind: "subtitle", text: "Vanessa: Bail is paid. Next time, no sirens." },
  { start: 128, end: 135, kind: "objective", text: "Return to the garage." },
  { start: 136, end: 142, kind: "place", text: "HARBOR LIGHTS" },
];

/**
 * Where each kind of HUD line sits, as fractions of the frame height (y = top of the text, size =
 * font size). Matched to the GTA V profile's OCR regions; tests/unit/demo.test.ts checks it.
 */
export const DEMO_LAYOUT = {
  watermark: { x: 0.022, y: 0.035, size: 0.026 },
  cash: { right: 0.972, y: 0.05, size: 0.044 },
  band: { y: 0.33, h: 0.29 },
  title: { y: 0.41, size: 0.078 },
  passed: { y: 0.41, size: 0.105 },
  bigResult: { y: 0.39, size: 0.15 },
  line: { y: 0.775, size: 0.042, box: 0.014 },
  place: { right: 0.97, y: 0.944, size: 0.032 },
  /**
   * A placeholder webcam tile (silhouette and "CAM", no face) above every OCR region. The demo
   * source hides it from the AI by default (DEMO_CAMERA_MASK), so "What the AI sees" shows the
   * camera mask at work.
   */
  camera: DEMO_CAMERA_TILE,
} as const;

export const DEMO_WATERMARK = "SLOT1 DEMO - SYNTHETIC TEST VIDEO, NOT GAMEPLAY";

/** Cash shown in the HUD at cycle second `c` (changes only at the result screens). */
export function demoCash(c: number): number {
  return 1_248_500 + (c >= 49 ? 25_000 : 0) - (c >= 81 ? 5_000 : 0) - (c >= 113 ? 2_500 : 0);
}

export interface DemoSceneOptions {
  width: number;
  height: number;
  fps: number;
  /**
   * Bold sans for every HUD line (DejaVu Sans Bold in the images). Heavy display faces such as
   * the site's poster font are read unreliably by tesseract, so the demo doesn't use them.
   */
  font: string | null;
  /** Pace inputs in real time (live publishing). Off only to render a file faster for tests. */
  realtime?: boolean;
}

export interface DemoScene {
  /** ffmpeg input arguments (all real-time paced), then -filter_complex_script and maps. */
  args: string[];
  /** Files written into the work dir (background, cars, text, filter script). */
  files: string[];
}

/** Deterministic pseudo-random numbers, so the skyline is the same on every start. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

/** The static backdrop: sky, striped sun, skyline, palms, sea, road and an (empty) minimap. */
export function backgroundSvg(w: number, h: number): string {
  const r = rng(1337);
  const horizon = h * 0.62;
  const stars: string[] = [];
  for (let i = 0; i < 70; i++) stars.push(`<circle cx="${f(r() * w)}" cy="${f(r() * horizon * 0.55)}" r="${f(0.6 + r() * 1.3)}" fill="#fff" opacity="${f(0.25 + r() * 0.6)}"/>`);
  const sunR = h * 0.17;
  const sunCy = h * 0.56;
  const stripes: string[] = [];
  // Retro sun: horizontal gaps that widen towards the horizon.
  for (let i = 0; i < 7; i++) {
    const y = sunCy + i * (sunR / 7) - sunR * 0.05;
    stripes.push(`<rect x="0" y="${f(y)}" width="${w}" height="${f(2 + i * 1.6)}"/>`);
  }
  const buildings: string[] = [];
  const windows: string[] = [];
  let x = 0;
  while (x < w) {
    const bw = 34 + r() * 70;
    const bh = h * (0.08 + r() * 0.2) * (Math.abs(x + bw / 2 - w / 2) < w * 0.16 ? 0.55 : 1);
    const top = horizon - bh;
    buildings.push(`<rect x="${f(x)}" y="${f(top)}" width="${f(bw)}" height="${f(bh + 1)}"/>`);
    for (let wy = top + 8; wy < horizon - 10; wy += 13) {
      for (let wx = x + 6; wx < x + bw - 8; wx += 11) {
        if (r() < 0.32) windows.push(`<rect x="${f(wx)}" y="${f(wy)}" width="5" height="6"/>`);
      }
    }
    x += bw + 2 + r() * 10;
  }
  const palm = (px: number, scale: number, flip: boolean) => {
    const s = scale * h;
    const t = flip ? `translate(${f(px)},${f(horizon + h * 0.02)}) scale(-1,1)` : `translate(${f(px)},${f(horizon + h * 0.02)})`;
    const fronds = [
      `M0,${f(-s)} C${f(s * 0.25)},${f(-s * 1.15)} ${f(s * 0.55)},${f(-s * 1.05)} ${f(s * 0.7)},${f(-s * 0.82)} C${f(s * 0.45)},${f(-s * 0.98)} ${f(s * 0.2)},${f(-s * 0.98)} 0,${f(-s)}Z`,
      `M0,${f(-s)} C${f(-s * 0.25)},${f(-s * 1.18)} ${f(-s * 0.6)},${f(-s * 1.08)} ${f(-s * 0.72)},${f(-s * 0.84)} C${f(-s * 0.45)},${f(-s * 1.0)} ${f(-s * 0.2)},${f(-s * 0.98)} 0,${f(-s)}Z`,
      `M0,${f(-s)} C${f(s * 0.1)},${f(-s * 1.3)} ${f(s * 0.35)},${f(-s * 1.4)} ${f(s * 0.5)},${f(-s * 1.32)} C${f(s * 0.3)},${f(-s * 1.24)} ${f(s * 0.12)},${f(-s * 1.12)} 0,${f(-s)}Z`,
      `M0,${f(-s)} C${f(-s * 0.1)},${f(-s * 1.3)} ${f(-s * 0.38)},${f(-s * 1.38)} ${f(-s * 0.52)},${f(-s * 1.3)} C${f(-s * 0.32)},${f(-s * 1.22)} ${f(-s * 0.12)},${f(-s * 1.12)} 0,${f(-s)}Z`,
    ];
    return `<g transform="${t}" fill="#0b0614"><path d="M${f(-s * 0.03)},0 C${f(s * 0.02)},${f(-s * 0.4)} ${f(s * 0.08)},${f(-s * 0.75)} ${f(-s * 0.01)},${f(-s)} L${f(s * 0.03)},${f(-s)} C${f(s * 0.12)},${f(-s * 0.72)} ${f(s * 0.06)},${f(-s * 0.38)} ${f(s * 0.04)},0Z"/>${fronds.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  };
  const reflections: string[] = [];
  for (let i = 0; i < 16; i++) {
    const y = horizon + 6 + i * i * 0.9 + i * 6;
    if (y > h * 0.655) break;
    const half = w * (0.11 - i * 0.006);
    reflections.push(`<rect x="${f(w / 2 - half)}" y="${f(y)}" width="${f(half * 2)}" height="2" opacity="${f(0.55 - i * 0.03)}"/>`);
  }
  const roadTop = h * 0.655;
  const roadBottom = h * 0.765;
  const dashes: string[] = [];
  for (let dx = 10; dx < w; dx += 90) dashes.push(`<rect x="${dx}" y="${f((roadTop + roadBottom) / 2 - 2)}" width="44" height="4"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#120822"/><stop offset="0.5" stop-color="#3f1452"/><stop offset="0.82" stop-color="#b8306b"/><stop offset="1" stop-color="#ff7a59"/></linearGradient>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset="0.6" stop-color="#ff8a5c"/><stop offset="1" stop-color="#ff4f8b"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a0f45"/><stop offset="1" stop-color="#07040f"/></linearGradient>
<mask id="sunmask"><rect width="${w}" height="${h}" fill="#fff"/><g fill="#000">${stripes.join("")}</g></mask>
</defs>
<rect width="${w}" height="${f(horizon)}" fill="url(#sky)"/>
<g>${stars.join("")}</g>
<circle cx="${f(w / 2)}" cy="${f(sunCy)}" r="${f(sunR)}" fill="url(#sun)" mask="url(#sunmask)"/>
<g fill="#170a26">${buildings.join("")}</g>
<g fill="#ffc94d" opacity="0.55">${windows.join("")}</g>
<rect x="${f(w * 0.06)}" y="${f(horizon - h * 0.2)}" width="${f(w * 0.09)}" height="${f(h * 0.05)}" fill="none" stroke="#ff4fa3" stroke-width="3" opacity="0.8"/>
<rect y="${f(horizon)}" width="${w}" height="${f(h - horizon)}" fill="url(#sea)"/>
<g fill="#ff6f91">${reflections.join("")}</g>
${palm(w * 0.12, 0.22, false)}${palm(w * 0.2, 0.16, true)}${palm(w * 0.86, 0.24, true)}${palm(w * 0.93, 0.15, false)}
<rect y="${f(roadTop)}" width="${w}" height="${f(roadBottom - roadTop)}" fill="#0d0a18"/>
<rect y="${f(roadTop)}" width="${w}" height="2" fill="#ff4fa3" opacity="0.5"/>
<g fill="#ffc94d" opacity="0.7">${dashes.join("")}</g>
<rect y="${f(roadBottom)}" width="${w}" height="${f(h - roadBottom)}" fill="#09060f"/>
<g transform="translate(${f(w * 0.018)},${f(h * 0.79)})"><rect width="${f(w * 0.15)}" height="${f(h * 0.17)}" rx="6" fill="#1b2a1f" opacity="0.85"/><path d="M${f(w * 0.02)},${f(h * 0.14)} L${f(w * 0.07)},${f(h * 0.06)} L${f(w * 0.13)},${f(h * 0.1)}" stroke="#7ee08f" stroke-width="3" fill="none" opacity="0.8"/><path d="M${f(w * 0.075)},${f(h * 0.075)} l-7,16 l7,-5 l7,5z" fill="#fff"/></g>
${cameraTileSvg(w, h)}
</svg>`;
}

/**
 * The demo's stand-in for a streamer's webcam: a framed tile with a head-and-shoulders silhouette
 * and a red recording dot (the "CAM" label is drawn as text by the filter graph). No face.
 */
export function cameraTileSvg(w: number, h: number): string {
  const t = DEMO_LAYOUT.camera;
  const x = w * t.x;
  const y = h * t.y;
  const tw = w * t.w;
  const th = h * t.h;
  const cx = x + tw * 0.5;
  const head = th * 0.17;
  const shoulders = `M${f(cx - tw * 0.26)},${f(y + th)} C${f(cx - tw * 0.25)},${f(y + th * 0.66)} ${f(cx - tw * 0.12)},${f(y + th * 0.6)} ${f(cx)},${f(y + th * 0.6)} C${f(cx + tw * 0.12)},${f(y + th * 0.6)} ${f(cx + tw * 0.25)},${f(y + th * 0.66)} ${f(cx + tw * 0.26)},${f(y + th)}Z`;
  return `<g><rect x="${f(x)}" y="${f(y)}" width="${f(tw)}" height="${f(th)}" rx="8" fill="#241536" stroke="#ff4fa3" stroke-width="3"/>
<circle cx="${f(cx)}" cy="${f(y + th * 0.4)}" r="${f(head)}" fill="#5b4775"/><path d="${shoulders}" fill="#5b4775"/>
<circle cx="${f(x + tw - th * 0.12)}" cy="${f(y + th * 0.13)}" r="${f(th * 0.045)}" fill="#ff2d55"/></g>`;
}

/** A low sports car seen from the side, `facing` right or left, transparent background. */
export function carSvg(w: number, h: number, body: string, facing: "right" | "left"): string {
  const cw = Math.round(w * 0.16);
  const ch = Math.round(h * 0.075);
  const flip = facing === "left" ? `transform="translate(${cw},0) scale(-1,1)"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 200 60"><g ${flip}>
<path d="M8,44 C10,36 18,32 34,30 L64,28 C78,16 98,12 122,13 C140,14 152,20 164,28 L186,31 C194,33 196,40 194,46 L190,48 L8,48Z" fill="${body}"/>
<path d="M74,28 C86,19 100,17 118,17 C132,18 142,22 150,28Z" fill="#7fe7ff" opacity="0.85"/>
<rect x="186" y="34" width="9" height="5" fill="#fff6c2"/><rect x="5" y="36" width="8" height="5" fill="#ff2d55"/>
<circle cx="50" cy="48" r="10" fill="#0b0614"/><circle cx="50" cy="48" r="4" fill="#555"/>
<circle cx="156" cy="48" r="10" fill="#0b0614"/><circle cx="156" cy="48" r="4" fill="#555"/>
</g></svg>`;
}

/** Quote a value for the ffmpeg filtergraph: single quotes, with \ and ' escaped. */
export function fq(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

function cyc(e: Pick<DemoEvent, "start" | "end">): string {
  return `between(mod(t,${DEMO_CYCLE_SEC}),${e.start},${e.end})`;
}

/**
 * Write the scene's assets into `dir` and return the ffmpeg arguments that generate it in real
 * time (video at the requested size and rate, plus a synth music bed). Encoding and the output
 * URL are added by the caller.
 */
export async function buildDemoScene(dir: string, o: DemoSceneOptions): Promise<DemoScene> {
  await mkdir(dir, { recursive: true });
  const { width: w, height: h, fps } = o;
  const caption = o.font;
  if (!caption) throw new Error("No font found for the demo HUD (install fonts-dejavu-core)");
  const files: string[] = [];
  const bg = path.join(dir, "background.png");
  await sharp(Buffer.from(backgroundSvg(w, h))).png().toFile(bg);
  const car1 = path.join(dir, "car-pink.png");
  const car2 = path.join(dir, "car-teal.png");
  await sharp(Buffer.from(carSvg(w, h, "#ff3d8b", "right"))).png().toFile(car1);
  await sharp(Buffer.from(carSvg(w, h, "#21d4c4", "left"))).png().toFile(car2);
  files.push(bg, car1, car2);

  const textFile = async (name: string, text: string) => {
    const file = path.join(dir, `${name}.txt`);
    await writeFile(file, text);
    files.push(file);
    return file;
  };

  const draws: string[] = [];
  const dt = (opts: Record<string, string | number>) =>
    draws.push(
      `drawtext=${Object.entries(opts)
        .map(([k, v]) => `${k}=${typeof v === "number" ? String(v) : v}`)
        .join(":")}`,
    );

  // Always on: the honest label (outside every OCR region) and the cash readout (top-right HUD).
  const L = DEMO_LAYOUT;
  const px = (f: number) => Math.round(h * f);
  dt({ fontfile: fq(caption), textfile: fq(await textFile("watermark", DEMO_WATERMARK)), fontsize: px(L.watermark.size), fontcolor: "white@0.9", box: 1, boxcolor: "black@0.45", boxborderw: px(0.011), x: Math.round(w * L.watermark.x), y: px(L.watermark.y) });
  const cash = (expr: string) => `%{eif:${expr}:d:3}`;
  const v = `(1248500+25000*gte(mod(t,${DEMO_CYCLE_SEC}),49)-5000*gte(mod(t,${DEMO_CYCLE_SEC}),81)-2500*gte(mod(t,${DEMO_CYCLE_SEC}),113))`;
  const cashText = `$%{eif:trunc(${v}/1000000):d},${cash(`mod(trunc(${v}/1000),1000)`)},${cash(`mod(${v},1000)`)}`;
  dt({ fontfile: fq(caption), textfile: fq(await textFile("cash", cashText)), fontsize: px(L.cash.size), fontcolor: "0x8ef0a0", borderw: 2, bordercolor: "black", box: 1, boxcolor: "black@0.35", boxborderw: px(0.011), x: `w*${L.cash.right}-text_w`, y: px(L.cash.y) });

  // The placeholder webcam's label (hidden from the AI by the demo's default camera mask).
  dt({ fontfile: fq(caption), textfile: fq(await textFile("cam", "CAM")), fontsize: px(L.camera.h * 0.14), fontcolor: "white@0.85", x: Math.round(w * (L.camera.x + 0.008)), y: px(L.camera.y + L.camera.h * 0.05) });

  // Title cards and result screens sit on a dark band across the centre, as the game does; the
  // band also keeps the lit skyline from confusing OCR.
  const band = (e: DemoEvent, alpha: number) =>
    draws.push(`drawbox=x=0:y=${px(L.band.y)}:w=iw:h=${px(L.band.h)}:color=black@${alpha}:t=fill:enable=${fq(cyc(e))}`);
  let i = 0;
  for (const e of DEMO_EVENTS) {
    const file = await textFile(`e${i++}-${e.kind}`, e.text);
    const enable = fq(cyc(e));
    switch (e.kind) {
      case "mission_title":
        band(e, 0.6);
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.title.size), fontcolor: "white", borderw: 2, bordercolor: "0x101014", x: "(w-text_w)/2", y: px(L.title.y), enable });
        break;
      case "passed":
        band(e, 0.75);
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.passed.size), fontcolor: "0xffc94d", borderw: 3, bordercolor: "0x101014", x: "(w-text_w)/2", y: px(L.passed.y), enable });
        break;
      case "wasted":
        band(e, 0.75);
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.bigResult.size), fontcolor: "0xe5484d", borderw: 3, bordercolor: "black", x: "(w-text_w)/2", y: px(L.bigResult.y), enable });
        break;
      case "busted":
        band(e, 0.75);
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.bigResult.size), fontcolor: "white", borderw: 3, bordercolor: "0x14213d", x: "(w-text_w)/2", y: px(L.bigResult.y), enable });
        break;
      case "subtitle":
      case "objective":
        // Bottom-centre region; kept above the bottom-right (area name) region.
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.line.size), fontcolor: e.kind === "objective" ? "0xfff2c6" : "white", box: 1, boxcolor: "black@0.55", boxborderw: px(L.line.box), x: "(w-text_w)/2", y: px(L.line.y), enable });
        break;
      case "place":
        dt({ fontfile: fq(caption), textfile: fq(file), fontsize: px(L.place.size), fontcolor: "white", borderw: 2, bordercolor: "black", x: `w*${L.place.right}-text_w`, y: px(L.place.y), enable });
        break;
    }
  }

  const passed = DEMO_EVENTS.find((e) => e.kind === "passed")!;
  const wasted = DEMO_EVENTS.find((e) => e.kind === "wasted")!;
  const busted = DEMO_EVENTS.find((e) => e.kind === "busted")!;
  const graph = [
    `[0:v]format=rgba[bg]`,
    `[bg][1:v]overlay=x='mod(t*230,W+w)-w':y=${Math.round(h * 0.662)}:eval=frame[c1]`,
    `[c1][2:v]overlay=x='W-mod(t*170+600,W+w)':y=${Math.round(h * 0.69)}:eval=frame[c2]`,
    // A neon sign on the skyline that flickers; no text, so OCR never reads it.
    `[c2]drawbox=x=${Math.round(w * 0.06)}:y=${Math.round(h * 0.42)}:w=${Math.round(w * 0.09)}:h=${Math.round(h * 0.05)}:color=0xff4fa3@0.35:t=fill:enable='lt(mod(t,1.7),1.25)',${draws.join(",")},hue=h='200*${cyc(busted)}':s='1-0.92*${cyc(wasted)}',format=yuv420p[v]`,
  ].join(";\n");
  const script = path.join(dir, "filter.txt");
  await writeFile(script, graph);
  files.push(script);

  // Synth bed: a stepping bass line and a slow pad, with a chime on MISSION PASSED.
  const k = `floor(mod(t*2,4))`;
  const bass = `0.16*sin(2*PI*55*(1+0.189*eq(${k},2)-0.109*eq(${k},3))*t)`;
  const pad = `0.05*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))`;
  const chime = `0.22*sin(2*PI*880*t)*${cyc({ start: passed.start, end: passed.start + 1.2 })}*exp(-3*(mod(t,${DEMO_CYCLE_SEC})-${passed.start}))`;
  const audio = `aevalsrc=${fq(`${bass}+${pad}+${chime}|${bass}+${pad}*0.8+${chime}`)}:s=48000:c=stereo`;

  const re = o.realtime === false ? [] : ["-re"];
  const loopImage = (file: string) => [...re, "-loop", "1", "-framerate", String(fps), "-i", file];
  const args = [
    ...loopImage(bg),
    ...loopImage(car1),
    ...loopImage(car2),
    ...re,
    "-f",
    "lavfi",
    "-i",
    audio,
    "-filter_complex_script",
    script,
    "-map",
    "[v]",
    "-map",
    "3:a",
  ];
  return { args, files };
}

/** The publish URL in each gateway's own key format (the same format Studio gives OBS). */
export function demoPublishUrl(gateway: "mediamtx" | "nginx-rtmp", base: string, key: string): string {
  const b = base.replace(/\/$/, "");
  return gateway === "mediamtx"
    ? `${b}/${DEMO_STREAM_NAME}?user=${DEMO_STREAM_NAME}&pass=${encodeURIComponent(key)}`
    : `${b}/${DEMO_STREAM_NAME}?key=${encodeURIComponent(key)}`;
}

/** Encoder settings for low delay: one keyframe per second, no B-frames, constant bitrate. */
export function demoEncodeArgs(o: { fps: number; bitrateKbps: number; preset: string }): string[] {
  const kb = Math.max(300, Math.round(o.bitrateKbps));
  return [
    "-c:v",
    "libx264",
    "-preset",
    o.preset,
    "-tune",
    "zerolatency",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(o.fps),
    "-g",
    String(o.fps),
    "-keyint_min",
    String(o.fps),
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-b:v",
    `${kb}k`,
    "-maxrate",
    `${kb}k`,
    "-bufsize",
    `${kb * 2}k`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
  ];
}
