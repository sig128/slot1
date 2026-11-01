import type { EvidenceRef, ObservationType, RelatedEntity } from "@slot1/contracts";
import { formatMediaTime } from "@slot1/contracts";
import type { Candidate } from "./fusion";
import type { MediaProbe } from "./media";
import type { OcrLine } from "./ocr";
import type { VisionResult } from "./providers/vision";

export interface FrameRef {
  ptsMs: number;
  assetId: string;
  receivedAt: Date;
  capturedAt: Date | null;
}

const frameEvidence = (f: FrameRef): EvidenceRef => ({ assetId: f.assetId, kind: "frame", mediaPtsMs: f.ptsMs });

const quote = (t: string, max = 120) => {
  const clean = t.replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
};

const OCR_PREFIX: Partial<Record<ObservationType, string>> = {
  objective_text: "Objective text",
  subtitle: "Subtitle",
  place_name: "Place name",
  result_screen: "Result screen",
  hud_reading: "HUD reads",
  mission_title: "Title text",
  visible_text: "On-screen text",
};

export function ocrCandidates(lines: OcrLine[], frame: FrameRef, engineVersion: string, nowIso: string): Candidate[] {
  return lines.map((l) => ({
    type: l.type,
    description: `${OCR_PREFIX[l.type] ?? "On-screen text"}: ${quote(l.text)}`.slice(0, 280),
    origin: "ocr",
    interpretation: "directly_visible",
    mediaStartMs: frame.ptsMs,
    mediaEndMs: frame.ptsMs,
    evidence: [frameEvidence(frame)],
    rawText: l.text,
    model: { provider: "tesseract", version: engineVersion },
    modelConfidence: Math.round(l.confidence) / 100,
    relatedEntities: [],
    receivedAt: frame.receivedAt.toISOString(),
    analyzedAt: nowIso,
    capturedAt: frame.capturedAt?.toISOString() ?? null,
    // A single clean reading is enough for very confident lines; otherwise require a repeat.
    minReadings: l.confidence >= 92 ? 1 : 2,
  }));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export function visionCandidates(result: VisionResult, frames: FrameRef[], nowIso: string): Candidate[] {
  const out: Candidate[] = [];
  for (const f of result.analysis.findings) {
    const cited = f.frameIndexes.map((i) => frames[i]).filter((x): x is FrameRef => Boolean(x));
    if (cited.length === 0) continue;
    const entities: RelatedEntity[] = f.entities.map((e) => ({ id: `${e.kind}:${slug(e.label)}`, kind: e.kind, label: e.label, certainty: e.certainty }));
    out.push({
      type: f.type,
      description: f.description.slice(0, 280),
      origin: "video",
      interpretation: f.interpretation,
      mediaStartMs: Math.min(...cited.map((c) => c.ptsMs)),
      mediaEndMs: Math.max(...cited.map((c) => c.ptsMs)),
      evidence: cited.map(frameEvidence),
      rawText: f.visibleText,
      model: result.model,
      modelConfidence: f.confidence,
      relatedEntities: entities,
      receivedAt: cited[cited.length - 1]!.receivedAt.toISOString(),
      analyzedAt: nowIso,
      capturedAt: cited[0]!.capturedAt?.toISOString() ?? null,
      minReadings: 1,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Deterministic, measured observations                                                       */
/* ------------------------------------------------------------------------------------------ */

const measured = (frame: FrameRef, nowIso: string): Pick<Candidate, "origin" | "interpretation" | "model" | "modelConfidence" | "relatedEntities" | "receivedAt" | "analyzedAt" | "capturedAt" | "minReadings" | "rawText"> => ({
  origin: "video",
  interpretation: "directly_visible",
  model: null,
  modelConfidence: null,
  relatedEntities: [],
  receivedAt: frame.receivedAt.toISOString(),
  analyzedAt: nowIso,
  capturedAt: null,
  minReadings: 1,
  rawText: null,
});

export function mediaFactsCandidate(probe: MediaProbe, first: FrameRef, nowIso: string, silences: { startMs: number; endMs: number }[]): Candidate {
  const v = probe.video;
  const parts = [
    v ? `${v.width}×${v.height}` : "no video",
    v?.fps ? `${v.fps} fps delivery` : "delivery frame rate unknown",
    v ? v.codec.toUpperCase() : null,
    probe.audio ? `audio ${probe.audio.codec.toUpperCase()}` : "no audio track",
  ].filter(Boolean);
  if (probe.audio && silences.length > 0) parts.push(`${silences.length} silent stretch${silences.length === 1 ? "" : "es"}`);
  return {
    ...measured(first, nowIso),
    type: "media_facts",
    description: `Source media: ${parts.join(" · ")}`,
    mediaStartMs: 0,
    mediaEndMs: probe.durationMs ?? 0,
    evidence: [frameEvidence(first)],
  };
}

export function sceneCandidates(scenes: { ptsMs: number; score: number }[], frames: FrameRef[], nowIso: string): Candidate[] {
  const out: Candidate[] = [];
  let lastMs = -Infinity;
  for (const s of scenes) {
    if (s.ptsMs - lastMs < 3000) continue; // merge rapid cuts
    const f = nearestFrame(frames, s.ptsMs + 250, 1500);
    if (!f) continue; // no evidence frame → no observation
    lastMs = s.ptsMs;
    out.push({ ...measured(f, nowIso), type: "scene_transition", description: "Scene cut detected", mediaStartMs: s.ptsMs, mediaEndMs: s.ptsMs, evidence: [frameEvidence(f)], fusable: false });
  }
  return out;
}

export function blackCandidates(segments: { startMs: number; endMs: number }[], frames: FrameRef[], nowIso: string): Candidate[] {
  const out: Candidate[] = [];
  for (const seg of segments) {
    const f = frames.find((fr) => fr.ptsMs >= seg.startMs && fr.ptsMs <= seg.endMs);
    if (!f) continue;
    const dur = ((seg.endMs - seg.startMs) / 1000).toFixed(1);
    out.push({ ...measured(f, nowIso), type: "black_screen", description: `Black screen for ${dur}s`, mediaStartMs: seg.startMs, mediaEndMs: seg.endMs, evidence: [frameEvidence(f)], fusable: false });
  }
  return out;
}

export function coverageCandidate(
  frames: FrameRef[],
  input: { durationMs: number; analyzedFrames: number; visionFrames: number; intervalMs: number; analyzers: string[] },
  nowIso: string,
): Candidate | null {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return null;
  const pct = input.durationMs > 0 ? Math.round((Math.min(input.analyzedFrames * input.intervalMs, input.durationMs) / input.durationMs) * 100) : 0;
  const analyzers = input.analyzers.length ? input.analyzers.join(" + ") : "no analyzer switched on";
  return {
    ...measured(last, nowIso),
    type: "session_coverage",
    description: `Analyzed ${input.analyzedFrames} frames over ${formatMediaTime(input.durationMs)} (~${pct}% coverage, ${analyzers}${input.visionFrames ? `, ${input.visionFrames} by vision` : ""})`,
    mediaStartMs: first.ptsMs,
    mediaEndMs: last.ptsMs,
    evidence: [frameEvidence(first), frameEvidence(last)],
  };
}

export function nearestFrame(frames: FrameRef[], t: number, tolerance: number): FrameRef | null {
  let best: FrameRef | null = null;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.ptsMs - t);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return bestD <= tolerance ? best : null;
}
