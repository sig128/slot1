import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { DataSet, RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { createQaProvider } from "@slot1/analysis";
import { handleCommand, type BotCommand, type BotPorts } from "@slot1/bot";
import {
  CHAT_MESSAGE_MAX,
  CHAT_RETENTION_HOURS,
  PRIVILEGED_COMMANDS,
  momentLink,
  type ChannelCard,
  type ChannelSettings,
  type ChatBadge,
  type ChatMessage,
} from "@slot1/contracts";
import { getBroadcasterByLogin, getConnection, getCurrentLiveSession, getSettings, latestObservation, listObservations, type BroadcasterRow } from "@slot1/db";
import { RedisLimiter } from "@slot1/platform";
import { analysisStatus, answerQuestion, gatherEvidence, hiddenDemo, isOwner, isPublicStream, type ServerContext } from "@slot1/services";
import { parseChatCommand, sanitizeReply } from "@slot1/twitch";
import type { FastifyRequest } from "fastify";
import { getPreviewLogins, isFeatured, previewCards } from "./preview-channels";

/**
 * SLOT1 chat: one shared chat per channel page, next to the Twitch chat. Messages live in a Redis
 * stream per room for at most 24 hours (trimmed by age and count, and the key expires once a room
 * goes quiet); bans and reports are in Postgres (@slot1/db chat.ts). New messages and deletions
 * are published on a Redis channel that the API's EventHub fans out to SSE connections.
 */

const RETENTION_MS = CHAT_RETENTION_HOURS * 3600_000;
const KEEP = 500;
const roomKey = (room: string) => `slot1:chat:room:${room}`;
export const chatChannel = (room: string) => `slot1:chat:pub:${room}`;

/** What's stored per message. `uid` (the poster's user id) never leaves the server. */
export interface StoredChatMessage {
  at: string;
  kind: "user" | "bot";
  uid: string | null;
  name: string;
  badges: ChatBadge[];
  text: string;
  replyTo: { id: string; name: string } | null;
}

export type ChatEvent = { type: "message"; message: ChatMessage } | { type: "delete"; ids: string[] };

export function publicMessage(id: string, m: StoredChatMessage): ChatMessage {
  return { id, at: m.at, kind: m.kind, name: m.name, badges: m.badges, text: m.text, replyTo: m.replyTo };
}

function parseEntry(entry: [string, string[]]): { id: string; m: StoredChatMessage } | null {
  const [id, fields] = entry;
  const i = fields.indexOf("m");
  if (i < 0 || i + 1 >= fields.length) return null;
  try {
    const m = JSON.parse(fields[i + 1]!) as StoredChatMessage;
    // A room that's active all day still drops anything older than 24 hours.
    if (Date.now() - new Date(m.at).getTime() > RETENTION_MS) return null;
    return { id, m };
  } catch {
    return null;
  }
}

/** Stream ids compare as "<ms>-<seq>". */
export function compareIds(a: string, b: string): number {
  const [am, as] = a.split("-").map((x) => BigInt(x || "0"));
  const [bm, bs] = b.split("-").map((x) => BigInt(x || "0"));
  if (am! !== bm!) return am! < bm! ? -1 : 1;
  return as! === bs! ? 0 : as! < bs! ? -1 : 1;
}

export async function appendChatMessage(redis: Redis, room: string, m: StoredChatMessage): Promise<ChatMessage> {
  const key = roomKey(room);
  const id = (await redis.xadd(key, "MAXLEN", "~", String(KEEP), "*", "m", JSON.stringify(m)))!;
  await redis
    .multi()
    .xtrim(key, "MINID", "~", `${Date.now() - RETENTION_MS}-0`)
    .expire(key, CHAT_RETENTION_HOURS * 3600)
    .exec();
  const message = publicMessage(id, m);
  await redis.publish(chatChannel(room), JSON.stringify({ type: "message", message } satisfies ChatEvent));
  return message;
}

/** The newest messages, oldest first. */
export async function recentChatMessages(redis: Redis, room: string, limit = 100): Promise<ChatMessage[]> {
  const rows = (await redis.xrevrange(roomKey(room), "+", "-", "COUNT", String(limit))) as [string, string[]][];
  return rows
    .map(parseEntry)
    .filter((x): x is { id: string; m: StoredChatMessage } => x !== null)
    .reverse()
    .map((x) => publicMessage(x.id, x.m));
}

export async function chatMessagesAfter(redis: Redis, room: string, afterId: string, limit = 200): Promise<ChatMessage[]> {
  const rows = (await redis.xrange(roomKey(room), `(${afterId}`, "+", "COUNT", String(limit))) as [string, string[]][];
  return rows
    .map(parseEntry)
    .filter((x): x is { id: string; m: StoredChatMessage } => x !== null)
    .map((x) => publicMessage(x.id, x.m));
}

export async function getChatMessage(redis: Redis, room: string, id: string): Promise<StoredChatMessage | null> {
  const rows = (await redis.xrange(roomKey(room), id, id)) as [string, string[]][];
  return rows[0] ? (parseEntry(rows[0])?.m ?? null) : null;
}

export async function deleteChatMessages(redis: Redis, room: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const n = await redis.xdel(roomKey(room), ...ids);
  await redis.publish(chatChannel(room), JSON.stringify({ type: "delete", ids } satisfies ChatEvent));
  return n;
}

/** Ids of a poster's messages still in the room (to remove them all when they're banned). */
export async function chatMessageIdsBy(redis: Redis, room: string, uid: string): Promise<string[]> {
  const rows = (await redis.xrevrange(roomKey(room), "+", "-", "COUNT", String(KEEP))) as [string, string[]][];
  return rows
    .map(parseEntry)
    .filter((x): x is { id: string; m: StoredChatMessage } => x !== null && x.m.uid === uid)
    .map((x) => x.id);
}

/* ------------------------------------------------------------------------------------------ */
/* What a message may say                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Everyday swearing stays allowed in GTA chat; slurs and sexual terms don't. */
const ALLOWED_WORDS = new Set(["fuck", "shit", "ass", "arse", "bastard", "bitch", "bollocks", "piss", "turd", "prick", "dick", "wank", "twat", "cuck"]);
const dataset = new DataSet<{ originalWord: string }>().addAll(englishDataset).removePhrasesIf((p) => ALLOWED_WORDS.has(p.metadata?.originalWord ?? ""));
const matcher = new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers });

