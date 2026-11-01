import {
  edlDurationMs,
  edlLocate,
  edlOutputTime,
  EDL_MAX_MS,
  interpolateKeys,
  segmentOutputMs,
  segmentPieces,
  segmentStartsMs,
  transitionOverlapMs,
  type AudioClip,
  type Edl,
  type EdlBox,
  type EdlSegment,
  type OverlayItem,
  type OverlayTrack,
} from "./clipper";

/**
 * Pure editing operations on an EDL, shared by the editor and its tests. Every function returns
 * a new EDL and leaves its input untouched; results still need `Edl.safeParse` before saving.
 */

let seq = 0;
/** A short id that is unique within an edit (letters and digits, at most 40 characters). */
export function edlId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36).slice(-6)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 40);
}

/** Something on the timeline the editor can select. */
export type TimelineRef =
  | { kind: "segment"; id: string }
  | { kind: "overlay"; trackId: string; id: string }
  | { kind: "audio"; trackId: string; id: string }
  | { kind: "effect"; id: string }
  | { kind: "caption"; id: string }
  | { kind: "text"; id: string };

export const refKeyOf = (r: TimelineRef) => `${r.kind}:${"trackId" in r ? `${r.trackId}:` : ""}${r.id}`;

/** Output-timeline span of a selectable item (segments use their place in the edit). */
export function refSpan(edl: Edl, r: TimelineRef): { startMs: number; endMs: number } | null {
  switch (r.kind) {
    case "segment": {
      const i = edl.segments.findIndex((s) => s.id === r.id);
      if (i < 0) return null;
      const start = segmentStartsMs(edl)[i]!;
      return { startMs: Math.round(start), endMs: Math.round(start + segmentOutputMs(edl.segments[i]!)) };
    }
    case "overlay": {
      const it = edl.overlays.find((t) => t.id === r.trackId)?.items.find((x) => x.id === r.id);
      return it ? { startMs: it.startMs, endMs: it.endMs } : null;
    }
    case "audio": {
      const c = edl.audioTracks.find((t) => t.id === r.trackId)?.clips.find((x) => x.id === r.id);
      return c ? { startMs: c.startMs, endMs: c.startMs + c.durationMs } : null;
    }
    case "effect": {
      const f = edl.effects.find((x) => x.id === r.id);
      return f ? { startMs: f.startMs, endMs: f.endMs } : null;
    }
    case "caption": {
      const c = edl.captionTrack.cues.find((x) => x.id === r.id);
      return c ? { startMs: c.startMs, endMs: c.endMs } : null;
    }
    case "text": {
      const t = edl.texts.find((x) => x.id === r.id);
      return t ? { startMs: t.startMs, endMs: t.endMs } : null;
    }
  }
}

/* ------------------------------------------ snapping --------------------------------------- */

/** Every place something starts or ends on the output timeline, for snapping. */
export function edlEdges(edl: Edl, exclude?: TimelineRef[]): number[] {
  const skip = new Set((exclude ?? []).map(refKeyOf));
  const out = new Set<number>([0, edlDurationMs(edl)]);
  const add = (r: TimelineRef, a: number, b: number) => {
    if (skip.has(refKeyOf(r))) return;
    out.add(Math.round(a));
    out.add(Math.round(b));
  };
  const starts = segmentStartsMs(edl);
  edl.segments.forEach((s, i) => add({ kind: "segment", id: s.id }, starts[i]!, starts[i]! + segmentOutputMs(s)));
  for (const t of edl.overlays) for (const it of t.items) add({ kind: "overlay", trackId: t.id, id: it.id }, it.startMs, it.endMs);
  for (const t of edl.audioTracks) for (const c of t.clips) add({ kind: "audio", trackId: t.id, id: c.id }, c.startMs, c.startMs + c.durationMs);
  for (const f of edl.effects) add({ kind: "effect", id: f.id }, f.startMs, f.endMs);
  for (const c of edl.captionTrack.cues) add({ kind: "caption", id: c.id }, c.startMs, c.endMs);
  for (const t of edl.texts) add({ kind: "text", id: t.id }, t.startMs, t.endMs);
  return [...out].sort((a, b) => a - b);
}

/** Snap a time to the nearest target within `tolerance` ms. */
export function snapTime(ms: number, targets: readonly number[], tolerance: number): { ms: number; snapped: boolean; target: number | null } {
  let best: number | null = null;
  for (const t of targets) if (Math.abs(t - ms) <= tolerance && (best === null || Math.abs(t - ms) < Math.abs(best - ms))) best = t;
  return best === null ? { ms, snapped: false, target: null } : { ms: best, snapped: true, target: best };
}

/* --------------------------------------- time remapping ------------------------------------ */

type Timed = { startMs: number; endMs: number };

