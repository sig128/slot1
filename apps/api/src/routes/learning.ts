import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createQaProvider, type GameEvidence } from "@slot1/analysis";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  activityOf,
  LearningAskInput,
  learningSkills,
  type LearningAskAccess,
  missionLabel,
  ModelEvaluation,
  questionActivities,
  questionMissions,
  questionPlaces,
  summarizeMissions,
  type LearningAnswer,
  type LearningModel,
  type LearningResponse,
  type MissionSummary,
  type StoryEventKind,
} from "@slot1/contracts";
import {
  consentingChannelCount,
  knowledgeCounts,
  knowledgeEntries,
  knowledgeEvidence,
  knowledgePlacesFor,
  learningExamples,
  learningFrames,
  learningHeard,
  learningSeen,
  learningWatched,
  listActiveModels,
  missionRecords,
  namedThings,
  outcomeCauses,
  type KnowledgeEvidence,
  type NamedThing,
  type OutcomeCause,
  type TagCount,
} from "@slot1/db";
import { sanitizeErrorMessage } from "@slot1/platform";
import { readLearningSwitch, type ServerContext } from "@slot1/services";
import { adminAccess } from "../lib/admin-access";

/** Text-model answers per day for "Ask SLOT1 about the game" (it's public); then records only. */
const ASK_MODEL_DAILY = 500;

const TTL_MS = 30_000;
let cache: { at: number; data: LearningResponse } | null = null;
let inflight: Promise<LearningResponse> | null = null;
let storiesCache: { at: number; missions: MissionSummary[]; causes: OutcomeCause[]; named: NamedThing[]; namedTotal: number } | null = null;

export function clearLearningCache() {
  cache = null;
  storiesCache = null;
}

/** Every mission and every result's causes across public streams, computed at most every 30 s. */
async function stories(ctx: ServerContext): Promise<{ missions: MissionSummary[]; causes: OutcomeCause[]; named: NamedThing[]; namedTotal: number }> {
  if (storiesCache && Date.now() - storiesCache.at < TTL_MS) return storiesCache;
  const [records, causes, named] = await Promise.all([missionRecords(ctx.db), outcomeCauses(ctx.db), namedThings(ctx.db)]);
  storiesCache = { at: Date.now(), missions: summarizeMissions(records), causes, named: named.things, namedTotal: named.total };
  return storiesCache;
}

const OUTCOME_LABEL: Record<StoryEventKind, string> = { wasted: "Wasted", busted: "Busted", mission_failed: "Mission failed", mission_passed: "Mission passed" };

const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const actLabel = (k: string) => activityOf(k)?.label ?? k;

/** The newest evaluation of a model, if it has one that parses. */
function latestEvaluation(metrics: unknown): ModelEvaluation | null {
  const list = Array.isArray(metrics) ? metrics.map((m) => ModelEvaluation.safeParse(m)).filter((r) => r.success).map((r) => r.data) : [];
  return list.sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0] ?? null;
}

