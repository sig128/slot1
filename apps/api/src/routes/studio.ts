import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { staleAfterMs } from "@slot1/analysis";
import {
  ChannelSettingsPatch,
  CreateIngestSourceInput,
  normalizeCameraMask,
  SetCameraMaskInput,
  type ChannelSettings,
  type CreateIngestSourceResponse,
  type ReadinessStep,
  type StudioOverview,
} from "@slot1/contracts";
import {
  createIngestSource,
  getAssets,
  getBotGrant,
  getConnection,
  getCurrentLiveSession,
  getGrant,
  getSession,
  getSettings,
  getSource,
  getSourceHealth,
  jobRunView,
  latestJobRunForSession,
  listJobRuns,
  listOpsErrors,
  listSessions,
  listSources,
  markPublishEnded,
  requestSessionDeletion,
  revokeSource,
  setAnalysisState,
  setSourceCameraMask,
  toBroadcasterRef,
  updateSettings,
  usageSummary,
  visionCallsInLastHour,
  type BroadcasterRow,
  type GrantRow,
  type MediaSourceRow,
  type SourceHealthRow,
} from "@slot1/db";
import { capabilityFor, publicText, QUEUES, randomToken, sha256, type CapabilityKey } from "@slot1/platform";
import {
  analysisStatus,
  disconnectBroadcaster,
  emitAnalysisStatus,
  sessionSummary,
  signedAssetUrl,
  sourceView,
  withAppToken,
  type ServerContext,
} from "@slot1/services";
import { BROADCASTER_CLIP_ANALYSIS_SCOPES, BROADCASTER_CONNECT_SCOPES, hasScopes, missingScopes } from "@slot1/twitch";
import { badRequest, conflict, notFound, unavailable } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";
import { seesSetupDetails } from "../lib/setup-details";
import { deleteWholeLibrary } from "./library";

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * Why a capability isn't available, for this viewer: operators get the missing server settings
 * and the command that fixes them; creators get a friendly line with no internals.
 */
function setupText(ctx: ServerContext, key: CapabilityKey, setupDetails: boolean, fallback: string): string {
  const c = capabilityFor(key, ctx.config.capabilities[key], setupDetails);
  if (!c.reason) return fallback;
  if (!setupDetails || !c.setup) return sentence(c.reason);
  const missing = c.setup.missing.length ? ` Missing ${c.setup.missing.join(", ")}.` : "";
  const fix = c.setup.command ? ` Fix it on the server: ${c.setup.command}.` : "";
  return `Not set up on the server yet.${missing}${fix}`;
}

/** One Twitch approval grants everything a creator uses; it lands back in Stream setup. */
export const GRANT_PERMISSIONS_URL = `/api/auth/twitch/start?returnTo=${encodeURIComponent("/studio?tab=stream")}`;
const GRANT_LABEL = "Grant the missing permissions";

interface SourceWithHealth {
  source: MediaSourceRow;
  health: SourceHealthRow | null;
}

/** A video source is "ready" only when real frames arrived recently — never on configuration alone. */
function liveSourceReady(sources: SourceWithHealth[], settings: ChannelSettings): SourceWithHealth | null {
  const threshold = staleAfterMs({ expectedIntervalMs: settings.sampleIntervalMs, measuredCadenceMs: null, measuredDelayMs: null });
  return (
    sources.find(
      (s) =>
        s.source.kind === "live_ingest" &&
        s.source.status === "publishing" &&
        s.health?.last_frame_at &&
        Date.now() - s.health.last_frame_at.getTime() <= threshold,
    ) ?? null
  );
}

