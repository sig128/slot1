import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** The skyline from SkylineArt, simplified for the share card (original artwork, no game assets). */
const SKYLINE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 210" preserveAspectRatio="none">
<defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101014" stop-opacity="0"/><stop offset="0.55" stop-color="#3a1a2c"/><stop offset="0.86" stop-color="#7a2c45"/><stop offset="1" stop-color="#ff4f87"/></linearGradient>
<linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff4f87" stop-opacity="0"/><stop offset="0.35" stop-color="#ff4f87"/><stop offset="0.7" stop-color="#ffad72"/><stop offset="1" stop-color="#ffad72" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1200" height="170" fill="url(#s)"/>
<circle cx="870" cy="170" r="92" fill="#ffad72" opacity="0.2"/><circle cx="870" cy="170" r="56" fill="#ffad72" opacity="0.34"/>
<g fill="#0d0c11"><rect x="150" y="70" width="66" height="100"/><rect x="222" y="112" width="38" height="58"/><rect x="326" y="52" width="52" height="118"/><rect x="382" y="96" width="34" height="74"/><rect x="500" y="78" width="38" height="92"/><rect x="542" y="118" width="58" height="52"/><rect x="642" y="60" width="38" height="110"/><rect x="684" y="106" width="48" height="64"/><rect x="792" y="74" width="74" height="96"/><rect x="950" y="66" width="44" height="104"/><rect x="998" y="116" width="66" height="54"/></g>
<g fill="#ffad72" opacity="0.85"><rect x="168" y="96" width="5" height="7"/><rect x="190" y="118" width="5" height="7"/><rect x="340" y="80" width="5" height="7"/><rect x="356" y="104" width="5" height="7"/><rect x="510" y="110" width="5" height="7"/><rect x="652" y="96" width="5" height="7"/><rect x="806" y="98" width="5" height="7"/><rect x="826" y="122" width="5" height="7"/><rect x="962" y="92" width="5" height="7"/></g>
<g fill="#0a090d"><path d="M80 170 C 84 128, 90 98, 93 66 L 98 66 C 95 98, 91 130, 88 170 Z"/><path d="M95 68 C 74 54, 50 58, 32 72 C 54 62, 76 64, 93 74 Z"/><path d="M96 66 C 110 46, 136 40, 158 48 C 134 46, 114 54, 99 72 Z"/><path d="M1120 170 C 1116 132, 1110 104, 1106 76 L 1111 76 C 1114 104, 1119 132, 1126 170 Z"/><path d="M1108 78 C 1090 62, 1066 62, 1048 74 C 1070 66, 1090 70, 1106 84 Z"/><path d="M1110 76 C 1124 58, 1148 52, 1170 60 C 1148 58, 1128 66, 1113 82 Z"/></g>
<rect y="168" width="1200" height="3" fill="url(#h)"/>
<rect y="171" width="1200" height="39" fill="#0b0b0e"/>
</svg>`;

export const SKYLINE_SRC = `data:image/svg+xml;base64,${Buffer.from(SKYLINE).toString("base64")}`;

/** The SLOT1 station ident: "SLOT" in ivory, the "1" in a sunset badge. */
export function OgWordmark({ size }: { size: number }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", fontFamily: "Passion One", fontWeight: 900, fontSize: size, lineHeight: 1, color: C.ivory }}>
      <span style={{ paddingRight: size * 0.06 }}>SLOT</span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          padding: `0 ${size * 0.14}px`,
          borderRadius: size * 0.08,
          background: "linear-gradient(160deg, #FF4F87 0%, #FF7A7C 48%, #FFAD72 100%)",
          color: C.graphite,
        }}
      >
        1
      </span>
    </div>
  );
}
