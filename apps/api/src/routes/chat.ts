import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminChatResolveInput,
  ChatBanInput,
  ChatMessageId,
  ChatPostInput,
  type AdminChatResponse,
  type ChatBadge,
  type ChatMessage,
  type ChatRoomResponse,
} from "@slot1/contracts";
import { addChatBan, addChatReport, getOpenChatReport, isChatBanned, listChatBans, listOpenChatReports, removeChatBan, resolveChatReports } from "@slot1/db";
import { RedisLimiter } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";
import { adminAccess, requireAdmin } from "../lib/admin-access";
import {
  CHAT_TEXT_PROBLEM,
  answerInChat,
  appendChatMessage,
  chatChannel,
  chatMessageIdsBy,
  chatMessagesAfter,
  chatTextHash,
  chatTextProblem,
  compareIds,
  deleteChatMessages,
  getChatMessage,
  isBotCall,
  normalizeChatText,
  recentChatMessages,
  resolveChatRoom,
  roomCommands,
  type ChatEvent,
  type ChatRoom,
} from "../lib/chat";
import { ApiProblem, badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import type { EventHub } from "../lib/hub";

const LoginParam = z.object({ login: z.string().min(2).max(32) });
const MessageParam = z.object({ login: z.string().min(2).max(32), id: ChatMessageId });
const tooFast = (msg: string) => new ApiProblem(429, "rate_limited", msg);

async function room(ctx: ServerContext, req: FastifyRequest, login: string): Promise<ChatRoom> {
  const r = await resolveChatRoom(ctx, req, login);
  if (!r) throw notFound("SLOT1 chat isn't open on this channel.");
  return r;
}

/** Admins moderate every chat; a creator moderates their own channel's chat. */
async function moderation(ctx: ServerContext, req: FastifyRequest, r: ChatRoom): Promise<{ moderate: boolean; everywhere: boolean }> {
  const admin = Boolean(await adminAccess(ctx, req));
  return { moderate: admin || (r.kind === "slot1" && r.owner), everywhere: admin };
}

function badgesFor(req: FastifyRequest, r: ChatRoom): ChatBadge[] {
  const badges: ChatBadge[] = [];
  if (r.kind === "slot1" && r.owner) badges.push("creator");
  if (req.auth.user?.is_operator) badges.push("team");
  return badges;
}

/**
 * SLOT1 chat: GET a room (recent messages and what this viewer may do), live updates over SSE,
 * posting (Twitch sign-in, filters, rate limits; `!slot1` gets the bot's answer), moderation
 * (delete, ban) and reports. Admin → Chat handles reports and bans.
 */
export const chatRoutes =
  (ctx: ServerContext, hub: EventHub): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/chat/:login", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply): Promise<ChatRoomResponse> => {
      const r = await room(ctx, req, LoginParam.parse(req.params).login);
      reply.header("cache-control", "no-store");
      const user = req.auth.user;
      const banned = user ? await isChatBanned(ctx.db, user.id, r.login) : false;
      const mod = await moderation(ctx, req, r);
      return {
        room: r.login,
        displayName: r.displayName,
        messages: await recentChatMessages(ctx.redis, r.login, 100),
        viewer: {
          signedIn: Boolean(user),
          name: user?.display_name ?? null,
          canPost: Boolean(user) && !banned,
          blocked: !user ? "sign_in" : banned ? "banned" : null,
          canModerate: mod.moderate,
          canBanEverywhere: mod.everywhere,
        },
        commands: roomCommands(r),
      };
    });

    /**
     * Live updates. Reconnects send Last-Event-ID (or ?after=) and get what they missed; every
     * (re)connect also gets `sync`, the ids still in the room, so a page drops messages that were
     * deleted while it was away.
     */
    app.get("/api/chat/:login/events", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply: FastifyReply) => {
      const r = await room(ctx, req, LoginParam.parse(req.params).login);
      const header = req.headers["last-event-id"];
      const raw = (Array.isArray(header) ? header[0] : header) ?? (req.query as { after?: string }).after ?? null;
      let last = raw && ChatMessageId.safeParse(raw).success ? raw : null;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const send = (m: ChatMessage) => {
        if (last && compareIds(m.id, last) <= 0) return; // never twice
        last = m.id;
        res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
      };
      const handle = (message: string) => {
        let e: ChatEvent;
        try {
          e = JSON.parse(message) as ChatEvent;
        } catch {
          return;
        }
        if (e.type === "message") send(e.message);
        else if (e.type === "delete") res.write(`event: delete\ndata: ${JSON.stringify({ ids: e.ids })}\n\n`);
      };
      // Subscribe first and buffer, then catch up, then flush: nothing is lost in between.
      const buffered: string[] = [];
      let live = false;
      const unsubscribe = await hub.subscribeRaw(chatChannel(r.login), (m) => (live ? handle(m) : buffered.push(m)));
      try {
        if (last) for (const m of await chatMessagesAfter(ctx.redis, r.login, last)) send(m);
        const ids = (await recentChatMessages(ctx.redis, r.login, 150)).map((m) => m.id);
        res.write(`event: sync\ndata: ${JSON.stringify({ ids })}\n\n`);
        for (const m of buffered) handle(m);
        live = true;
      } catch {
        await unsubscribe();
        res.end();
        return;
      }
      const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
      req.raw.on("close", () => {
        clearInterval(ping);
        void unsubscribe();
      });
    });

    app.post("/api/chat/:login/messages", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
      const r = await room(ctx, req, LoginParam.parse(req.params).login);
      const user = req.auth.user;
      if (!user) throw unauthorized("Sign in with Twitch to chat.");
      if (await isChatBanned(ctx.db, user.id, r.login)) throw forbidden("You can't post in this chat.");
      const text = normalizeChatText(ChatPostInput.parse(req.body).text);
      const problem = chatTextProblem(text);
      if (problem) throw badRequest(CHAT_TEXT_PROBLEM[problem]);

      const limiter = new RedisLimiter(ctx.redis);
      if (!(await limiter.cooldown(`chat:post:${user.id}`, 1)).allowed) throw tooFast("One message a second, please.");
      if (!(await limiter.take(`chat:post:min:${user.id}`, 20, 60)).allowed) throw tooFast("That's 20 messages this minute. Take a breather and try again shortly.");
      if (!(await limiter.remember(`chat:dup:${r.login}:${user.id}:${chatTextHash(text)}`, 30))) throw badRequest("You just sent that.");

      const message = await appendChatMessage(ctx.redis, r.login, {
        at: new Date().toISOString(),
        kind: "user",
        uid: user.id,
        name: user.display_name.slice(0, 40),
        badges: badgesFor(req, r),
        text,
        replyTo: null,
      });
      if (isBotCall(text)) {
        // The answer arrives like any other message; posting doesn't wait for it.
        void answerInChat(ctx, r, message, { id: user.id, name: user.display_name }).catch((err: Error) => req.log.warn({ err: err.message }, "chat: bot answer failed"));
      }
      reply.code(201);
      return { message };
    });

    app.delete("/api/chat/:login/messages/:id", async (req) => {
      const { login, id } = MessageParam.parse(req.params);
      const r = await room(ctx, req, login);
      if (!(await moderation(ctx, req, r)).moderate) throw forbidden("Only admins and this channel's creator can delete messages.");
      await deleteChatMessages(ctx.redis, r.login, [id]);
      await resolveChatReports(ctx.db, r.login, id);
      return { ok: true };
    });

    /** Ban whoever wrote a message (and remove their messages here). Everywhere: admins only. */
    app.post("/api/chat/:login/messages/:id/ban", async (req) => {
      const { login, id } = MessageParam.parse(req.params);
      const r = await room(ctx, req, login);
      const { everywhere } = ChatBanInput.parse(req.body ?? {});
      const mod = await moderation(ctx, req, r);
      if (!mod.moderate) throw forbidden("Only admins and this channel's creator can ban.");
      if (everywhere && !mod.everywhere) throw forbidden("Only admins can ban from every SLOT1 chat.");
      const m = await getChatMessage(ctx.redis, r.login, id);
      if (!m) throw notFound("That message is gone. It was deleted or is older than 24 hours.");
      if (!m.uid) throw badRequest("The SLOT1 bot can't be banned.");
      if (m.uid === req.auth.user?.id) throw badRequest("You can't ban yourself.");
      await addChatBan(ctx.db, { userId: m.uid, room: everywhere ? null : r.login, name: m.name, bannedBy: req.auth.user?.id ?? null });
      await deleteChatMessages(ctx.redis, r.login, await chatMessageIdsBy(ctx.redis, r.login, m.uid));
      await resolveChatReports(ctx.db, r.login, id);
      return { ok: true };
    });

    app.post("/api/chat/:login/messages/:id/report", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
      const { login, id } = MessageParam.parse(req.params);
      const r = await room(ctx, req, login);
      const user = req.auth.user;
      if (!user) throw unauthorized("Sign in with Twitch to report a message.");
      const m = await getChatMessage(ctx.redis, r.login, id);
      if (!m) throw notFound("That message is gone. It was deleted or is older than 24 hours.");
      if (m.kind === "bot") throw badRequest("Bot answers can't be reported here. Use the contact page if one is wrong.");
      if (m.uid === user.id) throw badRequest("That's your own message.");
      await addChatReport(ctx.db, { room: r.login, messageId: id, authorUserId: m.uid, authorName: m.name, text: m.text, messageAt: m.at, reporterUserId: user.id });
      return { ok: true };
    });

    /* Admin → Chat ------------------------------------------------------------------------- */

    app.get("/api/admin/chat", async (req, reply): Promise<AdminChatResponse> => {
      await requireAdmin(ctx, req, reply);
      const [reports, bans] = await Promise.all([listOpenChatReports(ctx.db), listChatBans(ctx.db)]);
      const still = await Promise.all(reports.map((x) => getChatMessage(ctx.redis, x.room, x.message_id)));
      return {
        reports: reports.map((x, i) => ({
          room: x.room,
          messageId: x.message_id,
          name: x.author_name,
          text: x.text,
          at: x.message_at.toISOString(),
          reports: x.reports,
          firstReportedAt: x.first_reported_at.toISOString(),
          stillInChat: still[i] !== null,
        })),
        bans: bans.map((b) => ({ id: b.id, name: b.name, room: b.room, bannedBy: b.banned_by_name, at: b.created_at.toISOString() })),
      };
    });

    /** Handle a report: dismiss it, delete the message, or ban the writer from every chat. */
    app.post("/api/admin/chat/reports/resolve", async (req, reply) => {
      await requireAdmin(ctx, req, reply);
      const { room: login, messageId, action } = AdminChatResolveInput.parse(req.body);
      const report = await getOpenChatReport(ctx.db, login, messageId);
      if (!report) throw notFound("That report was already handled.");
      if (action === "delete" || action === "ban") await deleteChatMessages(ctx.redis, login, [messageId]);
      if (action === "ban" && report.author_user_id) {
        await addChatBan(ctx.db, { userId: report.author_user_id, room: null, name: report.author_name, bannedBy: req.auth.user?.id ?? null });
        await deleteChatMessages(ctx.redis, login, await chatMessageIdsBy(ctx.redis, login, report.author_user_id));
      }
      await resolveChatReports(ctx.db, login, messageId);
      return { ok: true };
    });

    app.delete("/api/admin/chat/bans/:id", async (req, reply) => {
      await requireAdmin(ctx, req, reply);
      const { id } = z.object({ id: z.string().regex(/^\d{1,18}$/) }).parse(req.params);
      if (!(await removeChatBan(ctx.db, id))) throw notFound("That ban was already lifted.");
      return { ok: true };
    });
  };