/** Apply a time mapping to everything that lives on the output timeline; drops items squeezed below `minMs`. */
export function remapTimeline(edl: Edl, map: (t: number) => number, minMs = 100): Edl {
  const span = <T extends Timed>(x: T): T | null => {
    const a = Math.max(0, Math.round(map(x.startMs)));
    const b = Math.round(map(x.endMs));
    return b - a < minMs ? null : { ...x, startMs: a, endMs: b };
  };
  const keys = <K extends { atMs: number }>(ks: K[]) => ks.map((k) => ({ ...k, atMs: Math.max(0, Math.round(map(k.atMs))) }));
  return {
    ...edl,
    texts: edl.texts.flatMap((t) => span(t) ?? []),
    overlays: edl.overlays.map((tr) => ({
      ...tr,
      items: tr.items.flatMap((it) => {
        const s = span(it);
        return s ? [{ ...s, keys: keys(s.keys) } as OverlayItem] : [];
      }),
    })),
    audioTracks: edl.audioTracks.map((tr) => ({
      ...tr,
      clips: tr.clips.flatMap((c) => {
        const a = Math.max(0, Math.round(map(c.startMs)));
        const b = Math.round(map(c.startMs + c.durationMs));
        if (b - a < 50) return [];
        const durationMs = b - a;
        return [{ ...c, startMs: a, durationMs, fadeInMs: Math.min(c.fadeInMs, durationMs), fadeOutMs: Math.min(c.fadeOutMs, Math.max(0, durationMs - Math.min(c.fadeInMs, durationMs))), envelope: keys(c.envelope) }];
      }),
    })),
    effects: edl.effects.flatMap((f) => span(f) ?? []),
    captionTrack: {
      ...edl.captionTrack,
      cues: edl.captionTrack.cues.flatMap((c) => {
        const s = span(c);
        return s ? [{ ...s, words: s.words.flatMap((w) => span(w) ?? []) }] : [];
      }),
    },
    sourceAudio: { ...edl.sourceAudio, envelope: keys(edl.sourceAudio.envelope) },
    coverMs: edl.coverMs === null ? null : Math.max(0, Math.round(map(edl.coverMs))),
  };
}

/** Keep transitions valid after segments changed around them (shorten, or fall back to a cut). */
export function fixTransitions(edl: Edl): Edl {
  return {
    ...edl,
    segments: edl.segments.map((s, i) => {
      if (s.transitionIn.kind === "cut") return s.transitionIn.durationMs === 0 ? s : { ...s, transitionIn: { kind: "cut", durationMs: 0 } };
      if (i === 0) return { ...s, transitionIn: { kind: "cut", durationMs: 0 } };
      const limit = Math.floor(Math.min(segmentOutputMs(s), segmentOutputMs(edl.segments[i - 1]!)) - 100);
      if (limit < 100) return { ...s, transitionIn: { kind: "cut", durationMs: 0 } };
      return s.transitionIn.durationMs > limit ? { ...s, transitionIn: { ...s.transitionIn, durationMs: limit } } : s;
    }),
  };
}

/** Clamp timed items to the edit's length (after it got shorter). */
export function clampToDuration(edl: Edl): Edl {
  const total = edlDurationMs(edl);
  return remapTimeline(edl, (t) => Math.min(t, total));
}

/** Source time shown at output time `t` inside segment `index` (clamped to the segment). */
export function sourceAtOutput(edl: Edl, index: number, t: number): number {
  const s = edl.segments[index]!;
  let rest = Math.max(0, t - segmentStartsMs(edl)[index]!);
  for (const p of segmentPieces(s)) {
    const d = (p.outMs - p.inMs) / p.speed;
    if (rest <= d) return Math.min(p.outMs, p.inMs + rest * p.speed);
    rest -= d;
  }
  return s.outMs;
}

/**
 * Replace the main track and carry everything else along. Items keep their place in the
 * footage: a time is mapped through the source time it shows. Items over removed footage are
 * trimmed, or dropped when nothing is left.
 */
function withSegments(edl: Edl, segments: EdlSegment[]): Edl {
  const oldStarts = segmentStartsMs(edl);
  const draft = fixTransitions({ ...edl, segments });
  const newIndex = new Map(draft.segments.map((s, i) => [s.id, i]));
  const newStarts = segmentStartsMs(draft);
  const total = edlDurationMs(draft);
  const kept = edl.segments
    .map((s, i) => ({ i, a: oldStarts[i]!, b: oldStarts[i]! + segmentOutputMs(s), j: newIndex.get(s.id) }))
    .filter((x): x is { i: number; a: number; b: number; j: number } => x.j !== undefined);
  const map = (t: number) => {
    for (const k of kept) {
      if (t < k.a || t > k.b) continue;
      const src = sourceAtOutput(edl, k.i, t);
      const ns = draft.segments[k.j]!;
      if (src <= ns.inMs) return newStarts[k.j]!;
      if (src >= ns.outMs) return newStarts[k.j]! + segmentOutputMs(ns);
      return Math.min(total, edlOutputTime(draft, k.j, src));
    }
    // In removed time: where the next kept footage now starts.
    const next = kept.filter((k) => k.a > t).sort((x, y) => x.a - y.a)[0];
    return next ? newStarts[next.j]! : total;
  };
  return remapTimeline(draft, (t) => Math.min(total, Math.max(0, map(t))));
}

/* ---------------------------------------- segments ----------------------------------------- */

const keysWithin = (s: EdlSegment, a: number, b: number) => {
  if (s.keys.length === 0) return [];
  const inside = s.keys.filter((k) => k.atMs > a && k.atMs < b);
  const at = (t: number) => ({ atMs: t, x: interpolateKeys(s.keys, t, (k) => k.x), y: interpolateKeys(s.keys, t, (k) => k.y), zoom: interpolateKeys(s.keys, t, (k) => k.zoom) });
  return [at(a), ...inside, at(b)].slice(0, 16);
};

