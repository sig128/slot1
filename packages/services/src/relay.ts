import { lookup } from "node:dns/promises";
import net from "node:net";
import type { RelayDestinationView, RelayPlatform } from "@slot1/contracts";
import { getBroadcaster, getGrant, updateRelayDestination, type RelayDestinationRow } from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import { BROADCASTER_RELAY_SCOPES, HelixError } from "@slot1/twitch";
import type { ServerContext } from "./context";
import { GrantUnavailableError, userToken } from "./twitch";

export const RELAY_PLATFORM_LABEL: Record<RelayPlatform, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
  custom: "Custom server",
};

/** A problem the creator can fix; the message is safe to show them. */
export class RelayDestinationError extends Error {}

/** Whitespace or a control character anywhere (checked by code point, not a regex). */
function hasSpaceOrControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c === 0x7f || /\s/.test(ch)) return true;
  }
  return false;
}

/**
 * Validate a destination server URL: rtmp:// or rtmps:// only, a host, no credentials, no
 * fragments. The stream key is entered separately and never part of this URL.
 */
export function parseRelayServerUrl(raw: string): URL {
  // Pasted values often carry a trailing space or newline; anything inside the address is an error.
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayDestinationError("That server address isn't a valid URL. It should start with rtmps:// or rtmp://");
  }
  if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") throw new RelayDestinationError("The server address must start with rtmps:// or rtmp://");
  if (!url.hostname) throw new RelayDestinationError("The server address has no host");
  if (url.username || url.password) throw new RelayDestinationError("Put the stream key in the key field, not in the server address");
  if (url.hash) throw new RelayDestinationError("The server address can't contain #");
  if (hasSpaceOrControl(value)) throw new RelayDestinationError("The server address contains spaces or control characters");
  return url;
}

export function validateStreamKey(key: string): string {
  const k = key.trim();
  if (k.length < 4 || k.length > 300 || hasSpaceOrControl(k)) throw new RelayDestinationError("That stream key doesn't look right. Copy it again from the platform");
  return k;
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

/**
 * SSRF guard: forwarding connects from SLOT1's servers to the creator's server, so that server
 * must be on the public internet. Checked when saving and again right before every connection.
 */
export async function assertPublicRelayHost(url: URL, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new RelayDestinationError("Forwarding only goes to public streaming servers");
  }
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new RelayDestinationError(`Couldn't find the server ${host}. Check the address`);
  if (addresses.some(isPrivateAddress)) throw new RelayDestinationError("Forwarding only goes to public streaming servers");
}

/** The ffmpeg output URL: server + "/" + key, exactly as OBS joins them. */
export function relayOutputUrl(server: string, key: string): string {
  return `${server.replace(/\/+$/, "")}/${key}`;
}

/** Remove keys, full URLs and anything key-like from text that may be shown or logged. */
export function sanitizeRelayText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  // Any remaining rtmp(s) URL keeps only its host.
  out = out.replace(/rtmps?:\/\/([^/\s'"]+)[^\s'"]*/gi, (_m, host: string) => `rtmp://${host.replace(/^[^@]*@/, "")}/[redacted]`);
  return sanitizeErrorMessage(out);
}

export function relayDestinationView(row: RelayDestinationRow, ctx: ServerContext): RelayDestinationView {
  const server = row.platform === "twitch" ? ctx.config.env.RELAY_TWITCH_INGEST_URL : row.server_url;
  let serverHost: string | null = null;
  try {
    serverHost = server ? new URL(server).hostname : null;
  } catch {
    serverHost = null;
  }
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    enabled: row.enabled,
    status: row.status,
    statusDetail: row.status_detail,
    lastConnectedAt: row.last_connected_at ? row.last_connected_at.toISOString() : null,
    serverHost,
    keyHint: row.key_hint,
  };
}

export async function hasTwitchForwardingPermission(ctx: ServerContext, broadcasterTwitchId: string | null): Promise<boolean> {
  if (!broadcasterTwitchId) return false;
  const g = await getGrant(ctx.db, "broadcaster", broadcasterTwitchId);
  return Boolean(g && g.status !== "revoked" && BROADCASTER_RELAY_SCOPES.every((s) => g.scopes.includes(s)));
}

export type RelayTarget = { ok: true; url: string; secrets: string[]; host: string } | { ok: false; status: "needs_permission" | "error"; detail: string };

/**
 * Work out where to forward a destination right now. Twitch's key is fetched fresh from Twitch
 * (the creator may have reset it) and cached encrypted as a fallback; other keys are decrypted.
 */
export async function resolveRelayTarget(ctx: ServerContext, row: RelayDestinationRow): Promise<RelayTarget> {
  const env = ctx.config.env;
  if (row.platform === "twitch") {
    const b = await getBroadcaster(ctx.db, row.broadcaster_id);
    if (!b?.twitch_user_id) return { ok: false, status: "error", detail: "This channel isn't connected to Twitch" };
    if (!ctx.helix) return { ok: false, status: "error", detail: "Twitch isn't configured on this deployment" };
    if (!(await hasTwitchForwardingPermission(ctx, b.twitch_user_id))) {
      return { ok: false, status: "needs_permission", detail: "Allow SLOT1 to forward to Twitch (reconnect Twitch in Studio)" };
    }
    let key: string | null = null;
    try {
      const { token } = await userToken(ctx, "broadcaster", b.twitch_user_id);
      key = await ctx.helix.getStreamKey(token, b.twitch_user_id);
      const enc = ctx.cipher.encrypt(key);
      await updateRelayDestination(ctx.db, row.id, { keyEnc: enc.value, keyId: enc.keyId, keyHint: key.slice(-4) });
    } catch (err) {
      if (err instanceof GrantUnavailableError) return { ok: false, status: "needs_permission", detail: `${err.message}. ${err.requirement}` };
      if (err instanceof HelixError && (err.status === 401 || err.status === 403)) {
        return { ok: false, status: "needs_permission", detail: "Twitch refused the stream key request. Reconnect Twitch with forwarding allowed" };
      }
      // Twitch is having trouble: fall back to the last key we fetched, if any.
      key = row.key_enc ? ctx.cipher.decrypt(row.key_enc) : null;
      if (!key) return { ok: false, status: "error", detail: "Couldn't get your Twitch stream key right now" };
    }
    return { ok: true, url: relayOutputUrl(env.RELAY_TWITCH_INGEST_URL, key), secrets: [key], host: new URL(env.RELAY_TWITCH_INGEST_URL).hostname };
  }
  if (!row.server_url || !row.key_enc) return { ok: false, status: "error", detail: "Add the server address and stream key" };
  try {
    const url = parseRelayServerUrl(row.server_url);
    await assertPublicRelayHost(url, env.RELAY_ALLOW_PRIVATE_DESTINATIONS);
    const key = ctx.cipher.decrypt(row.key_enc);
    return { ok: true, url: relayOutputUrl(row.server_url, key), secrets: [key], host: url.hostname };
  } catch (err) {
    if (err instanceof RelayDestinationError) return { ok: false, status: "error", detail: err.message };
    return { ok: false, status: "error", detail: "The saved stream key can't be read. Paste it again" };
  }
}
