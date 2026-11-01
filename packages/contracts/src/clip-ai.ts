import { z } from "zod";
import { ASPECT_SIZE, Edl, EdlAspect, edlDurationMs, edlOutputTime } from "./clipper";
import { SessionKind, SourceLabel } from "./enums";
import { formatMediaTime } from "./presentation";

/**
 * AI clip tools (docs/CLIP_AI.md): ranking a session's best moments, finding the boring parts of
 * an edit, writing social posts and editing on request. Everything a ranking says comes from
 * something SLOT1 measured or read, with its media time; model-written text is labeled as such.
 */

/* ------------------------------------------------------------------------------------------ */
/* Status                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Per-second loudness of a session's stored video, measured once by the worker. */
export const AudioAnalysisStatus = z.object({
  state: z.enum(["unavailable", "not_started", "queued", "running", "ready", "failed"]),
  /** Why it's unavailable or failed, in plain words. */
  reason: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AudioAnalysisStatus = z.infer<typeof AudioAnalysisStatus>;

/** The text model behind "Write my post" and "Edit it for me". */
export const TextModelStatus = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** What's missing when it isn't available. */
  reason: z.string().nullable(),
  /** True when this server has AI prices set, so replies can show an estimated cost. */
  pricesConfigured: z.boolean(),
});
export type TextModelStatus = z.infer<typeof TextModelStatus>;

export const ClipAiSession = z.object({
  id: z.string(),
  title: z.string(),
  kind: SessionKind,
  label: SourceLabel.nullable(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  /** Stored video SLOT1 can cut clips from (an upload or a finished recording). */
  media: z.object({ available: z.boolean(), reason: z.string().nullable() }),
  audio: AudioAnalysisStatus,
  /** Gameplay observations with a media time. */
  observations: z.number(),
});
export type ClipAiSession = z.infer<typeof ClipAiSession>;

export const ClipAiSessionsResponse = z.object({ sessions: z.array(ClipAiSession), textModel: TextModelStatus });
export type ClipAiSessionsResponse = z.infer<typeof ClipAiSessionsResponse>;

/* ------------------------------------------------------------------------------------------ */
/* Best moments                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Where a reason comes from. */
export const MomentSignal = z.enum(["result", "mission", "action", "highlight", "text", "vision", "audio_peak", "cut_burst", "clip_request", "density"]);
export type MomentSignal = z.infer<typeof MomentSignal>;

export const MomentReason = z.object({
  signal: MomentSignal,
  /** e.g. "MISSION PASSED read on screen at 12:04". */
  label: z.string(),
  atMs: z.number().int().nullable(),
  /** The observation behind it, when there is one. */
  observationId: z.string().nullable(),
  points: z.number(),
});
export type MomentReason = z.infer<typeof MomentReason>;

export const MomentCandidate = z.object({
  id: z.string(),
  sessionId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  /** The strongest single signal. */
  peakMs: z.number().int(),
  /** 0–100, relative within SLOT1's own scale; not a measured quality. */
  score: z.number().int().min(0).max(100),
  /** Score as one to five stars. */
  stars: z.number().int().min(1).max(5),
  title: z.string(),
  tone: z.enum(["good", "bad", "neutral"]),
  reasons: z.array(MomentReason),
  /** A frame SLOT1 stored as evidence for the strongest observation, if any. */
  frameUrl: z.string().nullable(),
});
export type MomentCandidate = z.infer<typeof MomentCandidate>;

export const MomentsResponse = z.object({
  session: ClipAiSession,
  candidates: z.array(MomentCandidate),
  signals: z.object({ observations: z.number(), audioPeaks: z.number(), cuts: z.number(), clipRequests: z.number() }),
  /** What the ranking couldn't use, e.g. audio still being analyzed. */
  note: z.string().nullable(),
});
export type MomentsResponse = z.infer<typeof MomentsResponse>;

export const MomentPick = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  title: z.string().trim().min(1).max(60),
});
export type MomentPick = z.infer<typeof MomentPick>;

