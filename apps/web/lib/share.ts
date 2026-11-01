import { bigMoment, type LibraryItemKind } from "@slot1/contracts";

/**
 * Sharing helpers. Pure functions only (no "@/" imports) so they can be unit-tested directly.
 *
 * Upload pages, verified 2026-11-01:
 * - TikTok: tiktok.com, then "Upload" (top right). A direct /upload URL couldn't be verified, so
 *   the site root is linked. https://shortsync.app/resources/upload-tiktok-from-pc-high-quality (Jun 2026)
 * - YouTube (Shorts are uploaded like any video; vertical or square, up to 3 minutes):
 *   studio.youtube.com, then Create, Upload videos. https://support.google.com/youtube/answer/12779649
 * - Instagram: instagram.com, then the + (Create) button. No direct create URL is documented.
 *   https://www.hopperhq.com/blog/how-to-post-to-instagram-from-pc-mac/ (Jul 2026)
 */
export const UPLOAD_PAGES = [
  { id: "tiktok", label: "TikTok", href: "https://www.tiktok.com/", hint: "Click Upload, top right" },
  { id: "youtube", label: "YouTube Studio", href: "https://studio.youtube.com/", hint: "Create, then Upload videos" },
  { id: "instagram", label: "Instagram", href: "https://www.instagram.com/", hint: "Click + Create" },
] as const;

/** Files above this are fetched only after an explicit "Prepare" tap. */
export const AUTO_PREPARE_MAX_BYTES = 60 * 1024 * 1024;
/** Browsers and share targets struggle beyond this; such files are offered as a download instead. */
export const SHARE_MAX_BYTES = 300 * 1024 * 1024;

/** Same naming rule as the Library's Download button, so a shared file and a download match. */
export function shareFileName(title: string, ext: string): string {
  const base = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "slot1";
  return `${base}.${ext}`;
}

const MOMENT_TAGS: Record<string, string> = {
  "MISSION PASSED": "#MissionPassed",
  "MISSION FAILED": "#MissionFailed",
  "MISSION COMPLETE": "#MissionComplete",
  WASTED: "#Wasted",
  BUSTED: "#Busted",
};

/**
 * A starting caption: the title plus a few tags. A big moment SLOT1 read on screen (the title of
 * an auto clip, or text in a manual title) adds its own tag. Creators edit it before copying.
 */
export function buildShareCaption(i: { title: string; kind: LibraryItemKind }): string {
  const title = i.title.trim();
  const moment = bigMoment({ rawText: title, type: "visible_text", description: title });
  const tags = ["#GTA"];
  if (moment) tags.push(MOMENT_TAGS[moment.text] ?? `#${moment.text.toLowerCase().replace(/(^|\s)(\w)/g, (_m, _s, c: string) => c.toUpperCase())}`);
  tags.push("#gaming");
  if (i.kind === "render" || i.kind === "clip_export" || i.kind === "twitch_clip") tags.push("#clips");
  const line = moment && title.toUpperCase() === moment.text ? `${moment.text}!` : title;
  return `${line}\n\n${[...new Set(tags)].slice(0, 4).join(" ")}`;
}

/** Only finished videos SLOT1 rendered can be shared as a file. */
export function canShareAsFile(i: { kind: LibraryItemKind; status: string; url: string | null; canEdit: boolean }): boolean {
  return i.canEdit && i.status === "ready" && Boolean(i.url) && (i.kind === "render" || i.kind === "clip_export");
}