async function compute(ctx: ServerContext): Promise<LearningResponse> {
  const [watched, seen, frames, examples, channels, models, heard, counts, story, learningSwitch] = await Promise.all([
    learningWatched(ctx.db),
    learningSeen(ctx.db),
    learningFrames(ctx.db),
    learningExamples(ctx.db),
    consentingChannelCount(ctx.db),
    listActiveModels(ctx.db),
    learningHeard(ctx.db),
    knowledgeCounts(ctx.db),
    stories(ctx),
    readLearningSwitch(ctx.redis),
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
    missions: story.missions.slice(0, 40).map((m) => ({
      key: m.key,
      label: missionLabel(m),
      named: Boolean(m.name),
      attempts: m.attempts,
      passed: m.passed,
      failed: m.failed,
      streams: m.streams,
      medianPassMs: m.medianPassMs,
      fastestPassMs: m.fastestPassMs,
      deaths: m.deaths,
      failsAt: m.failsAt,
      failReasons: m.failReasons,
      href: m.proof[0] ? `/m/${m.proof[0]}` : null,
    })),
    named: story.named.map((t) => ({ kind: t.kind, label: t.label, seen: t.seen, streams: t.streams, href: `/m/${t.latestId}` })),
    namedTotal: story.namedTotal,
    outcomes: story.causes.map((c) => ({
      kind: c.kind,
      label: OUTCOME_LABEL[c.kind],
      total: c.total,
      before: c.before.map((b) => ({ key: b.activity, label: actLabel(b.activity), count: b.count })),
      places: c.places.map((p) => ({ name: p.place, count: p.count })),
      href: c.proof[0] ? `/m/${c.proof[0]}` : null,
    })),
    heard,
    models: modelViews,
    ask: { open: watched.analyzedMs / 3_600_000 >= ctx.config.env.SLOT1_ASK_OPENS_AT_HOURS, opensAtHours: ctx.config.env.SLOT1_ASK_OPENS_AT_HOURS },
    learningOn: learningSwitch.on,
  };
}

/** The Learning totals, computed at most every 30 s per API process. */
function learningData(ctx: ServerContext): Promise<LearningResponse> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  inflight ??= compute(ctx)
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Whether this visitor can ask: everyone once SLOT1 has watched enough, admins always. */
async function askAccess(ctx: ServerContext, req: FastifyRequest): Promise<LearningAskAccess> {
  const data = await learningData(ctx);
  const opensAtHours = data.ask.opensAtHours;
  if (data.ask.open) return { open: true, adminOnly: false, hours: data.watched.hours, opensAtHours };
  const admin = Boolean(await adminAccess(ctx, req));
  return { open: admin, adminOnly: admin, hours: data.watched.hours, opensAtHours };
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
      return learningData(ctx);
    });

    /** GET /api/learning/ask: whether this visitor can ask yet (it depends on who's asking). */
    app.get("/api/learning/ask", async (req, reply): Promise<LearningAskAccess> => {
      reply.header("cache-control", "no-store");
      return askAccess(ctx, req);
    });

    /**
     * POST /api/learning/ask: a question about the game, answered from everything SLOT1 saw on
     * public streams (with the moments as proof), and, when a text model is on, general game
     * knowledge kept apart from it. Never claims SLOT1 saw something it has no record of.
     */
    app.post("/api/learning/ask", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply): Promise<LearningAnswer> => {
      const { question } = LearningAskInput.parse(req.body);
      const access = await askAccess(ctx, req);
      if (!access.open) {
        return reply.status(403).send({
          error: { code: "not_open_yet", message: `Ask SLOT1 opens when it has watched ${access.opensAtHours.toLocaleString("en-US")} hours of GTA.`, requirement: null },
        });
      }
      const acts = questionActivities(question);
      const places = questionPlaces(question);
      const tags = [...acts.map((a) => `act:${a}`), ...places.map((p) => `place:${p}`)];
      const [found, counts, story] = await Promise.all([knowledgeEvidence(ctx.db, { tags, text: question, limit: 12 }), knowledgeCounts(ctx.db), stories(ctx)]);
      const asked = missionsAsked(question, story.missions);
      const things = namedAsked(question, story.named);
      const facts = [
        ...missionFacts(asked),
        ...things.map((t) => `${t.label} (${NAMED_KIND[t.kind]}): seen ${times(t.seen, "time", "times")} in ${times(t.streams, "stream", "streams")}.`),
        ...causeFacts(question, acts, story.causes),
        ...(await gameFacts(ctx, acts, places, counts)),
      ];
      // The missions' own result screens and the named things' newest moments first: the answer stands on them.
      const proof = await knowledgeEntries(ctx.db, [...asked.flatMap((m) => m.proof.slice(0, 2)), ...things.map((t) => t.latestId)]);
      const evidence = [...proof, ...found.filter((e) => !proof.some((p) => p.id === e.id))].slice(0, 14);
      const about = { activities: acts.map((a) => activityOf(a)?.label ?? a), places, missions: asked.map((m) => missionLabel(m)), named: things.map((t) => t.label) };
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
      // From SLOT1's records alone: the counts, one per line, and the moments themselves as sources.
      const top = evidence.slice(0, 4);
      const lines = facts.length ? facts : top.length ? [`SLOT1 saw ${top.length === 1 ? "one moment" : `${top.length} moments`} about this on stream.`] : [];
      const seen = lines.join("\n").slice(0, 1500);
      return { question, seen: seen ? { answer: seen, sources: top.map(sourceOf) } : null, general: null, about, mode: "retrieval" };
    });
  };

const NAMED_KIND: Record<NamedThing["kind"], string> = {
  vehicle: "vehicle",
  weapon: "weapon",
  person: "person",
  place: "place",
  item: "item",
  text: "text on screen",
  objective: "objective",
  other: "named thing",
};

