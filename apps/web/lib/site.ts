import "server-only";
import type { Metadata } from "next";
import { publicOrigin } from "./origin";
import { SITE, verificationToken } from "./meta";

export { SITE, clampDescription, defaultShareImage, pageMetadata, verificationToken, type OgImage } from "./meta";

/** Root metadata: base URL for every relative link and image, title template, verification. */
export async function rootMetadata(): Promise<Metadata> {
  const origin = await publicOrigin();
  const google = verificationToken(process.env.SLOT1_GOOGLE_SITE_VERIFICATION);
  const bing = verificationToken(process.env.SLOT1_BING_SITE_VERIFICATION);
  return {
    metadataBase: new URL(origin),
    title: { default: SITE.title, template: "%s — SLOT1" },
    description: SITE.description,
    applicationName: SITE.name,
    keywords: [
      "GTA streams",
      "GTA V live",
      "Twitch",
      "AI stream companion",
      "live stream log",
      "instant replay",
      "stream clips",
      "multistream",
      "Los Santos",
    ],
    category: "games",
    referrer: "strict-origin-when-cross-origin",
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: { type: "website", siteName: SITE.name, locale: SITE.locale, title: SITE.title, description: SITE.description },
    twitter: { card: "summary_large_image", title: SITE.title, description: SITE.description },
    verification: {
      ...(google ? { google } : {}),
      ...(bing ? { other: { "msvalidate.01": bing } } : {}),
    },
  };
}
