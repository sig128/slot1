import { ImageResponse } from "next/og";
import { C, OG_SIZE, OgHelpBox, OgShade, OgWordmark, inkOutline, ogFonts, ogHost, ogScene } from "@/lib/og";
import { publicOrigin } from "@/lib/origin";

export const alt = "SLOT1: the AI that watches GTA streams with you.";
export const size = OG_SIZE;
export const contentType = "image/png";
// The host name on the card comes from the deployment's configured origin, so render per request.
export const dynamic = "force-dynamic";

/** The site-wide share card: the loading-screen artwork, the title card and the address. */
export default async function Image() {
  const [scene, fonts, origin] = await Promise.all([ogScene(), ogFonts(), publicOrigin()]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: C.graphite }}>
        <img src={scene} alt="" width={1200} height={630} style={{ position: "absolute", left: 0, top: 0 }} />
        <OgShade strength={0.9} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: "58px 64px 0 64px", width: 760 }}>
          <OgWordmark size={150} />
          <div
            style={{
              display: "flex",
              marginTop: 30,
              fontFamily: "Passion One",
              fontWeight: 900,
              fontSize: 58,
              lineHeight: 0.98,
              color: C.ivory,
              textShadow: inkOutline(3, 5),
              maxWidth: 640,
            }}
          >
            The AI that watches GTA streams with you.
          </div>
          <div style={{ display: "flex", marginTop: 34 }}>
            <OgHelpBox accent={ogHost(origin)}>Live AI log · Instant replay · Clips</OgHelpBox>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
