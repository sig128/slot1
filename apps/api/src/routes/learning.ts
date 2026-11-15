import type { FastifyPluginAsync } from "fastify";
import { createQaProvider, type GameEvidence } from "@slot1/analysis";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  activityOf,
  LearningAskInput,
  learningSkills,
  ModelEvaluation,
  questionActivities,
  questionPlaces,
  type LearningAnswer,
  type LearningModel,
  type LearningResponse,
} from "@slot1/contracts";
import {
  consentingChannelCount,
  knowledgeCounts,
  knowledgeEvidence,
  knowledgePlacesFor,
  learningExamples,
  learningFrames,
  learningHeard,
  learningSeen,
  learningWatched,
  listActiveModels,
  type KnowledgeEvidence,
  type TagCount,
} from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

/** Text-model answers per day for "Ask SLOT1 about the game" (it's public); then records only. */
const ASK_MODEL_DAILY = 500;

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
  const [watched, seen, frames, examples, channels, models, heard, counts] = await Promise.all([
    learningWatched(ctx.db),
    learningSeen(ctx.db),
    learningFrames(ctx.db),
    learningExamples(ctx.db),
    consentingChannelCount(ctx.db),
    listActiveModels(ctx.db),
    learningHeard(ctx.db),
    knowledgeCounts(ctx.db),
  ]);
  const byTag = new Map(counts.map((c) => [c.tag, c]));
  const categoryLabel = new Map(ACTIVITY_CATEGORIES.map((c) => [c.key, c.label]));
  const order = new Map(ACTIVITY_CATEGORIES.map((c, i) => [c.key, i]));
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
    activities: [...ACTIVITIES]
      .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99))
      .map((a) => {
        const c = byTag.get(`act:${a.key}`);
        return {
          key: a.key,
          category: a.category,
          categoryLabel: categoryLabel.get(a.category) ?? a.category,
          label: a.label,
          seen: c?.seen ?? 0,
          streams: c?.streams ?? 0,
          lastSeenAt: c?.lastSeenAt ? c.lastSeenAt.toISOString() : null,
        };
      }),
    places: counts
      .filter((c) => c.tag.startsWith("place:"))
      .sort((a, b) => b.seen - a.seen || a.tag.localeCompare(b.tag))
      .slice(0, 40)
      .map((c) => ({ name: c.tag.slice(6), seen: c.seen, streams: c.streams })),
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

    /**
     * POST /api/learning/ask: a question about the game, answered from everything SLOT1 saw on
     * public streams (with the moments as proof), and, when a text model is on, general game
     * knowledge kept apart from it. Never claims SLOT1 saw something it has no record of.
     */
    app.post("/api/learning/ask", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req): Promise<LearningAnswer> => {
      const { question } = LearningAskInput.parse(req.body);
      const acts = questionActivities(question);
      const places = questionPlaces(question);
      const tags = [...acts.map((a) => `act:${a}`), ...places.map((p) => `place:${p}`)];
      const [evidence, counts] = await Promise.all([knowledgeEvidence(ctx.db, { tags, text: question, limit: 12 }), knowledgeCounts(ctx.db)]);
      const facts = await gameFacts(ctx, acts, places, counts);
      const about = { activities: acts.map((a) => activityOf(a)?.label ?? a), places };
      const sourceOf = (e: KnowledgeEvidence) => ({
        observationId: e.id,
        description: e.description,
        channel: e.channelName,
        channelLogin: e.channelLogin,
        at: e.receivedAt,
        href: `/m/${e.id}`,
      });

      const qa = createQaProvider(ctx.config.env);
      const day = `slot1:learning:ask:${new Date().toISOString().slice(0, 10)}`;
      const used = qa?.answerGame ? await ctx.redis.incr(day).catch(() => ASK_MODEL_DAILY + 1) : ASK_MODEL_DAILY + 1;
      if (used === 1) await ctx.redis.expire(day, 2 * 86_400).catch(() => undefined);
      if (qa?.answerGame && used <= ASK_MODEL_DAILY) {
        try {
          const ev: GameEvidence[] = evidence.map((e) => ({ observation: e, channel: e.channelName, at: e.receivedAt.slice(0, 10) }));
          const r = await qa.answerGame(question, ev, facts);
          req.log.info({ learningAsk: { provider: qa.provider, model: qa.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } }, "game question answered");
          const byId = new Map(evidence.map((e) => [e.id, e]));
          const cited = r.answer.citedObservationIds.map((id) => byId.get(id)).filter((e): e is KnowledgeEvidence => Boolean(e));
          return {
            question,
            seen: r.answer.seen && cited.length ? { answer: r.answer.seen, sources: cited.map(sourceOf) } : null,
            general: r.answer.general || null,
            about,
            mode: "model",
          };
        } catch (err) {
          req.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "game question: text model failed, answering from records");
        }
      }
      // From SLOT1's records alone: the counts, and the moments themselves.
      const top = evidence.slice(0, 4);
      const seen = facts.length || top.length ? [...facts, ...top.map((e) => `${e.description} (${e.channelName}).`)].join(" ") : "";
      return { question, seen: seen ? { answer: seen.slice(0, 700), sources: top.map(sourceOf) } : null, general: null, about, mode: "retrieval" };
    });
  };

/** Counts SLOT1 computed for the question's activities and places, as plain sentences. */
async function gameFacts(ctx: ServerContext, acts: string[], places: string[], counts: TagCount[]): Promise<string[]> {
  const byTag = new Map(counts.map((c) => [c.tag, c]));
  const out: string[] = [];
  for (const a of acts.slice(0, 4)) {
    const c = byTag.get(`act:${a}`);
    const label = activityOf(a)?.label ?? a;
    if (!c) continue;
    const where = await knowledgePlacesFor(ctx.db, `act:${a}`, 5);
    const at = where.length ? ` Places seen with it: ${where.map((p) => `${p.place} (${p.seen})`).join(", ")}.` : "";
    out.push(`${label}: seen ${c.seen} ${c.seen === 1 ? "time" : "times"} in ${c.streams} ${c.streams === 1 ? "stream" : "streams"}.${at}`);
  }
  for (const p of places.slice(0, 3)) {
    const c = byTag.get(`place:${p}`);
    if (c) out.push(`${p}: seen ${c.seen} ${c.seen === 1 ? "time" : "times"} in ${c.streams} ${c.streams === 1 ? "stream" : "streams"}.`);
  }
  return out;
}