function readiness(
  ctx: ServerContext,
  b: BroadcasterRow,
  grant: GrantRow | null,
  connStatus: string | null,
  botGrant: GrantRow | null,
  settings: ChannelSettings,
  sources: SourceWithHealth[],
  isOperator: boolean,
  /** Operators and /admin sessions see the missing server settings; creators never do. */
  setupDetails: boolean = isOperator,
): ReadinessStep[] {
  const caps = ctx.config.capabilities;
  const steps: ReadinessStep[] = [];
  const twitchOk = b.kind === "twitch" && connStatus === "active" && grant?.status === "active";
  const link = (label: string, href: string) => ({ label, kind: "link" as const, href, actionId: null });
  const action = (label: string, actionId: string) => ({ label, kind: "action" as const, href: null, actionId });

  const missing = twitchOk ? missingScopes(grant!.scopes, BROADCASTER_CONNECT_SCOPES) : [];
  if (twitchOk && missing.length)
    steps.push({
      id: "twitch_connected",
      label: "Twitch connected",
      status: "todo",
      detail: `Signed in as ${grant!.twitch_login}. Twitch still has to allow ${missing.join(", ")}: one approval adds them all.`,
      action: link(GRANT_LABEL, GRANT_PERMISSIONS_URL),
    });
  else if (twitchOk) steps.push({ id: "twitch_connected", label: "Twitch connected", status: "done", detail: `Signed in as ${grant!.twitch_login}`, action: null });
  else if (!caps.twitch.available)
    steps.push({ id: "twitch_connected", label: "Twitch connected", status: "unavailable", detail: setupText(ctx, "twitch", setupDetails, "Twitch sign-in isn't open yet."), action: null });
  else if (b.kind === "local")
    steps.push({ id: "twitch_connected", label: "Twitch connected", status: "todo", detail: "Local workspace — uploads only.", action: link("Connect Twitch", "/api/auth/twitch/start?returnTo=/studio") });
  else
    steps.push({ id: "twitch_connected", label: "Twitch connected", status: "todo", detail: "Twitch authorization needs renewing.", action: link("Reconnect Twitch", "/api/auth/twitch/start?returnTo=/studio") });

  if (!caps.bot.available) steps.push({ id: "bot_ready", label: "Bot ready", status: "unavailable", detail: setupText(ctx, "bot", setupDetails, "The chat bot isn't switched on yet."), action: null });
  else if (!twitchOk) steps.push({ id: "bot_ready", label: "Bot ready", status: "blocked", detail: "Needs Twitch connected first.", action: null });
  else if (!botGrant || botGrant.status !== "active")
    steps.push(
      isOperator
        ? {
            id: "bot_ready",
            label: "Bot ready",
            status: "todo",
            detail: `Link the dedicated bot account: sign in to Twitch as ${ctx.config.env.SLOT1_BOT_TWITCH_LOGIN ?? "the bot"}.`,
            action: link("Link bot account", "/api/auth/twitch/start?role=bot&returnTo=/studio"),
          }
        : { id: "bot_ready", label: "Bot ready", status: "blocked", detail: "The operator hasn't linked the SLOT1 bot account yet.", action: null },
    );
  else if (!grant!.scopes.includes("channel:bot"))
    steps.push({ id: "bot_ready", label: "Bot ready", status: "todo", detail: "Allow the SLOT1 bot in your chat (channel:bot).", action: link(GRANT_LABEL, GRANT_PERMISSIONS_URL) });
  else if (!settings.botEnabled || settings.botKilled)
    steps.push({ id: "bot_ready", label: "Bot ready", status: "todo", detail: settings.botKilled ? "Kill switch is on." : "Bot is off for your channel.", action: action("Turn on bot", "enable_bot") });
  else steps.push({ id: "bot_ready", label: "Bot ready", status: "done", detail: `SLOT1 answers !slot1 commands as ${botGrant.twitch_login}.`, action: null });

  if (!twitchOk) steps.push({ id: "clip_permissions_ready", label: "Clip permissions ready", status: "blocked", detail: "Needs Twitch connected first.", action: null });
  else if (!grant!.scopes.includes("clips:edit"))
    steps.push({ id: "clip_permissions_ready", label: "Clip permissions ready", status: "todo", detail: "Allow SLOT1 to create clips (clips:edit).", action: link(GRANT_LABEL, GRANT_PERMISSIONS_URL) });
  else if (!hasScopes(grant!.scopes, BROADCASTER_CLIP_ANALYSIS_SCOPES))
    steps.push({
      id: "clip_permissions_ready",
      label: "Clip permissions ready",
      status: "todo",
      detail: "Live clips work. Downloading clips for analysis needs channel:manage:clips.",
      action: link(GRANT_LABEL, GRANT_PERMISSIONS_URL),
    });
  else steps.push({ id: "clip_permissions_ready", label: "Clip permissions ready", status: "done", detail: "Clips can be created, downloaded and analyzed.", action: null });

  const ready = liveSourceReady(sources, settings);
  const ingest = sources.filter((s) => s.source.kind === "live_ingest" && s.source.status !== "revoked");
  if (ready) steps.push({ id: "video_source_ready", label: "Video source ready", status: "done", detail: `Receiving frames from “${ready.source.name}”.`, action: null });
  else if (!caps.ingest.available)
    steps.push({
      id: "video_source_ready",
      label: "Video source ready",
      status: "unavailable",
      detail: `${setupText(ctx, "ingest", setupDetails, "Streaming to SLOT1 isn't open yet.")} Uploaded replays still work.`,
      action: link("How video sources work", "/setup#sources"),
    });
  else if (ingest.length === 0) steps.push({ id: "video_source_ready", label: "Video source ready", status: "todo", detail: "No continuous video source yet.", action: action("Add a video source", "add_source") });
  else steps.push({ id: "video_source_ready", label: "Video source ready", status: "todo", detail: "Source created, but no frames are arriving.", action: link("Publishing help", "/setup#sources") });

  if (settings.agentEnabled) steps.push({ id: "agent_enabled", label: "Agent enabled", status: "done", detail: settings.analysisPaused ? "Enabled, currently paused." : "Analyzing live frames.", action: null });
  else if (ready) steps.push({ id: "agent_enabled", label: "Agent enabled", status: "todo", detail: "Frames are arriving. Turn on live analysis.", action: action("Enable live vision", "enable_agent") });
  else steps.push({ id: "agent_enabled", label: "Agent enabled", status: "blocked", detail: "Needs a video source with real frames.", action: null });
  return steps;
}