/** Speed of a (ramped) segment at a source time. */
export function speedAt(s: EdlSegment, sourceMs: number): number {
  if (s.rampTo === null) return s.speed;
  const f = Math.min(1, Math.max(0, (sourceMs - s.inMs) / Math.max(1, s.outMs - s.inMs)));
  return Math.round((s.speed + (s.rampTo - s.speed) * f) * 1000) / 1000;
}

/** Split the segment under output time `atMs` in two (cut at the playhead). */
export function splitSegmentAt(edl: Edl, atMs: number): { edl: Edl; leftId: string; rightId: string } | null {
  if (edl.segments.length >= 20) return null;
  const { index, sourceMs } = edlLocate(edl, atMs);
  const s = edl.segments[index]!;
  if (sourceMs - s.inMs < 300 || s.outMs - sourceMs < 300) return null;
  const mid = speedAt(s, sourceMs);
  const left: EdlSegment = { ...s, outMs: sourceMs, rampTo: s.rampTo === null ? null : mid, keys: keysWithin(s, s.inMs, sourceMs) };
  const right: EdlSegment = { ...s, id: edlId("s"), inMs: sourceMs, speed: s.rampTo === null ? s.speed : mid, keys: keysWithin(s, sourceMs, s.outMs), transitionIn: { kind: "cut", durationMs: 0 } };
  const segments = [...edl.segments.slice(0, index), left, right, ...edl.segments.slice(index + 1)];
  return { edl: fixTransitions({ ...edl, segments }), leftId: left.id, rightId: right.id };
}

/** Remove segments and close the gap; everything after them moves earlier (ripple delete). */
export function rippleDeleteSegments(edl: Edl, ids: readonly string[]): Edl | null {
  const drop = new Set(ids);
  const kept = edl.segments.filter((s) => !drop.has(s.id));
  if (kept.length === 0 || kept.length === edl.segments.length) return null;
  return withSegments(edl, kept);
}

/** Move a segment to another place in the main track; items over it travel with it. */
export function moveSegment(edl: Edl, id: string, toIndex: number): Edl {
  const from = edl.segments.findIndex((s) => s.id === id);
  if (from < 0) return edl;
  const segs = [...edl.segments];
  const [x] = segs.splice(from, 1);
  segs.splice(Math.max(0, Math.min(segs.length, toIndex)), 0, x!);
  if (segs.every((s, i) => s.id === edl.segments[i]!.id)) return edl;
  return withSegments(edl, segs);
}

/** Change one segment (trim, speed, ramp…) and keep the rest of the timeline in sync. */
export function updateSegment(edl: Edl, id: string, fn: (s: EdlSegment) => EdlSegment): Edl {
  return withSegments(edl, edl.segments.map((s) => (s.id === id ? fn(s) : s)));
}

/**
 * Trim a segment's in or out point to a source time. `ripple` (the default) lets everything after
 * it move; without it the trim is limited to keep the edit's length (a roll with its neighbour).
 */
export function trimSegment(edl: Edl, id: string, edge: "in" | "out", sourceMs: number, maxSourceMs = Number.MAX_SAFE_INTEGER): Edl {
  return updateSegment(edl, id, (s) => {
    let inMs = s.inMs;
    let outMs = s.outMs;
    if (edge === "in") inMs = Math.max(0, Math.min(Math.round(sourceMs), s.outMs - 300, s.outMs - 1));
    else outMs = Math.min(maxSourceMs, Math.max(Math.round(sourceMs), s.inMs + 300));
    if (outMs - inMs > 5 * 60_000) {
      if (edge === "in") inMs = outMs - 5 * 60_000;
      else outMs = inMs + 5 * 60_000;
    }
    return { ...s, inMs, outMs, keys: s.keys.filter((k) => k.atMs >= inMs && k.atMs <= outMs) };
  });
}

/**
 * Roll the cut between segment `index` and the next one by `deltaOutMs`: one gets longer and the
 * other shorter by the same amount, so the edit's length and everything after stay put.
 */
export function rollEdit(edl: Edl, index: number, deltaOutMs: number, maxSourceMs: (sessionId: string) => number = () => Number.MAX_SAFE_INTEGER): Edl {
  const a = edl.segments[index];
  const b = edl.segments[index + 1];
  if (!a || !b || deltaOutMs === 0) return edl;
  const sa = a.rampTo ?? a.speed;
  const sb = b.speed;
  // Limits, in output ms: both stay at least 0.3 s and inside their source media.
  const maxGrow = Math.min((maxSourceMs(a.sessionId) - a.outMs) / sa, (b.outMs - b.inMs - 300) / sb);
  const maxShrink = Math.min((a.outMs - a.inMs - 300) / sa, b.inMs / sb);
  const d = Math.max(-maxShrink, Math.min(maxGrow, deltaOutMs));
  if (Math.abs(d) < 1) return edl;
  const segs = edl.segments.map((s, i) => {
    if (i === index) {
      const outMs = Math.round(s.outMs + d * sa);
      return { ...s, outMs, keys: s.keys.filter((k) => k.atMs <= outMs) };
    }
    if (i === index + 1) {
      const inMs = Math.round(s.inMs + d * sb);
      return { ...s, inMs, keys: s.keys.filter((k) => k.atMs >= inMs) };
    }
    return s;
  });
  return fixTransitions({ ...edl, segments: segs });
}

