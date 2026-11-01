import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const API = process.env.SLOT1_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server for the Docker image; traced from the monorepo root.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  devIndicators: false,
  // Server-sent events must not be buffered by compression on the /api proxy.
  compress: false,
  transpilePackages: ["@slot1/contracts", "@slot1/twitch"],
  // One public origin: the browser only ever talks to this app; /api is routed to the API.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