export function publishCredentials(ctx: ServerContext, publishPath: string, secret: string) {
  const env = ctx.config.env;
  const name = publishPath.replace(/^live\//, "");
  const server = env.INGEST_PUBLIC_RTMP_URL ?? "";
  const streamKey = env.INGEST_GATEWAY === "mediamtx" ? `${name}?user=${name}&pass=${secret}` : `${name}?key=${secret}`;
  // MediaMTX also accepts WebRTC (WHIP, lowest delay) and SRT publishers on the same path.
  const webrtc = env.INGEST_GATEWAY === "mediamtx" ? env.INGEST_PUBLIC_WEBRTC_URL : null;
  const srt = env.INGEST_GATEWAY === "mediamtx" ? env.INGEST_PUBLIC_SRT_URL : null;
  return {
    streamKey,
    publishUrl: `${server.replace(/\/$/, "")}/${streamKey}`,
    whip: webrtc ? { url: `${webrtc.replace(/\/$/, "")}/${publishPath}/whip`, bearerToken: secret } : null,
    srt: srt ? { url: `${srt.replace(/\/$/, "")}?streamid=publish:${publishPath}:${name}:${secret}` } : null,
  };
}

export const studioRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const load = async (b: BroadcasterRow) => {
      const settings = await getSettings(ctx.db, b.id);
      const grant = b.twitch_user_id ? await getGrant(ctx.db, "broadcaster", b.twitch_user_id) : null;
      const conn = await getConnection(ctx.db, b.id);
      const botGrant = await getBotGrant(ctx.db);
      const sources: SourceWithHealth[] = [];
      for (const s of await listSources(ctx.db, b.id)) sources.push({ source: s, health: await getSourceHealth(ctx.db, s.id) });
      return { settings, grant, conn, botGrant, sources };
    };

    app.get("/api/studio", async (req): Promise<StudioOverview> => {
      const b = requireBroadcaster(req);
      const { settings, grant, conn, botGrant, sources } = await load(b);
      const current = await getCurrentLiveSession(ctx.db, b.id);
      const setupDetails = await seesSetupDetails(ctx, req);
      // Only continuous sources: an uploaded replay is not "what SLOT1 is receiving right now".
      const latestHealth = sources
        .filter((s) => s.source.kind === "live_ingest" && s.health?.last_frame_asset_id)
        .sort((x, y) => (y.health!.last_frame_at?.getTime() ?? 0) - (x.health!.last_frame_at?.getTime() ?? 0))[0];
      let lastFrame: StudioOverview["lastFrame"] = null;
      if (latestHealth?.health?.last_frame_asset_id) {
        const [a] = await getAssets(ctx.db, [latestHealth.health.last_frame_asset_id]);
        if (a?.session_id) {
          lastFrame = { url: await signedAssetUrl(ctx.storage, ctx.config, a), receivedAt: latestHealth.health.last_frame_at!.toISOString(), mediaPtsMs: latestHealth.health.last_frame_pts_ms, sessionId: a.session_id };
        }
      }
      const usage = await usageSummary(ctx.db, b.id);
      const priced = Boolean(ctx.config.env.VISION_PRICE_INPUT_PER_MTOK && ctx.config.env.VISION_PRICE_OUTPUT_PER_MTOK);
      return {
        broadcaster: toBroadcasterRef(b),
        twitch: {
          linked: b.kind === "twitch",
          login: grant?.twitch_login ?? null,
          scopes: grant?.scopes ?? [],
          missingScopes: b.kind === "twitch" && grant && grant.status !== "revoked" ? missingScopes(grant.scopes, BROADCASTER_CONNECT_SCOPES) : [],
          grantStatus: !grant ? "missing" : grant.status,
          lastValidatedAt: grant?.last_validated_at?.toISOString() ?? null,
        },
        readiness: readiness(ctx, b, grant, conn?.status ?? null, botGrant, settings, sources, Boolean(req.auth.user?.is_operator), setupDetails),
        settings,
        // A source's last error can name a server setting; only operators see those.
        sources: sources
          .map((s) => sourceView(s.source, s.health, ctx.config))
          .map((v) => (setupDetails ? v : { ...v, error: publicText(ctx.config.capabilities, v.error) })),
        currentSession: current
          ? await sessionSummary(ctx.db, ctx.storage, ctx.config, current, b, { playbackSource: null, job: await latestJobRunForSession(ctx.db, current.id) })
          : null,
        lastFrame,
        jobs: (await listJobRuns(ctx.db, b.id, 15)).map(jobRunView).map((j) => (setupDetails ? j : { ...j, error: publicText(ctx.config.capabilities, j.error) })),
        usage: {
          periodStart: usage.periodStart,
          visionCalls: usage.visionCalls,
          framesAnalyzed: usage.framesAnalyzed,
          audioSeconds: usage.audioSeconds,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostUsd: priced ? usage.estimatedCostUsd : null,
          costBasis: priced
            ? "Estimated from provider-reported token counts × your configured prices"
            : setupDetails
              ? "Provider-reported token counts. Set VISION_PRICE_INPUT_PER_MTOK and VISION_PRICE_OUTPUT_PER_MTOK on the server to estimate spend."
              : "Provider-reported token counts. SLOT1 doesn't estimate spend yet.",
          maxVisionCallsPerHour: settings.maxVisionCallsPerHour,
          visionCallsLastHour: await visionCallsInLastHour(ctx.db, b.id),
        },
        recentErrors: (await listOpsErrors(ctx.db, b.id, 8)).map((e) => (setupDetails ? e : { ...e, message: publicText(ctx.config.capabilities, e.message) })),
        sessions: (await listSessions(ctx.db, b.id, { limit: 20 })).map((s) => ({
          id: s.id,
          kind: s.kind,
          label: s.label,
          title: s.title,
          startedAt: s.started_at.toISOString(),
          visibility: s.visibility,
        })),
      };
    });

    app.patch("/api/studio/settings", async (req) => {
      const b = requireBroadcaster(req);
      const patch = ChannelSettingsPatch.parse(req.body);
      const current = await getSettings(ctx.db, b.id);
      const visibility = patch.visibility ?? current.visibility;
      if (visibility === "private") {
        patch.directoryOptIn = false;
        patch.publicAnalysis = false;
      }
      if (patch.directoryOptIn && b.kind !== "twitch") throw badRequest("Only Twitch-connected channels can be listed in the directory");
      if ((patch.directoryOptIn || patch.publicAnalysis) && visibility !== "public") throw badRequest("Make the channel public first");
      if (patch.rollingBufferEnabled && !(patch.recordingConsent ?? current.recordingConsent)) {
        throw badRequest("The rolling buffer records your stream — confirm recording consent first");
      }
      if (patch.recordingEnabled && !(patch.recordingConsent ?? current.recordingConsent)) {
        throw badRequest("Recording stores your whole stream — confirm recording consent first");
      }
      if (patch.recordingConsent === false) patch.recordingEnabled = false;
      const updated = await updateSettings(ctx.db, b.id, patch);
      if (patch.botEnabled !== undefined || patch.botKilled !== undefined) {
        await ctx.enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: b.id, reason: "bot settings changed" });
      }
      return updated;
    });

    /** "Enable live vision" can only succeed when real frames are arriving from a real source. */
    app.post("/api/studio/agent", async (req) => {
      const b = requireBroadcaster(req);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const { settings, sources } = await load(b);
      if (enabled) {
        if (!ctx.config.capabilities.ingest.available) throw unavailable("Streaming to SLOT1 isn't open yet", ctx.config.capabilities.ingest.reason);
        if (!liveSourceReady(sources, settings)) throw conflict("No real video frames are arriving yet", "Start publishing to your SLOT1 ingest URL, then try again");
      }
      const updated = await updateSettings(ctx.db, b.id, { agentEnabled: enabled, analysisPaused: false });
      if (!enabled) {
        const s = await getCurrentLiveSession(ctx.db, b.id);
        if (s && s.kind !== "replay") {
          const row = await setAnalysisState(ctx.db, s.id, "stopped", "Analysis stopped by the creator");
          if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
        }
      }
      return updated;
    });

    app.post("/api/studio/analysis/:action", async (req) => {
      const b = requireBroadcaster(req);
      const { action } = z.object({ action: z.enum(["pause", "resume"]) }).parse(req.params);
      const updated = await updateSettings(ctx.db, b.id, { analysisPaused: action === "pause" });
      const s = await getCurrentLiveSession(ctx.db, b.id);
      if (s && s.kind !== "replay" && action === "pause") {
        const row = await setAnalysisState(ctx.db, s.id, "stopped", "Analysis paused by the creator");
        if (row) await emitAnalysisStatus(ctx.db, ctx.publisher, row, analysisStatus(row, ctx.config));
      }
      return updated;
    });

    app.post("/api/studio/commentary/:action", async (req) => {
      const b = requireBroadcaster(req);
      const { action } = z.object({ action: z.enum(["mute", "unmute"]) }).parse(req.params);
      return updateSettings(ctx.db, b.id, { commentaryMuted: action === "mute" });
    });

    /** Creator kill switch: the bot stops replying and commenting immediately. */
    app.post("/api/studio/bot/kill", async (req) => {
      const b = requireBroadcaster(req);
      const { killed } = z.object({ killed: z.boolean() }).parse(req.body);
      const updated = await updateSettings(ctx.db, b.id, { botKilled: killed });
      await ctx.enqueue(QUEUES.twitch, "eventsub-reconcile", { broadcasterId: b.id, reason: "kill switch" });
      return updated;
    });

    app.get("/api/studio/lookup-user", async (req) => {
      requireBroadcaster(req);
      const { login } = z.object({ login: z.string().regex(/^[a-zA-Z0-9_]{3,25}$/) }).parse(req.query);
      if (!ctx.helix) throw unavailable("Twitch isn't connected to SLOT1 yet", ctx.config.capabilities.twitch.reason);
      const helix = ctx.helix;
      const users = await withAppToken(ctx, (t) => helix.getUsers(t, { logins: [login] }));
      const u = users[0];
      if (!u) throw notFound("No Twitch user with that name");
      return { id: u.id, login: u.login, displayName: u.display_name };
    });

    /** Create an authenticated live-ingest source. The stream key is shown once; only a hash is kept. */
    app.post("/api/studio/sources", async (req): Promise<CreateIngestSourceResponse> => {
      const b = requireBroadcaster(req);
      const input = CreateIngestSourceInput.parse(req.body);
      if (!ctx.config.capabilities.ingest.available) throw unavailable("Streaming to SLOT1 isn't open yet", ctx.config.capabilities.ingest.reason);
      const name = `s${randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)}${Date.now().toString(36).slice(-4)}`;
      const secret = randomToken(24).replace(/[^A-Za-z0-9]/g, "x");
      const source = await createIngestSource(ctx.db, {
        broadcasterId: b.id,
        name: input.name,
        label: input.label,
        publishPath: `live/${name}`,
        keyHash: sha256(secret),
        keyHint: secret.slice(-4),
      });
      const creds = publishCredentials(ctx, source.publish_path!, secret);
      return { source: sourceView(source, null, ctx.config), streamKey: creds.streamKey, publishUrl: creds.publishUrl, whip: creds.whip, srt: creds.srt };
    });

    app.post("/api/studio/sources/:id/rotate-key", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const src = await getSource(ctx.db, id);
      if (!src || src.broadcaster_id !== b.id || src.kind !== "live_ingest" || src.revoked_at) throw notFound("Source not found");
      const secret = randomToken(24).replace(/[^A-Za-z0-9]/g, "x");
      await ctx.db.query(`UPDATE media_sources SET publish_key_hash = $2, publish_key_hint = $3, updated_at = now() WHERE id = $1`, [id, sha256(secret), secret.slice(-4)]);
      await markPublishEnded(ctx.db, id);
      return publishCredentials(ctx, src.publish_path!, secret);
    });

    /**
     * "Hide your camera from the AI": the boxes blacked out of every frame SLOT1 analyzes from
     * this live source. Owner only; an empty list removes the mask. The worker applies a change
     * within a few seconds (it restarts its reader for the new mask).
     */
    app.put("/api/studio/sources/:id/camera-mask", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const parsed = SetCameraMaskInput.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid boxes");
      const updated = await setSourceCameraMask(ctx.db, b.id, id, normalizeCameraMask(parsed.data.boxes));
      if (!updated) throw notFound("Source not found");
      return { source: sourceView(updated, await getSourceHealth(ctx.db, updated.id), ctx.config) };
    });

    app.delete("/api/studio/sources/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      if (!(await revokeSource(ctx.db, b.id, id))) throw notFound("Source not found");
      await markPublishEnded(ctx.db, id);
      return { ok: true };
    });

    app.post("/api/studio/twitch/disconnect", async (req) => {
      const b = requireBroadcaster(req);
      await disconnectBroadcaster(ctx, b.id);
      return { ok: true };
    });

    /** Delete every session's media, transcripts and analysis for this channel. */
    app.delete("/api/studio/data", async (req) => {
      const b = requireBroadcaster(req);
      const { confirm } = z.object({ confirm: z.literal("DELETE") }).parse(req.body);
      void confirm;
      const sessions = await listSessions(ctx.db, b.id, { limit: 1000 });
      for (const s of sessions) {
        if (await requestSessionDeletion(ctx.db, b.id, s.id)) {
          await ctx.enqueue(QUEUES.maintenance, "delete-session", { sessionId: s.id, broadcasterId: b.id }, { jobId: `delete-${s.id}` });
        }
      }
      // Library files (clips, renders, screenshots) live outside sessions: remove them too.
      await deleteWholeLibrary(ctx, b.id);
      return { ok: true, scheduled: sessions.length };
    });

    app.get("/api/studio/sessions/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const s = await getSession(ctx.db, id);
      if (!s || s.broadcaster_id !== b.id) throw notFound("Session not found");
      return sessionSummary(ctx.db, ctx.storage, ctx.config, s, b, { playbackSource: null, job: await latestJobRunForSession(ctx.db, s.id) });
    });
  };
