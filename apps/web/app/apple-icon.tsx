import { ImageResponse } from "next/og";
import { C, ogFonts } from "@/lib/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the "1" channel bug from the wordmark, on graphite. */
export default async function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.graphite }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 104,
            height: 136,
            borderRadius: 12,
            background: "linear-gradient(160deg, #FF4F87 0%, #FF7A7C 48%, #FFAD72 100%)",
            fontFamily: "Passion One",
            fontWeight: 900,
            fontSize: 124,
            lineHeight: 1,
            color: C.graphite,
          }}
        >
          1
        </div>
      </div>
    ),
    { ...size, fonts: await ogFonts() },
  );
}
