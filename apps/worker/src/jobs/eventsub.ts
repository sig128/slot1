import type { Observation } from "@slot1/contracts";
import {
  endTwitchBroadcastSessions,
  getBroadcasterByTwitchId,
  getOpenTwitchSession,
  getSettings,
  insertObservation,
  markDeliveryProcessed,
  setBroadcastState,
  upsertTwitchBroadcastSession,
  type StreamSessionRow,
} from "@slot1/db";
import type { TwitchJobs } from "@slot1/platform";
import { emitBroadcastStatus, emitObservation, invalidateLiveCache, type ServerContext } from "@slot1/services";
import { ChannelUpdateEvent, StreamOfflineEvent, StreamOnlineEvent } from "@slot1/twitch";

/** Twitch platform facts. No media timeline, no model, no confidence. */
async function platformFact(ctx: ServerContext, session: StreamSessionRow, type: Observation["type"], description: string, messageId: string) {
  const now = new Date().toISOString();
  const { observation, created } = await insertObservation(ctx.db, {
    broadcasterId: session.broadcaster_id,
    sessionId: session.id,
    sourceId: null,
    mediaStartMs: null,
    mediaEndMs: null,
    capturedAt: null,
    receivedAt: now,
    analyzedAt: null,
    type,
    description: description.slice(0, 280),
    origin: "twitch",
    interpretation: "directly_visible",
    evidence: [],
    rawText: null,
    model: null,
    modelConfidence: null,
    relatedEntities: [],
    dedupeKey: `eventsub:${messageId}`,
  });
  if (created) await emitObservation(ctx.db, ctx.publisher, session, observation);
}

/** Processes verified, de-duplicated EventSub notifications asynchronously (the API already acked). */
export async function processEventSub(ctx: ServerContext, data: TwitchJobs["eventsub-process"]): Promise<void> {
  try {
    switch (data.subscriptionType) {
      case "stream.online": {
        const e = StreamOnlineEvent.parse(data.event);
        const b = await getBroadcasterByTwitchId(ctx.db, e.broadcaster_user_id);
        if (!b) break;
        const settings = await getSettings(ctx.db, b.id);
        const session = await upsertTwitchBroadcastSession(ctx.db, {
          broadcasterId: b.id,
          twitchStreamId: e.id,
          startedAt: e.started_at,
          title: null,
          category: null,
          visibility: settings.visibility,
        });
        await invalidateLiveCache(ctx, e.broadcaster_user_id);
        await emitBroadcastStatus(ctx.db, ctx.publisher, session, { state: "live", title: session.title, category: session.category });
        await platformFact(ctx, session, "stream_online", `Went live on Twitch (${e.type})`, data.messageId);
        break;
      }
      case "stream.offline": {
        const e = StreamOfflineEvent.parse(data.event);
        const b = await getBroadcasterByTwitchId(ctx.db, e.broadcaster_user_id);
        if (!b) break;
        await invalidateLiveCache(ctx, e.broadcaster_user_id);
        for (const s of await endTwitchBroadcastSessions(ctx.db, b.id)) {
          await emitBroadcastStatus(ctx.db, ctx.publisher, s, { state: "offline", title: s.title, category: s.category });
          await platformFact(ctx, s, "stream_offline", "Went offline on Twitch", data.messageId);
        }
        break;
      }
      case "channel.update": {
        const e = ChannelUpdateEvent.parse(data.event);
        const b = await getBroadcasterByTwitchId(ctx.db, e.broadcaster_user_id);
        if (!b) break;
        await invalidateLiveCache(ctx, e.broadcaster_user_id);
        const open = await getOpenTwitchSession(ctx.db, b.id);
        if (!open) break;
        await setBroadcastState(ctx.db, open.id, "live", e.title, e.category_name ?? null);
        await emitBroadcastStatus(ctx.db, ctx.publisher, open, { state: "live", title: e.title, category: e.category_name ?? null });
        // Category is creator-supplied metadata — recorded as a Twitch fact, not as proof of the game.
        await platformFact(ctx, open, "channel_update", `Title set to “${e.title}”${e.category_name ? ` · category ${e.category_name}` : ""}`, data.messageId);
        break;
      }
      default:
        await markDeliveryProcessed(ctx.db, data.messageId, "ignored");
        return;
    }
    await markDeliveryProcessed(ctx.db, data.messageId, "processed");
  } catch (err) {
    await markDeliveryProcessed(ctx.db, data.messageId, "failed", (err as Error).message.slice(0, 300));
    throw err;
  }
}