/** Insert a segment after `afterIndex`; later items move by the time it adds (ripple insert). */
export function insertSegment(edl: Edl, seg: EdlSegment, afterIndex: number): Edl | null {
  if (edl.segments.length >= 20) return null;
  const at = Math.max(-1, Math.min(edl.segments.length - 1, afterIndex));
  return withSegments(edl, [...edl.segments.slice(0, at + 1), seg, ...edl.segments.slice(at + 1)]);
}

/**
 * Instant replay: the `lengthMs` before `atMs` again in slow motion, flashed in right after the
 * moment, with a REPLAY tag over it.
 */
export function instantReplay(edl: Edl, atMs: number, lengthMs = 2500, speed = 0.5): { edl: Edl; note: string } | null {
  const split = splitSegmentAt(edl, atMs);
  const base = split?.edl ?? edl;
  // The replay goes right after the moment: after the split's left half, or the segment there.
  const index = split ? base.segments.findIndex((x) => x.id === split.leftId) : edlLocate(base, atMs).index;
  const s = base.segments[index]!;
  const sourceMs = split ? s.outMs : edlLocate(base, atMs).sourceMs;
  const inMs = Math.max(0, sourceMs - lengthMs);
  if (sourceMs - inMs < 600 || base.segments.length >= 20) return null;
  const replay: EdlSegment = { ...s, id: edlId("r"), inMs, outMs: sourceMs, speed, rampTo: null, keys: keysWithin(s, inMs, sourceMs).filter((k) => k.atMs >= inMs && k.atMs <= sourceMs), transitionIn: { kind: "flash", durationMs: 250 } };
  let next = insertSegment(base, replay, index);
  if (!next) return null;
  const i = next.segments.findIndex((x) => x.id === replay.id);
  const start = Math.round(segmentStartsMs(next)[i]!);
  const end = Math.round(start + segmentOutputMs(replay));
  next = addOverlayItem(next, { type: "text", id: edlId("t"), startMs: start, endMs: end, x: 0.5, y: 0.12, scale: 1, rotation: 0, opacity: 1, keys: [], text: "REPLAY", subtext: "", style: "banner", animation: "pop" });
  return { edl: fixTransitions(next), note: `Instant replay added: ${(lengthMs / 1000).toFixed(1)} s at ${speed}×` };
}

/* ----------------------------------- overlays, audio, rest --------------------------------- */

/** Which overlay track a new item would go on: an existing track's id, or null for a new track. */
export function pickOverlayTrack(edl: Edl, item: { startMs: number; endMs: number }): string | null {
  const free = edl.overlays.find((t) => !t.locked && t.items.length < 40 && !t.items.some((x) => x.startMs < item.endMs && x.endMs > item.startMs));
  if (free) return free.id;
  if (edl.overlays.length < 4) return null;
  return edl.overlays.find((t) => !t.locked && t.items.length < 40)?.id ?? null;
}

/**
 * Put an overlay item on `trackId` when that track exists and is unlocked, otherwise on the first
 * unlocked track with room, otherwise on a new track (named `newTrackId` when given).
 */
export function addOverlayItem(edl: Edl, item: OverlayItem, trackId?: string, newTrackId?: string): Edl {
  const explicit = trackId ? edl.overlays.find((t) => t.id === trackId && !t.locked && t.items.length < 40) : undefined;
  const id = explicit?.id ?? pickOverlayTrack(edl, item);
  if (id) return { ...edl, overlays: edl.overlays.map((t) => (t.id === id ? { ...t, items: [...t.items, item] } : t)) };
  if (edl.overlays.length >= 4) return edl;
  const track: OverlayTrack = { id: newTrackId ?? edlId("ov"), name: `Overlay ${edl.overlays.length + 1}`, hidden: false, locked: false, items: [item] };
  return { ...edl, overlays: [...edl.overlays, track] };
}

/** Put an audio clip on a track of that kind (creating one when needed). */
export function addAudioClip(edl: Edl, clip: AudioClip, kind: "music" | "sfx" | "voice", trackId?: string): Edl {
  const target = trackId ? edl.audioTracks.find((t) => t.id === trackId && !t.locked) : edl.audioTracks.find((t) => t.kind === kind && !t.locked && t.clips.length < 60);
  if (target) return { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === target.id ? { ...t, clips: [...t.clips, clip] } : t)) };
  if (edl.audioTracks.length >= 4) return edl;
  const name = kind === "music" ? "Music" : kind === "voice" ? "Voice" : "Sound effects";
  return { ...edl, audioTracks: [...edl.audioTracks, { id: edlId("au"), name, kind, muted: false, solo: false, locked: false, volume: 1, duck: kind === "music", clips: [clip] }] };
}

