import type { FastifyPluginAsync } from "fastify";
import { recordEventSubDelivery, markDeliveryProcessed, setEventSubStatusById, getBroadcasterByTwitchId } from "@slot1/db";
import { QUEUES } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { EventSubEnvelope, verifyEventSubMessage } from "@slot1/twitch";

/**
 * EventSub webhook callback. Verifies the HMAC over the UNTOUCHED raw body, rejects stale
 * deliveries, de-duplicates by message id, acknowledges immediately and processes in the worker.
 */
export const eventsubRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    // Encapsulated parser: this route receives the raw bytes, not parsed JSON.
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

    app.post("/api/twitch/eventsub", { config: { csrf: false } }, async (req, reply) => {
      const secret = ctx.config.env.TWITCH_EVENTSUB_SECRET;
      if (!secret || !ctx.config.capabilities.eventsub.available) return reply.status(503).send({ error: { code: "unavailable", message: "EventSub not configured" } });
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw)) return reply.status(400).send();
      const v = verifyEventSubMessage({ headers: req.headers as Record<string, string>, rawBody: raw, secret });
      if (!v.ok) {
        req.log.warn({ reason: v.reason }, "eventsub delivery rejected");
        return reply.status(403).send();
      }
      let envelope;
      try {
        envelope = EventSubEnvelope.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        return reply.status(400).send();
      }

      if (v.messageType === "webhook_callback_verification") {
        // Raw challenge string, text/plain, nothing else in the body.
        return reply.status(200).header("content-type", "text/plain").send(envelope.challenge ?? "");
      }

      const broadcasterTwitchId = envelope.subscription.condition.broadcaster_user_id ?? null;
      const fresh = await recordEventSubDelivery(ctx.db, {
        messageId: v.messageId,
        messageType: v.messageType,
        subscriptionId: envelope.subscription.id,
        subscriptionType: envelope.subscription.type,
        broadcasterTwitchId,
      });
      if (!fresh) return reply.status(204).send(); // duplicate delivery: already handled

      if (v.messageType === "revocation") {
        await setEventSubStatusById(ctx.db, envelope.subscription.id, envelope.subscription.status);
        const b = broadcasterTwitchId ? await getBroadcasterByTwitchId(ctx.db, broadcasterTwitchId) : null;
        if (b) await ctx.enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: b.id, reason: `revoked: ${envelope.subscription.status}` });
        await markDeliveryProcessed(ctx.db, v.messageId, "processed");
        return reply.status(204).send();
      }

      if (envelope.subscription.type === "channel.chat.message") {
        const text = (envelope.event as { message?: { text?: string } } | undefined)?.message?.text ?? "";
        // Only possible commands are queued. Ordinary chat is never stored.
        if (text.trimStart().startsWith("!")) {
          await ctx.enqueue(QUEUES.chat, "handle-command", { messageId: v.messageId, event: envelope.event }, { jobId: `chat-${v.messageId}`, attempts: 1 });
        } else {
          await markDeliveryProcessed(ctx.db, v.messageId, "ignored");
        }
      } else {
        await ctx.enqueue(
          QUEUES.twitch,
          "eventsub-process",
          { messageId: v.messageId, subscriptionType: envelope.subscription.type, event: envelope.event },
          { jobId: `es-${v.messageId}` },
        );
      }
      return reply.status(204).send();
    });
  };
