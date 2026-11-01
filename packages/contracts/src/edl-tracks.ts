import {
  EDL_LIMITS,
  type AudioClip,
  EDL_MAX_MS,
  edlDurationMs,
  MAIN_SEQUENCE_ID,
  MAX_SEQUENCES,
  segmentOutputMs,
  segmentStartsMs,
  type AudioTrack,
  type Edl,
  type EdlMarker,
  type EdlSegment,
  type MarkerColor,
  type OverlayItem,
  type OverlayTrack,
  type ProjectSequence,
  type ProjectSequences,
} from "./clipper";
import {
  edlId,
  fixTransitions,
  moveRef,
  refKeyOf,
  refSpan,
  rippleDeleteSegments,
  splitAt,
  splitSegmentAt,
  trimRef,
  withSegments,
  type TimelineRef,
} from "./edl-edit";

/*
 * Track-level and sequence-level edit operations for the Studio editor (pure; every function
 * returns a new edit and leaves its input alone). Tracks in the editor:
 *
 *   CC      captions                         (drawn on top of everything)
 *   Vn..V2  overlay tracks, kind "video"     (picture-in-picture, images; any item may sit here)
 *   Tn..T1  overlay tracks, kind "text"      (interleaved with V tracks in stacking order)
 *   FX      effects over the picture         (under overlays, over V1)
 *   V1      the main video track             (magnetic: clips play back to back, no gaps)
 *   A1      V1's own audio                   (linked to V1)
 *   A2..An  audio tracks                     (music, sound effects, voice)
 */

export type TrackKey = "v1" | "a1" | "fx" | "cc" | "texts" | `ov:${string}` | `au:${string}`;

export interface TrackInfo {
  key: TrackKey;
  /** Short label: V1, V2, T1, A1, A2, FX, CC. */
  label: string;
  name: string;
  kind: "main" | "video" | "text" | "source-audio" | "audio" | "effects" | "captions" | "texts";
  /** Overlay or audio track id. */
  id?: string;
  hidden: boolean;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  audio: boolean;
}

/** The editor's tracks, top to bottom as drawn. */
export function listTracks(edl: Edl): TrackInfo[] {
  let v = 1;
  let t = 0;
  const labels = new Map<string, string>();
  for (const tr of edl.overlays) labels.set(tr.id, tr.kind === "text" ? `T${++t}` : `V${++v}`);
  const base = { hidden: false, locked: false, muted: false, solo: false, audio: false };
  const out: TrackInfo[] = [{ ...base, key: "cc", label: "CC", name: "Captions", kind: "captions", hidden: edl.captionTrack.hidden }];
  for (const tr of [...edl.overlays].reverse()) {
    out.push({ ...base, key: `ov:${tr.id}`, label: labels.get(tr.id)!, name: tr.name, kind: tr.kind === "text" ? "text" : "video", id: tr.id, hidden: tr.hidden, locked: tr.locked });
  }
  if (edl.texts.length) out.push({ ...base, key: "texts", label: "T0", name: "Classic text", kind: "texts" });
  out.push({ ...base, key: "fx", label: "FX", name: "Effects", kind: "effects" });
  out.push({ ...base, key: "v1", label: "V1", name: "Video", kind: "main", locked: edl.mainTrack.locked });
  out.push({ ...base, key: "a1", label: "A1", name: "Game audio", kind: "source-audio", muted: edl.sourceAudio.muted, solo: edl.sourceAudio.solo, locked: edl.mainTrack.locked, audio: true });
  edl.audioTracks.forEach((tr, i) => out.push({ ...base, key: `au:${tr.id}`, label: `A${i + 2}`, name: tr.name, kind: "audio", id: tr.id, muted: tr.muted, solo: tr.solo, locked: tr.locked, audio: true }));
  return out;
}

/** The track an item sits on. */
export function refTrackKey(r: TimelineRef): TrackKey {
  switch (r.kind) {
    case "segment":
      return "v1";
    case "overlay":
      return `ov:${r.trackId}`;
    case "audio":
      return `au:${r.trackId}`;
    case "effect":
      return "fx";
    case "caption":
      return "cc";
    case "text":
      return "texts";
  }
}

export function isTrackLocked(edl: Edl, key: TrackKey): boolean {
  if (key === "v1" || key === "a1") return edl.mainTrack.locked;
  if (key.startsWith("ov:")) return edl.overlays.find((t) => t.id === key.slice(3))?.locked ?? false;
  if (key.startsWith("au:")) return edl.audioTracks.find((t) => t.id === key.slice(3))?.locked ?? false;
  return false;
}

const nextName = (prefix: string, taken: string[], from = 1) => {
  for (let n = from; ; n++) if (!taken.includes(`${prefix} ${n}`)) return `${prefix} ${n}`;
};

