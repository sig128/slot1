import { z } from "zod";
import {
  ASPECT_SIZE,
  Edl,
  EdlAspect,
  edlDurationMs,
  edlOutputTime,
  segmentOutputMs,
  type AudioClip,
  type EdlInput,
  type EdlSegment,
  type OverlayItem,
} from "./clipper";
import { SessionKind, SourceLabel } from "./enums";
import { formatMediaTime } from "./presentation";
import { StudioAssetKind } from "./studio-assets";

/**
 * AI clip tools (docs/CLIP_AI.md): ranking a session's best moments, finding the boring parts of
 * an edit, quick polish (sounds and GTA effects at real moments), writing social posts and editing
 * on request. Every ranking reason is something SLOT1 measured or read, with its media time;
 * model-written text is labeled as such, and every change is shown before it's applied.
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

/** The text model behind "Write my post", "Edit it for me" and polish refinement. */
export const TextModelStatus = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** What's missing when it isn't available. */
  reason: z.string().nullable(),
  /** True when this server has AI prices set, so replies can show an estimated cost. */
  pricesConfigured: z.boolean(),
  /** The server's prices in US dollars per million tokens, when set. */
  pricePerMTok: z.object({ input: z.number(), output: z.number() }).nullable(),
});
export type TextModelStatus = z.infer<typeof TextModelStatus>;

/** Tokens a text-model call used, and its estimated cost when this server has prices set. */
export const AiUsage = z.object({ inputTokens: z.number(), outputTokens: z.number(), estimatedCostUsd: z.number().nullable() });
export type AiUsage = z.infer<typeof AiUsage>;

/** Dollars for some tokens at per-million prices. */
export function tokenCostUsd(t: { inputTokens: number; outputTokens: number }, p: { input: number; output: number }): number {
  return (t.inputTokens * p.input + t.outputTokens * p.output) / 1_000_000;
}

/**
 * Fixed part of every "Edit it for me" request in characters: the instructions and the reply
 * schema (the edit format). A unit test keeps this close to the real prompt.
 */
export const EDIT_REQUEST_BASE_CHARS = 21_000;

/**
 * A rough, deliberately generous token estimate for one "Edit it for me" request, from the size
 * of what's sent (about 4 characters per token): the fixed instructions and schema, the request,
 * the current edit, a typical list of detected moments and the library catalogue. The reply is
 * a whole new edit. The real count comes back with the answer.
 */
export function estimateEditTokens(edl: Edl, request: string, libraryItems: number): { inputTokens: number; outputTokens: number } {
  const edlChars = JSON.stringify(edl).length;
  const input = EDIT_REQUEST_BASE_CHARS + request.length + edlChars + 8_000 + Math.min(100, libraryItems) * 110;
  const output = Math.round(edlChars * 1.2) + 500;
  return { inputTokens: Math.ceil(input / 4), outputTokens: Math.min(6000, Math.ceil(output / 4)) };
}

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

export const ClipAiSessionsResponse = z.object({
  sessions: z.array(ClipAiSession),
  textModel: TextModelStatus,
  /** Items in the Studio library (sounds, music, stickers…) the tools can place. */
  libraryAssets: z.number(),
});
export type ClipAiSessionsResponse = z.infer<typeof ClipAiSessionsResponse>;

export const ClipAiStatusResponse = z.object({ textModel: TextModelStatus, libraryAssets: z.number() });
export type ClipAiStatusResponse = z.infer<typeof ClipAiStatusResponse>;

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

export const MomentTone = z.enum(["good", "bad", "neutral"]);
export type MomentTone = z.infer<typeof MomentTone>;