/** Every selectable item in the edit. */
export function allRefs(edl: Edl): TimelineRef[] {
  return [
    ...edl.segments.map((s): TimelineRef => ({ kind: "segment", id: s.id })),
    ...edl.overlays.flatMap((t) => t.items.map((x): TimelineRef => ({ kind: "overlay", trackId: t.id, id: x.id }))),
    ...edl.audioTracks.flatMap((t) => t.clips.map((x): TimelineRef => ({ kind: "audio", trackId: t.id, id: x.id }))),
    ...edl.effects.map((x): TimelineRef => ({ kind: "effect", id: x.id })),
    ...edl.captionTrack.cues.map((x): TimelineRef => ({ kind: "caption", id: x.id })),
    ...edl.texts.map((x): TimelineRef => ({ kind: "text", id: x.id })),
  ];
}

const laneOf = (r: TimelineRef) => (r.kind === "overlay" || r.kind === "audio" ? `${r.kind}:${r.trackId}` : r.kind);

/**
 * Remove items. Segments always close their gap (ripple); other items leave a gap unless
 * `ripple`, which pulls later items on the same track earlier.
 */
export function deleteRefs(edl: Edl, refs: readonly TimelineRef[], ripple = false): Edl {
  const segIds = refs.filter((r) => r.kind === "segment").map((r) => r.id);
  let next = segIds.length ? (rippleDeleteSegments(edl, segIds) ?? edl) : edl;
  const others = refs.filter((r) => r.kind !== "segment");
  if (others.length === 0) return next;
  const removed = others.flatMap((r) => {
    const span = refSpan(next, r);
    return span ? [{ lane: laneOf(r), ...span }] : [];
  });
  const gone = new Set(others.map(refKeyOf));
  const keep = (r: TimelineRef) => !gone.has(refKeyOf(r));
  next = {
    ...next,
    overlays: next.overlays.map((t) => ({ ...t, items: t.items.filter((x) => keep({ kind: "overlay", trackId: t.id, id: x.id })) })),
    audioTracks: next.audioTracks.map((t) => ({ ...t, clips: t.clips.filter((x) => keep({ kind: "audio", trackId: t.id, id: x.id })) })),
    effects: next.effects.filter((x) => keep({ kind: "effect", id: x.id })),
    captionTrack: { ...next.captionTrack, cues: next.captionTrack.cues.filter((x) => keep({ kind: "caption", id: x.id })) },
    texts: next.texts.filter((x) => keep({ kind: "text", id: x.id })),
  };
  if (!ripple) return next;
  for (const r of allRefs(next)) {
    if (r.kind === "segment") continue;
    const span = refSpan(next, r);
    if (!span) continue;
    const d = removed.filter((x) => x.lane === laneOf(r) && x.endMs <= span.startMs).reduce((n, x) => n + (x.endMs - x.startMs), 0);
    if (d > 0) next = moveRef(next, r, span.startMs - d);
  }
  return next;
}

/** Split whatever is selected (or the main track) at the playhead. */
export function splitAt(edl: Edl, atMs: number, ref?: TimelineRef): { edl: Edl; note: string } | null {
  if (!ref || ref.kind === "segment") {
    const r = splitSegmentAt(edl, atMs);
    return r ? { edl: r.edl, note: "Split the video at the playhead" } : null;
  }
  const cut = <T extends { id: string; startMs: number; endMs: number }>(x: T): [T, T] | null => (atMs - x.startMs < 100 || x.endMs - atMs < 100 ? null : [{ ...x, endMs: atMs }, { ...x, id: edlId("x"), startMs: atMs }]);
  if (ref.kind === "overlay") {
    const tr = edl.overlays.find((t) => t.id === ref.trackId);
    const it = tr?.items.find((x) => x.id === ref.id);
    const parts = it && tr && tr.items.length < 40 ? cut(it) : null;
    if (!parts) return null;
    return { edl: { ...edl, overlays: edl.overlays.map((t) => (t.id === tr!.id ? { ...t, items: t.items.flatMap((x) => (x.id === it!.id ? (parts as OverlayItem[]) : [x])) } : t)) }, note: "Split the overlay" };
  }
  if (ref.kind === "audio") {
    const tr = edl.audioTracks.find((t) => t.id === ref.trackId);
    const c = tr?.clips.find((x) => x.id === ref.id);
    if (!c || !tr || atMs - c.startMs < 100 || c.startMs + c.durationMs - atMs < 100 || tr.clips.length >= 60) return null;
    const leftDur = atMs - c.startMs;
    const left: AudioClip = { ...c, durationMs: leftDur, fadeOutMs: 0, fadeInMs: Math.min(c.fadeInMs, leftDur) };
    const right: AudioClip = { ...c, id: edlId("c"), startMs: atMs, offsetMs: c.offsetMs + leftDur, durationMs: c.durationMs - leftDur, fadeInMs: 0, fadeOutMs: Math.min(c.fadeOutMs, c.durationMs - leftDur) };
    return { edl: { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === tr.id ? { ...t, clips: t.clips.flatMap((x) => (x.id === c.id ? [left, right] : [x])) } : t)) }, note: "Split the audio clip" };
  }
  if (ref.kind === "effect") {
    const f = edl.effects.find((x) => x.id === ref.id);
    const parts = f && edl.effects.length < 30 ? cut(f) : null;
    return parts ? { edl: { ...edl, effects: edl.effects.flatMap((x) => (x.id === f!.id ? parts : [x])) }, note: "Split the effect" } : null;
  }
  if (ref.kind === "caption") {
    const c = edl.captionTrack.cues.find((x) => x.id === ref.id);
    const parts = c ? cut(c) : null;
    if (!parts || !c) return null;
    const words = c.text.split(/\s+/);
    const share = Math.max(1, Math.min(words.length - 1, Math.round((words.length * (atMs - c.startMs)) / (c.endMs - c.startMs))));
    const [l, r] = parts;
    const lt = words.slice(0, share).join(" ") || c.text;
    const rt = words.slice(share).join(" ") || c.text;
    return { edl: { ...edl, captionTrack: { ...edl.captionTrack, cues: edl.captionTrack.cues.flatMap((x) => (x.id === c.id ? [{ ...l, text: lt, words: [] }, { ...r, text: rt, words: [] }] : [x])) } }, note: "Split the caption" };
  }
  return null;
}

