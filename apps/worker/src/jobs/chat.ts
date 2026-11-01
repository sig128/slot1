import { createQaProvider } from "@slot1/analysis";
import { handleCommand, type BotPorts } from "@slot1/bot";
import { momentLink, type RelayStatus } from "@slot1/contracts";
import {
  claimChatMessage,
  createClipJob,
  getBotGrant,
  getBroadcasterByTwitchId,
  getBroadcaster,
  getCurrentLiveSession,
  getGrant,
  getSettings,
  latestObservation,
  listObservations,
  listRelayDestinations,
  markDeliveryProcessed,
  setAnalysisState,
  setChatDecision,
  updateSettings,
  recordOpsError,
} from "@slot1/db";
import { QUEUES, RedisLimiter, sanitizeErrorMessage, sha256Hex, type ChatJobs } from "@slot1/platform";
import { analysisStatus, answerQuestion, emitAnalysisStatus, gatherEvidence, isPublicStream, withAppToken, type ServerContext } from "@slot1/services";
import { ChatMessageEvent, parseChatCommand, readBadges, sanitizeReply } from "@slot1/twitch";

/** How forwarding statuses read in chat: short, and never a URL or key. */
const RELAY_STATUS_WORDS: Record<RelayStatus, string> = {
  disabled: "off",
  idle: "waiting for your stream",
  connecting: "connecting",
  live: "live",
  retrying: "retrying",
  error: "needs attention in Studio",
  needs_permission: "needs permission in Studio",
};

/**
 * Send a chat message as the SLOT1 bot via Helix Send Chat Message with the APP access token
 * (cloud chatbot flow: bot grants user:write:chat + user:bot, broadcaster grants channel:bot).
 */
export async function sendChat(ctx: ServerContext, broadcasterTwitchId: string, text: string, replyTo: string | null): Promise<string | null> {
  const bot = await getBotGrant(ctx.db);
  if (!bot || bot.status !== "active" || !ctx.helix) return null;
  const helix = ctx.helix;
  const message = sanitizeReply(text);
  if (!message) return null;
  const res = await withAppToken(ctx, (t) => helix.sendChatMessage(t, { broadcasterId: broadcasterTwitchId, senderId: bot.twitch_user_id, message, replyParentMessageId: replyTo }));
  if (!res.is_sent) {
    ctx.log.warn({ code: res.drop_reason?.code }, "chat message dropped by Twitch");
    return null;
  }
  return res.message_id;
}

/**
 * What `!slot1 record`, `!slot1 autoclip` and `!slot1 relay` do. Permission is checked by the bot
 * before any of these run (broadcaster and approved moderators only).
 */
export function creatorControlPorts(ctx: ServerContext, broadcasterId: string): Pick<BotPorts, "setRecording" | "setAutoClips" | "relayStatus"> {
  return {
    setRecording: async (on) => {
      if (!on) {
        await updateSettings(ctx.db, broadcasterId, { recordingEnabled: false });
        return { ok: true, message: "Recording off. Everything already recorded stays in your SLOT1 library." };
      }
      if (!ctx.config.capabilities.ingest.available) return { ok: false, message: "Recording needs your stream sent to SLOT1, which isn't set up on this SLOT1 server yet." };
      const s = await getSettings(ctx.db, broadcasterId);
      if (!s.recordingConsent) return { ok: false, message: "Recording needs your OK first: SLOT1 Studio → Library → Recording. Then type !slot1 record on again." };
      await updateSettings(ctx.db, broadcasterId, { recordingEnabled: true });
      return { ok: true, message: `Recording on. Your SLOT1 stream is saved to your library for ${s.recordingRetentionDays} days.` };
    },
    setAutoClips: async (on) => {
      await updateSettings(ctx.db, broadcasterId, { autoClips: on });
      if (!on) return { ok: true, message: "Auto-clips off." };
      const s = await getSettings(ctx.db, broadcasterId);
      return s.recordingEnabled && s.recordingConsent
        ? { ok: true, message: "Auto-clips on. SLOT1 clips MISSION PASSED, WASTED and BUSTED moments into your library." }
        : { ok: true, message: "Auto-clips on. Live auto-clips also need recording: !slot1 record on" };
    },
    relayStatus: async () => (await listRelayDestinations(ctx.db, broadcasterId)).map((d) => ({ label: d.label, status: RELAY_STATUS_WORDS[d.status] })),
  };
}