export const MomentCandidate = z.object({
  id: z.string(),
  sessionId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  /** The strongest single signal. */
  peakMs: z.number().int(),
  /** 0–100 on SLOT1's own scale; a ranking, not a measured quality. */
  score: z.number().int().min(0).max(100),
  /** Score as one to five stars. */
  stars: z.number().int().min(1).max(5),
  title: z.string(),
  tone: MomentTone,
  /** The result text when this is a result screen ("MISSION PASSED", "WASTED"…). */
  big: z.string().nullable(),
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
  /** Media time of the moment itself; GTA effects land here. */
  peakMs: z.number().int().min(0).nullable().default(null),
  tone: MomentTone.default("neutral"),
  /** Result text read on screen, if any. */
  big: z.string().max(40).nullable().default(null),
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

const TITLE_MS = 2600;
const EFFECT_MS = 2400;

/**
 * An edit from chosen moments of ONE session, ready to render. Each moment gets a title on an
 * overlay track (mission-style for result screens), a GTA effect where a result screen was read
 * (MISSION PASSED banner or WASTED freeze), and a reel joins its moments with whip transitions.
 * Vertical edits show the whole frame over a blurred backdrop, like auto clips.
 */
export function momentsEdl(sessionId: string, picks: MomentPick[], opts: { aspect: EdlAspect; mode: "single" | "reel" }): Edl {
  const sorted = opts.mode === "reel" ? [...picks].sort((a, b) => a.startMs - b.startMs) : picks;
  const segments: EdlInput["segments"] = sorted.map((p, i) => ({
    id: `m${i + 1}`,
    sessionId,
    inMs: p.startMs,
    outMs: Math.max(p.endMs, p.startMs + 300),
    transitionIn: opts.mode === "reel" && i > 0 ? { kind: "whip" as const, durationMs: 250 } : { kind: "cut" as const, durationMs: 0 },
  }));
  const timing = Edl.parse({ version: 1, aspect: opts.aspect, segments });
  const items: OverlayItem[] = [];
  const effects: Edl["effects"] = [];
  for (const [i, p] of sorted.entries()) {
    const seg = timing.segments[i]!;
    const start = edlOutputTime(timing, i, seg.inMs);
    const end = edlOutputTime(timing, i, seg.outMs);
    const style = p.tone === "good" && p.big ? "mission" : p.tone === "bad" && p.big ? "wasted" : "title-card";
    if (opts.mode === "reel" || i === 0) {
      items.push({
        type: "text",
        id: `title${i + 1}`,
        startMs: start,
        endMs: Math.min(end, start + TITLE_MS),
        x: 0.5,
        y: 0.16,
        scale: 1,
        rotation: 0,
        opacity: 1,
        keys: [],
        text: p.title.slice(0, 160),
        subtext: "",
        style: opts.mode === "reel" ? "title-card" : style,
        animation: "pop",
      });
    }
    if (p.big && p.peakMs !== null && p.peakMs >= seg.inMs && p.peakMs < seg.outMs) {
      const at = edlOutputTime(timing, i, p.peakMs);
      const kind = p.tone === "bad" ? ("wasted" as const) : ("passed" as const);
      effects.push({ id: `fx${i + 1}`, kind, startMs: at, endMs: Math.min(end, at + EFFECT_MS), text: p.big.slice(0, 60), amount: 0.5 });
    }
  }
  const total = edlDurationMs(timing);
  return Edl.parse({
    version: 1,
    aspect: opts.aspect,
    layout: opts.aspect === "16:9" ? "crop" : "fit",
    segments,
    overlays: items.length ? [{ id: "titles", name: "Titles", items: items.filter((it) => it.endMs > it.startMs) }] : [],
    effects: effects.filter((f) => f.endMs > f.startMs),
    fadeInMs: 0,
    fadeOutMs: Math.min(400, Math.floor(total / 4)),
    normalize: opts.mode === "reel",
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
 * Remove source-time ranges from an edit's segments. Pieces shorter than 0.3 s go with the cut.
 * Everything placed on the finished timeline (texts, overlays, sounds, effects, captions, volume
 * keys, cover) moves with the cut so it stays on the same picture; items that fall entirely
 * inside a cut go with it. Returns an error instead of an invalid edit.
 */
export function cutRangesFromEdl(edl: Edl, cuts: { segmentId: string; startMs: number; endMs: number }[]): CutResult {
  const removed: [number, number][] = [];
  const segments: EdlSegment[] = [];
  const usedIds = new Set(edl.segments.map((s) => s.id));
  for (const [i, seg] of edl.segments.entries()) {
    const mine = cuts
      .filter((c) => c.segmentId === seg.id)
      .map((c) => [Math.max(seg.inMs, c.startMs), Math.min(seg.outMs, c.endMs)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
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
    let pos = seg.inMs;
    for (const [a, b] of [...kept, [seg.outMs, seg.outMs] as [number, number]]) {
      if (a > pos) removed.push([edlOutputTime(edl, i, pos), edlOutputTime(edl, i, a)]);
      pos = Math.max(pos, b);
    }
    const span = seg.outMs - seg.inMs;
    const speedAt = (t: number) => (seg.rampTo === null ? seg.speed : Math.round((seg.speed + ((seg.rampTo - seg.speed) * (t - seg.inMs)) / span) * 1000) / 1000);
    kept.forEach(([a, b], n) => {
      let id = seg.id;
      if (n > 0) {
        let k = n + 1;
        do id = `${seg.id.slice(0, 34)}-${k++}`;
        while (usedIds.has(id));
        usedIds.add(id);
      }
      const keys = seg.keys.filter((k) => k.atMs >= a && k.atMs <= b);
      const nearest = seg.keys.length && !keys.length ? [...seg.keys].sort((x, y) => Math.abs(x.atMs - a) - Math.abs(y.atMs - a))[0]! : null;
      segments.push({
        ...seg,
        id,
        inMs: a,
        outMs: b,
        speed: Math.min(4, Math.max(0.25, speedAt(a))),
        rampTo: seg.rampTo === null ? null : Math.min(4, Math.max(0.25, speedAt(b))),
        keys,
        reframe: nearest ? { x: nearest.x, y: nearest.y, zoom: nearest.zoom } : seg.reframe,
        transitionIn: n === 0 ? seg.transitionIn : { kind: "cut", durationMs: 0 },
      });
    });
  }
  removed.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const r of removed) {
    const last = ranges.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else if (r[1] > r[0]) ranges.push([...r]);
  }
  const removedMs = ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (segments.length === 0) return { edl: null, removedMs, error: "That would cut the whole edit" };
  if (segments.length > 20) return { edl: null, removedMs, error: "That would split the edit into more than 20 parts. Cut fewer parts at once" };

  // Transitions can't be longer than the (now shorter) parts they join.
  segments.forEach((s, i) => {
    if (i === 0) {
      s.transitionIn = { kind: "cut", durationMs: 0 };
      return;
    }
    if (s.transitionIn.kind === "cut") return;
    const limit = Math.floor(Math.min(segmentOutputMs(s), segmentOutputMs(segments[i - 1]!)) - 100);
    s.transitionIn = limit < 100 ? { kind: "cut", durationMs: 0 } : { ...s.transitionIn, durationMs: Math.min(s.transitionIn.durationMs, limit) };
  });

  const total = edlDurationMs({ segments });
  const shift = (t: number): number => {
    let out = t;
    for (const [a, b] of ranges) {
      if (t >= b) out -= b - a;
      else if (t > a) out -= t - a;
    }
    return Math.max(0, Math.min(total, Math.round(out)));
  };
  const span = <T extends { startMs: number; endMs: number }>(v: T): T => ({ ...v, startMs: shift(v.startMs), endMs: shift(v.endMs) });
  const keysAt = <K extends { atMs: number }>(keys: K[]): K[] => keys.map((k) => ({ ...k, atMs: shift(k.atMs) }));
  const alive = (v: { startMs: number; endMs: number }) => v.endMs - v.startMs >= 200 && v.startMs < total;

  const next: Edl = {
    ...edl,
    segments,
    texts: edl.texts.map(span).filter(alive),
    overlays: edl.overlays.map((t) => ({ ...t, items: t.items.map((it) => ({ ...span(it), keys: keysAt(it.keys) })).filter(alive) })),
    audioTracks: edl.audioTracks.map((t) => ({
      ...t,
      clips: t.clips
        .map((c): AudioClip => {
          const startMs = shift(c.startMs);
          const durationMs = Math.max(50, Math.min(c.durationMs, total - startMs));
          return { ...c, startMs, durationMs, fadeInMs: Math.min(c.fadeInMs, durationMs / 2), fadeOutMs: Math.min(c.fadeOutMs, durationMs / 2), envelope: keysAt(c.envelope) };
        })
        .filter((c) => c.startMs < total),
    })),
    effects: edl.effects.map(span).filter(alive),
    captionTrack: {
      ...edl.captionTrack,
      cues: edl.captionTrack.cues
        .map((c) => ({ ...span(c), words: c.words.map(span).filter((w) => w.endMs > w.startMs) }))
        .filter(alive),
    },
    sourceAudio: { ...edl.sourceAudio, envelope: keysAt(edl.sourceAudio.envelope) },
    coverMs: edl.coverMs === null ? null : shift(edl.coverMs),
  };
  if (next.fadeInMs + next.fadeOutMs > total) {
    next.fadeInMs = Math.floor(Math.min(next.fadeInMs, total / 4));
    next.fadeOutMs = Math.floor(Math.min(next.fadeOutMs, total / 4));
  }
  const parsed = Edl.safeParse(next);
  if (!parsed.success) return { edl: null, removedMs, error: `The cut edit isn't valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}` };
  return { edl: parsed.data, removedMs, error: null };
}

/* ------------------------------------------------------------------------------------------ */
/* Library assets inside an edit                                                              */
/* ------------------------------------------------------------------------------------------ */

/** A Studio library item a tool placed, with a time on the finished edit and a preview link. */
export const PlacedAsset = z.object({
  assetId: z.string(),
  name: z.string(),
  kind: StudioAssetKind,
  atMs: z.number().int().nullable(),
  previewUrl: z.string().nullable(),
  /** Why it was placed there, e.g. "MISSION PASSED read on screen". */
  reason: z.string().nullable(),
});
export type PlacedAsset = z.infer<typeof PlacedAsset>;

/** Every Studio library item an edit uses: images on overlay tracks and clips on audio tracks. */
export function edlLibraryRefs(edl: Edl): { assetId: string; atMs: number; where: "overlay" | "audio" }[] {
  const out: { assetId: string; atMs: number; where: "overlay" | "audio" }[] = [];
  for (const t of edl.overlays) for (const it of t.items) if (it.type === "image" && it.source.kind === "library") out.push({ assetId: it.source.assetId, atMs: it.startMs, where: "overlay" });
  for (const t of edl.audioTracks) for (const c of t.clips) if (c.source.kind === "library") out.push({ assetId: c.source.assetId, atMs: c.startMs, where: "audio" });
  return out;
}

/**
 * Remove library items that don't exist and uploaded files the edit didn't already use, so a
 * proposal can only place real files. Returns the cleaned edit and what was removed.
 */
export function stripUnknownAssets(edl: Edl, knownLibrary: ReadonlySet<string>, allowedUploads: ReadonlySet<string>): { edl: Edl; removed: string[] } {
  const removed: string[] = [];
  const ok = (src: { kind: "library" | "upload"; assetId: string }) => {
    const good = src.kind === "library" ? knownLibrary.has(src.assetId) : allowedUploads.has(src.assetId);
    if (!good) removed.push(src.kind === "library" ? `library item “${src.assetId}”` : "an uploaded file the edit didn't use");
    return good;
  };
  const cleaned: Edl = {
    ...edl,
    overlays: edl.overlays.map((t) => ({ ...t, items: t.items.filter((it) => it.type !== "image" || ok(it.source)) })),
    audioTracks: edl.audioTracks.map((t) => ({ ...t, clips: t.clips.filter((c) => ok(c.source)) })),
  };
  return { edl: cleaned, removed };
}

/** Uploaded files (by id) an edit already uses. */
export function edlUploadIds(edl: Edl): Set<string> {
  const ids = new Set<string>();
  for (const t of edl.overlays) for (const it of t.items) if (it.type === "image" && it.source.kind === "upload") ids.add(it.source.assetId);
  for (const t of edl.audioTracks) for (const c of t.clips) if (c.source.kind === "upload") ids.add(c.source.assetId);
  return ids;
}

/* ------------------------------------------------------------------------------------------ */
/* Quick polish: sounds and GTA effects at real moments                                       */
/* ------------------------------------------------------------------------------------------ */

export const PolishInput = z.object({
  edl: Edl,
  /** Sound effects at the clip's moments and a whoosh on each cut. */
  sounds: z.boolean().default(true),
  /** A music bed under the whole clip (ducked under voices). */
  music: z.boolean().default(false),
  /** WASTED / MISSION PASSED effects and punch-ins at real moments, flash transitions between parts. */
  effects: z.boolean().default(false),
  /** Let the text model pick and time the sounds (needs an AI key). */
  refine: z.boolean().default(false),
});
export type PolishInput = z.infer<typeof PolishInput>;

export const PolishResponse = z.object({
  edl: Edl,
  changes: z.array(z.string()),
  placed: z.array(PlacedAsset),
  /** What couldn't be done, e.g. no sounds in the library yet. */
  note: z.string().nullable(),
  /** True when the text model chose the sounds. */
  usedAi: z.boolean(),
  usage: AiUsage.nullable(),
});
export type PolishResponse = z.infer<typeof PolishResponse>;

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
  /** What actually changes, computed by SLOT1 from the two edits (not written by the model). */
  changes: z.array(z.string()),
  /** Library items the proposal adds, with previews. */
  placed: z.array(PlacedAsset),
  /** Things SLOT1 removed from the proposal because they don't exist (unknown library ids…). */
  stripped: z.array(z.string()),
  unchanged: z.boolean(),
  model: z.string(),
  usage: AiUsage,
});
export type EditForMeResponse = z.infer<typeof EditForMeResponse>;

/* ------------------------------------------------------------------------------------------ */
/* Readable diff                                                                              */
/* ------------------------------------------------------------------------------------------ */

const ASPECT_WORD: Record<string, string> = { "9:16": "vertical", "16:9": "widescreen", "1:1": "square" };
const EFFECT_WORD: Record<string, string> = { wasted: "WASTED", passed: "MISSION PASSED", punch: "punch-in zoom", shake: "camera shake", flash: "flash", glitch: "glitch" };
const LAYOUT_WORD: Record<string, string> = { crop: "Fills the frame (crops the sides)", fit: "Shows the whole frame over a blurred backdrop", split: "Facecam panel and gameplay stacked" };

/** m:ss.t, the way the editor shows times. */
export function clipTime(ms: number): string {
  const t = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 100));
  const total = Math.floor(t / 10);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}.${t % 10}` : `${m}:${s}.${t % 10}`;
}
const human = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/ ms$/i, "").toLowerCase();
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed between two edits, in plain sentences. Computed, never model-written, so the
 * creator sees exactly what applying a proposal does. `assetName` turns library ids into names.
 */
export function describeEdlChanges(before: Edl, after: Edl, assetName: (id: string) => string | null = () => null): string[] {
  const out: string[] = [];
  const libName = (id: string) => `“${assetName(id) ?? id}”`;
  const sound = (src: { kind: string; assetId: string }) => (src.kind === "library" ? `sound ${libName(src.assetId)}` : "an uploaded sound");
  const lenA = edlDurationMs(before);
  const lenB = edlDurationMs(after);
  if (Math.abs(lenA - lenB) >= 100) out.push(`Length ${clipTime(lenA)} → ${clipTime(lenB)}`);
  if (before.aspect !== after.aspect) out.push(`Format ${ASPECT_WORD[before.aspect]} → ${ASPECT_WORD[after.aspect]} (${ASPECT_SIZE[after.aspect].width}×${ASPECT_SIZE[after.aspect].height})`);
  if (before.layout !== after.layout) out.push(LAYOUT_WORD[after.layout] ?? `Layout ${after.layout}`);
  else if (after.layout === "split" && !sameJson(before.split, after.split)) out.push("Moves the facecam panel");

  // Main track.
  const oldSeg = new Map(before.segments.map((s) => [s.id, s]));
  const newIds = new Set(after.segments.map((s) => s.id));
  for (const [i, s] of after.segments.entries()) {
    const prev = oldSeg.get(s.id);
    const n = i + 1;
    if (!prev) {
      out.push(`Adds part ${n}: ${clipTime(s.inMs)}–${clipTime(s.outMs)}${s.speed !== 1 ? ` at ${s.speed}×` : ""}`);
      continue;
    }
    if (prev.inMs !== s.inMs || prev.outMs !== s.outMs) out.push(`Part ${n} now ${clipTime(s.inMs)}–${clipTime(s.outMs)} (was ${clipTime(prev.inMs)}–${clipTime(prev.outMs)})`);
    if (prev.speed !== s.speed || prev.rampTo !== s.rampTo) out.push(s.rampTo !== null ? `Part ${n} ramps ${s.speed}× → ${s.rampTo}×` : `Part ${n} plays at ${s.speed}×`);
    if (!sameJson(prev.reframe, s.reframe) || !sameJson(prev.keys, s.keys)) out.push(s.keys.length ? `Part ${n} gets ${s.keys.length} pan and zoom keyframes` : `Part ${n} framing changes`);
    if (prev.volume !== s.volume) out.push(`Part ${n} volume ${Math.round(prev.volume * 100)}% → ${Math.round(s.volume * 100)}%`);
    if (i > 0 && !sameJson(prev.transitionIn, s.transitionIn)) out.push(s.transitionIn.kind === "cut" ? `Part ${n} starts with a hard cut` : `Part ${n} starts with a ${s.transitionIn.kind} (${clipTime(s.transitionIn.durationMs)})`);
    if (prev.sessionId !== s.sessionId) out.push(`Part ${n} uses a different session`);
  }
  for (const s of before.segments) if (!newIds.has(s.id)) out.push(`Removes ${clipTime(s.inMs)}–${clipTime(s.outMs)}`);
  const keptOrder = after.segments.map((s) => s.id).filter((id) => oldSeg.has(id));
  const oldOrder = before.segments.map((s) => s.id).filter((id) => newIds.has(id));
  if (keptOrder.join("|") !== oldOrder.join("|")) out.push("Reorders the parts");

  // Legacy texts.
  const oldTexts = new Map(before.texts.map((x) => [x.id, x]));
  const newTextIds = new Set(after.texts.map((x) => x.id));
  for (const x of after.texts) {
    const prev = oldTexts.get(x.id);
    if (!prev) out.push(`Adds text “${x.text}” at ${clipTime(x.startMs)}`);
    else if (prev.text !== x.text) out.push(`Text “${prev.text}” → “${x.text}”`);
    else if (!sameJson(prev, x)) out.push(`Moves or restyles text “${x.text}”`);
  }
  for (const x of before.texts) if (!newTextIds.has(x.id)) out.push(`Removes text “${x.text}”`);

  // Overlays.
  const itemLabel = (it: OverlayItem) => (it.type === "text" ? `text “${it.text}”` : it.type === "image" ? (it.source.kind === "library" ? libName(it.source.assetId) : "an uploaded image") : "picture-in-picture");
  const oldItems = new Map(before.overlays.flatMap((t) => t.items.map((it) => [it.id, it] as const)));
  const newItems = new Map(after.overlays.flatMap((t) => t.items.map((it) => [it.id, it] as const)));
  for (const [id, it] of newItems) {
    const prev = oldItems.get(id);
    if (!prev) out.push(`Adds ${itemLabel(it)} at ${clipTime(it.startMs)}`);
    else if (!sameJson(prev, it)) out.push(prev.type === "text" && it.type === "text" && prev.text !== it.text ? `Text “${prev.text}” → “${it.text}”` : `Moves or restyles ${itemLabel(it)}`);
  }
  for (const [id, it] of oldItems) if (!newItems.has(id)) out.push(`Removes ${itemLabel(it)}`);

  // Audio.
  const oldTracks = new Set(before.audioTracks.map((t) => t.id));
  for (const t of after.audioTracks) if (!oldTracks.has(t.id)) out.push(`Adds the audio track “${t.name}”`);
  const oldClips = new Map(before.audioTracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  const newClips = new Map(after.audioTracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (const [id, c] of newClips) {
    const prev = oldClips.get(id);
    if (!prev) out.push(`Adds ${sound(c.source)} at ${clipTime(c.startMs)}${c.loop ? " (looped)" : ""}`);
    else if (!sameJson(prev, c)) out.push(`Changes ${sound(c.source)}`);
  }
  for (const [id, c] of oldClips) if (!newClips.has(id)) out.push(`Removes ${sound(c.source)}`);
  const newTrackIds = new Set(after.audioTracks.map((t) => t.id));
  for (const t of before.audioTracks) if (!newTrackIds.has(t.id)) out.push(`Removes the audio track “${t.name}”`);

  // Effects.
  const oldFx = new Map(before.effects.map((f) => [f.id, f]));
  const newFx = new Map(after.effects.map((f) => [f.id, f]));
  for (const [id, f] of newFx) {
    const prev = oldFx.get(id);
    if (!prev) out.push(`Adds ${EFFECT_WORD[f.kind] ?? f.kind} at ${clipTime(f.startMs)}`);
    else if (!sameJson(prev, f)) out.push(`Changes the ${EFFECT_WORD[f.kind] ?? f.kind} effect`);
  }
  for (const [id, f] of oldFx) if (!newFx.has(id)) out.push(`Removes ${EFFECT_WORD[f.kind] ?? f.kind}`);

  // Whole-edit settings.
  if (before.grade.preset !== after.grade.preset) out.push(after.grade.preset === "none" ? "Removes the colour look" : `Colour look: ${after.grade.preset.replace("-", " ")}`);
  else if (!sameJson(before.grade, after.grade)) out.push("Adjusts the colour");
  if (before.captionTrack.cues.length !== after.captionTrack.cues.length) out.push(`Caption lines ${before.captionTrack.cues.length} → ${after.captionTrack.cues.length}`);
  else if (!sameJson(before.captionTrack, after.captionTrack)) out.push("Restyles the captions");
  if (before.captions !== after.captions) out.push(after.captions ? "Turns transcript captions on" : "Turns transcript captions off");
  if (before.normalize !== after.normalize) out.push(after.normalize ? "Normalizes loudness" : "Stops normalizing loudness");
  if (before.fadeInMs !== after.fadeInMs) out.push(`Fade in ${clipTime(before.fadeInMs)} → ${clipTime(after.fadeInMs)}`);
  if (before.fadeOutMs !== after.fadeOutMs) out.push(`Fade out ${clipTime(before.fadeOutMs)} → ${clipTime(after.fadeOutMs)}`);
  if (before.volume !== after.volume) out.push(`Game audio ${Math.round(before.volume * 100)}% → ${Math.round(after.volume * 100)}%`);
  if (!sameJson(before.sourceAudio, after.sourceAudio)) out.push("Changes how the game audio is processed");
  if (before.coverMs !== after.coverMs) out.push(after.coverMs === null ? "Clears the cover frame" : `Cover frame at ${clipTime(after.coverMs)}`);

  // Anything the editor gains later is still reported, generically.
  const handled = new Set([
    "version", "aspect", "layout", "split", "segments", "texts", "captions", "fadeInMs", "fadeOutMs", "volume", "coverMs",
    "mainTrack", "sourceAudio", "overlays", "audioTracks", "effects", "grade", "captionTrack", "normalize",
  ]);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (handled.has(k)) continue;
    if (!sameJson((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k])) out.push(`Changes ${human(k)}`);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* What the text model must return (validated again after the reply)                          */
/* ------------------------------------------------------------------------------------------ */

/** Sound placement chosen by the model from SLOT1's cues and the library. */
export const ModelSoundPlan = z.object({
  sounds: z.array(z.object({ assetId: z.string(), atMs: z.number(), volume: z.number(), reason: z.string() })),
});
export type ModelSoundPlan = z.infer<typeof ModelSoundPlan>;

/** Posts as the model writes them; SLOT1 trims them to each platform's limits. */
export const ModelPosts = z.object({
  posts: z.array(z.object({ platform: PostPlatform, title: z.string(), caption: z.string(), hashtags: z.array(z.string()) })),
});
export type ModelPosts = z.infer<typeof ModelPosts>;

/** A complete new edit plus a one-line summary. */
export const ModelEditProposal = z.object({ summary: z.string(), edl: Edl });
export type ModelEditProposal = z.infer<typeof ModelEditProposal>;