/** Move a timed (non-segment) item to a new start, keeping its length; keyframes travel with it. */
export function moveRef(edl: Edl, ref: TimelineRef, startMs: number): Edl {
  const total = edlDurationMs(edl);
  const clampStart = (len: number) => Math.max(0, Math.min(Math.round(startMs), Math.max(0, total - Math.min(len, 100))));
  switch (ref.kind) {
    case "overlay":
      return {
        ...edl,
        overlays: edl.overlays.map((t) =>
          t.id !== ref.trackId
            ? t
            : {
                ...t,
                items: t.items.map((x) => {
                  if (x.id !== ref.id) return x;
                  const len = x.endMs - x.startMs;
                  const a = clampStart(len);
                  const d = a - x.startMs;
                  return { ...x, startMs: a, endMs: a + len, keys: x.keys.map((k) => ({ ...k, atMs: Math.max(0, k.atMs + d) })) };
                }),
              },
        ),
      };
    case "audio":
      return {
        ...edl,
        audioTracks: edl.audioTracks.map((t) =>
          t.id !== ref.trackId
            ? t
            : {
                ...t,
                clips: t.clips.map((c) => {
                  if (c.id !== ref.id) return c;
                  const a = clampStart(c.durationMs);
                  const d = a - c.startMs;
                  return { ...c, startMs: a, envelope: c.envelope.map((k) => ({ ...k, atMs: Math.max(0, k.atMs + d) })) };
                }),
              },
        ),
      };
    case "effect":
      return { ...edl, effects: edl.effects.map((f) => (f.id === ref.id ? { ...f, startMs: clampStart(f.endMs - f.startMs), endMs: clampStart(f.endMs - f.startMs) + (f.endMs - f.startMs) } : f)) };
    case "caption":
      return {
        ...edl,
        captionTrack: {
          ...edl.captionTrack,
          cues: edl.captionTrack.cues.map((c) => {
            if (c.id !== ref.id) return c;
            const a = clampStart(c.endMs - c.startMs);
            const d = a - c.startMs;
            return { ...c, startMs: a, endMs: c.endMs + d, words: c.words.map((w) => ({ ...w, startMs: w.startMs + d, endMs: w.endMs + d })) };
          }),
        },
      };
    case "text":
      return { ...edl, texts: edl.texts.map((t) => (t.id === ref.id ? { ...t, startMs: clampStart(t.endMs - t.startMs), endMs: clampStart(t.endMs - t.startMs) + (t.endMs - t.startMs) } : t)) };
    case "segment":
      return edl;
  }
}

/** Change a timed (non-segment) item's start or end. */
export function trimRef(edl: Edl, ref: TimelineRef, edge: "start" | "end", ms: number, limits?: { maxDurationMs?: number }): Edl {
  const total = edlDurationMs(edl);
  const t = Math.max(0, Math.min(Math.round(ms), total));
  const span = <T extends Timed>(x: T): T => (edge === "start" ? { ...x, startMs: Math.min(t, x.endMs - 100) } : { ...x, endMs: Math.max(t, x.startMs + 100) });
  switch (ref.kind) {
    case "overlay":
      return { ...edl, overlays: edl.overlays.map((tr) => (tr.id !== ref.trackId ? tr : { ...tr, items: tr.items.map((x) => (x.id === ref.id ? span(x) : x)) })) };
    case "audio":
      return {
        ...edl,
        audioTracks: edl.audioTracks.map((tr) =>
          tr.id !== ref.trackId
            ? tr
            : {
                ...tr,
                clips: tr.clips.map((c) => {
                  if (c.id !== ref.id) return c;
                  const end = c.startMs + c.durationMs;
                  const maxDur = limits?.maxDurationMs ?? EDL_MAX_MS;
                  if (edge === "start") {
                    // Trimming the head moves into the file: the offset follows.
                    const a = Math.max(0, Math.min(t, end - 50), c.loop ? 0 : c.startMs - c.offsetMs);
                    const durationMs = end - a;
                    return { ...c, startMs: a, offsetMs: Math.max(0, c.offsetMs + (a - c.startMs)), durationMs, fadeInMs: Math.min(c.fadeInMs, durationMs), fadeOutMs: Math.min(c.fadeOutMs, durationMs) };
                  }
                  const durationMs = Math.max(50, Math.min(t - c.startMs, c.loop ? EDL_MAX_MS : maxDur - c.offsetMs));
                  return { ...c, durationMs, fadeInMs: Math.min(c.fadeInMs, durationMs), fadeOutMs: Math.min(c.fadeOutMs, Math.max(0, durationMs - c.fadeInMs)) };
                }),
              },
        ),
      };
    case "effect":
      return { ...edl, effects: edl.effects.map((f) => (f.id === ref.id ? span(f) : f)) };
    case "caption":
      return { ...edl, captionTrack: { ...edl.captionTrack, cues: edl.captionTrack.cues.map((c) => (c.id === ref.id ? { ...span(c), words: [] } : c)) } };
    case "text":
      return { ...edl, texts: edl.texts.map((x) => (x.id === ref.id ? span(x) : x)) };
    case "segment":
      return edl;
  }
}