/** Add a track: video and text tracks go on top of the overlay stack, audio tracks at the bottom. */
export function addTrack(edl: Edl, kind: "video" | "text" | "audio", audioKind: AudioTrack["kind"] = "sfx"): { edl: Edl; key: TrackKey } | null {
  if (kind === "audio") {
    if (edl.audioTracks.length >= EDL_LIMITS.audioTracks) return null;
    const id = edlId("a");
    const name = nextName(audioKind === "music" ? "Music" : audioKind === "voice" ? "Voice" : "Audio", edl.audioTracks.map((t) => t.name));
    const track: AudioTrack = { id, name, kind: audioKind, muted: false, solo: false, locked: false, volume: 1, duck: audioKind === "music", clips: [] };
    return { edl: { ...edl, audioTracks: [...edl.audioTracks, track] }, key: `au:${id}` };
  }
  if (edl.overlays.length >= EDL_LIMITS.overlayTracks) return null;
  const id = edlId("o");
  // Video tracks start at 2: V1 is the main track.
  const name = nextName(kind === "text" ? "Text" : "Video", edl.overlays.map((t) => t.name), kind === "text" ? 1 : 2);
  const track: OverlayTrack = { id, name, kind, hidden: false, locked: false, items: [] };
  return { edl: { ...edl, overlays: [...edl.overlays, track] }, key: `ov:${id}` };
}

/** Remove an overlay or audio track with everything on it. V1, A1, FX and CC always exist. */
export function removeTrack(edl: Edl, key: TrackKey): Edl {
  if (key.startsWith("ov:")) return { ...edl, overlays: edl.overlays.filter((t) => t.id !== key.slice(3)) };
  if (key.startsWith("au:")) return { ...edl, audioTracks: edl.audioTracks.filter((t) => t.id !== key.slice(3)) };
  return edl;
}

export function renameTrack(edl: Edl, key: TrackKey, name: string): Edl {
  const n = name.trim().slice(0, 40);
  if (!n) return edl;
  if (key.startsWith("ov:")) return { ...edl, overlays: edl.overlays.map((t) => (t.id === key.slice(3) ? { ...t, name: n } : t)) };
  if (key.startsWith("au:")) return { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === key.slice(3) ? { ...t, name: n } : t)) };
  return edl;
}

/** Move a track up (-1) or down (+1) as drawn. Overlay order is stacking order: up draws on top. */
export function moveTrack(edl: Edl, key: TrackKey, dir: -1 | 1): Edl {
  const swap = <T extends { id: string }>(list: T[], id: string, by: number): T[] => {
    const i = list.findIndex((t) => t.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  if (key.startsWith("ov:")) return { ...edl, overlays: swap(edl.overlays, key.slice(3), -dir) };
  if (key.startsWith("au:")) return { ...edl, audioTracks: swap(edl.audioTracks, key.slice(3), dir) };
  return edl;
}

export type TrackFlag = "hidden" | "locked" | "muted" | "solo";

/** Flip a track switch. Tracks without that switch are left as they are. */
export function toggleTrack(edl: Edl, key: TrackKey, flag: TrackFlag): Edl {
  if (key === "v1" || key === "a1") {
    if (flag === "locked") return { ...edl, mainTrack: { locked: !edl.mainTrack.locked } };
    if (key === "a1" && (flag === "muted" || flag === "solo")) return { ...edl, sourceAudio: { ...edl.sourceAudio, [flag]: !edl.sourceAudio[flag] } };
    return edl;
  }
  if (key === "cc") return flag === "hidden" ? { ...edl, captionTrack: { ...edl.captionTrack, hidden: !edl.captionTrack.hidden } } : edl;
  if (key.startsWith("ov:") && (flag === "hidden" || flag === "locked")) {
    return { ...edl, overlays: edl.overlays.map((t) => (t.id === key.slice(3) ? { ...t, [flag]: !t[flag] } : t)) };
  }
  if (key.startsWith("au:") && flag !== "hidden") {
    return { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === key.slice(3) ? { ...t, [flag]: !t[flag] } : t)) };
  }
  return edl;
}

/** Every item on one track. */
export function trackRefs(edl: Edl, key: TrackKey): TimelineRef[] {
  if (key === "v1") return edl.segments.map((s) => ({ kind: "segment", id: s.id }));
  if (key === "fx") return edl.effects.map((x) => ({ kind: "effect", id: x.id }));
  if (key === "cc") return edl.captionTrack.cues.map((x) => ({ kind: "caption", id: x.id }));
  if (key === "texts") return edl.texts.map((x) => ({ kind: "text", id: x.id }));
  if (key.startsWith("ov:")) return (edl.overlays.find((t) => t.id === key.slice(3))?.items ?? []).map((x) => ({ kind: "overlay", trackId: key.slice(3), id: x.id }));
  if (key.startsWith("au:")) return (edl.audioTracks.find((t) => t.id === key.slice(3))?.clips ?? []).map((x) => ({ kind: "audio", trackId: key.slice(3), id: x.id }));
  return [];
}