export async function handleChatCommand(ctx: ServerContext, data: ChatJobs["handle-command"]): Promise<void> {
  const parsedEvent = ChatMessageEvent.safeParse(data.event);
  if (!parsedEvent.success) return markDeliveryProcessed(ctx.db, data.messageId, "ignored");
  const e = parsedEvent.data;
  const broadcaster = await getBroadcasterByTwitchId(ctx.db, e.broadcaster_user_id);
  const bot = await getBotGrant(ctx.db);
  // Never react to our own messages, unknown channels, or shared-chat messages from other channels.
  if (!broadcaster || !bot || e.chatter_user_id === bot.twitch_user_id) return markDeliveryProcessed(ctx.db, data.messageId, "ignored");
  if (e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id) return markDeliveryProcessed(ctx.db, data.messageId, "ignored");

  const settings = await getSettings(ctx.db, broadcaster.id);
  const cmd = parseChatCommand(e.message.text, { aliasesEnabled: settings.shortAliasesEnabled });
  if (!cmd) return markDeliveryProcessed(ctx.db, data.messageId, "ignored");
  const claimed = await claimChatMessage(ctx.db, {
    broadcasterId: broadcaster.id,
    chatterUserId: e.chatter_user_id,
    chatterLogin: e.chatter_user_login,
    messageId: e.message_id,
    command: cmd.command,
    argsSha256: cmd.args ? sha256Hex(cmd.args) : null,
    argsLength: cmd.args.length,
  });
  if (!claimed) return markDeliveryProcessed(ctx.db, data.messageId, "ignored");

  const session = await getCurrentLiveSession(ctx.db, broadcaster.id);
  const status = session ? analysisStatus(session, ctx.config) : null;
  const limiter = new RedisLimiter(ctx.redis);
  const qa = createQaProvider(ctx.config.env);
  const badges = readBadges(e.badges, e.chatter_user_id, e.broadcaster_user_id);

  const ports: BotPorts = {
    cooldown: (k, s) => limiter.cooldown(k, s),
    take: (k, l, w) => limiter.take(k, l, w),
    remember: (k, s) => limiter.remember(k, s),
    latestObservation: async () => (session ? latestObservation(ctx.db, session.id) : null),
    recentObservations: async (windowMs) =>
      session ? listObservations(ctx.db, session.id, { sinceReceivedAt: new Date(Date.now() - windowMs).toISOString(), limit: 50 }) : [],
    coverageRatio: async () => {
      if (!session) return null;
      const dur = (session.ended_at ?? new Date()).getTime() - session.started_at.getTime();
      return dur > 0 ? Math.min(1, session.analyzed_ms / dur) : null;
    },
    search: async (q) => (session ? gatherEvidence(ctx, session.id, q) : []),
    answer: async (q) => {
      if (!session) return { answer: "I haven't observed that.", notObserved: true };
      const r = await answerQuestion(ctx, session, q, qa);
      return { answer: r.answer, notObserved: r.notObserved };
    },
    requestClip: async () => {
      if (!session || session.kind !== "twitch_broadcast" || session.broadcast_state !== "live") return { ok: false, reason: "the channel isn't live on Twitch" };
      const grant = broadcaster.twitch_user_id ? await getGrant(ctx.db, "broadcaster", broadcaster.twitch_user_id) : null;
      if (!grant || grant.status !== "active") return { ok: false, reason: "the creator needs to reconnect Twitch" };
      if (!grant.scopes.includes("clips:edit")) return { ok: false, reason: "clip permission (clips:edit) wasn't granted" };
      const { job, created } = await createClipJob(ctx.db, {
        broadcasterId: broadcaster.id,
        sessionId: session.id,
        momentId: null,
        kind: "twitch_live",
        idempotencyKey: `chat:${e.message_id}`,
        requestSource: "chat",
        userId: null,
        chatterId: e.chatter_user_id,
      });
      if (created) await ctx.enqueue(QUEUES.twitch, "create-live-clip", { clipJobId: job.id }, { jobId: `clip-${job.id}`, attempts: 1 });
      return { ok: true, jobId: job.id };
    },
    setPaused: async (paused) => {
      await updateSettings(ctx.db, broadcaster.id, { analysisPaused: paused });
      if (session) {
        const row = await setAnalysisState(ctx.db, session.id, paused ? "stopped" : "ready", paused ? "Analysis paused by the creator" : "Resuming — waiting for frames");
        if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
      }
    },
    setMuted: async (muted) => {
      await updateSettings(ctx.db, broadcaster.id, { commentaryMuted: muted });
    },
    ...creatorControlPorts(ctx, broadcaster.id),
    // Only moments chat viewers can open (public session, a place in the video) get a link.
    momentLink: (o) =>
      session && o.sessionId === session.id && o.mediaStartMs !== null && isPublicStream(session, settings) ? momentLink(ctx.config.publicOrigin, o.id) : null,
  };

  try {
    const decision = await handleCommand(
      cmd,
      {
        broadcasterId: broadcaster.id,
        settings,
        globalKill: ctx.config.env.BOT_GLOBAL_KILL,
        globalMessagesPer30s: ctx.config.env.BOT_GLOBAL_MESSAGES_PER_30S,
        chatter: { id: e.chatter_user_id, login: e.chatter_user_login, ...badges },
        analysis: status,
        broadcastLive: session?.kind === "twitch_broadcast" && session.broadcast_state === "live",
        now: Date.now(),
      },
      ports,
    );
    let replyId: string | null = null;
    if (decision.reply) replyId = await sendChat(ctx, e.broadcaster_user_id, decision.reply, e.message_id);
    await setChatDecision(ctx.db, broadcaster.id, e.message_id, decision.decision, decision.reason, replyId);
    await markDeliveryProcessed(ctx.db, data.messageId, "processed");
  } catch (err) {
    const msg = sanitizeErrorMessage((err as Error).message);
    await setChatDecision(ctx.db, broadcaster.id, e.message_id, "error", msg);
    await recordOpsError(ctx.db, broadcaster.id, "bot", msg);
    await markDeliveryProcessed(ctx.db, data.messageId, "failed", msg);
  }
}

/** Notices (clip ready/failed, commentary). Kill switches and duplicate suppression apply again here. */
export async function postReply(ctx: ServerContext, data: ChatJobs["post-reply"]): Promise<void> {
  if (ctx.config.env.BOT_GLOBAL_KILL) return;
  const b = await getBroadcaster(ctx.db, data.broadcasterId);
  if (!b?.twitch_user_id) return;
  const settings = await getSettings(ctx.db, b.id);
  if (!settings.botEnabled || settings.botKilled) return;
  const limiter = new RedisLimiter(ctx.redis);
  if (!(await limiter.remember(`notice:${data.dedupeKey}`, 3600))) return;
  if (!(await limiter.take("bot:global", ctx.config.env.BOT_GLOBAL_MESSAGES_PER_30S, 30)).allowed) return;
  await sendChat(ctx, b.twitch_user_id, data.text, data.replyToMessageId);
}