export const CreateMomentClipsInput = z.object({
  /** single: one edit per moment. reel: one edit with all of them, in time order, with title cards. */
  mode: z.enum(["single", "reel"]),
  aspect: EdlAspect.default("9:16"),
  moments: z.array(MomentPick).min(1).max(10),
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreateMomentClipsInput = z.infer<typeof CreateMomentClipsInput>;

export const CreateMomentClipsResponse = z.object({ projectIds: z.array(z.string()) });
export type CreateMomentClipsResponse = z.infer<typeof CreateMomentClipsResponse>;

/** Score (0–100) as wanted-style stars (1–5). */
export function scoreStars(score: number): number {
  return Math.max(1, Math.min(5, Math.ceil(Math.max(0, score) / 20)));
}

/**
 * An edit from chosen moments of ONE session: one segment per moment. Vertical edits show the
 * whole frame over a blurred backdrop (like auto clips); a reel adds a title card per moment.
 */
export function momentsEdl(sessionId: string, picks: MomentPick[], opts: { aspect: EdlAspect; mode: "single" | "reel" }): Edl {
  const sorted = opts.mode === "reel" ? [...picks].sort((a, b) => a.startMs - b.startMs) : picks;
  const segments = sorted.map((p, i) => ({
    id: `m${i + 1}`,
    sessionId,
    runId: null,
    inMs: p.startMs,
    outMs: Math.max(p.endMs, p.startMs + 300),
    speed: 1 as const,
    reframe: { x: 0.5, y: 0.5, zoom: 1 },
  }));
  const texts: { id: string; text: string; startMs: number; endMs: number; position: "top"; style: "banner" | "poster" }[] = [];
  let t = 0;
  for (const [i, s] of segments.entries()) {
    const len = s.outMs - s.inMs;
    if (opts.mode === "reel" || i === 0) {
      texts.push({ id: `t${i + 1}`, text: sorted[i]!.title.slice(0, 90), startMs: t, endMs: t + Math.min(2500, len), position: "top", style: opts.mode === "reel" ? "banner" : "poster" });
    }
    t += len;
  }
  return Edl.parse({
    version: 1,
    aspect: opts.aspect,
    layout: opts.aspect === "16:9" ? "crop" : "fit",
    segments,
    texts,
    fadeInMs: 0,
    fadeOutMs: Math.min(400, Math.floor(t / 4)),
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Boring parts                                                                               */
/* ------------------------------------------------------------------------------------------ */

export const BoringKind = z.enum(["black", "silence", "loading", "quiet"]);
export type BoringKind = z.infer<typeof BoringKind>;

export const BoringPart = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** The edit segment it falls in; times are that session's media times. */
  segmentId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  kind: BoringKind,
  label: z.string(),
  observationId: z.string().nullable(),
});
export type BoringPart = z.infer<typeof BoringPart>;

export const BoringInput = z.object({ edl: Edl });
export type BoringInput = z.infer<typeof BoringInput>;

export const BoringResponse = z.object({
  parts: z.array(BoringPart),
  audio: z.array(z.object({ sessionId: z.string(), status: AudioAnalysisStatus })),
  note: z.string().nullable(),
});
export type BoringResponse = z.infer<typeof BoringResponse>;

export interface CutResult {
  edl: Edl | null;
  /** Output time removed. */
  removedMs: number;
  /** Why the cut couldn't be applied. */
  error: string | null;
}

const MIN_PIECE_MS = 300;

/**
 * Remove source-time ranges from an edit's segments. Pieces shorter than 0.3 s go with the cut;
 * output-timeline items (texts, cover, and any other list with startMs/endMs) move with the
 * cut so they stay on the same picture. Returns an error instead of an invalid edit.
 */
export function cutRangesFromEdl(edl: Edl, cuts: { segmentId: string; startMs: number; endMs: number }[]): CutResult {
  const removedOut: [number, number][] = [];
  const segments: Edl["segments"] = [];
  const usedIds = new Set(edl.segments.map((s) => s.id));
  for (const [i, seg] of edl.segments.entries()) {
    const mine = cuts
      .filter((c) => c.segmentId === seg.id)
      .map((c) => [Math.max(seg.inMs, c.startMs), Math.min(seg.outMs, c.endMs)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    // Merge overlaps, then compute the pieces that remain.
    const merged: [number, number][] = [];
    for (const r of mine) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    const pieces: [number, number][] = [];
    let cursor = seg.inMs;
    for (const [a, b] of merged) {
      if (a > cursor) pieces.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < seg.outMs) pieces.push([cursor, seg.outMs]);
    const kept = pieces.filter(([a, b]) => b - a >= MIN_PIECE_MS);
    // Everything not kept is removed: record it on the old output timeline.
    let pos = seg.inMs;
    for (const [a, b] of [...kept, [seg.outMs, seg.outMs] as [number, number]]) {
      if (a > pos) removedOut.push([edlOutputTime(edl, i, pos), edlOutputTime(edl, i, a)]);
      pos = Math.max(pos, b);
    }
    kept.forEach(([a, b], n) => {
      let id = seg.id;
      if (n > 0) {
        let k = n + 1;
        do id = `${seg.id.slice(0, 34)}-${k++}`;
        while (usedIds.has(id));
        usedIds.add(id);
      }
      segments.push({ ...seg, id, inMs: a, outMs: b });
    });
  }
  const removedMs = removedOut.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (segments.length === 0) return { edl: null, removedMs, error: "That would cut the whole edit" };
  if (segments.length > 20) return { edl: null, removedMs, error: "That would split the edit into more than 20 parts. Cut fewer parts at once" };

  const shift = (t: number): number => {
    let out = t;
    for (const [a, b] of removedOut) {
      if (t >= b) out -= b - a;
      else if (t > a) out -= t - a;
    }
    return Math.max(0, Math.round(out));
  };
  const next: Record<string, unknown> = { ...edl, segments };
  const total = edlDurationMs({ segments });
  // Output-timeline items: texts, and any other list of {startMs, endMs} (kept generic on purpose).
  for (const [key, value] of Object.entries(edl)) {
    if (!Array.isArray(value) || key === "segments") continue;
    if (!value.every((v) => v && typeof v === "object" && typeof (v as { startMs?: unknown }).startMs === "number" && typeof (v as { endMs?: unknown }).endMs === "number")) continue;
    next[key] = (value as { startMs: number; endMs: number }[])
      .map((v) => ({ ...v, startMs: shift(v.startMs), endMs: Math.min(total, shift(v.endMs)) }))
      .filter((v) => v.endMs - v.startMs >= 200 && v.startMs < total);
  }
  if (typeof edl.coverMs === "number") next.coverMs = Math.min(total, shift(edl.coverMs));
  if (edl.fadeInMs + edl.fadeOutMs > total) {
    next.fadeInMs = Math.floor(Math.min(edl.fadeInMs, total / 4));
    next.fadeOutMs = Math.floor(Math.min(edl.fadeOutMs, total / 4));
  }
  const parsed = Edl.safeParse(next);
  if (!parsed.success) return { edl: null, removedMs, error: `The cut edit isn't valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}` };
  return { edl: parsed.data, removedMs, error: null };
}

/* ------------------------------------------------------------------------------------------ */
/* Write my post                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const PostPlatform = z.enum(["tiktok", "youtube", "instagram", "x"]);
export type PostPlatform = z.infer<typeof PostPlatform>;

export const POST_PLATFORM_LABEL: Record<PostPlatform, string> = { tiktok: "TikTok", youtube: "YouTube Shorts", instagram: "Instagram Reels", x: "X" };

export const PostTone = z.enum(["hype", "clean", "funny"]);
export type PostTone = z.infer<typeof PostTone>;

export const WritePostInput = z.object({
  edl: Edl,
  platforms: z.array(PostPlatform).min(1).max(4),
  tone: PostTone.default("hype"),
});
export type WritePostInput = z.infer<typeof WritePostInput>;

export const PlatformPost = z.object({
  platform: PostPlatform,
  /** YouTube needs a title; elsewhere it's a short hook. */
  title: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});
export type PlatformPost = z.infer<typeof PlatformPost>;

export const AiUsage = z.object({ inputTokens: z.number(), outputTokens: z.number(), estimatedCostUsd: z.number().nullable() });
export type AiUsage = z.infer<typeof AiUsage>;

export const WritePostResponse = z.object({
  posts: z.array(PlatformPost),
  /** What the model was given. */
  basedOn: z.object({ moments: z.number(), transcriptLines: z.number() }),
  model: z.string(),
  usage: AiUsage,
});
export type WritePostResponse = z.infer<typeof WritePostResponse>;

/* ------------------------------------------------------------------------------------------ */
/* Edit it for me                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const EditForMeInput = z.object({
  request: z.string().trim().min(3).max(500),
  edl: Edl,
});
export type EditForMeInput = z.infer<typeof EditForMeInput>;

export const EditForMeResponse = z.object({
  /** The model's own one-line summary (AI-written). */
  summary: z.string(),
  edl: Edl,
  /** What actually changed, computed by SLOT1 from the two edits (not written by the model). */
  changes: z.array(z.string()),
  unchanged: z.boolean(),
  model: z.string(),
  usage: AiUsage,
});
export type EditForMeResponse = z.infer<typeof EditForMeResponse>;

const ASPECT_WORD: Record<string, string> = { "9:16": "vertical", "16:9": "widescreen", "1:1": "square" };
const t1 = (ms: number) => {
  const tenths = Math.round(ms / 100) % 10;
  return `${formatMediaTime(ms)}.${tenths}`;
};
const human = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/Ms$/, "").toLowerCase();