/* ----------------------------------------- razor ------------------------------------------- */

/** Cut every unlocked track at one time (the razor across all tracks, or "add edit"). */
export function razorAll(edl: Edl, atMs: number): { edl: Edl; cuts: number } {
  let next = edl;
  let cuts = 0;
  if (!edl.mainTrack.locked) {
    const r = splitSegmentAt(next, atMs);
    if (r) {
      next = r.edl;
      cuts++;
    }
  }
  for (const key of listTracks(next).map((t) => t.key)) {
    if (key === "v1" || key === "a1" || key === "texts" || isTrackLocked(next, key)) continue;
    for (const ref of trackRefs(next, key)) {
      const span = refSpan(next, ref);
      if (!span || atMs <= span.startMs || atMs >= span.endMs) continue;
      const r = splitAt(next, atMs, ref);
      if (r) {
        next = r.edl;
        cuts++;
      }
    }
  }
  return { edl: next, cuts };
}

/* ------------------------------------- ranges (in/out) ------------------------------------- */

/** Remove what's between `a` and `b` on the unlocked tracks besides V1, leaving a gap (lift). */
export function liftRange(edl: Edl, a: number, b: number): Edl {
  if (b - a < 100) return edl;
  let next = edl;
  for (const key of listTracks(edl).map((t) => t.key)) {
    if (key === "v1" || key === "a1" || key === "texts" || isTrackLocked(edl, key)) continue;
    for (const ref of trackRefs(next, key)) {
      const span = refSpan(next, ref);
      if (!span || span.endMs <= a || span.startMs >= b) continue;
      if (span.startMs >= a && span.endMs <= b) next = removeRef(next, ref);
      else if (span.startMs < a && span.endMs > b) {
        // Spans the whole range: keep both ends.
        const r = splitAt(next, b, ref);
        if (r) next = trimRef(r.edl, ref, "end", a);
      } else if (span.startMs < a) next = trimRef(next, ref, "end", a);
      else next = trimRef(next, ref, "start", b);
    }
  }
  return next;
}

/** Cut `a`..`b` out of the whole edit and close the gap (extract). Null when V1 is locked or the range is too short. */
export function extractRange(edl: Edl, a: number, b: number): Edl | null {
  if (edl.mainTrack.locked || b - a < 300) return null;
  let next = edl;
  for (const t of [b, a]) {
    const r = splitSegmentAt(next, t);
    if (r) next = r.edl;
  }
  const starts = segmentStartsMs(next);
  const inside = next.segments.filter((s, i) => starts[i]! >= a - 150 && starts[i]! + segmentOutputMs(s) <= b + 150).map((s) => s.id);
  if (inside.length === 0 || inside.length === next.segments.length) return null;
  return rippleDeleteSegments(next, inside);
}

/* ----------------------------------------- gaps -------------------------------------------- */

/** Pull every item on a track (not V1, which never has gaps) back so nothing is left between them. */
export function closeGaps(edl: Edl, key: TrackKey): Edl {
  if (key === "v1" || key === "a1" || isTrackLocked(edl, key)) return edl;
  let next = edl;
  let at = 0;
  const refs = trackRefs(edl, key)
    .map((r) => ({ r, span: refSpan(edl, r)! }))
    .filter((x) => x.span)
    .sort((x, y) => x.span.startMs - y.span.startMs);
  for (const { r, span } of refs) {
    if (at !== span.startMs) next = moveRef(next, r, at);
    at += span.endMs - span.startMs;
  }
  return next;
}

/* --------------------------------------- ripple trim --------------------------------------- */

/**
 * Trim an item and move the later items on its track by the same amount (ripple trim). V1
 * always ripples on its own; this is for the free tracks.
 */
export function rippleTrimRef(edl: Edl, ref: TimelineRef, edge: "start" | "end", ms: number, limits?: { maxDurationMs?: number }): Edl {
  const before = refSpan(edl, ref);
  if (!before || ref.kind === "segment") return edl;
  let next = trimRef(edl, ref, edge, ms, limits);
  const after = refSpan(next, ref);
  if (!after) return next;
  const delta = edge === "end" ? after.endMs - before.endMs : before.startMs - after.startMs;
  if (delta === 0) return next;
  if (edge === "start") next = moveRef(next, ref, before.startMs);
  const lead = refSpan(next, ref)!;
  for (const r of trackRefs(next, refTrackKey(ref))) {
    if (refKeyOf(r) === refKeyOf(ref)) continue;
    const s = refSpan(next, r);
    if (s && s.startMs >= before.endMs - 1) next = moveRef(next, r, Math.max(lead.endMs, s.startMs + delta));
  }
  return next;
}

