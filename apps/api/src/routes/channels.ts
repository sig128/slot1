import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { BroadcastSnapshot, ChannelCard, DirectoryResponse, ResolveLinkResponse, WatchChannelResponse } from "@slot1/contracts";
import {
  getBroadcasterByLogin,
  getConnection,
  getCurrentLiveSession,
  getSettings,
  getSourceByPublishPath,
  latestJobRunForSession,
  listDirectoryBroadcasters,
  listSessions,
  type BroadcasterRow,
  type StreamSessionRow,
} from "@slot1/db";
import {
  analysisStatus,
  canViewSession,
  isOwner,
  liveSnapshots,
  sessionSummary,
  withAppToken,
  DEMO_PUBLISH_PATH,
  DEMO_SESSION_TITLE,
  hiddenDemo,
  isDemoBroadcaster,
  type ServerContext,
} from "@slot1/services";
import { channelUrl, parseTwitchUrl, sizeThumbnail } from "@slot1/twitch";
import { badRequest, notFound } from "../lib/errors";

const NO_SOURCE_STATUS = (visionConfigured: boolean) => ({
  state: "no_source" as const,
  reason: "No authorized video source — chat and clips only",
  sourceLabel: null,
  lastReceivedFrameAt: null,
  lastAnalyzedFrameAt: null,
  lastResultAt: null,
  measuredCadenceMs: null,
  measuredDelayMs: null,
  staleAfterMs: null,
  visionConfigured,
});

export async function channelCard(
  ctx: ServerContext,
  b: BroadcasterRow,
  snapshot: BroadcastSnapshot,
  session: StreamSessionRow | null,
  publicAnalysis: boolean,
): Promise<ChannelCard> {
  return {
    broadcasterId: b.id,
    login: b.login,
    displayName: b.display_name,
    avatarUrl: b.avatar_url,
    // SLOT1-only channels (the demo) have no Twitch channel: empty means "no Twitch link".
    twitchUrl: b.kind === "twitch" ? channelUrl(b.login) : "",
    broadcast: snapshot,
    analysis: session ? analysisStatus(session, ctx.config) : NO_SOURCE_STATUS(ctx.config.capabilities.vision.available),
    publicAnalysis,
  };
}

async function demoSending(ctx: ServerContext): Promise<boolean> {
  const src = await getSourceByPublishPath(ctx.db, DEMO_PUBLISH_PATH);
  return Boolean(src && src.status === "publishing" && !src.revoked_at);
}