/* ------------------------------------------ templates -------------------------------------- */

export interface TemplateMarker {
  sessionId: string;
  ms: number;
  label: string;
  kind: "big" | "event" | "text";
}
export interface TemplateContext {
  title: string;
  markers: TemplateMarker[];
  cameraBox: EdlBox | null;
  /** Length of each session's stored video, when known. */
  durations: Record<string, number | null>;
}

export const EDL_TEMPLATES = [
  { id: "tiktok-highlight", name: "TikTok highlight", description: "Vertical, facecam on top when your camera box is set, a title card, punch-ins on the AI's big moments, loudness normalized." },
  { id: "best-of", name: "Best-of reel", description: "A cut of every big moment the AI found, joined with flashes and labelled with lower thirds." },
  { id: "wasted-moment", name: "Wasted moment", description: "The run-up to a WASTED, slowing into the moment, then the freeze, the shake and the banner." },
] as const;
export type EdlTemplateId = (typeof EDL_TEMPLATES)[number]["id"];

/** Where a source-media moment lands in the edit, if it's inside a segment. */
export function markerOutputMs(edl: Edl, m: { sessionId: string; ms: number }): number | null {
  const i = edl.segments.findIndex((s) => s.sessionId === m.sessionId && m.ms >= s.inMs && m.ms <= s.outMs);
  return i < 0 ? null : edlOutputTime(edl, i, m.ms);
}

const clampSeg = (ctx: TemplateContext, sessionId: string, a: number, b: number) => {
  const max = ctx.durations[sessionId] ?? Number.MAX_SAFE_INTEGER;
  return { inMs: Math.max(0, Math.round(a)), outMs: Math.min(max, Math.round(b)) };
};

/**
 * Apply a template. Templates only use what exists: the edit, the AI's moments and the camera box.
 * When something they need is missing, the edit comes back unchanged with a note saying why.
 */
