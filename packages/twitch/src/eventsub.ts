import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const EVENTSUB_HEADERS = {
  id: "twitch-eventsub-message-id",
  timestamp: "twitch-eventsub-message-timestamp",
  signature: "twitch-eventsub-message-signature",
  type: "twitch-eventsub-message-type",
  retry: "twitch-eventsub-message-retry",
  subscriptionType: "twitch-eventsub-subscription-type",
  subscriptionVersion: "twitch-eventsub-subscription-version",
} as const;

export type EventSubMessageType = "notification" | "webhook_callback_verification" | "revocation";

export type VerifyResult =
  | { ok: true; messageId: string; messageType: EventSubMessageType; timestamp: Date; subscriptionType: string | null }
  | { ok: false; reason: "missing_headers" | "bad_signature" | "stale_timestamp" | "future_timestamp" | "bad_message_type" };

export function computeEventSubSignature(secret: string, messageId: string, timestamp: string, rawBody: Buffer | string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(messageId);
  hmac.update(timestamp);
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Verify an EventSub webhook delivery: HMAC-SHA256 over message-id + timestamp + the UNTOUCHED
 * raw body, compared in constant time, and the timestamp must be recent (replay protection).
 */
export function verifyEventSubMessage(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  secret: string;
  now?: Date;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
}): VerifyResult {
  const h = (name: string) => {
    const v = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h(EVENTSUB_HEADERS.id);
  const ts = h(EVENTSUB_HEADERS.timestamp);
  const sig = h(EVENTSUB_HEADERS.signature);
  const type = h(EVENTSUB_HEADERS.type);
  if (!id || !ts || !sig || !type) return { ok: false, reason: "missing_headers" };

  const expected = computeEventSubSignature(input.secret, id, ts, input.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return { ok: false, reason: "stale_timestamp" };
  const now = (input.now ?? new Date()).getTime();
  if (now - when.getTime() > (input.maxAgeMs ?? 10 * 60_000)) return { ok: false, reason: "stale_timestamp" };
  if (when.getTime() - now > (input.maxFutureSkewMs ?? 2 * 60_000)) return { ok: false, reason: "future_timestamp" };

  if (type !== "notification" && type !== "webhook_callback_verification" && type !== "revocation") return { ok: false, reason: "bad_message_type" };
  return { ok: true, messageId: id, messageType: type, timestamp: when, subscriptionType: h(EVENTSUB_HEADERS.subscriptionType) ?? null };
}

export const EventSubSubscription = z.object({
  id: z.string(),
  type: z.string(),
  version: z.string(),
  status: z.string(),
  condition: z.record(z.string(), z.string()),
  created_at: z.string().optional(),
});

export const EventSubEnvelope = z.object({
  subscription: EventSubSubscription,
  event: z.unknown().optional(),
  challenge: z.string().optional(),
});
export type EventSubEnvelope = z.infer<typeof EventSubEnvelope>;

export const StreamOnlineEvent = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
  type: z.string(),
  started_at: z.string(),
});

export const StreamOfflineEvent = z.object({
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
});

export const ChannelUpdateEvent = z.object({
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  title: z.string(),
  category_id: z.string().optional(),
  category_name: z.string().optional(),
});

export const ChatMessageEvent = z.object({
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  chatter_user_id: z.string(),
  chatter_user_login: z.string(),
  chatter_user_name: z.string(),
  message_id: z.string(),
  message: z.object({ text: z.string() }),
  badges: z.array(z.object({ set_id: z.string(), id: z.string().optional(), info: z.string().optional() })).default([]),
  source_broadcaster_user_id: z.string().nullable().optional(),
});
export type ChatMessageEvent = z.infer<typeof ChatMessageEvent>;

/** Subscriptions SLOT1 needs per channel. Nothing else is requested. */
export function requiredSubscriptions(broadcasterTwitchId: string, botTwitchId: string | null, chatEnabled: boolean) {
  const subs: { type: string; version: string; condition: Record<string, string> }[] = [
    { type: "stream.online", version: "1", condition: { broadcaster_user_id: broadcasterTwitchId } },
    { type: "stream.offline", version: "1", condition: { broadcaster_user_id: broadcasterTwitchId } },
    { type: "channel.update", version: "2", condition: { broadcaster_user_id: broadcasterTwitchId } },
  ];
  if (chatEnabled && botTwitchId) {
    subs.push({ type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: broadcasterTwitchId, user_id: botTwitchId } });
  }
  return subs;
}
