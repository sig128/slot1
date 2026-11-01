import { getBroadcaster, getSettings } from "@slot1/db";
import { QUEUES, RedisLimiter } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

/** At most this many announcements per channel per window, on top of the bot's global limits. */
const MAX_PER_WINDOW = 3;
const WINDOW_SEC = 300;

/**
 * Opt-in bot announcements ("SLOT1 is watching", auto-clip ready). Off unless the creator turned
 * on chat announcements and the bot; each message is sent at most once (dedupe key) and the
 * existing post-reply job still applies kill switches and the global rate limit.
 */
export async function announce(ctx: ServerContext, broadcasterId: string, text: string, dedupeKey: string): Promise<boolean> {
  const s = await getSettings(ctx.db, broadcasterId);
  if (!s.chatAnnouncements || !s.botEnabled || s.botKilled || ctx.config.env.BOT_GLOBAL_KILL) return false;
  const b = await getBroadcaster(ctx.db, broadcasterId);
  if (!b?.twitch_user_id) return false;
  const limiter = new RedisLimiter(ctx.redis);
  if (!(await limiter.remember(`announce-seen:${dedupeKey}`, 6 * 3600))) return false;
  if (!(await limiter.take(`announce:${broadcasterId}`, MAX_PER_WINDOW, WINDOW_SEC)).allowed) return false;
  await ctx.enqueue(QUEUES.chat, "post-reply", { broadcasterId, text, replyToMessageId: null, dedupeKey: `announce:${dedupeKey}` }, { jobId: `announce-${dedupeKey}` });
  return true;
}
