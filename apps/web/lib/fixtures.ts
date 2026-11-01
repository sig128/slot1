/**
 * DESIGN FIXTURES — used ONLY by /demo for design review. Production routes never import this
 * file. Nothing here is a real broadcast or a real observation.
 */
import type { AnalysisStatus, AskResponse, Observation, ObservationDetail, ObservationPage, SessionSummary } from "@slot1/contracts";

let t0 = Date.parse("2026-01-01T21:40:00Z");
const at = (mins: number) => new Date(t0 + mins * 60_000).toISOString();

const base = {
  schemaVersion: 1 as const,
  broadcasterId: "demo",
  sessionId: "00000000-0000-4000-8000-000000000000",
  sourceId: "demo-source",
  capturedAt: null,
  publishedAt: null,
  evidence: [{ assetId: "demo", kind: "frame" as const, mediaPtsMs: 0 }],
  rawText: null,
  model: { provider: "fixture", version: "design-demo" },
  modelConfidence: null,
  reviewStatus: "unreviewed" as const,
  relatedEntities: [],
};

function o(id: number, mins: number, partial: Partial<Observation>): Observation {
  return {
    ...base,
    id: `00000000-0000-4000-8000-0000000000${String(id).padStart(2, "0")}`,
    mediaStartMs: mins * 60_000,
    mediaEndMs: mins * 60_000,
    receivedAt: at(mins),
    analyzedAt: at(mins),
    type: "visible_text",
    description: "",
    origin: "video",
    interpretation: "directly_visible",
    ...partial,
  } as Observation;
}

function observations(): Observation[] {
  return [
  o(1, 0, { type: "stream_online", description: "Went live on Twitch (fixture)", origin: "twitch", interpretation: "directly_visible", model: null, evidence: [], mediaStartMs: null, mediaEndMs: null }),
  o(2, 2, { type: "mission_title", description: "Title text: “Docks run” (fixture)", origin: "ocr", rawText: "Docks run", modelConfidence: 0.95 }),
  o(3, 4, { type: "objective_text", description: "Objective text: “Go to the docks” (fixture)", origin: "ocr", rawText: "Go to the docks", modelConfidence: 0.93 }),
  o(4, 9, { type: "vehicle", description: "Red sports car in view (fixture)", modelConfidence: 0.72 }),
  o(5, 12, { type: "possible_collision", description: "Possible vehicle collision (fixture)", interpretation: "inferred", modelConfidence: 0.58 }),
  o(6, 14, { type: "place_name", description: "Place name: “Vespucci Beach” (fixture)", origin: "ocr", rawText: "Vespucci Beach", modelConfidence: 0.9 }),
  o(7, 19, { type: "objective_text", description: "Objective text changed: “Lose the cops” (fixture)", origin: "ocr", rawText: "Lose the cops", modelConfidence: 0.91 }),
  o(8, 23, { type: "scene_transition", description: "Scene cut detected (fixture)", model: null }),
  o(9, 27, { type: "result_screen", description: "Result screen: “MISSION PASSED” (fixture)", origin: "ocr", rawText: "MISSION PASSED", modelConfidence: 0.96 }),
  ];
}

function status(): AnalysisStatus {
  return {
  state: "live_vision",
  reason: "Design fixture — not a real source",
  sourceLabel: "test",
  lastReceivedFrameAt: at(28),
  lastAnalyzedFrameAt: at(28),
  lastResultAt: at(27),
  measuredCadenceMs: 5000,
  measuredDelayMs: 6200,
  staleAfterMs: 21_200,
  visionConfigured: true,
  };
}

function session(st: AnalysisStatus): SessionSummary {
  return {
  id: base.sessionId,
  broadcasterId: "demo",
  channelLogin: "fixture",
  channelDisplayName: "Fixture Channel",
  kind: "ingest",
  label: "test",
  title: "Design fixture session",
  startedAt: at(0),
  endedAt: null,
  visibility: "public",
  broadcastState: "unknown",
  analysis: st,
  coverage: { analyzedMs: 25 * 60_000, durationMs: 28 * 60_000, ratio: 0.89, framesAnalyzed: 300, framesDropped: 4, gaps: [] },
  playback: null,
  processing: null,
  };
}

/** Build fixtures relative to the viewer's clock so ages and the 30-minute timeline read sensibly. */
export function buildDemo(now: number) {
  t0 = now - 29 * 60_000;
  const obs = observations();
  const st = status();
  const page: ObservationPage = {
    observations: obs,
    sources: [{ id: "demo-source", kind: "live_ingest", label: "test", name: "Fixture source", createdAt: at(0) }],
    lastEventId: null,
    hasMore: false,
  };
  const details: Record<string, ObservationDetail> = Object.fromEntries(
    obs.map((x) => [
      x.id,
      { observation: x, evidence: [], corrections: [], sessionLabel: "test", sessionKind: "ingest", nearbyClip: null, canEdit: false } satisfies ObservationDetail,
    ]),
  );
  return { observations: obs, status: st, session: session(st), page, details, answer: (q: string) => demoAnswer(obs, q) };
}

function demoAnswer(obs: Observation[], q: string): AskResponse {
  const hit = obs.find((x) => q.toLowerCase().includes("crash") ? x.type === "possible_collision" : q.toLowerCase().includes("objective") && x.type === "objective_text");
  if (!hit) return { answer: "I haven't observed that.", notObserved: true, citations: [], mode: "retrieval", freshness: { lastObservationAgeMs: null, stale: false } };
  return {
    answer: `Fixture answer: ${hit.description}.`,
    notObserved: false,
    citations: [{ observationId: hit.id, mediaStartMs: hit.mediaStartMs, description: hit.description, type: hit.type }],
    mode: "retrieval",
    freshness: { lastObservationAgeMs: null, stale: false },
  };
}