// Control, zero-width and direction-changing characters (they hide or reorder text).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const LINK =
  /(https?:\/\/|www\.|\b[a-z0-9-]{1,63}\s*(\.|\[\.\]|\(\.\)|\bdot\b)\s*(com|net|org|tv|gg|io|ly|me|co|xyz|ru|cn|info|biz|app|dev|site|online|shop|link|click|live|stream|fun|top|club|be|to|uk|us|de|fr|nl|no|se|dk|fi|es|it|pl|ca|au|nz|in|jp|kr|br|cc|ws|su|pw|zip|mov|sh|lol|gl)\b)/i;

/** One line, no invisible characters, single spaces. */
export function normalizeChatText(raw: string): string {
  return raw.normalize("NFKC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

export type ChatTextProblem = "empty" | "too_long" | "link" | "words";

/** Words spelled out letter by letter ("f a g", "f.a.g"), joined back up to be checked too. */
function spelledOut(text: string): string[] {
  return (text.match(/(?:\b\w\b[\s.\-_*]*){3,}/g) ?? []).map((run) => run.replace(/[\s.\-_*]/g, ""));
}

export function chatTextProblem(text: string): ChatTextProblem | null {
  if (!text) return "empty";
  if (text.length > CHAT_MESSAGE_MAX) return "too_long";
  if (LINK.test(text)) return "link";
  if (matcher.hasMatch(text) || spelledOut(text).some((w) => matcher.hasMatch(w))) return "words";
  return null;
}

export const CHAT_TEXT_PROBLEM: Record<ChatTextProblem, string> = {
  empty: "Write something first.",
  too_long: `Keep it under ${CHAT_MESSAGE_MAX} characters.`,
  link: "Links aren't allowed in SLOT1 chat.",
  words: "That message has words SLOT1 chat doesn't allow. Slurs and sexual terms are blocked.",
};

export const chatTextHash = (text: string) => createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 24);

/* ------------------------------------------------------------------------------------------ */
/* Rooms                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export type ChatRoom =
  | { kind: "featured"; login: string; displayName: string }
  | { kind: "slot1"; login: string; displayName: string; broadcaster: BroadcasterRow; settings: ChannelSettings; owner: boolean };

/**
 * Which channel pages have SLOT1 chat: channels on SLOT1 that the visitor can watch (public and
 * connected, or their own), and featured channels (Admin → Featured channels). Not every pasted
 * Twitch link: nobody can open a SLOT1 chat for a channel that isn't on SLOT1.
 */
export async function resolveChatRoom(ctx: ServerContext, req: FastifyRequest, rawLogin: string): Promise<ChatRoom | null> {
  const login = rawLogin.toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(login)) return null;
  const b = await getBroadcasterByLogin(ctx.db, login);
  if (b && !hiddenDemo(ctx.config, b)) {
    const settings = await getSettings(ctx.db, b.id);
    const owner = isOwner(req.auth.viewer, b.id);
    const conn = b.kind === "twitch" ? await getConnection(ctx.db, b.id) : null;
    if (owner || (settings.visibility === "public" && (b.kind !== "twitch" || conn?.status === "active"))) {
      return { kind: "slot1", login, displayName: b.display_name, broadcaster: b, settings, owner };
    }
  }
  if (await isFeatured(ctx, login)) {
    const card = await featuredCard(ctx, login);
    return { kind: "featured", login, displayName: card?.displayName ?? login.replace(/^kick-/, "") };
  }
  return null;
}