/* -------------------------------------- slip and slide ------------------------------------- */

/** Slip: keep a V1 clip's place and length, change which part of the source it shows. */
export function slipSegment(edl: Edl, id: string, deltaSourceMs: number, maxSourceMs = Number.MAX_SAFE_INTEGER): Edl {
  const s = edl.segments.find((x) => x.id === id);
  if (!s) return edl;
  const len = s.outMs - s.inMs;
  const inMs = Math.max(0, Math.min(maxSourceMs - len, Math.round(s.inMs + deltaSourceMs)));
  if (inMs === s.inMs) return edl;
  const shift = inMs - s.inMs;
  return withSegments(edl, edl.segments.map((x) => (x.id === id ? { ...x, inMs, outMs: inMs + len, keys: x.keys.map((k) => ({ ...k, atMs: k.atMs + shift })) } : x)));
}

/**
 * Slide: move a V1 clip later or earlier between its neighbours, keeping its content. The clip
 * before gets longer (or shorter) and the clip after shorter (or longer) by the same time.
 */
export function slideSegment(edl: Edl, id: string, deltaMs: number, maxSourceMs: (sessionId: string) => number = () => Number.MAX_SAFE_INTEGER): Edl {
  const i = edl.segments.findIndex((x) => x.id === id);
  if (i <= 0 || i >= edl.segments.length - 1) return edl;
  const prev = edl.segments[i - 1]!;
  const next = edl.segments[i + 1]!;
  const ps = prev.rampTo ?? prev.speed;
  const ns = next.speed;
  // Limits: both neighbours keep at least 0.3 s, and stay inside their sources.
  const maxLater = Math.min((maxSourceMs(prev.sessionId) - prev.outMs) / ps, (next.outMs - next.inMs - 300) / ns);
  const maxEarlier = Math.min((prev.outMs - prev.inMs - 300) / ps, next.inMs / ns);
  const d = Math.max(-maxEarlier, Math.min(maxLater, deltaMs));
  if (Math.abs(d) < 1) return edl;
  const segs: EdlSegment[] = edl.segments.map((x, k) =>
    k === i - 1 ? { ...x, outMs: Math.round(x.outMs + d * ps), rampTo: x.rampTo } : k === i + 1 ? { ...x, inMs: Math.round(x.inMs + d * ns) } : x,
  );
  return fixTransitions({ ...edl, segments: segs });
}

/* ------------------------------------- copy and paste -------------------------------------- */

export interface ClipboardItem {
  track: TrackKey;
  /** Offset from the earliest copied item. */
  offsetMs: number;
  segment?: EdlSegment;
  overlay?: OverlayItem;
  audio?: AudioTrack["clips"][number];
  effect?: Edl["effects"][number];
  caption?: Edl["captionTrack"]["cues"][number];
}
export interface Clipboard {
  items: ClipboardItem[];
  spanMs: number;
}

/** Copy items for pasting later (in this edit or another sequence). */
export function copyRefs(edl: Edl, refs: readonly TimelineRef[]): Clipboard | null {
  const spans = refs.flatMap((r) => {
    const s = refSpan(edl, r);
    return s ? [{ r, s }] : [];
  });
  if (spans.length === 0) return null;
  const t0 = Math.min(...spans.map((x) => x.s.startMs));
  const t1 = Math.max(...spans.map((x) => x.s.endMs));
  const items: ClipboardItem[] = spans.flatMap(({ r, s }): ClipboardItem[] => {
    const base = { track: refTrackKey(r), offsetMs: s.startMs - t0 };
    switch (r.kind) {
      case "segment": {
        const seg = edl.segments.find((x) => x.id === r.id);
        return seg ? [{ ...base, segment: seg }] : [];
      }
      case "overlay": {
        const it = edl.overlays.find((t) => t.id === r.trackId)?.items.find((x) => x.id === r.id);
        return it ? [{ ...base, overlay: it }] : [];
      }
      case "audio": {
        const c = edl.audioTracks.find((t) => t.id === r.trackId)?.clips.find((x) => x.id === r.id);
        return c ? [{ ...base, audio: c }] : [];
      }
      case "effect": {
        const f = edl.effects.find((x) => x.id === r.id);
        return f ? [{ ...base, effect: f }] : [];
      }
      case "caption": {
        const c = edl.captionTrack.cues.find((x) => x.id === r.id);
        return c ? [{ ...base, caption: c }] : [];
      }
      default:
        return [];
    }
  });
  return { items, spanMs: t1 - t0 };
}

