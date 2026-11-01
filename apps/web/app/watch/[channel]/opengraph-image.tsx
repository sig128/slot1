import { ImageResponse } from "next/og";
import type { WatchChannelResponse } from "@slot1/contracts";
import { C, OG_SIZE, OgHelpBox, OgShade, OgWordmark, drawable, inkOutline, ogFonts, ogHost, ogScene, truncate } from "@/lib/og";
import { publicOrigin } from "@/lib/origin";

export const alt = "Watch on SLOT1";
export const size = OG_SIZE;
export const contentType = "image/png";

const API = process.env.SLOT1_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

/** Share cards are fetched anonymously: only what any visitor may see goes on the card. */
async function load(login: string): Promise<WatchChannelResponse | null> {
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(login)) return null;
  try {
    const res = await fetch(`${API}/api/channels/${encodeURIComponent(login)}/watch`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as WatchChannelResponse) : null;
  } catch {
    return null;
  }
}

/** Twitch's live thumbnail as a data URI, or nothing if it can't be fetched quickly. */
async function thumbnail(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\/static-cdn\.jtvnw\.net\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 2_000_000 ? `data:${type.split(";")[0]};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const [w, scene, fonts, origin] = await Promise.all([load(channel), ogScene(), ogFonts(), publicOrigin()]);
  const login = w?.channel.login ?? channel.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const name = truncate(drawable(w?.channel.displayName, login), 20);
  const connected = Boolean(w?.authorized);
  const live = w?.channel.broadcast.state === "live";
  const title = connected && w?.channel.broadcast.title ? truncate(drawable(w.channel.broadcast.title, ""), 80) : "";
  const category = connected && w?.channel.broadcast.category ? truncate(drawable(w.channel.broadcast.category, ""), 40) : "";
  const thumb = connected && live ? await thumbnail(w!.channel.broadcast.thumbnailUrl) : null;
  // The name must fit its column: narrower when the live thumbnail takes the right side.
  const nameSize = thumb ? (name.length <= 9 ? 96 : name.length <= 12 ? 80 : 64) : name.length <= 12 ? 96 : name.length <= 16 ? 80 : 66;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: C.graphite }}>
        <img src={scene} alt="" width={1200} height={630} style={{ position: "absolute", left: 0, top: 0 }} />
        <OgShade strength={thumb ? 1 : 0.9} />
        {thumb && (
          <div
            style={{
              position: "absolute",
              right: 56,
              top: 96,
              display: "flex",
              width: 520,
              height: 293,
              border: `6px solid ${C.ink}`,
              borderRadius: 6,
              boxShadow: `10px 14px 0 ${C.ink}`,
              transform: "rotate(-2deg)",
              overflow: "hidden",
              background: C.graphite,
            }}
          >
            <img src={thumb} alt="" width={520} height={293} style={{ width: 520, height: 293, objectFit: "cover" }} />
          </div>
        )}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", padding: "54px 64px 0 64px", width: thumb ? 640 : 820 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <OgWordmark size={64} />
            <div style={{ display: "flex", marginTop: 34 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: 44,
                  padding: "0 16px",
                  fontFamily: "Barlow Condensed",
                  fontWeight: 800,
                  fontSize: 28,
                  letterSpacing: 2,
                  color: live ? C.ink : C.ivory,
                  background: live ? C.coral : "rgba(10, 6, 14, 0.7)",
                  border: `3px solid ${live ? C.ink : "rgba(244,237,226,0.35)"}`,
                  borderRadius: 4,
                }}
              >
                {live ? "LIVE" : connected ? "OFFLINE" : "WATCH ONLY"}
              </div>
            </div>
            <div style={{ display: "flex", marginTop: 18, fontFamily: "Passion One", fontWeight: 900, fontSize: nameSize, lineHeight: 0.95, color: C.ivory, textShadow: inkOutline(4, 6) }}>
              {name}
            </div>
            {title && (
              <div style={{ display: "flex", marginTop: 16, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 36, lineHeight: 1.12, color: C.ivory, textShadow: `2px 3px 0 ${C.ink}` }}>
                {title}
              </div>
            )}
            {category && (
              <div style={{ display: "flex", marginTop: 10, fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 30, color: C.gold, textShadow: `2px 3px 0 ${C.ink}` }}>{category}</div>
            )}
          </div>
          <div style={{ display: "flex", marginTop: 30 }}>
            <OgHelpBox accent={ogHost(origin)}>{connected ? "Watch with the live AI log" : "Watch on SLOT1"}</OgHelpBox>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
