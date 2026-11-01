import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce CSP. Frames are limited to the official Twitch player, clip and chat
 * embeds; media and images come from this origin (signed URLs), Twitch's image CDN and, when
 * S3 storage is used, its public endpoint (SLOT1_MEDIA_ORIGINS).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  // SLOT1's own live video: the browser talks WHEP to MediaMTX's WebRTC server.
  const webrtcOrigin = (() => {
    try {
      const u = new URL(process.env.INGEST_PUBLIC_WEBRTC_URL ?? "");
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
    } catch {
      return "";
    }
  })();
  const mediaOrigins = (process.env.SLOT1_MEDIA_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/[a-z0-9.:-]+$/i.test(s))
    .join(" ");
  // Studio → Stream setup talks to OBS's WebSocket server on the creator's own computer.
  const obsLocal = request.nextUrl.pathname.startsWith("/studio") ? "ws://localhost:*" : "";
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // React style attributes (timeline positions) need inline styles; scripts stay nonce-only.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https://static-cdn.jtvnw.net https://clips-media-assets2.twitch.tv ${mediaOrigins}`.trim(),
    `media-src 'self' blob: ${mediaOrigins}`.trim(),
    `font-src 'self'`,
    // Sharing a clip fetches its file, which may live on the S3 media origin.
    `connect-src ${["'self'", webrtcOrigin, mediaOrigins, obsLocal].filter(Boolean).join(" ")}`,
    `frame-src https://player.twitch.tv https://clips.twitch.tv https://www.twitch.tv`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self' https://id.twitch.tv`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
