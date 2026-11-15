import { z } from "zod";

/**
 * SLOT1 chat: one shared chat per channel page, next to the channel's Twitch chat. Everyone on the
 * page reads it; posting needs a Twitch sign-in (identity only). The SLOT1 bot answers `!slot1`
 * commands in it. Messages are kept for 24 hours.
 */

export const CHAT_MESSAGE_MAX = 300;
/** How long a message stays in a room. */
export const CHAT_RETENTION_HOURS = 24;

/** "team": runs SLOT1 (operators). "creator": the channel's own creator. "bot": the SLOT1 bot. */
export const ChatBadge = z.enum(["bot", "creator", "team"]);
export type ChatBadge = z.infer<typeof ChatBadge>;

/** Redis stream ids: "<ms>-<seq>". */
export const ChatMessageId = z.string().regex(/^\d{1,16}-\d{1,9}$/);

export const ChatMessage = z.object({
  id: ChatMessageId,
  at: z.string(),
  kind: z.enum(["user", "bot"]),
  name: z.string(),
  badges: z.array(ChatBadge),
  text: z.string(),
  /** The message a bot reply answers. */
  replyTo: z.object({ id: ChatMessageId, name: z.string() }).nullable(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatViewer = z.object({
  signedIn: z.boolean(),
  name: z.string().nullable(),
  canPost: z.boolean(),
  /** Why this viewer can't post: not signed in, or banned from this chat. */
  blocked: z.enum(["sign_in", "banned"]).nullable(),
  /** Admins, and the creator in their own channel's chat: delete messages and ban. */
  canModerate: z.boolean(),
  /** Admins only: ban from every SLOT1 chat. */
  canBanEverywhere: z.boolean(),
});
export type ChatViewer = z.infer<typeof ChatViewer>;

export const ChatRoomResponse = z.object({
  room: z.string(),
  displayName: z.string(),
  messages: z.array(ChatMessage),
  viewer: ChatViewer,
  /** Example commands for this room's bot. */
  commands: z.array(z.string()),
});
export type ChatRoomResponse = z.infer<typeof ChatRoomResponse>;

export const ChatPostInput = z.object({ text: z.string().max(2000) });
export const ChatPostResponse = z.object({ message: ChatMessage });
export const ChatBanInput = z.object({ everywhere: z.boolean().default(false) });

/** Admin → Chat: a reported message, with how many people reported it. */
export const AdminChatReport = z.object({
  room: z.string(),
  messageId: ChatMessageId,
  name: z.string(),
  text: z.string(),
  at: z.string(),
  reports: z.number().int(),
  firstReportedAt: z.string(),
  /** False once the message has been deleted or has aged out of the chat. */
  stillInChat: z.boolean(),
});
export type AdminChatReport = z.infer<typeof AdminChatReport>;

export const AdminChatBan = z.object({
  id: z.string(),
  name: z.string(),
  /** null: every SLOT1 chat. */
  room: z.string().nullable(),
  bannedBy: z.string().nullable(),
  at: z.string(),
});
export type AdminChatBan = z.infer<typeof AdminChatBan>;

export const AdminChatResponse = z.object({ reports: z.array(AdminChatReport), bans: z.array(AdminChatBan) });
export type AdminChatResponse = z.infer<typeof AdminChatResponse>;

export const AdminChatResolveInput = z.object({
  room: z.string().max(40),
  messageId: ChatMessageId,
  action: z.enum(["dismiss", "delete", "ban"]),
});
