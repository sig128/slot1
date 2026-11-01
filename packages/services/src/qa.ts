import { retrievalAnswer, type QaProvider } from "@slot1/analysis";
import type { AskResponse, Observation } from "@slot1/contracts";
import { latestObservation, listObservations, listObservationsByType, recordUsage, searchSessionObservations, type StreamSessionRow } from "@slot1/db";
import { analysisStatus } from "./views";
import type { ServerContext } from "./context";

const TYPE_HINTS: [RegExp, string[]][] = [
  [/\b(crash|crashed|collision|collide|wreck)/i, ["possible_collision"]],
  [/\bobjective|mission text|what (do|should) (i|they) do/i, ["objective_text"]],
  [/\b(conversation|dialogue|said|say|subtitle|talk)/i, ["subtitle", "dialogue"]],
  [/\b(where|place|location|street|area)\b/i, ["place_name", "landmark"]],
  [/\b(car|vehicle|bike|truck|drive|driving)/i, ["vehicle", "vehicle_enter_exit"]],
  [/\b(passed|failed|wasted|busted|result)\b/i, ["result_screen"]],
  [/\b(fight|shoot|shot|gun|combat)/i, ["combat"]],
];
const RECENT_RE = /\b(just|now|latest|recent|happening|happened)\b/i;

/** Gather authorized evidence for a question, always scoped to ONE session id. */
export async function gatherEvidence(ctx: ServerContext, sessionId: string, question: string): Promise<Observation[]> {
  const found = new Map<string, Observation>();
  for (const o of await searchSessionObservations(ctx.db, sessionId, question, 8)) found.set(o.id, o);
  for (const [re, types] of TYPE_HINTS) {
    if (re.test(question)) for (const o of await listObservationsByType(ctx.db, sessionId, types, 6)) found.set(o.id, o);
  }
  if (found.size === 0 && RECENT_RE.test(question)) {
    const since = new Date(Date.now() - 3 * 60_000).toISOString();
    for (const o of (await listObservations(ctx.db, sessionId, { sinceReceivedAt: since, limit: 10 })).filter((x) => x.origin !== "twitch")) found.set(o.id, o);
  }
  return [...found.values()]
    .filter((o) => o.reviewStatus !== "rejected" && o.type !== "media_facts" && o.type !== "session_coverage")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, 10);
}

export async function answerQuestion(ctx: ServerContext, session: StreamSessionRow, question: string, qa: QaProvider | null): Promise<AskResponse> {
  const status = analysisStatus(session, ctx.config);
  const latest = await latestObservation(ctx.db, session.id);
  const ageMs = latest ? Date.now() - new Date(latest.receivedAt).getTime() : null;
  const stale = status.state === "stale";
  const evidence = await gatherEvidence(ctx, session.id, question);
  const freshnessNote = session.kind === "replay" ? "This is a replay of a recording." : stale ? "The live feed is stale; evidence may be old." : "Live session.";
  let mode: AskResponse["mode"] = "retrieval";
  let answer = retrievalAnswer(evidence);
  if (qa && evidence.length > 0) {
    try {
      const r = await qa.answer(question, evidence, { freshnessNote });
      answer = r.answer;
      mode = "model";
      await recordUsage(ctx.db, {
        broadcasterId: session.broadcaster_id,
        sessionId: session.id,
        kind: "qa",
        provider: qa.provider,
        model: qa.model,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      });
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, "qa provider failed; falling back to retrieval");
    }
  }
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return {
    answer: answer.answer,
    notObserved: answer.notObserved,
    citations: answer.citedObservationIds
      .map((id) => byId.get(id))
      .filter((x): x is Observation => Boolean(x))
      .map((o) => ({ observationId: o.id, mediaStartMs: o.mediaStartMs, description: o.description, type: o.type })),
    mode,
    freshness: { lastObservationAgeMs: ageMs, stale },
  };
}