const shiftKeys = <K extends { atMs: number }>(keys: K[], by: number) => keys.map((k) => ({ ...k, atMs: Math.max(0, Math.round(k.atMs + by)) }));

/**
 * Paste at a time. V1 clips are inserted at the edit point under the time (the clip there is
 * cut first); other items land on the same tracks when they still exist, otherwise on the
 * first track of the same kind (a new one is added when there is none).
 */
export function pasteClipboard(edl: Edl, clip: Clipboard, atMs: number): { edl: Edl; refs: TimelineRef[] } | null {
  let next = edl;
  const refs: TimelineRef[] = [];
  const segs = clip.items.filter((x) => x.segment);
  if (segs.length) {
    if (next.mainTrack.locked || next.segments.length + segs.length > EDL_LIMITS.segments) return null;
    const cut = splitSegmentAt(next, atMs);
    if (cut) next = cut.edl;
    const starts = segmentStartsMs(next);
    let at = next.segments.findIndex((s, i) => starts[i]! >= atMs - 150);
    if (at < 0) at = next.segments.length;
    const copies = segs.map((x) => ({ ...x.segment!, id: edlId("s"), transitionIn: { kind: "cut" as const, durationMs: 0 } }));
    next = withSegments(next, [...next.segments.slice(0, at), ...copies, ...next.segments.slice(at)]);
    refs.push(...copies.map((s): TimelineRef => ({ kind: "segment", id: s.id })));
  }
  const total = edlDurationMs(next);
  const trackFor = (key: TrackKey, kind: "overlay" | "audio"): string | null => {
    if (kind === "overlay") {
      const id = key.startsWith("ov:") ? key.slice(3) : "";
      if (next.overlays.some((t) => t.id === id && !t.locked)) return id;
      const any = next.overlays.find((t) => !t.locked);
      if (any) return any.id;
      const added = addTrack(next, "video");
      if (!added) return null;
      next = added.edl;
      return added.key.slice(3);
    }
    const id = key.startsWith("au:") ? key.slice(3) : "";
    if (next.audioTracks.some((t) => t.id === id && !t.locked)) return id;
    const any = next.audioTracks.find((t) => !t.locked);
    if (any) return any.id;
    const added = addTrack(next, "audio");
    if (!added) return null;
    next = added.edl;
    return added.key.slice(3);
  };
  for (const x of clip.items) {
    const start = Math.round(atMs + x.offsetMs);
    if (start >= total - 100) continue;
    if (x.overlay) {
      const tid = trackFor(x.track, "overlay");
      if (!tid) continue;
      const len = x.overlay.endMs - x.overlay.startMs;
      const it = { ...x.overlay, id: edlId("x"), startMs: start, endMs: Math.min(total, start + len), keys: shiftKeys(x.overlay.keys, start - x.overlay.startMs) } as OverlayItem;
      next = { ...next, overlays: next.overlays.map((t) => (t.id === tid && t.items.length < EDL_LIMITS.overlayItems ? { ...t, items: [...t.items, it] } : t)) };
      refs.push({ kind: "overlay", trackId: tid, id: it.id });
    } else if (x.audio) {
      const tid = trackFor(x.track, "audio");
      if (!tid) continue;
      const c = { ...x.audio, id: edlId("c"), startMs: start, envelope: shiftKeys(x.audio.envelope, start - x.audio.startMs) };
      next = { ...next, audioTracks: next.audioTracks.map((t) => (t.id === tid && t.clips.length < EDL_LIMITS.audioClips ? { ...t, clips: [...t.clips, c] } : t)) };
      refs.push({ kind: "audio", trackId: tid, id: c.id });
    } else if (x.effect && next.effects.length < EDL_LIMITS.effects) {
      const f = { ...x.effect, id: edlId("f"), startMs: start, endMs: Math.min(total, start + (x.effect.endMs - x.effect.startMs)) };
      next = { ...next, effects: [...next.effects, f] };
      refs.push({ kind: "effect", id: f.id });
    } else if (x.caption && next.captionTrack.cues.length < 400) {
      const by = start - x.caption.startMs;
      const c = { ...x.caption, id: edlId("k"), startMs: start, endMs: Math.min(total, x.caption.endMs + by), words: x.caption.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })) };
      next = { ...next, captionTrack: { ...next.captionTrack, cues: [...next.captionTrack.cues, c] } };
      refs.push({ kind: "caption", id: c.id });
    }
  }
  return refs.length ? { edl: next, refs } : null;
}