/**
 * What changed between two edits, in plain sentences. Computed, never model-written, so the
 * creator sees exactly what applying a proposal does.
 */
export function describeEdlChanges(before: Edl, after: Edl): string[] {
  const out: string[] = [];
  const lenA = edlDurationMs(before);
  const lenB = edlDurationMs(after);
  if (Math.abs(lenA - lenB) >= 100) out.push(`Length ${t1(lenA)} → ${t1(lenB)}`);
  if (before.aspect !== after.aspect) {
    out.push(`Format ${ASPECT_WORD[before.aspect] ?? before.aspect} → ${ASPECT_WORD[after.aspect] ?? after.aspect} (${ASPECT_SIZE[after.aspect]?.label ?? after.aspect})`);
  }
  if (before.layout !== after.layout) out.push(after.layout === "fit" ? "Shows the whole frame over a blurred backdrop" : "Fills the frame (crops the sides)");

  const oldById = new Map(before.segments.map((s, i) => [s.id, { s, i }]));
  const newIds = new Set(after.segments.map((s) => s.id));
  for (const [i, s] of after.segments.entries()) {
    const prev = oldById.get(s.id);
    const range = `${t1(s.inMs)}–${t1(s.outMs)}`;
    if (!prev) {
      out.push(`Adds part ${i + 1}: ${range}${s.speed !== 1 ? ` at ${s.speed}×` : ""}`);
      continue;
    }
    if (prev.s.inMs !== s.inMs || prev.s.outMs !== s.outMs) out.push(`Part ${i + 1} now ${range} (was ${t1(prev.s.inMs)}–${t1(prev.s.outMs)})`);
    if (prev.s.speed !== s.speed) out.push(`Part ${i + 1} speed ${prev.s.speed}× → ${s.speed}×`);
    if (JSON.stringify(prev.s.reframe) !== JSON.stringify(s.reframe)) out.push(`Part ${i + 1} framing changes`);
    if (prev.s.sessionId !== s.sessionId) out.push(`Part ${i + 1} uses a different session`);
  }
  for (const s of before.segments) if (!newIds.has(s.id)) out.push(`Removes ${t1(s.inMs)}–${t1(s.outMs)}`);
  const keptOrder = after.segments.map((s) => s.id).filter((id) => oldById.has(id));
  const oldOrder = before.segments.map((s) => s.id).filter((id) => newIds.has(id));
  if (keptOrder.join("|") !== oldOrder.join("|")) out.push("Reorders the parts");

  const oldTexts = new Map(before.texts.map((x) => [x.id, x]));
  const newTextIds = new Set(after.texts.map((x) => x.id));
  for (const x of after.texts) {
    const prev = oldTexts.get(x.id);
    if (!prev) out.push(`Adds text “${x.text}” at ${t1(x.startMs)}`);
    else if (prev.text !== x.text) out.push(`Text “${prev.text}” → “${x.text}”`);
    else if (prev.startMs !== x.startMs || prev.endMs !== x.endMs || prev.position !== x.position || prev.style !== x.style) out.push(`Moves or restyles text “${x.text}”`);
  }
  for (const x of before.texts) if (!newTextIds.has(x.id)) out.push(`Removes text “${x.text}”`);

  if (before.captions !== after.captions) out.push(after.captions ? "Turns captions on" : "Turns captions off");
  if (before.fadeInMs !== after.fadeInMs) out.push(`Fade in ${t1(before.fadeInMs)} → ${t1(after.fadeInMs)}`);
  if (before.fadeOutMs !== after.fadeOutMs) out.push(`Fade out ${t1(before.fadeOutMs)} → ${t1(after.fadeOutMs)}`);
  if (before.volume !== after.volume) out.push(`Volume ${Math.round(before.volume * 100)}% → ${Math.round(after.volume * 100)}%`);
  if (before.coverMs !== after.coverMs) out.push(after.coverMs === null ? "Clears the cover frame" : `Cover frame at ${t1(after.coverMs)}`);

  // Anything the editor gains later is still reported, generically.
  const handled = new Set(["version", "aspect", "layout", "segments", "texts", "captions", "fadeInMs", "fadeOutMs", "volume", "coverMs"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (handled.has(k)) continue;
    if (JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k])) out.push(`Changes ${human(k)}`);
  }
  return out;
}