/** Named things (vehicles, weapons, people…) a question mentions by name, most seen first. */
function namedAsked(question: string, named: NamedThing[]): NamedThing[] {
  const q = ` ${question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return named
    .filter((t) => {
      const k = t.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return k.length >= 4 && t.kind !== "objective" && t.kind !== "text" && q.includes(` ${k} `);
    })
    .slice(0, 3);
}

/** The missions a question is about: the ones it names, or the most failed ones for "which mission…". */
function missionsAsked(question: string, missions: MissionSummary[]): MissionSummary[] {
  const byKey = new Map(missions.map((m) => [m.key, m]));
  const named = questionMissions(question, missions)
    .map((k) => byKey.get(k))
    .filter((m): m is MissionSummary => Boolean(m));
  if (named.length) return named.slice(0, 3);
  if (/\b(?:which|what|hardest|toughest|most)\b.*\b(?:missions?|heists?)\b|\b(?:missions?|heists?)\b.*\b(?:hardest|toughest|fail(?:s|ed|ing)? (?:the )?most)\b/i.test(question)) {
    return [...missions].filter((m) => m.failed > 0).sort((a, b) => b.failed - a.failed || b.attempts - a.attempts).slice(0, 3);
  }
  return [];
}

/** A mission's attempts across streams, as plain sentences. */
function missionFacts(missions: MissionSummary[]): string[] {
  return missions.map((m) => {
    const parts = [`${missionLabel(m)}: ${times(m.attempts, "attempt", "attempts")} in ${times(m.streams, "stream", "streams")}, ${m.passed} passed, ${m.failed} failed.`];
    if (m.medianPassMs !== null) parts.push(`Passing took about ${minutes(m.medianPassMs)}${m.fastestPassMs !== null && m.fastestPassMs < m.medianPassMs ? ` (fastest ${minutes(m.fastestPassMs)})` : ""}.`);
    if (m.failsAt.length) parts.push(`Failed most at the objective ${m.failsAt.map((f) => `“${f.objective}” (${f.count})`).join(", ")}.`);
    if (m.failReasons.length) parts.push(`The result screen said: ${m.failReasons.map((f) => `“${f.reason}” (${f.count})`).join(", ")}.`);
    if (m.deaths) parts.push(`${times(m.deaths, "death", "deaths")} during it.`);
    if (m.inPassed.length) parts.push(`In passed attempts SLOT1 saw: ${m.inPassed.map((a) => `${actLabel(a.activity)} (${a.count} of ${m.passed})`).join(", ")}.`);
    if (m.inFailed.length) parts.push(`In failed ones: ${m.inFailed.map((a) => `${actLabel(a.activity)} (${a.count} of ${m.failed})`).join(", ")}.`);
    return parts.join("\n");
  });
}

const DEATH_Q = /\b(?:die|dies|dying|died|death|deaths|wasted|killed|kill me|keep dying)\b/i;
const BUST_Q = /\b(?:busted|arrested|caught|jail)\b/i;
const FAIL_Q = /\b(?:fail|fails|failed|failing|lose|losing)\b.*\bmissions?\b|\bmissions?\b.*\b(?:fail|fails|failed|failing)\b/i;

/** What leads to WASTED, BUSTED or MISSION FAILED, when the question is about it. */
function causeFacts(question: string, acts: string[], causes: OutcomeCause[]): string[] {
  const kinds: StoryEventKind[] = [];
  if (DEATH_Q.test(question) || acts.includes("wasted")) kinds.push("wasted");
  if (BUST_Q.test(question) || acts.includes("busted")) kinds.push("busted");
  if (FAIL_Q.test(question) || acts.includes("mission_failed")) kinds.push("mission_failed");
  const out: string[] = [];
  for (const k of kinds) {
    const c = causes.find((x) => x.kind === k);
    if (!c || c.total === 0 || c.before.length === 0) continue;
    const places = c.places.length ? ` Where: ${c.places.map((p) => `${p.place} (${p.count})`).join(", ")}.` : "";
    out.push(`In the minute before ${OUTCOME_LABEL[k].toUpperCase()} (${times(c.total, "time", "times")}) SLOT1 saw: ${c.before.map((b) => `${actLabel(b.activity)} (${b.count})`).join(", ")}.${places}`);
  }
  return out;
}

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