/** Duplicate items right after themselves (V1 clips) or at the end of the copied span (others). */
export function duplicateRefs(edl: Edl, refs: readonly TimelineRef[]): { edl: Edl; refs: TimelineRef[] } | null {
  const clip = copyRefs(edl, refs);
  if (!clip) return null;
  const spans = refs.map((r) => refSpan(edl, r)).filter((x): x is { startMs: number; endMs: number } => x !== null);
  const end = Math.max(...spans.map((s) => s.endMs));
  return pasteClipboard(edl, clip, end);
}

/** Remove one item without touching anything else (V1 clips still close their gap). */
export function removeRef(edl: Edl, ref: TimelineRef): Edl {
  switch (ref.kind) {
    case "segment":
      return rippleDeleteSegments(edl, [ref.id]) ?? edl;
    case "overlay":
      return { ...edl, overlays: edl.overlays.map((t) => (t.id === ref.trackId ? { ...t, items: t.items.filter((x) => x.id !== ref.id) } : t)) };
    case "audio":
      return { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === ref.trackId ? { ...t, clips: t.clips.filter((x) => x.id !== ref.id) } : t)) };
    case "effect":
      return { ...edl, effects: edl.effects.filter((x) => x.id !== ref.id) };
    case "caption":
      return { ...edl, captionTrack: { ...edl.captionTrack, cues: edl.captionTrack.cues.filter((x) => x.id !== ref.id) } };
    case "text":
      return { ...edl, texts: edl.texts.filter((x) => x.id !== ref.id) };
  }
}

/** Move several free items by the same time (V1 clips can't move in time; they reorder). */
export function nudgeRefs(edl: Edl, refs: readonly TimelineRef[], deltaMs: number): Edl {
  let next = edl;
  for (const r of refs) {
    if (r.kind === "segment" || isTrackLocked(edl, refTrackKey(r))) continue;
    const s = refSpan(next, r);
    if (s) next = moveRef(next, r, Math.max(0, s.startMs + deltaMs));
  }
  return next;
}

/** Items whose span crosses a time range on the given tracks (marquee selection). */
export function refsInRange(edl: Edl, a: number, b: number, tracks: readonly TrackKey[]): TimelineRef[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return tracks.flatMap((k) => (k === "a1" ? [] : trackRefs(edl, k))).filter((r) => {
    const s = refSpan(edl, r);
    return s !== null && s.endMs > lo && s.startMs < hi;
  });
}

/* --------------------------------------- source clips -------------------------------------- */

/**
 * Put part of a stored video into the edit: on V1 it's inserted at the edit point under
 * `atMs` (the clip there is cut first, later clips move right); on a video track it plays
 * full frame from `atMs`.
 */
export function insertSourceClip(
  edl: Edl,
  src: { sessionId: string; inMs: number; outMs: number },
  atMs: number,
  track: TrackKey = "v1",
): { edl: Edl; ref: TimelineRef; note: string } | null {
  const room = EDL_MAX_MS - edlDurationMs(edl);
  const len = Math.min(src.outMs - src.inMs, room, EDL_LIMITS.segmentMs);
  if (len < 300) return null;
  if (track.startsWith("ov:")) {
    const tid = track.slice(3);
    const tr = edl.overlays.find((t) => t.id === tid);
    const total = edlDurationMs(edl);
    if (!tr || tr.locked || tr.items.length >= EDL_LIMITS.overlayItems || atMs >= total - 300) return null;
    const it: OverlayItem = {
      type: "pip",
      id: edlId("p"),
      startMs: Math.round(atMs),
      endMs: Math.round(Math.min(total, atMs + len)),
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      keys: [],
      sessionId: src.sessionId,
      sourceInMs: Math.round(src.inMs),
      box: { x: 0, y: 0, w: 1, h: 1 },
      widthPct: 1,
      border: false,
    };
    return { edl: { ...edl, overlays: edl.overlays.map((t) => (t.id === tid ? { ...t, items: [...t.items, it] } : t)) }, ref: { kind: "overlay", trackId: tid, id: it.id }, note: `Added to ${tr.name}` };
  }
  if (edl.mainTrack.locked || edl.segments.length >= EDL_LIMITS.segments) return null;
  let next = edl;
  const cut = splitSegmentAt(next, atMs);
  if (cut) next = cut.edl;
  const starts = segmentStartsMs(next);
  let at = next.segments.findIndex((s, i) => starts[i]! >= atMs - 150);
  if (at < 0) at = next.segments.length;
  const seg: EdlSegment = {
    id: edlId("s"),
    sessionId: src.sessionId,
    runId: null,
    inMs: Math.round(src.inMs),
    outMs: Math.round(src.inMs + len),
    speed: 1,
    rampTo: null,
    reframe: { x: 0.5, y: 0.5, zoom: 1 },
    keys: [],
    volume: 1,
    transitionIn: { kind: "cut", durationMs: 0 },
  };
  next = withSegments(next, [...next.segments.slice(0, at), seg, ...next.segments.slice(at)]);
  return { edl: next, ref: { kind: "segment", id: seg.id }, note: len < src.outMs - src.inMs ? "Added the part that fits (an edit is at most 30 minutes)" : "Added to V1" };
}