async function featuredCard(ctx: ServerContext, login: string): Promise<ChannelCard | null> {
  // The same list (and cache) as the home page.
  const cards = await previewCards(ctx, await getPreviewLogins(ctx));
  return cards.find((c) => c.login === login) ?? null;
}

export function roomCommands(room: ChatRoom): string[] {
  return room.kind === "featured" ? ["!slot1 now", "!slot1 uptime", "!slot1 followers"] : ["!slot1 now", "!slot1 recap", "!slot1 ask what just happened?"];
}

/* ------------------------------------------------------------------------------------------ */
/* The SLOT1 bot in site chat                                                                 */
/* ------------------------------------------------------------------------------------------ */

const BOT_NAME = "SLOT1";

/** `!slot1 …` or `@slot1 …` (a question). */
export function isBotCall(text: string): boolean {
  return /^(!|@)slot1\b/i.test(text.trim());
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

function uptime(startedAt: string | null, now: number): string | null {
  if (!startedAt) return null;
  const min = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

/**
 * Twitch's live info for a featured channel: SLOT1 doesn't see its video, so the bot only ever
 * answers from what Twitch reports (live state, game, title, viewers, uptime, followers).
 */
export function featuredReply(card: ChannelCard | null, displayName: string, text: string, now = Date.now()): string {
  const m = /^[!@]slot1\b\s*([a-z]+)?\s*(.*)$/i.exec(text.trim());
  const sub = (m?.[1] ?? "help").toLowerCase();
  const b = card?.broadcast;
  const live = b?.state === "live";
  const name = card?.displayName ?? displayName;
  const platform = card?.platform === "kick" ? "Kick" : "Twitch";
  if (card && b?.state === "unknown") return `${name} streams on ${platform}. Their live info isn't available here right now.`;
  const up = live ? uptime(b?.startedAt ?? null, now) : null;
  const nowLine = !card
    ? `I can't reach ${platform} for ${name}'s live info right now.`
    : live
      ? `${name} is live${b?.category ? ` in ${b.category}` : ""}${b?.title ? `: “${b.title}”` : ""}${up ? ` · live ${up}` : ""}${typeof b?.viewerCount === "number" ? ` · ${compact(b.viewerCount)} watching` : ""}.`
      : `${name} is offline right now.`;
  switch (sub) {
    case "now":
    case "status":
      return nowLine;
    case "uptime":
      return live ? (up ? `${name} has been live for ${up}.` : `${name} is live.`) : `${name} is offline right now.`;
    case "game":
      return live && b?.category ? `${name} is playing ${b.category}.` : live ? `${platform} doesn't list a game for ${name} right now.` : `${name} is offline right now.`;
    case "title":
      return live && b?.title ? `“${b.title}”` : `${name} is offline right now.`;
    case "viewers":
      return live && typeof b?.viewerCount === "number" ? `${compact(b.viewerCount)} watching ${name} on ${platform} right now.` : `${name} is offline right now.`;
    case "followers":
      return typeof card?.followers === "number" ? `${name} has ${compact(card.followers)} followers on ${platform}.` : `${platform} didn't give a follower count for ${name}.`;
    case "help":
      return "SLOT1 here: !slot1 now · uptime · game · title · viewers · followers";
    default:
      if (m?.[0]?.startsWith("@") || ["ask", "find", "recap", "clip"].includes(sub)) return `I can't see the game on this stream, only ${platform}'s live info. ${nowLine}`;
      return "SLOT1 here: !slot1 now · uptime · game · title · viewers · followers";
  }
}

/** Limiter keys for site chat never share budgets with the Twitch chat bot. */
function siteLimiter(ctx: ServerContext): Pick<BotPorts, "cooldown" | "take" | "remember"> {
  const limiter = new RedisLimiter(ctx.redis);
  return {
    cooldown: (k, s) => limiter.cooldown(`site:${k}`, s),
    take: async (k, l, w) => ({ allowed: (await limiter.take(`site:${k}`, l, w)).allowed }),
    remember: (k, s) => limiter.remember(`site:${k}`, s),
  };
}

/**
 * The bot's reply to a `!slot1` message on a SLOT1 channel: the same commands and answers as in
 * Twitch chat, read-only (no clips, no creator controls), and only from what the channel shows
 * publicly. Null when the bot stays quiet (cooldowns, duplicates, bot off for the channel).
 */
async function slot1Reply(ctx: ServerContext, room: Extract<ChatRoom, { kind: "slot1" }>, text: string, chatter: { id: string; name: string }): Promise<string | null> {
  const s = room.settings;
  const trimmed = text.trim();
  const cmd: BotCommand | null = trimmed.startsWith("@")
    ? { command: "ask", args: trimmed.replace(/^@slot1\b[\s,:]*/i, "").slice(0, 300), unknown: null }
    : parseChatCommand(trimmed, { aliasesEnabled: false });
  if (!cmd) return null;
  if (PRIVILEGED_COMMANDS.has(cmd.command)) return room.owner ? "Creator commands work in your Twitch chat or in SLOT1 Studio." : null;
  if (cmd.command === "clip") return "Clips are made from Twitch chat: type !slot1 clip there.";

  const session = await getCurrentLiveSession(ctx.db, room.broadcaster.id);
  const visible = session ? room.owner || isPublicStream(session, s) : false;
  const reads = ["now", "recap", "find", "ask"].includes(cmd.command);
  if (session && !visible && reads) return `${room.displayName} keeps this stream's SLOT1 log private.`;
  if (cmd.command === "ask" && s.viewerQuestions === "off" && !room.owner) return `${room.displayName} has turned off questions for SLOT1.`;

  const qa = createQaProvider(ctx.config.env);
  const shown = visible ? session : null;
  const ports: BotPorts = {
    ...siteLimiter(ctx),
    latestObservation: async () => (shown ? latestObservation(ctx.db, shown.id) : null),
    recentObservations: async (windowMs) =>
      shown ? listObservations(ctx.db, shown.id, { sinceReceivedAt: new Date(Date.now() - windowMs).toISOString(), limit: 50 }) : [],
    coverageRatio: async () => {
      if (!shown) return null;
      const dur = (shown.ended_at ?? new Date()).getTime() - shown.started_at.getTime();
      return dur > 0 ? Math.min(1, shown.analyzed_ms / dur) : null;
    },
    search: async (q) => (shown ? gatherEvidence(ctx, shown.id, q) : []),
    answer: async (q) => {
      if (!shown) return { answer: "I haven't observed that.", notObserved: true };
      const r = await answerQuestion(ctx, shown, q, qa);
      return { answer: r.answer, notObserved: r.notObserved };
    },
    requestClip: async () => ({ ok: false, reason: "clips are made from Twitch chat" }),
    setPaused: async () => undefined,
    setMuted: async () => undefined,
    setRecording: async () => ({ ok: false, message: "Creator commands work in Twitch chat or SLOT1 Studio." }),
    setAutoClips: async () => ({ ok: false, message: "Creator commands work in Twitch chat or SLOT1 Studio." }),
    relayStatus: async () => [],
    momentLink: (o) => (shown && o.sessionId === shown.id && o.mediaStartMs !== null && isPublicStream(shown, s) ? momentLink(ctx.config.publicOrigin, o.id) : null),
  };
  const decision = await handleCommand(
    cmd,
    {
      broadcasterId: room.broadcaster.id,
      // "Chat bot" in Studio is about the creator's Twitch chat. Here the bot answers on SLOT1's own
      // page, like Ask SLOT1, so only the creator's kill switch and allowed commands apply.
      settings: { ...s, botEnabled: true },
      globalKill: ctx.config.env.BOT_GLOBAL_KILL,
      globalMessagesPer30s: ctx.config.env.BOT_GLOBAL_MESSAGES_PER_30S,
      chatter: { id: `site:${chatter.id}`, login: chatter.name, isBroadcaster: room.owner, isModerator: false, isVip: false, isSubscriber: false },
      analysis: shown ? analysisStatus(shown, ctx.config) : null,
      broadcastLive: session?.kind === "twitch_broadcast" && session.broadcast_state === "live",
      now: Date.now(),
    },
    ports,
  );
  return decision.reply;
}

/** Post the bot's answer to a `!slot1` message, as a reply to it. */
export async function answerInChat(ctx: ServerContext, room: ChatRoom, asked: ChatMessage, chatter: { id: string; name: string }): Promise<ChatMessage | null> {
  if (ctx.config.env.BOT_GLOBAL_KILL) return null;
  const limiter = new RedisLimiter(ctx.redis);
  let reply: string | null;
  if (room.kind === "featured") {
    // One answer per command every few seconds per room, and at most 20 a minute per room.
    const sub = (/^[!@]slot1\b\s*([a-z]+)?/i.exec(asked.text)?.[1] ?? "help").toLowerCase();
    if (!(await limiter.cooldown(`site-bot:${room.login}:${sub}`, 4)).allowed) return null;
    if (!(await limiter.take(`site-bot:${room.login}`, 20, 60)).allowed) return null;
    reply = featuredReply(await featuredCard(ctx, room.login), room.displayName, asked.text);
  } else {
    reply = await slot1Reply(ctx, room, asked.text, chatter);
  }
  const text = reply ? sanitizeReply(reply) : "";
  if (!text) return null;
  return appendChatMessage(ctx.redis, room.login, {
    at: new Date().toISOString(),
    kind: "bot",
    uid: null,
    name: BOT_NAME,
    badges: ["bot"],
    text,
    replyTo: { id: asked.id, name: asked.name },
  });
}
