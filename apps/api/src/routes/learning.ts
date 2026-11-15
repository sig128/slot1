import type { FastifyPluginAsync } from "fastify";
import { learningSkills, ModelEvaluation, type LearningModel, type LearningResponse } from "@slot1/contracts";
import { consentingChannelCount, learningExamples, learningFrames, learningHeard, learningSeen, learningWatched, listActiveModels } from "@slot1/db";
import type { ServerContext } from "@slot1/services";

const TTL_MS = 30_000;
let cache: { at: number; data: LearningResponse } | null = null;
let inflight: Promise<LearningResponse> | null = null;

export function clearLearningCache() {
  cache = null;
}

/** The newest evaluation of a model, if it has one that parses. */
function latestEvaluation(metrics: unknown): ModelEvaluation | null {
  const list = Array.isArray(metrics) ? metrics.map((m) => ModelEvaluation.safeParse(m)).filter((r) => r.success).map((r) => r.data) : [];
  return list.sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0] ?? null;
}

async function compute(ctx: ServerContext): Promise<LearningResponse> {
  const [watched, seen, frames, examples, channels, models, heard] = await Promise.all([
    learningWatched(ctx.db),
    learningSeen(ctx.db),
    learningFrames(ctx.db),
    learningExamples(ctx.db),
    consentingChannelCount(ctx.db),
    listActiveModels(ctx.db),
    learningHeard(ctx.db),
  ]);
  // Per-class scores from the active models' own test sets: scenes from the scene model, screen
  // elements from the detector.
  const scores = new Map<string, number>();
  const modelViews: LearningModel[] = models.map((m) => {
    const ev = latestEvaluation(m.metrics);
    for (const [cls, v] of Object.entries(ev?.perClass ?? {})) scores.set(`${m.task === "scene" ? "scene" : "box"}:${cls}`, Math.max(0, Math.min(1, v.f1)));
    return {
      task: m.task,
      version: m.version,
      activatedAt: m.activated_at ? m.activated_at.toISOString() : null,
      metric: ev?.primaryMetric ?? null,
      score: ev ? ev.value : null,
      testFrames: ev ? ev.testFrames : null,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    watched: {
      streams: watched.streams,
      channels: watched.channels,
      hours: Math.round((watched.analyzedMs / 3_600_000) * 10) / 10,
      caught: [...seen.values()].reduce((a, b) => a + b, 0),
    },
    learning: { channels, frames: frames.frames, labeledFrames: frames.labeled },
    skills: learningSkills({ examples, seen, scores }),
    heard,
    models: modelViews,
  };
}

/**
 * GET /api/learning: what SLOT1's AI has watched, caught and learned, combined across every
 * stream. Public, the same for everyone, computed at most every 30 s per API process.
 */
export const learningRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/learning", async (_req, reply): Promise<LearningResponse> => {
      reply.header("cache-control", "public, max-age=15");
      if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
      inflight ??= compute(ctx)
        .then((data) => {
          cache = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    });
  };
