import { AnalysisStatus, armedLearningStatus, PREVIEW_CHANNELS_MAX, type AnalysisStatus as AnalysisStatusT, type ChannelCard } from "@slot1/contracts";
import {
  ADDED_WATCH_STATUS_KEY,
  DEFAULT_PREVIEW_LOGINS,
  featuredEntry,
  featuredLogin,
  followerTotals,
  getPreviewLogins,
  isFeatured,
  kickChannels,
  PREVIEW_CHANNELS_KEY,
  withAppToken,
  type KickChannel,
  type ServerContext,
} from "@slot1/services";
import { channelUrl, parseTwitchUrl, sizeThumbnail } from "@slot1/twitch";
import { badRequest } from "./errors";

export { DEFAULT_PREVIEW_LOGINS, featuredEntry, featuredLogin, getPreviewLogins, isFeatured };

/**
 * Admin → Featured channels: Twitch and Kick channels shown on the home page (Live now and On air)
 * for everyone, like any other channel. They carry `preview`: their platform's own player. While a
 * channel is live, the worker watches its public preview picture and learns from it. A channel
 * shows offline only while that channel is offline. The list is kept in Redis, so a change shows
 * on the next page load without a restart.
 *
 * Entries are Twitch logins ("vader") or Kick slugs as "kick:<slug>". On the site a Kick channel's
 * login is "kick-<slug>": Twitch logins never contain "-", so the two can't collide.
 */

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
  await ctx.redis.set(PREVIEW_CHANNELS_KEY, JSON.stringify(logins));
  cache = null;
}

let cache: { key: string; at: number; cards: ChannelCard[] } | null = null;
const TTL_MS = 30_000;

async function learningStatus(ctx: ServerContext, entry: string, broadcast: "live" | "offline" | "unknown" | "error"): Promise<AnalysisStatusT> {
  const vision = ctx.config.capabilities.vision.available;
  if (broadcast === "live") {
    const raw = await ctx.redis.get(ADDED_WATCH_STATUS_KEY(entry)).catch(() => null);
    if (raw) {
      try {
        const parsed = AnalysisStatus.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.lastReceivedFrameAt) {
          const age = Date.now() - Date.parse(parsed.data.lastReceivedFrameAt);
          if (age >= 0 && age < 180_000) return parsed.data;
        }
      } catch {
        /* a bad cache falls through to the armed status */
      }
    }
  }
  return armedLearningStatus(broadcast, vision);
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
      analysis: await learningStatus(ctx, login, s ? "live" : "offline"),
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
      analysis: await learningStatus(ctx, `kick:${slug}`, k ? (k.live ? "live" : "offline") : failed ? "error" : known ? "offline" : "unknown"),
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
