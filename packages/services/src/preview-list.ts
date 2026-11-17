import { PREVIEW_CHANNELS_MAX } from "@slot1/contracts";
import type { ServerContext } from "./context";

/**
 * Admin → Featured channels, shared by the API (the cards) and the worker (the watcher).
 * Entries are Twitch logins ("vader") or Kick slugs as "kick:<slug>". On the site a Kick
 * channel's login is "kick-<slug>".
 */
export const PREVIEW_CHANNELS_KEY = "slot1:admin:preview-channels";
/** Latest picture SLOT1 actually analyzed for one featured entry. */
export const ADDED_WATCH_STATUS_KEY = (entry: string) => `slot1:added-watch:status:${entry}`;

const TWITCH_RE = /^[a-z0-9_]{1,25}$/;
const KICK_RE = /^kick:[a-z0-9_-]{1,25}$/;
const entryOk = (v: string) => TWITCH_RE.test(v) || KICK_RE.test(v);

/** The list until an admin saves one (saving an empty list clears it for good). */
export const DEFAULT_PREVIEW_LOGINS: readonly string[] = [
  "vader",
  "darkviperau",
  "missmikkaa",
  "darkzelk",
  "grevethebarber",
  "deansocool",
  "csyon",
  "lpmassive",
  "realzbluewater",
  "gtasty",
  "kick:lazenxd",
  "kick:manny_xers",
  "kick:rraenee",
];

/** The site login for an entry: "vader" stays, "kick:slug" becomes "kick-slug". */
export const featuredLogin = (entry: string) => (entry.startsWith("kick:") ? `kick-${entry.slice(5)}` : entry);

/** The entry for a site login, or null when it can't be one. */
export function featuredEntry(login: string): string | null {
  const l = login.toLowerCase();
  const e = l.startsWith("kick-") ? `kick:${l.slice(5)}` : l;
  return entryOk(e) ? e : null;
}

export async function getPreviewLogins(ctx: ServerContext): Promise<string[]> {
  const raw = await ctx.redis.get(PREVIEW_CHANNELS_KEY);
  if (raw === null) return [...DEFAULT_PREVIEW_LOGINS];
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && entryOk(x)).slice(0, PREVIEW_CHANNELS_MAX) : [];
  } catch {
    return [];
  }
}

/** True when a site login ("vader", "kick-lazenxd") is a featured channel right now. */
export async function isFeatured(ctx: ServerContext, login: string): Promise<boolean> {
  const e = featuredEntry(login);
  return e !== null && (await getPreviewLogins(ctx)).includes(e);
}
