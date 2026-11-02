import { ImageResponse } from "next/og";
import type { ClipGuide } from "./clip-guides";
import { C, OG_SIZE, OgHelpBox, OgShade, OgWordmark, inkOutline, ogFonts, ogHost, ogScene } from "./og";
import { publicOrigin } from "./origin";

/** A clipping guide's share card: the site's artwork and title card, with the guide's own title. */
export async function guideShareCard(g: ClipGuide): Promise<ImageResponse> {
  const [scene, fonts, origin] = await Promise.all([ogScene(), ogFonts(), publicOrigin()]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: C.graphite }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- an image card rendered by next/og, not a page */}
        <img src={scene} alt="" width={1200} height={630} style={{ position: "absolute", left: 0, top: 0 }} />
        <OgShade strength={0.95} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: "52px 64px 0 64px", width: 820 }}>
          <OgWordmark size={96} />
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontFamily: "Passion One",
              fontWeight: 900,
              fontSize: 66,
              lineHeight: 0.98,
              color: C.ivory,
              textShadow: inkOutline(3, 5),
              maxWidth: 760,
            }}
          >
            {g.card.title}
          </div>
          <div style={{ display: "flex", marginTop: 30 }}>
            <OgHelpBox accent={ogHost(origin)}>{g.card.line}</OgHelpBox>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}

/** The card's address and alt text, for pageMetadata's images. */
export function guideShareImage(g: ClipGuide) {
  return { url: `${g.path}/opengraph-image`, width: OG_SIZE.width, height: OG_SIZE.height, alt: g.card.title };
}
