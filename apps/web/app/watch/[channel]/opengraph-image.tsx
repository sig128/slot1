import { ImageResponse } from "next/og";
import type { WatchChannelResponse } from "@slot1/contracts";
import { C, OG_SIZE, OgWordmark, drawable, ogFonts, truncate } from "@/lib/og";

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
  const w = await load(channel);
  const login = w?.channel.login ?? channel.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const name = truncate(drawable(w?.channel.displayName, login), 22);
  const connected = Boolean(w?.authorized);
  const live = w?.channel.broadcast.state === "live";
  const title = connected && w?.channel.broadcast.title ? truncate(drawable(w.channel.broadcast.title, ""), 86) : "";
  const category = connected && w?.channel.broadcast.category ? truncate(drawable(w.channel.broadcast.category, ""), 40) : "";
  const thumb = connected && live ? await thumbnail(w!.channel.broadcast.thumbnailUrl) : null;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: C.graphite, position: "relative" }}>
        {thumb && (
          <div style={{ position: "absolute", top: 0, right: 0, width: 760, height: 630, display: "flex" }}>
            <img src={thumb} alt="" width={1120} height={630} style={{ width: 1120, height: 630, objectFit: "cover", marginLeft: -180 }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", background: "linear-gradient(90deg, #101014 0%, rgba(16,16,20,0.75) 38%, rgba(16,16,20,0.1) 100%)" }} />
          </div>
        )}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "70px 72px 64px 72px", width: 800 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex" }}>
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
                  color: live ? C.graphite : C.ivory2,
                  background: live ? C.coral : "transparent",
                  border: live ? `2px solid ${C.coral}` : `2px solid rgba(244,237,226,0.3)`,
                  borderRadius: 3,
                }}
              >
                {live ? "LIVE" : connected ? "OFFLINE" : "WATCH ONLY"}
              </div>
            </div>
            <div style={{ display: "flex", marginTop: 26, fontFamily: "Passion One", fontWeight: 900, fontSize: 104, lineHeight: 0.92, color: C.ivory }}>{name}</div>
            {title && <div style={{ display: "flex", marginTop: 20, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 38, lineHeight: 1.12, color: C.ivory }}>{title}</div>}
            {category && <div style={{ display: "flex", marginTop: 12, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 30, color: C.ivory3 }}>{category}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <OgWordmark size={58} />
            <div style={{ display: "flex", marginLeft: 22, fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 30, color: C.ivory2 }}>
              {connected ? "Watch with the live log of what SLOT1 saw" : "Watch on SLOT1"}
            </div>
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, display: "flex", background: "linear-gradient(90deg, #ff4f87 0%, #ffad72 100%)" }} />
      </div>
    ),
    { ...size, fonts: await ogFonts() },
  );
}