/* -------------------------------------- detached audio ------------------------------------- */

export const DETACHED_TRACK_NAME = "Detached audio";

/** Why a V1 clip's sound can't be detached, or null when it can. */
export function detachProblem(edl: Edl, segId: string): string | null {
  const s = edl.segments.find((x) => x.id === segId);
  if (!s) return "That clip isn't on V1";
  if (s.runId) return "Detach the sound after the recording is finished";
  if (s.speed !== 1 || (s.rampTo !== null && s.rampTo !== 1)) return "Detach audio works on clips at normal speed";
  if (s.volume === 0) return "This clip's sound is already off (detached or muted)";
  return null;
}

/**
 * Detach a V1 clip's sound: it moves to an audio track as its own clip (same time, same part
 * of the video), and the V1 clip goes quiet. The sound can then be moved and trimmed on its
 * own, for J and L cuts. It no longer gets the game-audio clean-up (denoise, voice boost).
 */
export function detachAudio(edl: Edl, segId: string): { edl: Edl; ref: TimelineRef } | null {
  if (detachProblem(edl, segId)) return null;
  const i = edl.segments.findIndex((x) => x.id === segId);
  const s = edl.segments[i]!;
  const startMs = Math.round(segmentStartsMs(edl)[i]!);
  const durationMs = Math.round(segmentOutputMs(s));
  const free = (t: AudioTrack) => !t.locked && t.clips.length < EDL_LIMITS.audioClips && t.clips.every((c) => c.startMs + c.durationMs <= startMs || c.startMs >= startMs + durationMs);
  let next = edl;
  let track = next.audioTracks.find((t) => t.name === DETACHED_TRACK_NAME && free(t));
  if (!track) {
    const added = addTrack(next, "audio", "voice");
    if (!added) return null;
    next = renameTrack(added.edl, added.key, DETACHED_TRACK_NAME);
    next = { ...next, audioTracks: next.audioTracks.map((t) => (`au:${t.id}` === added.key ? { ...t, duck: false } : t)) };
    track = next.audioTracks.find((t) => `au:${t.id}` === added.key)!;
  }
  const clip: AudioClip = {
    id: edlId("c"),
    source: { kind: "session", sessionId: s.sessionId },
    startMs,
    offsetMs: s.inMs,
    durationMs,
    volume: Math.min(2, Math.round(s.volume * edl.volume * 100) / 100),
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: false,
    envelope: [],
    link: s.id,
  };
  const tid = track.id;
  return {
    edl: {
      ...next,
      segments: next.segments.map((x) => (x.id === s.id ? { ...x, volume: 0 } : x)),
      audioTracks: next.audioTracks.map((t) => (t.id === tid ? { ...t, clips: [...t.clips, clip] } : t)),
    },
    ref: { kind: "audio", trackId: tid, id: clip.id },
  };
}

/** Put a detached sound back on its V1 clip (the audio clip goes away). */
export function relinkAudio(edl: Edl, trackId: string, clipId: string): Edl | null {
  const c = edl.audioTracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
  if (!c?.link || c.source.kind !== "session") return null;
  const seg = edl.segments.find((s) => s.id === c.link);
  if (!seg) return null;
  const volume = Math.min(2, Math.max(0, Math.round((c.volume / Math.max(0.01, edl.volume)) * 100) / 100));
  return {
    ...edl,
    segments: edl.segments.map((s) => (s.id === seg.id ? { ...s, volume } : s)),
    audioTracks: edl.audioTracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.filter((x) => x.id !== clipId) } : t)),
  };
}

/* ----------------------------------------- markers ----------------------------------------- */

const MARKER_COLORS: MarkerColor[] = ["red", "gold", "blue", "green", "violet"];

export function addMarker(edl: Edl, atMs: number, label = "", color: MarkerColor = "red"): { edl: Edl; id: string } | null {
  const markers = edl.markers ?? [];
  if (markers.length >= EDL_LIMITS.markers) return null;
  const at = Math.max(0, Math.round(atMs));
  if (markers.some((m) => Math.abs(m.atMs - at) < 20)) return null;
  const m: EdlMarker = { id: edlId("m"), atMs: at, durationMs: 0, label: label.slice(0, 80), color };
  return { edl: { ...edl, markers: [...markers, m].sort((x, y) => x.atMs - y.atMs) }, id: m.id };
}

