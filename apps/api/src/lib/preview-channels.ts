import { PREVIEW_CHANNELS_MAX, type ChannelCard } from "@slot1/contracts";
import { followerTotals, withAppToken, type ServerContext } from "@slot1/services";
import { channelUrl, parseTwitchUrl, sizeThumbnail } from "@slot1/twitch";
import { badRequest } from "./errors";

/**
 * Admin → Featured channels: up to five Twitch channels shown on the home page (Live now and On air)
 * for everyone, like any other channel. They haven't connected SLOT1, so they carry `preview`:
 * Twitch's own player and chat, nothing analyzed or recorded, no bot in their chat. Kept in Redis,
 * so a change shows on the next page load without a restart.
 */
const KEY = "slot1:admin:preview-channels";
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

/** The list until an admin saves one (saving an empty list clears it for good). */
export const DEFAULT_PREVIEW_LOGINS: readonly string[] = ["vader", "darkviperau", "missmikkaa", "darkzelk"];

export async function getPreviewLogins(ctx: ServerContext): Promise<string[]> {
  const raw = await ctx.redis.get(KEY);
  if (raw === null) return [...DEFAULT_PREVIEW_LOGINS];
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && LOGIN_RE.test(x)).slice(0, PREVIEW_CHANNELS_MAX) : [];
  } catch {
    return [];
  }
}

/** Channel names or twitch.tv channel links → lower-case logins, de-duplicated. A bad entry is a 400 that names it. */
export function normalizePreviewLogins(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const v = e.trim();
    if (!v) continue;
    const p = parseTwitchUrl(v);
    if (!p || p.kind !== "channel") throw badRequest(`“${v.slice(0, 60)}” isn’t a Twitch channel name or channel link`);
    if (!out.includes(p.login)) out.push(p.login);
  }
  if (out.length > PREVIEW_CHANNELS_MAX) throw badRequest(`Add up to ${PREVIEW_CHANNELS_MAX} preview channels`);
  return out;
}

export async function setPreviewLogins(ctx: ServerContext, logins: string[]): Promise<void> {
  // Stored even when empty, so a cleared list stays cleared instead of going back to the default.
  await ctx.redis.set(KEY, JSON.stringify(logins));
  cache = null;
}

let cache: { key: string; at: number; cards: ChannelCard[] } | null = null;
const TTL_MS = 30_000;

/** Twitch's public data for the preview channels (cached 30 s). A name Twitch doesn't know is left out. */
export async function previewCards(ctx: ServerContext, logins: string[]): Promise<ChannelCard[]> {
  if (logins.length === 0 || !ctx.helix) return [];
  const key = logins.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.cards;
  const helix = ctx.helix;
  let cards: ChannelCard[];
  try {
    const [users, streams] = await Promise.all([
      withAppToken(ctx, (t) => helix.getUsers(t, { logins })),
      withAppToken(ctx, (t) => helix.getStreams(t, { userLogins: logins })),
    ]);
    const now = new Date().toISOString();
    const followers = await followerTotals(ctx, users.map((u) => u.id));
    cards = logins.flatMap((login): ChannelCard[] => {
      const u = users.find((x) => x.login.toLowerCase() === login);
      if (!u) return [];
      const s = streams.find((x) => x.user_login.toLowerCase() === login);
      return [
        {
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
          analysis: {
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
          },
          publicAnalysis: false,
          followers: followers.get(u.id) ?? null,
          preview: true,
        },
      ];
    });
  } catch {
    // Twitch unreachable: keep the last answer for these channels, if any.
    return cache?.key === key ? cache.cards : [];
  }
  cache = { key, at: Date.now(), cards };
  return cards;
}

export function clearPreviewCache(): void {
  cache = null;
}
