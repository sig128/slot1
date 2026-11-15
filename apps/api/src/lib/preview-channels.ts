import { PREVIEW_CHANNELS_MAX, type AnalysisStatus, type ChannelCard } from "@slot1/contracts";
import { followerTotals, kickChannels, withAppToken, type KickChannel, type ServerContext } from "@slot1/services";
import { channelUrl, parseTwitchUrl, sizeThumbnail } from "@slot1/twitch";
import { badRequest } from "./errors";

/**
 * Admin → Featured channels: Twitch and Kick channels shown on the home page (Live now and On air)
 * for everyone, like any other channel. They haven't connected SLOT1, so they carry `preview`: their
 * platform's own player, nothing analyzed or recorded, no bot in their chat. Kept in Redis, so a
 * change shows on the next page load without a restart.
 *
 * Entries are Twitch logins ("vader") or Kick slugs as "kick:<slug>". On the site a Kick channel's
 * login is "kick-<slug>": Twitch logins never contain "-", so the two can't collide.
 */
const KEY = "slot1:admin:preview-channels";
const TWITCH_RE = /^[a-z0-9_]{1,25}$/;
const KICK_RE = /^kick:[a-z0-9_-]{1,25}$/;
const entryOk = (v: string) => TWITCH_RE.test(v) || KICK_RE.test(v);

/** The list until an admin saves one (saving an empty list clears it for good). */
export const DEFAULT_PREVIEW_LOGINS: readonly string[] = ["vader", "darkviperau", "missmikkaa", "darkzelk", "kick:lazenxd", "kick:manny_xers", "kick:rraenee"];

/** The site login for an entry: "vader" stays, "kick:slug" becomes "kick-slug". */
export const featuredLogin = (entry: string) => (entry.startsWith("kick:") ? `kick-${entry.slice(5)}` : entry);
/** The entry for a site login, or null when it can't be one. */
export function featuredEntry(login: string): string | null {
  const l = login.toLowerCase();
  const e = l.startsWith("kick-") ? `kick:${l.slice(5)}` : l;
  return entryOk(e) ? e : null;
}

