import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadStudioAssetManifest, ProviderError } from "@slot1/analysis";
import {
  BoringInput,
  CreateMomentClipsInput,
  EditForMeInput,
  momentsEdl,
  PolishInput,
  PostTone,
  WritePostInput,
  type AudioAnalysisStatus,
  type BoringResponse,
  type ClipAiSessionsResponse,
  type ClipAiStatusResponse,
  type CreateMomentClipsResponse,
  type Edl,
  type EditForMeResponse,
  type MomentsResponse,
  type PolishResponse,
  type WritePostResponse,
} from "@slot1/contracts";
import { createProject, getSession, type BroadcasterRow, type StreamSessionRow } from "@slot1/db";
import {
  bestMoments,
  boringParts,
  ClipAiError,
  createClipTextModel,
  editForMe,
  listClipAiSessions,
  polishEdl,
  requestAudioAnalysis,
  sessionTitle,
  storedMediaInfo,
  textModelStatus,
  writePosts,
  type ClipTextModel,
  type ServerContext,
} from "@slot1/services";
import { ApiProblem, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const IdParam = z.object({ id: z.string().uuid() });

/** A session of this creator that still exists (others get a plain 404). */
async function ownedSession(ctx: ServerContext, b: BroadcasterRow, id: string): Promise<StreamSessionRow> {
  const s = await getSession(ctx.db, id);
  if (!s || s.broadcaster_id !== b.id || s.delete_requested_at) throw notFound("Session not found");
  return s;
}

/** Every session an edit plays, all owned by this creator. */
async function editSessions(ctx: ServerContext, b: BroadcasterRow, edl: Edl): Promise<StreamSessionRow[]> {
  const ids = [...new Set([...edl.segments.map((s) => s.sessionId), ...edl.overlays.flatMap((t) => t.items.flatMap((it) => (it.type === "pip" ? [it.sessionId] : [])))])];
  const out: StreamSessionRow[] = [];
  for (const id of ids) out.push(await ownedSession(ctx, b, id));
  return out;
}

function textModelOrThrow(ctx: ServerContext): ClipTextModel {
  const m = createClipTextModel(ctx.config.env);
  if (!m) throw new ApiProblem(503, "unavailable", "AI writing isn't set up on this server", textModelStatus(ctx.config).reason);
  return m;
}

/** Turn service refusals and provider failures into API errors with plain messages. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ClipAiError) throw new ApiProblem(err.status, err.status === 429 ? "rate_limited" : "clip_ai", err.message, err.requirement);
    if (err instanceof ProviderError) {
      const busy = err.status === 429 || err.status === 529;
      throw new ApiProblem(502, "provider_error", busy ? "The AI provider is busy right now. Try again in a minute" : `The AI provider didn't answer properly (${err.status ?? "no response"}). Try again`);
    }
    throw err;
  }
}

/**
 * AI clip tools (docs/CLIP_AI.md). Creator-only: every route needs a signed-in creator, and
 * every session, edit and project must be theirs.
 */
export const clipAiRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    /** What the tools can use on this server: the text model and the Studio library. */
    app.get("/api/clip-ai/status", async (req): Promise<ClipAiStatusResponse> => {
      requireBroadcaster(req);
      return { textModel: textModelStatus(ctx.config), libraryAssets: loadStudioAssetManifest().assets.length };
    });

    app.get("/api/clip-ai/sessions", async (req): Promise<ClipAiSessionsResponse> => {
      const b = requireBroadcaster(req);
      return { sessions: await listClipAiSessions(ctx, b.id), textModel: textModelStatus(ctx.config), libraryAssets: loadStudioAssetManifest().assets.length };
    });

    /** Start the one-time loudness analysis of a session's stored video. */
    app.post("/api/clip-ai/sessions/:id/audio", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<AudioAnalysisStatus> => {
      const b = requireBroadcaster(req);
      const s = await ownedSession(ctx, b, IdParam.parse(req.params).id);
      return requestAudioAnalysis(ctx, s);
    });

    app.get("/api/clip-ai/sessions/:id/moments", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply): Promise<MomentsResponse> => {
      const b = requireBroadcaster(req);
      const s = await ownedSession(ctx, b, IdParam.parse(req.params).id);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(30).default(12) }).parse(req.query);
      reply.header("cache-control", "no-store");
      return bestMoments(ctx, s, limit);
    });

    /** Turn picked moments into editable projects: one each, or one best-of reel. */
    app.post("/api/clip-ai/sessions/:id/clips", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<CreateMomentClipsResponse> => {
      const b = requireBroadcaster(req);
      const s = await ownedSession(ctx, b, IdParam.parse(req.params).id);
      const input = CreateMomentClipsInput.parse(req.body);
      const media = await storedMediaInfo(ctx, s.id);
      if (!media) {
        throw new ApiProblem(409, "conflict", "This session has no stored video to clip", s.kind === "replay" ? null : "Turn on Recording in Studio → Library so SLOT1 keeps the video of your streams");
      }
      // Times come from the browser: keep them inside the stored video, drop what's outside it.
      const end = media.durationMs ?? Number.MAX_SAFE_INTEGER;
      const picks = input.moments
        .filter((p) => p.startMs < end - 1000)
        .map((p) => ({ ...p, endMs: Math.min(p.endMs, end), peakMs: p.peakMs !== null && p.peakMs < end ? p.peakMs : null }))
        .filter((p) => p.endMs - p.startMs >= 1000);
      if (!picks.length) throw new ApiProblem(400, "bad_request", "Those moments are outside the stored video");
      const base = sessionTitle(s);
      const userId = req.auth.user?.id ?? null;
      const ids: string[] = [];
      if (input.mode === "reel") {
        const edl = momentsEdl(s.id, picks, { aspect: input.aspect, mode: "reel" });
        const p = await createProject(ctx.db, { broadcasterId: b.id, title: (input.title ?? `Best of ${base}`).slice(0, 120), origin: "manual", edl, userId });
        if (p) ids.push(p.id);
      } else {
        for (const pick of picks) {
          const edl = momentsEdl(s.id, [pick], { aspect: input.aspect, mode: "single" });
          const p = await createProject(ctx.db, { broadcasterId: b.id, title: `${pick.title} · ${base}`.slice(0, 120), origin: "manual", edl, userId });
          if (p) ids.push(p.id);
        }
      }
      return { projectIds: ids };
    });

    app.post("/api/clip-ai/boring", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<BoringResponse> => {
      const b = requireBroadcaster(req);
      const { edl } = BoringInput.parse(req.body);
      return guarded(async () => boringParts(ctx, edl, await editSessions(ctx, b, edl)));
    });

    app.post("/api/clip-ai/polish", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<PolishResponse> => {
      const b = requireBroadcaster(req);
      const input = PolishInput.parse(req.body);
      const { tone } = z.object({ tone: PostTone.default("hype") }).parse({ tone: (req.body as { tone?: unknown } | null)?.tone });
      const model = input.refine ? createClipTextModel(ctx.config.env) : null;
      return guarded(async () => polishEdl(ctx, b.id, input, await editSessions(ctx, b, input.edl), model, tone));
    });

    app.post("/api/clip-ai/post", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req): Promise<WritePostResponse> => {
      const b = requireBroadcaster(req);
      const input = WritePostInput.parse(req.body);
      const model = textModelOrThrow(ctx);
      return guarded(async () => writePosts(ctx, b.id, input, await editSessions(ctx, b, input.edl), model));
    });

    app.post("/api/clip-ai/edit", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req): Promise<EditForMeResponse> => {
      const b = requireBroadcaster(req);
      const input = EditForMeInput.parse(req.body);
      const model = textModelOrThrow(ctx);
      return guarded(async () => editForMe(ctx, b.id, input, await editSessions(ctx, b, input.edl), model));
    });
  };