export const channelRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** ON AIR directory: only creators who connected AND opted in. Never padded with fake channels. */
    app.get("/api/channels", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req): Promise<DirectoryResponse> => {
      const { q } = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query);
      const list = await listDirectoryBroadcasters(ctx.db);
      const snaps = await liveSnapshots(ctx, list);
      const cards: ChannelCard[] = [];
      for (const b of list) {
        const settings = await getSettings(ctx.db, b.id);
        const session = await getCurrentLiveSession(ctx.db, b.id);
        const visible = session && canViewSession({ userId: null, broadcasterId: null, isOperator: false }, session, settings) ? session : null;
        cards.push(await channelCard(ctx, b, snaps.get(b.id)!, visible, settings.publicAnalysis));
      }
      const needle = q?.toLowerCase();
      const filtered = needle
        ? cards.filter((c) =>
            [c.login, c.displayName, c.broadcast.title ?? "", c.broadcast.category ?? ""].some((v) => v.toLowerCase().includes(needle)),
          )
        : cards;
      filtered.sort((a, b) => {
        const la = a.broadcast.state === "live" ? 1 : 0;
        const lb = b.broadcast.state === "live" ? 1 : 0;
        if (la !== lb) return lb - la;
        return (b.broadcast.viewerCount ?? -1) - (a.broadcast.viewerCount ?? -1);
      });
      const refreshed = filtered.map((c) => c.broadcast.lastRefreshedAt).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
      return { channels: filtered, twitchConfigured: ctx.config.capabilities.twitch.available, refreshedAt: refreshed };
    });

    /**
     * Resolve a pasted Twitch link. The URL is parsed strictly and NEVER fetched; public metadata
     * comes from Helix by login. A pasted link only opens a watch-only embed — it does not claim
     * the channel or authorize any recording.
     */
    app.get("/api/channels/resolve", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<ResolveLinkResponse> => {
      const { url } = z.object({ url: z.string().max(300) }).parse(req.query);
      const parsed = parseTwitchUrl(url);
      if (!parsed) throw badRequest("That doesn't look like a Twitch channel, clip or video link");
      const login = parsed.kind === "channel" ? parsed.login : parsed.kind === "clip" ? parsed.login : null;
      const b = login ? await getBroadcasterByLogin(ctx.db, login) : null;
      const conn = b ? await getConnection(ctx.db, b.id) : null;
      const settings = b ? await getSettings(ctx.db, b.id) : null;
      const authorized = Boolean(b && b.kind === "twitch" && conn?.status === "active" && settings?.visibility === "public");
      let metadata: ResolveLinkResponse["metadata"] = null;
      let reason: string | null = null;
      if (login && ctx.helix) {
        try {
          const helix = ctx.helix;
          const [users, streams] = await Promise.all([
            withAppToken(ctx, (t) => helix.getUsers(t, { logins: [login] })),
            withAppToken(ctx, (t) => helix.getStreams(t, { userLogins: [login] })),
          ]);
          const u = users[0];
          if (u) {
            const s = streams[0];
            metadata = { displayName: u.display_name, avatarUrl: u.profile_image_url || null, title: s?.title ?? null, category: s?.game_name ?? null, isLive: Boolean(s) };
          } else reason = "Twitch has no channel with that name";
        } catch {
          reason = "Twitch metadata is temporarily unavailable";
        }
      } else if (login) reason = ctx.config.capabilities.twitch.reason;
      const twitchUrl =
        parsed.kind === "clip" ? `https://clips.twitch.tv/${parsed.slug}` : parsed.kind === "video" ? `https://www.twitch.tv/videos/${parsed.videoId}` : channelUrl(parsed.login);
      return {
        kind: parsed.kind,
        login,
        clipSlug: parsed.kind === "clip" ? parsed.slug : null,
        videoId: parsed.kind === "video" ? parsed.videoId : null,
        slot1Authorized: authorized,
        broadcasterId: authorized ? b!.id : null,
        watchHref: login ? `/watch/${encodeURIComponent(login)}${parsed.kind === "clip" ? `?clip=${encodeURIComponent(parsed.slug)}` : ""}` : twitchUrl,
        twitchUrl,
        metadata,
        metadataUnavailableReason: reason,
      };
    });

    /** Data for the WATCH page. Analysis is included only where the viewer is allowed to see it. */
    app.get("/api/channels/:login/watch", async (req): Promise<WatchChannelResponse> => {
      // "-" only occurs in SLOT1's own demo login; Twitch logins never contain it.
      const { login } = z.object({ login: z.string().min(2).max(25).regex(/^[a-zA-Z0-9_-]+$/) }).parse(req.params);
      const b = await getBroadcasterByLogin(ctx.db, login);
      if (b && hiddenDemo(ctx.config, b)) throw notFound("The demo broadcast is off on this server");
      if (!b && login.includes("-")) throw notFound("Channel not found");
      const viewer = req.auth.viewer;
      if (!b) {
        // Watch-only: a public Twitch channel that is not a SLOT1 channel.
        let snapshot: BroadcastSnapshot = { state: "unknown", title: null, category: null, thumbnailUrl: null, viewerCount: null, startedAt: null, lastRefreshedAt: null };
        let displayName = login;
        let avatar: string | null = null;
        if (ctx.helix) {
          const helix = ctx.helix;
          try {
            const [users, streams] = await Promise.all([
              withAppToken(ctx, (t) => helix.getUsers(t, { logins: [login] })),
              withAppToken(ctx, (t) => helix.getStreams(t, { userLogins: [login] })),
            ]);
            if (users[0]) {
              displayName = users[0].display_name;
              avatar = users[0].profile_image_url || null;
            }
            const s = streams[0];
            snapshot = {
              state: s ? "live" : users[0] ? "offline" : "unknown",
              title: s?.title ?? null,
              category: s?.game_name ?? null,
              thumbnailUrl: s ? sizeThumbnail(s.thumbnail_url, 960, 540) : null,
              viewerCount: s ? s.viewer_count : null,
              startedAt: s?.started_at ?? null,
              lastRefreshedAt: new Date().toISOString(),
            };
          } catch {
            snapshot = { ...snapshot, state: "error" };
          }
        }
        return {
          channel: {
            broadcasterId: "",
            login: login.toLowerCase(),
            displayName,
            avatarUrl: avatar,
            twitchUrl: channelUrl(login),
            broadcast: snapshot,
            analysis: NO_SOURCE_STATUS(ctx.config.capabilities.vision.available),
            publicAnalysis: false,
          },
          authorized: false,
          session: null,
          viewer: { isCreator: false, canAsk: false, askPolicy: "off" },
          recentReplays: [],
        };
      }
      const settings = await getSettings(ctx.db, b.id);
      const owner = isOwner(viewer, b.id);
      const conn = b.kind === "twitch" ? await getConnection(ctx.db, b.id) : null;
      const authorized = owner || (settings.visibility === "public" && (b.kind === "local" || conn?.status === "active"));
      const snaps = await liveSnapshots(ctx, [b]);
      const session = await getCurrentLiveSession(ctx.db, b.id);
      const visibleSession = session && canViewSession(viewer, session, settings) ? session : null;
      if (isDemoBroadcaster(b)) {
        // No Twitch channel behind the demo: its "broadcast" is the generator sending to SLOT1.
        const sending = visibleSession && !visibleSession.ended_at ? await demoSending(ctx) : false;
        snaps.set(b.id, {
          state: sending ? "live" : "offline",
          title: DEMO_SESSION_TITLE,
          category: "Demo (synthetic test video)",
          thumbnailUrl: null,
          viewerCount: null,
          startedAt: sending && visibleSession ? visibleSession.started_at.toISOString() : null,
          lastRefreshedAt: new Date().toISOString(),
        });
      }
      const summary = visibleSession
        ? await sessionSummary(ctx.db, ctx.storage, ctx.config, visibleSession, b, {
            playbackSource: null,
            job: owner ? await latestJobRunForSession(ctx.db, visibleSession.id) : null,
          })
        : null;
      const replays = (await listSessions(ctx.db, b.id, { kind: "replay", publicOnly: !owner, limit: 6 })).filter((s) => owner || canViewSession(viewer, s, settings));
      const canAsk =
        Boolean(visibleSession) &&
        (owner || settings.viewerQuestions === "anyone" || (settings.viewerQuestions === "signed_in" && viewer.userId !== null));
      return {
        channel: await channelCard(ctx, b, snaps.get(b.id)!, visibleSession, settings.publicAnalysis),
        authorized,
        session: summary,
        viewer: { isCreator: owner, canAsk, askPolicy: settings.viewerQuestions },
        recentReplays: replays.map((r) => ({ id: r.id, title: r.title, startedAt: r.started_at.toISOString(), label: r.label })),
      };
    });
  };