export async function getPreviewLogins(ctx: ServerContext): Promise<string[]> {
  const raw = await ctx.redis.get(KEY);
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

/** A Kick channel link or "kick:name" → its slug, else null. */
function kickSlug(v: string): string | null {
  const m = /^(?:kick:|(?:https?:\/\/)?(?:www\.)?kick\.com\/)([A-Za-z0-9_-]{1,25})\/?(?:[?#].*)?$/i.exec(v);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Channel names, twitch.tv or kick.com channel links, or "kick:name" → entries, de-duplicated. A bad
 * entry is a 400 that names it.
 */
export function normalizePreviewLogins(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const v = e.trim();
    if (!v) continue;
    const kick = kickSlug(v);
    let entry: string;
    if (kick) entry = `kick:${kick}`;
    else {
      const p = parseTwitchUrl(v);
      if (!p || p.kind !== "channel") throw badRequest(`“${v.slice(0, 60)}” isn’t a Twitch or Kick channel name or link`);
      entry = p.login;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > PREVIEW_CHANNELS_MAX) throw badRequest(`Add up to ${PREVIEW_CHANNELS_MAX} featured channels`);
  return out;
}

export async function setPreviewLogins(ctx: ServerContext, logins: string[]): Promise<void> {
  // Stored even when empty, so a cleared list stays cleared instead of going back to the default.
  await ctx.redis.set(KEY, JSON.stringify(logins));
  cache = null;
}

let cache: { key: string; at: number; cards: ChannelCard[] } | null = null;
const TTL_MS = 30_000;

function notAnalyzed(ctx: ServerContext): AnalysisStatus {
  return {
    state: "no_source",
    reason: "SLOT1 isn’t reading this stream",
    sourceLabel: null,
    lastReceivedFrameAt: null,
    lastAnalyzedFrameAt: null,
    lastResultAt: null,
    measuredCadenceMs: null,
    measuredDelayMs: null,
    staleAfterMs: null,
    visionConfigured: ctx.config.capabilities.vision.available,
  };
}

async function twitchCards(ctx: ServerContext, logins: string[], now: string): Promise<Map<string, ChannelCard>> {
  const out = new Map<string, ChannelCard>();
  if (logins.length === 0 || !ctx.helix) return out;
  const helix = ctx.helix;
  const [users, streams] = await Promise.all([
    withAppToken(ctx, (t) => helix.getUsers(t, { logins })),
    withAppToken(ctx, (t) => helix.getStreams(t, { userLogins: logins })),
  ]);
  const followers = await followerTotals(ctx, users.map((u) => u.id));
  for (const login of logins) {
    const u = users.find((x) => x.login.toLowerCase() === login);
    if (!u) continue;
    const s = streams.find((x) => x.user_login.toLowerCase() === login);
    out.set(login, {
      broadcasterId: `preview:${login}`,
      login,
      displayName: u.display_name,
      avatarUrl: u.profile_image_url || null,
      twitchUrl: channelUrl(login),
      broadcast: {
        state: s ? "live" : "offline",
        title: s?.title ?? null,
        category: s?.game_name ?? null,
        thumbnailUrl: s ? sizeThumbnail(s.thumbnail_url, 960, 540) : null,
        viewerCount: s ? s.viewer_count : null,
        startedAt: s?.started_at ?? null,
        lastRefreshedAt: now,
      },
      analysis: notAnalyzed(ctx),
      publicAnalysis: false,
      followers: followers.get(u.id) ?? null,
      preview: true,
      platform: "twitch",
    });
  }
  return out;
}

/** Kick channels always get a card (Kick's player works without the API); live data when Kick answers. */
async function kickCards(ctx: ServerContext, slugs: string[], now: string): Promise<Map<string, ChannelCard>> {
  const out = new Map<string, ChannelCard>();
  if (slugs.length === 0) return out;
  let data = new Map<string, KickChannel>();
  let failed = false;
  try {
    data = await kickChannels(ctx, slugs);
  } catch {
    failed = true;
  }
  const known = !failed && data.size > 0;
  for (const slug of slugs) {
    const k = data.get(slug);
    out.set(`kick:${slug}`, {
      broadcasterId: `preview:kick:${slug}`,
      login: `kick-${slug}`,
      displayName: k?.displayName ?? slug,
      avatarUrl: k?.avatarUrl ?? null,
      twitchUrl: "",
      broadcast: {
        state: k ? (k.live ? "live" : "offline") : failed ? "error" : known ? "offline" : "unknown",
        title: k?.title ?? null,
        category: k?.category ?? null,
        thumbnailUrl: k?.thumbnailUrl ?? null,
        viewerCount: k?.viewers ?? null,
        startedAt: k?.startedAt ?? null,
        lastRefreshedAt: k ? now : null,
      },
      analysis: notAnalyzed(ctx),
      publicAnalysis: false,
      followers: null,
      subscribers: k?.subscribers ?? null,
      preview: true,
      platform: "kick",
    });
  }
  return out;
}

/**
 * Public data for the featured channels, in the admin's order (cached 30 s): Twitch's for Twitch
 * channels (a name Twitch doesn't know is left out), Kick's for Kick channels.
 */
export async function previewCards(ctx: ServerContext, entries: string[]): Promise<ChannelCard[]> {
  if (entries.length === 0) return [];
  const key = entries.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.cards;
  const now = new Date().toISOString();
  const twitch = entries.filter((e) => !e.startsWith("kick:"));
  const kick = entries.filter((e) => e.startsWith("kick:")).map((e) => e.slice(5));
  let t: Map<string, ChannelCard>;
  try {
    t = await twitchCards(ctx, twitch, now);
  } catch {
    // Twitch unreachable: keep the last answer for these channels, if any.
    if (cache?.key === key) return cache.cards;
    t = new Map();
  }
  const k = await kickCards(ctx, kick, now);
  const cards = entries.flatMap((e) => {
    const c = t.get(e) ?? k.get(e);
    return c ? [c] : [];
  });
  cache = { key, at: Date.now(), cards };
  return cards;
}

export function clearPreviewCache(): void {
  cache = null;
}
