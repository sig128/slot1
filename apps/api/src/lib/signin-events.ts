import type { Redis } from "ioredis";
import { TwitchSignInEvent, type TwitchSignInWhy } from "@slot1/contracts";

/** Recent "Sign in with Twitch" results, newest first, for /admin and /status. */
export const TWITCH_SIGNIN_EVENTS_KEY = "slot1:auth:twitch:events";
const KEEP = 50;

/** Best effort: a Redis hiccup must never break a sign-in. */
export async function recordSignInEvent(
  redis: Pick<Redis, "lpush" | "ltrim">,
  e: { outcome: TwitchSignInEvent["outcome"]; why?: TwitchSignInWhy | null; detail?: string | null },
): Promise<void> {
  const event: TwitchSignInEvent = {
    at: new Date().toISOString(),
    outcome: e.outcome,
    why: e.why ?? null,
    detail: e.detail ? e.detail.slice(0, 300) : null,
  };
  try {
    await redis.lpush(TWITCH_SIGNIN_EVENTS_KEY, JSON.stringify(event));
    await redis.ltrim(TWITCH_SIGNIN_EVENTS_KEY, 0, KEEP - 1);
  } catch {
    // Not worth failing the sign-in over.
  }
}

export async function listSignInEvents(redis: Pick<Redis, "lrange">, limit = 20): Promise<TwitchSignInEvent[]> {
  const rows = await redis.lrange(TWITCH_SIGNIN_EVENTS_KEY, 0, Math.max(0, Math.min(limit, KEEP) - 1)).catch(() => [] as string[]);
  const out: TwitchSignInEvent[] = [];
  for (const r of rows) {
    try {
      const p = TwitchSignInEvent.safeParse(JSON.parse(r));
      if (p.success) out.push(p.data);
    } catch {
      // Skip a malformed entry.
    }
  }
  return out;
}

/**
 * Sorts a failed code exchange into a reason the sign-in page can explain. `twitchMessage` is
 * Twitch's own text from the token endpoint, e.g. "invalid client secret" (403),
 * "Invalid authorization code" (400) or "Parameter redirect_uri does not match registered URI" (400).
 */
export function classifyExchangeError(status: number, twitchMessage: string): TwitchSignInWhy {
  const m = twitchMessage.toLowerCase();
  if (status === 0 || status >= 500) return "twitch_down";
  if (m.includes("client secret")) return "app_secret";
  if (m.includes("redirect")) return "redirect";
  if (m.includes("authorization code")) return "code";
  if (m.includes("invalid client") || m.includes("client id") || m.includes("client_id")) return "app_client";
  // The token endpoint answers 401/403 when the app's credentials aren't accepted.
  if (status === 401 || status === 403) return "app_secret";
  return "server";
}
