import { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Scopes, each tied to one feature. Documented in docs/TWITCH_SCOPES.md. "Connect my Twitch"
 * asks for every creator scope in one approval (BROADCASTER_CONNECT_SCOPES), so a new streamer
 * goes from connect to a working setup in one flow. Broadcaster and bot identities are separate grants.
 */
export const SCOPES = {
  broadcaster: {
    /** Lets SLOT1's bot account read and post in this channel's chat (EventSub chat via app token). */
    "channel:bot": "Allow the SLOT1 bot account in your chat",
    /** Create live clips when you (or permitted chat users) request one. */
    "clips:edit": "Create clips of your live broadcast",
  },
  broadcasterClipAnalysis: {
    /** Get Clips Download / Create Clip From VOD — needed to download and analyze your clips. */
    "channel:manage:clips": "Download clips so SLOT1 can analyze them",
  },
  broadcasterRelay: {
    /** Get Stream Key: lets SLOT1 forward the creator's SLOT1 ingest to their own Twitch channel. */
    "channel:read:stream_key": "Let SLOT1 forward your stream to your Twitch channel",
  },
  bot: {
    "user:read:chat": "Read chat messages as the bot account",
    "user:write:chat": "Send chat messages as the bot account",
    "user:bot": "Appear as a chat bot (required for chat via app access token)",
  },
} as const;

export const BROADCASTER_BASE_SCOPES = Object.keys(SCOPES.broadcaster);
export const BROADCASTER_CLIP_ANALYSIS_SCOPES = Object.keys(SCOPES.broadcasterClipAnalysis);
export const BROADCASTER_RELAY_SCOPES = Object.keys(SCOPES.broadcasterRelay);
export const BOT_SCOPES = Object.keys(SCOPES.bot);
/** Everything "Connect my Twitch" asks for, in one approval: chat bot, live clips, clip analysis, forwarding. */
export const BROADCASTER_CONNECT_SCOPES = [...BROADCASTER_BASE_SCOPES, ...BROADCASTER_CLIP_ANALYSIS_SCOPES, ...BROADCASTER_RELAY_SCOPES];

export const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().optional(),
  scope: z.array(z.string()).optional().default([]),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const ValidateResponse = z.object({
  client_id: z.string(),
  login: z.string().optional(),
  scopes: z.array(z.string()).nullable().optional(),
  user_id: z.string().optional(),
  expires_in: z.number().int(),
});
export type ValidateResponse = z.infer<typeof ValidateResponse>;

export class TwitchAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "invalid_grant" | "invalid_token" | "bad_request" | "server" | "network",
    /** Twitch's own error text, when it sent one (e.g. "invalid client secret"). */
    readonly twitchMessage?: string,
  ) {
    super(message);
  }
}

export interface OAuthClient {
  idBase: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

export function buildAuthorizeUrl(o: { idBase: string; clientId: string; redirectUri: string; scopes: string[]; state: string; forceVerify?: boolean }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: o.scopes.join(" "),
    state: o.state,
  });
  if (o.forceVerify) q.set("force_verify", "true");
  return `${o.idBase.replace(/\/$/, "")}/authorize?${q.toString()}`;
}

async function postForm(c: OAuthClient, path: string, form: Record<string, string>): Promise<Response> {
  const f = c.fetch ?? fetch;
  try {
    return await f(`${c.idBase.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new TwitchAuthError(`Twitch auth request failed: ${(err as Error).message}`, 0, "network");
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { message?: string };
    return j.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** Authorization-code exchange. The redirect URI must exactly match the one used to authorize. */
export async function exchangeCode(c: OAuthClient, code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await postForm(c, "token", {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!res.ok) {
    const msg = await readError(res);
    throw new TwitchAuthError(`Code exchange failed: ${msg}`, res.status, res.status === 400 ? "invalid_grant" : "server", msg);
  }
  return TokenResponse.parse(await res.json());
}

export async function refreshUserToken(c: OAuthClient, refreshToken: string): Promise<TokenResponse> {
  const res = await postForm(c, "token", {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!res.ok) {
    const msg = await readError(res);
    // 400/401 means the refresh token is invalid or revoked: the user must reconnect.
    const code = res.status === 400 || res.status === 401 ? "invalid_grant" : "server";
    throw new TwitchAuthError(`Token refresh failed: ${msg}`, res.status, code);
  }
  return TokenResponse.parse(await res.json());
}

/** Returns null when Twitch reports the token invalid (401). */
export async function validateToken(c: Pick<OAuthClient, "idBase" | "fetch">, accessToken: string): Promise<ValidateResponse | null> {
  const f = c.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${c.idBase.replace(/\/$/, "")}/validate`, { headers: { authorization: `OAuth ${accessToken}` } });
  } catch (err) {
    throw new TwitchAuthError(`Token validation request failed: ${(err as Error).message}`, 0, "network");
  }
  if (res.status === 401) return null;
  if (!res.ok) throw new TwitchAuthError(`Token validation failed (${res.status})`, res.status, "server");
  return ValidateResponse.parse(await res.json());
}

export async function revokeToken(c: Pick<OAuthClient, "idBase" | "clientId" | "fetch">, token: string): Promise<void> {
  const res = await postForm({ ...c, clientSecret: "" }, "revoke", { client_id: c.clientId, token });
  // 400 "Invalid token" means it is already unusable — treat as revoked.
  if (!res.ok && res.status !== 400) throw new TwitchAuthError(`Revoke failed (${res.status})`, res.status, "server");
}

export async function getAppAccessToken(c: OAuthClient): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await postForm(c, "token", { client_id: c.clientId, client_secret: c.clientSecret, grant_type: "client_credentials" });
  if (!res.ok) throw new TwitchAuthError(`App token request failed: ${await readError(res)}`, res.status, "server");
  const t = TokenResponse.parse(await res.json());
  return { accessToken: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

export function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  const set = new Set(granted);
  return required.every((s) => set.has(s));
}

export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const set = new Set(granted);
  return required.filter((s) => !set.has(s));
}
