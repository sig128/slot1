import type { EvidenceRef, Interpretation, ObservationOrigin, ObservationType, RelatedEntity } from "@slot1/contracts";
import { normalizeText, textSimilarity } from "./ocr";

/** A not-yet-persisted observation produced by any analyzer. */
export interface Candidate {
  type: ObservationType;
  description: string;
  origin: ObservationOrigin;
  interpretation: Interpretation;
  mediaStartMs: number;
  mediaEndMs: number;
  evidence: EvidenceRef[];
  rawText: string | null;
  model: { provider: string; version: string } | null;
  modelConfidence: number | null;
  relatedEntities: RelatedEntity[];
  receivedAt: string;
  analyzedAt: string;
  capturedAt: string | null;
  /** How many independent readings are required before publishing (noisy OCR uses 2). */
  minReadings: number;
  /** Discrete events (cuts, black screens) are never merged with neighbours. Default true. */
  fusable?: boolean;
}

export type FusionAction =
  | { kind: "insert"; candidate: Candidate; key: string }
  | { kind: "extend"; id: string; mediaEndMs: number; evidence: EvidenceRef[]; key: string }
  | { kind: "hold"; key: string };

interface Entry {
  key: string;
  type: ObservationType;
  text: string;
  id: string | null;
  firstStartMs: number;
  lastEndMs: number;
  readings: number;
  evidence: EvidenceRef[];
  pending: Candidate | null;
}

const MAX_EVIDENCE = 8;
const TEXT_TYPES: ReadonlySet<ObservationType> = new Set([
  "visible_text",
  "objective_text",
  "mission_title",
  "subtitle",
  "result_screen",
  "hud_reading",
  "place_name",
  "dialogue",
]);

function mergeEvidence(a: EvidenceRef[], b: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set(a.map((e) => e.assetId));
  const out = [...a];
  for (const e of b) if (!seen.has(e.assetId)) out.push(e);
  // Keep the first frames and the most recent ones when trimming.
  if (out.length <= MAX_EVIDENCE) return out;
  return [...out.slice(0, 3), ...out.slice(-(MAX_EVIDENCE - 3))];
}

/**
 * Fuse observations across nearby timestamps: repeated readings of the same text or the same
 * visual description extend one observation instead of creating many. Noisy single readings are
 * held until confirmed by another frame.
 */
export class FusionWindow {
  private entries: Entry[] = [];

  constructor(private readonly windowMs = 20_000) {}

  private keyText(c: Candidate): string {
    return TEXT_TYPES.has(c.type) && c.rawText ? c.rawText : c.description;
  }

  push(c: Candidate): FusionAction {
    this.expire(c.mediaStartMs);
    const text = this.keyText(c);
    const match = c.fusable === false ? undefined : this.entries.find(
      (e) =>
        e.type === c.type &&
        c.mediaStartMs - e.lastEndMs <= this.windowMs &&
        (TEXT_TYPES.has(c.type) ? textSimilarity(e.text, text) >= 0.6 : normalizeText(e.text) === normalizeText(text)),
    );
    if (match) {
      match.lastEndMs = Math.max(match.lastEndMs, c.mediaEndMs);
      match.readings += 1;
      match.evidence = mergeEvidence(match.evidence, c.evidence);
      if (match.id) return { kind: "extend", id: match.id, mediaEndMs: match.lastEndMs, evidence: match.evidence, key: match.key };
      const pending = match.pending ?? c;
      if (match.readings >= pending.minReadings) {
        match.pending = null;
        return {
          kind: "insert",
          key: match.key,
          candidate: { ...pending, mediaStartMs: match.firstStartMs, mediaEndMs: match.lastEndMs, evidence: match.evidence },
        };
      }
      return { kind: "hold", key: match.key };
    }
    const key = `${c.type}:${normalizeText(text).slice(0, 80)}:${c.mediaStartMs}`;
    const entry: Entry = {
      key,
      type: c.type,
      text,
      id: null,
      firstStartMs: c.mediaStartMs,
      lastEndMs: c.mediaEndMs,
      readings: 1,
      evidence: [...c.evidence],
      pending: c,
    };
    this.entries.push(entry);
    if (c.minReadings <= 1) {
      entry.pending = null;
      return { kind: "insert", candidate: c, key };
    }
    return { kind: "hold", key };
  }

  markInserted(key: string, id: string) {
    const e = this.entries.find((x) => x.key === key);
    if (e) e.id = id;
  }

  private expire(nowMediaMs: number) {
    this.entries = this.entries.filter((e) => nowMediaMs - e.lastEndMs <= this.windowMs * 3);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Highlight candidates                                                                       */
/* ------------------------------------------------------------------------------------------ */

const WEIGHTS: Partial<Record<ObservationType, number>> = {
  possible_collision: 3,
  combat: 2,
  result_screen: 3,
  reaction: 2,
  siren: 1,
  vehicle_enter_exit: 1,
  mission_title: 2,
  objective_text: 1,
};

export interface ScoredEvent {
  id: string;
  type: ObservationType;
  mediaStartMs: number;
  evidence: EvidenceRef[];
  description: string;
}

/**
 * Suggest a highlight when weighted evidence clusters within a short window. Built only from
 * already-evidenced observations; the suggestion is labelled inferred and cites their evidence.
 */
export class HighlightScorer {
  private recent: ScoredEvent[] = [];
  private lastHighlightMs = -Infinity;

  constructor(
    private readonly windowMs = 20_000,
    private readonly threshold = 4,
    private readonly cooldownMs = 60_000,
  ) {}

  add(e: ScoredEvent): { score: number; events: ScoredEvent[] } | null {
    if (!WEIGHTS[e.type]) return null;
    this.recent.push(e);
    this.recent = this.recent.filter((x) => e.mediaStartMs - x.mediaStartMs <= this.windowMs);
    const score = this.recent.reduce((s, x) => s + (WEIGHTS[x.type] ?? 0), 0);
    if (score >= this.threshold && e.mediaStartMs - this.lastHighlightMs >= this.cooldownMs) {
      this.lastHighlightMs = e.mediaStartMs;
      const events = [...this.recent];
      this.recent = [];
      return { score, events };
    }
    return null;
  }
}
