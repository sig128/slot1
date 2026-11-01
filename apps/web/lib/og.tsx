import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";

/**
 * Share-card (Open Graph) rendering helpers. Satori, which draws these images, reads TTF, OTF
 * or WOFF but not WOFF2, so WOFF copies of the site's OFL fonts live in public/fonts/og. They are
 * read relative to the web app's directory, which is the working directory in development, at
 * build time and in the standalone production server (and public/ ships in the Docker image).
 */
export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  graphite: "#101014",
  graphite800: "#15151a",
  ivory: "#f4ede2",
  ivory2: "#b8b0a4",
  ivory3: "#8a847b",
  coral: "#ff4f87",
  apricot: "#ffad72",
  gold: "#ffc94d",
  ink: "#140715",
};

let fontsPromise: Promise<{ name: string; data: Buffer; weight: 600 | 800 | 900; style: "normal" }[]> | null = null;

export function ogFonts() {
  fontsPromise ??= (async () => {
    const dir = join(process.cwd(), "public", "fonts", "og");
    const [poster, display, displayBold] = await Promise.all([
      readFile(join(dir, "passion-one-900.woff")),
      readFile(join(dir, "barlow-condensed-600.woff")),
      readFile(join(dir, "barlow-condensed-800.woff")),
    ]);
    return [
      { name: "Passion One", data: poster, weight: 900 as const, style: "normal" as const },
      { name: "Barlow Condensed", data: display, weight: 600 as const, style: "normal" as const },
      { name: "Barlow Condensed", data: displayBold, weight: 800 as const, style: "normal" as const },
    ];
  })().catch((err: unknown) => {
    fontsPromise = null;
    throw err;
  });
  return fontsPromise;
}

/** Text the share fonts can draw (Latin); anything else falls back to the given ASCII text. */
export function drawable(text: string | null | undefined, fallback: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t && /^[\x20-\x7E -ɏ–—‘’“”…]+$/.test(t) ? t : fallback;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * The share cards' background: SLOT1's loading-screen artwork (components/brand/SkylineArt.tsx),
 * captured once as a static 1200 × 630 PNG in public/og (original artwork, no game assets).
 * Read relative to the web app's directory, like the fonts above.
 */
let scenePromise: Promise<string> | null = null;

export function ogScene(): Promise<string> {
  scenePromise ??= readFile(join(process.cwd(), "public", "og", "scene-1200x630.png"))
    .then((buf) => `data:image/png;base64,${buf.toString("base64")}`)
    .catch((err: unknown) => {
      scenePromise = null;
      throw err;
    });
  return scenePromise;
}

/** The public host name for the card ("slot1.fun"), from the configured origin at request time. */
export function ogHost(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, "");
  } catch {
    return "SLOT1";
  }
}

/** A thick ink outline for text, drawn as shadows (the share renderer has no paint-order). */
export function inkOutline(px: number, drop = px * 1.6): string {
  const d = Math.max(1, Math.round(px));
  const o = [
    [-d, 0],
    [d, 0],
    [0, -d],
    [0, d],
    [-d, -d],
    [d, -d],
    [-d, d],
    [d, d],
  ].map(([x, y]) => `${x}px ${y}px 0 ${C.ink}`);
  return [...o, `${Math.round(drop * 0.4)}px ${Math.round(drop)}px 0 ${C.ink}`].join(", ");
}

/** SLOT1's title card, as on the home intro: gold "SLOT" with an ink outline, the boxed "1". */
export function OgWordmark({ size }: { size: number }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", fontFamily: "Passion One", fontWeight: 900, fontSize: size, lineHeight: 0.86 }}>
      <span style={{ color: C.gold, textShadow: inkOutline(size * 0.035, size * 0.06), paddingRight: size * 0.06 }}>SLOT</span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          margin: `${size * 0.03}px 0 ${size * 0.05}px 0`,
          padding: `0 ${size * 0.13}px`,
          borderRadius: size * 0.07,
          border: `${Math.max(2, Math.round(size * 0.045))}px solid ${C.ink}`,
          background: "linear-gradient(160deg, #FF4F87 0%, #FF7A7C 48%, #FFAD72 100%)",
          boxShadow: `${Math.round(size * 0.025)}px ${Math.round(size * 0.06)}px 0 ${C.ink}`,
          color: C.ink,
        }}
      >
        1
      </span>
    </div>
  );
}

/** The game-style help box: black glass, white text (the home intro's TIP box). */
export function OgHelpBox({ children, accent }: { children: ReactNode; accent?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "14px 22px",
        background: "rgba(10, 6, 14, 0.78)",
        border: "2px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 6,
        fontFamily: "Barlow Condensed",
        fontWeight: 600,
        fontSize: 30,
        lineHeight: 1.1,
        color: C.ivory,
      }}
    >
      {accent && <span style={{ display: "flex", flexShrink: 0, color: C.gold, fontWeight: 800, marginRight: 12 }}>{accent}</span>}
      <span style={{ display: "flex", flexShrink: 1 }}>{children}</span>
    </div>
  );
}

/** Darkens the city behind the text column so the copy stays readable on the artwork. */
export function OgShade({ strength = 1 }: { strength?: number }) {
  const a = (v: number) => (v * strength).toFixed(2);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        display: "flex",
        background: `linear-gradient(90deg, rgba(20,7,21,${a(0.86)}) 0%, rgba(20,7,21,${a(0.7)}) 32%, rgba(20,7,21,${a(0.28)}) 56%, rgba(20,7,21,0) 72%)`,
      }}
    />
  );
}
