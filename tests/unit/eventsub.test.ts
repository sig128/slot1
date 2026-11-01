import { describe, expect, it } from "vitest";
import { computeEventSubSignature, verifyEventSubMessage } from "@slot1/twitch";

const secret = "s3cret-for-tests-only-0123456789";
const body = Buffer.from(JSON.stringify({ subscription: { type: "stream.online" }, event: { broadcaster_user_id: "1" } }));

function headers(over: Record<string, string> = {}, ts = new Date().toISOString(), id = "msg-1") {
  return {
    "twitch-eventsub-message-id": id,
    "twitch-eventsub-message-timestamp": ts,
    "twitch-eventsub-message-signature": computeEventSubSignature(secret, id, ts, body),
    "twitch-eventsub-message-type": "notification",
    "twitch-eventsub-subscription-type": "stream.online",
    ...over,
  };
}

describe("verifyEventSubMessage", () => {
  it("accepts a correctly signed, recent notification", () => {
    const r = verifyEventSubMessage({ headers: headers(), rawBody: body, secret });
    expect(r).toMatchObject({ ok: true, messageId: "msg-1", messageType: "notification", subscriptionType: "stream.online" });
  });

  it("rejects a forged signature", () => {
    const h = headers({ "twitch-eventsub-message-signature": computeEventSubSignature("other-secret", "msg-1", new Date().toISOString(), body) });
    expect(verifyEventSubMessage({ headers: h, rawBody: body, secret })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a body that was modified after signing", () => {
    const tampered = Buffer.from(body.toString().replace('"1"', '"2"'));
    expect(verifyEventSubMessage({ headers: headers(), rawBody: tampered, secret })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects re-parsed JSON (signature covers the raw bytes)", () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyEventSubMessage({ headers: headers(), rawBody: reserialized, secret }).ok).toBe(false);
  });

  it("rejects replays older than ten minutes", () => {
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(verifyEventSubMessage({ headers: headers({}, old), rawBody: body, secret })).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects timestamps far in the future", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(verifyEventSubMessage({ headers: headers({}, future), rawBody: body, secret })).toEqual({ ok: false, reason: "future_timestamp" });
  });

  it("rejects missing headers and unknown message types", () => {
    const h = headers();
    delete (h as Record<string, string>)["twitch-eventsub-message-signature"];
    expect(verifyEventSubMessage({ headers: h, rawBody: body, secret })).toEqual({ ok: false, reason: "missing_headers" });
    const ts = new Date().toISOString();
    const bad = headers({ "twitch-eventsub-message-type": "surprise" }, ts);
    expect(verifyEventSubMessage({ headers: bad, rawBody: body, secret })).toEqual({ ok: false, reason: "bad_message_type" });
  });
});