export function applyEdlTemplate(id: EdlTemplateId, edl: Edl, ctx: TemplateContext): { edl: Edl; note: string; changed: boolean } {
  const total = edlDurationMs(edl);
  const big = ctx.markers.filter((m) => m.kind === "big");
  if (id === "tiktok-highlight") {
    let next: Edl = {
      ...edl,
      aspect: "9:16",
      layout: ctx.cameraBox ? "split" : "fit",
      split: ctx.cameraBox ? { ...edl.split, cam: ctx.cameraBox } : edl.split,
      normalize: true,
      fadeOutMs: Math.min(Math.max(edl.fadeOutMs, 300), Math.floor(total / 4)),
      captionTrack: { ...edl.captionTrack, style: "karaoke" },
    };
    const titleEnd = Math.min(total - 1, 2200);
    if (!next.overlays.some((t) => t.items.some((x) => x.type === "text" && x.style === "title-card")) && titleEnd > 300) {
      next = addOverlayItem(next, { type: "text", id: edlId("t"), startMs: 0, endMs: titleEnd, x: 0.5, y: ctx.cameraBox ? 0.48 : 0.2, scale: 1, rotation: 0, opacity: 1, keys: [], text: ctx.title.slice(0, 48).toUpperCase(), subtext: "", style: "title-card", animation: "pop" });
    }
    const punches = big
      .map((m) => markerOutputMs(next, m))
      .filter((t): t is number => t !== null && t + 400 < total)
      .slice(0, 6);
    for (const t of punches) {
      if (next.effects.length >= 30) break;
      next = { ...next, effects: [...next.effects, { id: edlId("e"), kind: "punch", startMs: t, endMs: Math.min(total, t + 700), text: "", amount: 0.45 }] };
    }
    const bits = [ctx.cameraBox ? "facecam on top from your camera box" : "whole picture over a blurred backdrop (set your camera box under Stream setup for a facecam split)", "title card", punches.length ? `${punches.length} punch-in${punches.length === 1 ? "" : "s"} on AI moments` : "no AI moments inside the edit for punch-ins", "loudness normalized"];
    return { edl: next, note: `TikTok highlight: ${bits.join(", ")}.`, changed: true };
  }
  if (id === "best-of") {
    const sessionIds = new Set(edl.segments.map((s) => s.sessionId));
    const picks = big.filter((m) => sessionIds.has(m.sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.ms - b.ms);
    if (picks.length === 0) return { edl, note: "No big AI moments (MISSION PASSED, WASTED…) were found in this video, so there's nothing to build a reel from.", changed: false };
    const ranges: { sessionId: string; inMs: number; outMs: number; label: string }[] = [];
    for (const m of picks) {
      const r = clampSeg(ctx, m.sessionId, m.ms - 4000, m.ms + 2000);
      const last = ranges.at(-1);
      if (last && last.sessionId === m.sessionId && r.inMs <= last.outMs) last.outMs = Math.max(last.outMs, r.outMs);
      else if (r.outMs - r.inMs >= 1000) ranges.push({ sessionId: m.sessionId, ...r, label: m.label });
      if (ranges.length >= 12) break;
    }
    const first = edl.segments[0]!;
    const segments: EdlSegment[] = ranges.map((r, i) => ({ ...first, id: `b${i + 1}`, sessionId: r.sessionId, runId: null, inMs: r.inMs, outMs: r.outMs, speed: 1, rampTo: null, keys: [], volume: 1, transitionIn: i === 0 ? { kind: "cut", durationMs: 0 } : { kind: "flash", durationMs: 250 } }));
    let next: Edl = fixTransitions({ ...edl, segments, texts: [], overlays: [], effects: [], captionTrack: { ...edl.captionTrack, cues: [] }, audioTracks: edl.audioTracks.map((t) => ({ ...t, clips: [] })), normalize: true, coverMs: null });
    while (edlDurationMs(next) > EDL_MAX_MS && next.segments.length > 1) next = fixTransitions({ ...next, segments: next.segments.slice(0, -1) });
    const starts = segmentStartsMs(next);
    next.segments.forEach((s, i) => {
      const r = ranges[i]!;
      next = addOverlayItem(next, { type: "text", id: edlId("t"), startMs: Math.round(starts[i]!), endMs: Math.round(starts[i]! + Math.min(1800, segmentOutputMs(s) - 100)), x: 0.08, y: 0.86, scale: 1, rotation: 0, opacity: 1, keys: [], text: r.label.slice(0, 60), subtext: `#${i + 1}`, style: "lower-third", animation: "slide" });
    });
    next = { ...next, fadeInMs: 0, fadeOutMs: Math.min(500, Math.floor(edlDurationMs(next) / 4)) };
    return { edl: next, note: `Best-of reel: ${next.segments.length} moment${next.segments.length === 1 ? "" : "s"} the AI marked, joined with flashes. Music and captions were cleared; add your own.`, changed: true };
  }
  // Wasted moment
  const sessionIds = new Set(edl.segments.map((s) => s.sessionId));
  const wasted = big.filter((m) => sessionIds.has(m.sessionId) && /wasted/i.test(m.label));
  const m = wasted[0] ?? null;
  if (!m) return { edl, note: "The AI hasn't marked a WASTED in this video, so the template has no moment to build on. Add the WASTED effect by hand in the Look tab.", changed: false };
  const first = edl.segments.find((s) => s.sessionId === m.sessionId)!;
  const a = clampSeg(ctx, m.sessionId, m.ms - 6000, m.ms - 1500);
  const b = clampSeg(ctx, m.sessionId, m.ms - 1500, m.ms + 300);
  const c = clampSeg(ctx, m.sessionId, m.ms + 300, m.ms + 3000);
  const parts = [a, b, c].filter((r) => r.outMs - r.inMs >= 300);
  if (parts.length < 2) return { edl, note: "The WASTED moment is too close to the start or end of the video for this template.", changed: false };
  const segments: EdlSegment[] = parts.map((r, i) => ({ ...first, id: `w${i + 1}`, runId: null, ...r, speed: 1, rampTo: r === b ? 0.4 : null, keys: [], volume: 1, transitionIn: { kind: "cut", durationMs: 0 } }));
  let next: Edl = fixTransitions({ ...edl, segments, texts: [], overlays: [], effects: [], captionTrack: { ...edl.captionTrack, cues: [] }, coverMs: null });
  const hit = markerOutputMs(next, m) ?? Math.max(0, edlDurationMs(next) - 2500);
  const end = edlDurationMs(next);
  next = {
    ...next,
    effects: [
      { id: edlId("e"), kind: "shake", startMs: Math.max(0, hit - 250), endMs: Math.min(end, hit + 350), text: "", amount: 0.6 },
      { id: edlId("e"), kind: "wasted", startMs: Math.min(end - 300, hit + 120), endMs: end, text: "", amount: 0.5 },
    ],
    fadeOutMs: Math.min(400, Math.floor(end / 4)),
  };
  return { edl: next, note: "Wasted moment: the run-up, a slow-motion ramp into the WASTED the AI marked, then the shake, freeze and banner.", changed: true };
}

/** The edit's segments that overlap the given output range (for selections and markers). */
export function segmentsInRange(edl: Edl, a: number, b: number): string[] {
  const starts = segmentStartsMs(edl);
  return edl.segments.filter((s, i) => starts[i]! < b && starts[i]! + segmentOutputMs(s) > a).map((s) => s.id);
}

/** Overlap (in ms) between segment `index` and the previous one. */
export const overlapBefore = (edl: Edl, index: number) => transitionOverlapMs(edl.segments, index);
