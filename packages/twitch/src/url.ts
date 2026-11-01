/**
 * Strict Twitch URL parser. Only twitch.tv hosts and known path shapes are accepted. The parsed
 * result is used to look up public metadata through Helix — the submitted URL itself is never
 * fetched by the server.
 */
export type ParsedTwitchUrl =
  | { kind: "channel"; login: string }
  | { kind: "clip"; slug: string; login: string | null }
  | { kind: "video"; videoId: string };

const LOGIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_]{2,24}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{3,100}$/;
const VIDEO_RE = /^\d{1,15}$/;
const HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);
const CLIP_HOSTS = new Set(["clips.twitch.tv"]);

/** First path segments that are Twitch product pages, not channels. */
const RESERVED = new Set([
  "directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops", "p", "search", "downloads",
  "jobs", "turbo", "prime", "store", "friends", "messages", "payments", "team", "moderator", "popout", "embed",
  "signup", "login", "logout", "user", "broadcast", "dashboard", "creatorcamp", "bits", "partner", "giftcard",
  "legal", "security", "privacy", "help", "following", "activate", "event", "collections", "clip", "clips",
]);

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login) && !RESERVED.has(login.toLowerCase());
}

export function parseTwitchUrl(input: string): ParsedTwitchUrl | null {
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;

  // A bare channel name is accepted as a convenience.
  if (/^[a-zA-Z0-9_]+$/.test(raw)) return isValidLogin(raw) ? { kind: "channel", login: raw.toLowerCase() } : null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (CLIP_HOSTS.has(host)) {
    const slug = parts[0];
    if (parts.length === 1 && slug && SLUG_RE.test(slug)) return { kind: "clip", slug, login: null };
    return null;
  }
  if (!HOSTS.has(host)) return null;

  if (parts[0] === "videos" && parts.length === 2 && parts[1] && VIDEO_RE.test(parts[1])) return { kind: "video", videoId: parts[1] };
  const login = parts[0];
  if (!login || !isValidLogin(login)) return null;
  if (parts.length === 1) return { kind: "channel", login: login.toLowerCase() };
  if (parts.length === 3 && parts[1] === "clip" && parts[2] && SLUG_RE.test(parts[2])) {
    return { kind: "clip", slug: parts[2], login: login.toLowerCase() };
  }
  if (parts.length === 2 && ["videos", "about", "schedule"].includes(parts[1] ?? "")) return { kind: "channel", login: login.toLowerCase() };
  return null;
}

export function channelUrl(login: string): string {
  return `https://www.twitch.tv/${encodeURIComponent(login)}`;
}

/** Official live player embed. `parents` must list every hostname that embeds the player. */
export function liveEmbedUrl(login: string, parents: string[], opts: { autoplay?: boolean; muted?: boolean } = {}): string {
  const q = new URLSearchParams({ channel: login, autoplay: String(opts.autoplay ?? false), muted: String(opts.muted ?? true) });
  for (const p of parents) q.append("parent", p);
  return `https://player.twitch.tv/?${q.toString()}`;
}

export function clipEmbedUrl(slug: string, parents: string[]): string {
  const q = new URLSearchParams({ clip: slug, autoplay: "false", preload: "metadata" });
  for (const p of parents) q.append("parent", p);
  return `https://clips.twitch.tv/embed?${q.toString()}`;
}

export function chatEmbedUrl(login: string, parents: string[], dark = true): string {
  const q = new URLSearchParams();
  if (dark) q.set("darkpopout", "");
  for (const p of parents) q.append("parent", p);
  return `https://www.twitch.tv/embed/${encodeURIComponent(login)}/chat?${q.toString()}`;
}

/** Twitch's documented minimum embed size. */
export const EMBED_MIN_WIDTH = 400;
export const EMBED_MIN_HEIGHT = 300;