export function updateMarker(edl: Edl, id: string, patch: Partial<Omit<EdlMarker, "id">>): Edl {
  return { ...edl, markers: (edl.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch, atMs: Math.max(0, Math.round(patch.atMs ?? m.atMs)) } : m)).sort((x, y) => x.atMs - y.atMs) };
}

export function removeMarker(edl: Edl, id: string): Edl {
  return { ...edl, markers: (edl.markers ?? []).filter((m) => m.id !== id) };
}

export const nextMarkerColor = (c: MarkerColor): MarkerColor => MARKER_COLORS[(MARKER_COLORS.indexOf(c) + 1) % MARKER_COLORS.length]!;

/* ---------------------------------------- sequences ---------------------------------------- */

/** The project's timelines as the editor holds them. */
export interface ProjectDoc {
  main: Edl;
  sequences: ProjectSequences;
}

export interface SequenceInfo {
  id: string;
  name: string;
  edl: Edl;
}

export function docSequences(doc: ProjectDoc): SequenceInfo[] {
  return [{ id: MAIN_SEQUENCE_ID, name: doc.sequences.mainName, edl: doc.main }, ...doc.sequences.extra];
}

export function docEdl(doc: ProjectDoc, id: string): Edl {
  return id === MAIN_SEQUENCE_ID ? doc.main : (doc.sequences.extra.find((s) => s.id === id)?.edl ?? doc.main);
}

export function setDocEdl(doc: ProjectDoc, id: string, edl: Edl): ProjectDoc {
  if (id === MAIN_SEQUENCE_ID) return doc.main === edl ? doc : { ...doc, main: edl };
  const cur = doc.sequences.extra.find((s) => s.id === id);
  if (!cur || cur.edl === edl) return doc;
  return { ...doc, sequences: { ...doc.sequences, extra: doc.sequences.extra.map((s) => (s.id === id ? { ...s, edl } : s)) } };
}

const uniqueSeqName = (doc: ProjectDoc, base: string) => {
  const taken = docSequences(doc).map((s) => s.name);
  if (!taken.includes(base)) return base.slice(0, 40);
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`.slice(0, 40))) return `${base} ${n}`.slice(0, 40);
};

/**
 * A new sequence: a copy of `fromId` (duplicate), optionally in another shape. A new shape
 * starts with the same clips; the crop and overlays are kept as they are and may need moving.
 */
export function addSequence(doc: ProjectDoc, fromId: string, opts: { name?: string; aspect?: Edl["aspect"] } = {}): { doc: ProjectDoc; id: string } | null {
  if (doc.sequences.extra.length >= MAX_SEQUENCES - 1) return null;
  const src = docEdl(doc, fromId);
  const fromName = docSequences(doc).find((s) => s.id === fromId)?.name ?? "Sequence";
  const aspect = opts.aspect ?? src.aspect;
  const edl: Edl = { ...src, aspect, layout: aspect === "9:16" ? src.layout : src.layout === "split" ? "crop" : src.layout };
  const name = uniqueSeqName(doc, opts.name?.trim() || (aspect !== src.aspect ? `${fromName} ${aspect}` : `${fromName} copy`));
  const seq: ProjectSequence = { id: edlId("q"), name, edl };
  return { doc: { ...doc, sequences: { ...doc.sequences, extra: [...doc.sequences.extra, seq] } }, id: seq.id };
}

export function renameSequence(doc: ProjectDoc, id: string, name: string): ProjectDoc {
  const n = name.trim().slice(0, 40);
  if (!n) return doc;
  if (id === MAIN_SEQUENCE_ID) return { ...doc, sequences: { ...doc.sequences, mainName: n } };
  return { ...doc, sequences: { ...doc.sequences, extra: doc.sequences.extra.map((s) => (s.id === id ? { ...s, name: n } : s)) } };
}

/** Delete a sequence. The main sequence stays (it's the project's own edit). */
export function removeSequence(doc: ProjectDoc, id: string): ProjectDoc {
  if (id === MAIN_SEQUENCE_ID) return doc;
  return { ...doc, sequences: { ...doc.sequences, extra: doc.sequences.extra.filter((s) => s.id !== id) } };
}

/** Move an extra sequence's tab left (-1) or right (+1). */
export function moveSequence(doc: ProjectDoc, id: string, dir: -1 | 1): ProjectDoc {
  const list = [...doc.sequences.extra];
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return doc;
  [list[i], list[j]] = [list[j]!, list[i]!];
  return { ...doc, sequences: { ...doc.sequences, extra: list } };
}
