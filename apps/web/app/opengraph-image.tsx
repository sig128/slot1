import { ImageResponse } from "next/og";
import { C, OG_SIZE, OgWordmark, SKYLINE_SRC, ogFonts } from "@/lib/og";

export const alt = "SLOT1: live GTA streams, with an AI that shows its evidence.";
export const size = OG_SIZE;
export const contentType = "image/png";

/** The site-wide share card: station ident, the promise, and the skyline. */
export default async function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: C.graphite, position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", padding: "76px 84px 0 84px" }}>
          <OgWordmark size={164} />
          <div style={{ display: "flex", marginTop: 34, fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 62, lineHeight: 1.02, color: C.ivory, maxWidth: 940 }}>
            Live GTA streams, with an AI that shows its evidence.
          </div>
          <div style={{ display: "flex", marginTop: 22, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 32, color: C.ivory2 }}>
            Every line links to the frames it came from.
          </div>
        </div>
        <img src={SKYLINE_SRC} alt="" width={1200} height={210} style={{ position: "absolute", left: 0, bottom: 0 }} />
      </div>
    ),
    { ...size, fonts: await ogFonts() },
  );
}
