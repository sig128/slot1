"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  edlEdges,
  edlOutputTime,
  isTrackLocked,
  listTracks,
  moveRef,
  moveSegment,
  razorAll,
  refKeyOf,
  refsInRange,
  refTrackKey,
  rippleTrimRef,
  rollEdit,
  segmentOutputMs,
  segmentStartsMs,
  slideSegment,
  slipSegment,
  snapTime,
  sourceAtOutput,
  splitAt,
  SPRITE_TIERS,
  trimRef,
  trimSegment,
  updateMarker,
  type Edl,
  type EdlMarker,
  type MediaRef,
  type OverlayItem,
  type SpriteSheetView,
  type StudioAsset,
  type TimelineRef,
  type TrackInfo,
  type TrackKey,
} from "@slot1/contracts";
import { isAssetDrag, readAssetDrag } from "../library/studio-assets-client";
import { ContextMenu, type MenuEntry, type MenuState } from "./Menu";
import { clamp, isSourceDrag, readSourceDrag, rulerLabel, timecode, type SourceDrag } from "./util";

export type Tool = "select" | "razor" | "ripple" | "roll" | "slip" | "slide" | "hand" | "zoom";
export const TOOLS: { id: Tool; label: string; key: string; hint: string; glyph: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Select, move and trim", glyph: "M5 3l13 8-6 1 3 7-3 1-3-7-4 4z" },
  { id: "razor", label: "Razor", key: "C", hint: "Cut a clip where you click (Shift: every track)", glyph: "M6 4a3 3 0 1 0 2 5l3 2-3 2a3 3 0 1 0 2 2l9-7-2-1-6 4V9l6-4 2-1-9-1a3 3 0 0 0-4 1z" },
  { id: "ripple", label: "Ripple trim", key: "B", hint: "Trim, and move what follows on the track", glyph: "M4 4h2v16H4zM9 12l5-5v3h6v4h-6v3z" },
  { id: "roll", label: "Roll", key: "N", hint: "Move the cut between two V1 clips", glyph: "M11 4h2v16h-2zM3 12l4-4v3h3v2H7v3zM21 12l-4 4v-3h-3v-2h3V8z" },
  { id: "slip", label: "Slip", key: "Y", hint: "Change which part of the source a clip shows", glyph: "M3 6h18v12H3zM8 12l3-3v2h2V9l3 3-3 3v-2h-2v2z" },
  { id: "slide", label: "Slide", key: "U", hint: "Move a V1 clip between its neighbours", glyph: "M2 8h5v8H2zM17 8h5v8h-5zM8 7h8v10H8z" },
  { id: "hand", label: "Hand", key: "H", hint: "Drag to scroll the timeline", glyph: "M7 11V6a1.5 1.5 0 0 1 3 0v4V4.5a1.5 1.5 0 0 1 3 0V10V5.5a1.5 1.5 0 0 1 3 0V11V8a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7s-6-2-8-5l-2-3a1.5 1.5 0 0 1 2.5-1.5z" },
  { id: "zoom", label: "Zoom", key: "Z", hint: "Click to zoom in (Alt: zoom out)", glyph: "M10 3a7 7 0 1 0 4.2 12.6L20 21.4l1.4-1.4-5.8-5.8A7 7 0 0 0 10 3zm-1 3h2v3h3v2h-3v3H9v-3H6V9h3z" },
];

export interface AiMarker {
  ms: number;
  label: string;
  kind: "big" | "event" | "text";
}

export interface Range {
  inMs: number | null;
  outMs: number | null;
}

interface Props {
  edl: Edl;
  total: number;
  fps: number;
  playheadMs: number;
  playing: boolean;
  selection: TimelineRef[];
  onSelect: (refs: TimelineRef[], mode?: "replace" | "toggle" | "add") => void;
  aiMarkers: AiMarker[];
  range: Range;
  onRange: (r: Range) => void;
  tool: Tool;
  snapping: boolean;
  pps: number;
  minPps: number;
  maxPps: number;
  onPps: (pps: number) => void;
  heights: Record<string, number>;
  onHeight: (key: TrackKey, h: number) => void;
  expanded: string[];
  onExpand: (key: TrackKey) => void;
  sourcePeaks: (sessionId: string) => { peaks: number[]; durationMs: number } | null;
  clipPeaks: (ref: MediaRef) => { peaks: number[]; durationMs: number } | null;
  clipName: (ref: MediaRef) => string;
  sourceTitle: (sessionId: string) => string;
  maxSourceMs: (sessionId: string) => number;
  sprites: (sessionId: string, tier: number) => SpriteSheetView | null;
  onSeek: (ms: number) => void;
  onEdit: (fn: (e: Edl) => Edl, label: string, coalesce?: string) => void;
  announce: (m: string) => void;
  onDropAsset: (asset: StudioAsset, atMs: number, track: TrackKey) => void;
  onDropSource: (src: SourceDrag, atMs: number, track: TrackKey) => void;
  clipMenu: (ref: TimelineRef, atMs: number) => MenuEntry[];
  trackMenu: (track: TrackInfo) => MenuEntry[];
  laneMenu: (track: TrackInfo, atMs: number) => MenuEntry[];
  markerMenu: (m: EdlMarker) => MenuEntry[];
  selectedMarker: string | null;
  onSelectMarker: (id: string | null) => void;
  onRename: (key: TrackKey, name: string) => void;
  onToggle: (key: TrackKey, flag: "hidden" | "locked" | "muted" | "solo") => void;
}

const HEAD_W = 184;
const RULER_H = 34;
const KEY_H = 22;
const SNAP_PX = 8;
export const DEFAULT_HEIGHTS: Record<TrackInfo["kind"], number> = { captions: 26, video: 44, text: 34, texts: 28, effects: 28, main: 64, "source-audio": 46, audio: 46 };
const MAX_TRACK_H = 160;
const MIN_TRACK_H = 22;
const AI_TONE: Record<AiMarker["kind"], string> = { big: "nle-blip-gold", text: "nle-blip-apricot", event: "nle-blip-blue" };

let dragSeq = 0;

/** Steps for the ruler, from one frame to an hour. */
function rulerSteps(fps: number) {
  const f = 1000 / fps;
  return [f, 2 * f, 5 * f, 10 * f, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
}

/** Move an overlay item or an audio clip to another track of the same kind. */
function moveToTrack(edl: Edl, ref: TimelineRef, to: TrackKey): { edl: Edl; ref: TimelineRef } | null {
  if (ref.kind === "overlay" && to.startsWith("ov:")) {
    const tid = to.slice(3);
    if (tid === ref.trackId) return null;
    const it = edl.overlays.find((t) => t.id === ref.trackId)?.items.find((x) => x.id === ref.id);
    if (!it) return null;
    return {
      edl: { ...edl, overlays: edl.overlays.map((t) => (t.id === ref.trackId ? { ...t, items: t.items.filter((x) => x.id !== ref.id) } : t.id === tid ? { ...t, items: [...t.items, it] } : t)) },
      ref: { kind: "overlay", trackId: tid, id: ref.id },
    };
  }
  if (ref.kind === "audio" && to.startsWith("au:")) {
    const tid = to.slice(3);
    if (tid === ref.trackId) return null;
    const c = edl.audioTracks.find((t) => t.id === ref.trackId)?.clips.find((x) => x.id === ref.id);
    if (!c) return null;
    return {
      edl: { ...edl, audioTracks: edl.audioTracks.map((t) => (t.id === ref.trackId ? { ...t, clips: t.clips.filter((x) => x.id !== ref.id) } : t.id === tid ? { ...t, clips: [...t.clips, c] } : t)) },
      ref: { kind: "audio", trackId: tid, id: ref.id },
    };
  }
  return null;
}

/**
 * The editor's timeline: a track header column and long, zoomable lanes from hours down to
 * single frames. Only what is on screen is drawn, so long edits stay quick.
 */
export function Timeline(p: Props) {
  const { edl, total, pps } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, top: 0, width: 900, height: 300 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TrackKey | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const anchor = useRef<{ ms: number; screenX: number } | null>(null);
  const prevPps = useRef(pps);

  const tracks = useMemo(() => listTracks(edl), [edl]);
  const starts = useMemo(() => segmentStartsMs(edl), [edl]);
  const selected = useMemo(() => new Set(p.selection.map(refKeyOf)), [p.selection]);
  const anySolo = edl.sourceAudio.solo || edl.audioTracks.some((t) => t.solo);
  const heightOf = (t: TrackInfo) => clamp(p.heights[t.key] ?? DEFAULT_HEIGHTS[t.kind], MIN_TRACK_H, MAX_TRACK_H);
  const x = (ms: number) => (ms / 1000) * pps;
  const laneW = Math.max(0, view.width - HEAD_W);
  const contentW = Math.max(laneW, Math.ceil(x(total + Math.max(15_000, total * 0.3))));
  // What's on screen (lane time), with one screen of margin either side.
  const visA = (view.left / pps) * 1000;
  const visB = ((view.left + laneW) / pps) * 1000;
  const marginMs = Math.max(2000, visB - visA);
  const inView = (a: number, b: number) => b >= visA - marginMs && a <= visB + marginMs;

  // Row layout (content coordinates), for marquee and drag-between-tracks.
  const rows = useMemo(() => {
    let y = RULER_H;
    return tracks.map((t) => {
      const h = clamp(p.heights[t.key] ?? DEFAULT_HEIGHTS[t.kind], MIN_TRACK_H, MAX_TRACK_H);
      const k = p.expanded.includes(t.key) ? KEY_H : 0;
      const r = { key: t.key, top: y, h, k };
      y += h + k;
      return r;
    });
  }, [tracks, p.heights, p.expanded]);
  const contentH = (rows.at(-1)?.top ?? RULER_H) + (rows.at(-1)?.h ?? 0) + (rows.at(-1)?.k ?? 0);

  /* ----------------------------------- view tracking ----------------------------------- */

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setView((v) => (v.left === el.scrollLeft && v.top === el.scrollTop && v.width === el.clientWidth && v.height === el.clientHeight ? v : { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Zoom keeps a point still: the pointer for wheel zooms, otherwise the playhead (or the middle).
  useLayoutEffect(() => {
    const el = scroller.current;
    const before = prevPps.current;
    prevPps.current = pps;
    if (!el || before === pps) return;
    const lw = el.clientWidth - HEAD_W;
    let a = anchor.current;
    anchor.current = null;
    if (!a) {
      const phx = (p.playheadMs / 1000) * before - el.scrollLeft;
      a = phx >= 0 && phx <= lw ? { ms: p.playheadMs, screenX: phx } : { ms: ((el.scrollLeft + lw / 2) / before) * 1000, screenX: lw / 2 };
    }
    el.scrollLeft = Math.max(0, (a.ms / 1000) * pps - a.screenX);
    // Only zoom changes move the view here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pps]);

  // Keep the playhead on screen while it plays (page along), or after a jump.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const px = (p.playheadMs / 1000) * pps;
    const lw = el.clientWidth - HEAD_W;
    if (px < el.scrollLeft || px > el.scrollLeft + lw - 24) el.scrollLeft = Math.max(0, px - (p.playing ? lw * 0.1 : lw * 0.3));
    // Following the playhead only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.playheadMs]);

  // Ctrl/⌘ + wheel zooms around the pointer; Alt + wheel scrolls sideways.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const sx = e.clientX - r.left - HEAD_W;
        anchor.current = { ms: ((el.scrollLeft + sx) / pps) * 1000, screenX: sx };
        p.onPps(clamp(pps * Math.pow(1.0018, -e.deltaY), p.minPps, p.maxPps));
      } else if (e.altKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [pps, p]);

  /* -------------------------------------- helpers -------------------------------------- */

  const msAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.round(((el.scrollLeft + clientX - r.left - HEAD_W) / pps) * 1000));
  };
  const rowAt = (clientY: number) => {
    const el = scroller.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    return rows.find((r) => y >= r.top && y < r.top + r.h + r.k) ?? null;
  };
  const tolerance = (SNAP_PX / pps) * 1000;
  const snapTargets = (exclude: TimelineRef[]) =>
    p.snapping ? [...edlEdges(edl, exclude), Math.round(p.playheadMs), ...(edl.markers ?? []).map((m) => m.atMs), ...p.aiMarkers.map((m) => Math.round(m.ms)), ...(p.range.inMs !== null ? [p.range.inMs] : []), ...(p.range.outMs !== null ? [p.range.outMs] : [])] : [];
  const snapEdge = (ms: number, targets: number[], free: boolean) => {
    if (free || targets.length === 0) return ms;
    const s = snapTime(ms, targets, tolerance);
    return s.ms;
  };
  const snapSpan = (start: number, len: number, targets: number[], free: boolean) => {
    if (free || targets.length === 0) return start;
    const a = snapTime(start, targets, tolerance);
    const b = snapTime(start + len, targets, tolerance);
    if (a.snapped && (!b.snapped || Math.abs(a.ms - start) <= Math.abs(b.ms - start - len))) return a.ms;
    if (b.snapped) return b.ms - len;
    return start;
  };

  /** Pointer drag with capture; `move` gets the time travelled (ms) and the event. */
  const drag = (e: React.PointerEvent, move: (dMs: number, ev: PointerEvent) => void, done?: (ev: PointerEvent, moved: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      if (moved) move(((ev.clientX - x0) / pps) * 1000, ev);
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setSnapLine(null);
      done?.(ev, moved);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const pick = (r: TimelineRef, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) p.onSelect([r], "toggle");
    else if (!selected.has(refKeyOf(r))) p.onSelect([r], "replace");
  };

  const openMenu = (label: string, items: MenuEntry[], x0: number, y0: number) => setMenu({ label, items, x: x0, y: y0 });

  /* ---------------------------------- clip interactions -------------------------------- */

  const onBlockDown = (r: TimelineRef, e: React.PointerEvent, span: { startMs: number; endMs: number }, locked: boolean, edge: "start" | "end" | null) => {
    if (e.button !== 0) return;
    const tool = p.tool;
    if (tool === "hand") return startPan(e);
    if (tool === "zoom") {
      e.stopPropagation();
      const el = scroller.current!;
      const sx = e.clientX - el.getBoundingClientRect().left - HEAD_W;
      anchor.current = { ms: msAt(e.clientX), screenX: sx };
      return p.onPps(clamp(pps * (e.altKey ? 1 / 1.6 : 1.6), p.minPps, p.maxPps));
    }
    if (tool === "razor") {
      e.preventDefault();
      e.stopPropagation();
      if (locked) return p.announce("That track is locked");
      let at = msAt(e.clientX);
      if (p.snapping) at = snapTime(at, [Math.round(p.playheadMs), ...edlEdges(edl)], tolerance).ms;
      if (e.shiftKey) {
        const res = razorAll(edl, at);
        if (!res.cuts) return p.announce("Nothing to cut there");
        p.onEdit(() => res.edl, "Cut every track");
        return p.announce(`Cut ${res.cuts} clip${res.cuts === 1 ? "" : "s"} at ${timecode(at, p.fps)}`);
      }
      const res = splitAt(edl, at, r);
      if (!res) return p.announce("Too close to the clip's edge to cut");
      p.onEdit(() => res.edl, "Razor");
      return p.announce(`${res.note} at ${timecode(at, p.fps)}`);
    }
    pick(r, e);
    if (locked) return;
    const orig = edl;
    const key = `${tool}:${refKeyOf(r)}:${++dragSeq}`;
    const targets = snapTargets([r]);
    const seg = r.kind === "segment" ? orig.segments.find((s) => s.id === r.id) : undefined;
    const segIndex = seg ? orig.segments.indexOf(seg) : -1;

    if (tool === "slip") {
      if (seg) return drag(e, (d) => p.onEdit(() => slipSegment(orig, seg.id, -d * seg.speed, p.maxSourceMs(seg.sessionId)), "Slip", key));
      const it = r.kind === "overlay" ? orig.overlays.find((t) => t.id === r.trackId)?.items.find((i) => i.id === r.id) : undefined;
      if (it?.type === "pip") {
        return drag(e, (d) => p.onEdit((ed) => ({ ...ed, overlays: ed.overlays.map((t) => (t.id === (r as { trackId: string }).trackId ? { ...t, items: t.items.map((i) => (i.id === it.id && i.type === "pip" ? { ...i, sourceInMs: Math.max(0, Math.round(it.sourceInMs - d)) } : i)) } : t)) }), "Slip", key));
      }
      return p.announce("Slip works on video clips");
    }
    if (tool === "slide") {
      if (!seg) return p.announce("Slide works on V1 clips");
      if (segIndex <= 0 || segIndex >= orig.segments.length - 1) return p.announce("Slide needs a clip on both sides");
      return drag(e, (d) => p.onEdit(() => slideSegment(orig, seg.id, d, p.maxSourceMs), "Slide", key));
    }

    // Trims (select, ripple and roll tools), from the clip's edge handles.
    if (edge) {
      if (seg) {
        const canRoll = edge === "end" ? segIndex < orig.segments.length - 1 : segIndex > 0;
        return drag(e, (d, ev) => {
          const edgeMs = edge === "start" ? span.startMs : span.endMs;
          const to = snapEdge(edgeMs + d, targets, ev.shiftKey);
          if (to !== edgeMs + d) setSnapLine(to);
          const dOut = to - edgeMs;
          if ((tool === "roll" || ev.altKey) && canRoll) {
            p.onEdit(() => rollEdit(orig, edge === "end" ? segIndex : segIndex - 1, dOut, p.maxSourceMs), "Roll", key);
            return;
          }
          const speed = edge === "start" ? seg.speed : (seg.rampTo ?? seg.speed);
          const src = edge === "start" ? seg.inMs + dOut * speed : seg.outMs + dOut * speed;
          p.onEdit(() => trimSegment(orig, seg.id, edge === "start" ? "in" : "out", src, p.maxSourceMs(seg.sessionId)), "Trim", key);
        });
      }
      if (tool === "roll") return p.announce("Roll works on cuts between V1 clips");
      const file = r.kind === "audio" ? (orig.audioTracks.find((t) => t.id === r.trackId)?.clips.find((c) => c.id === r.id)?.source ?? null) : null;
      const maxDurationMs = file ? (p.clipPeaks(file)?.durationMs ?? undefined) : undefined;
      return drag(e, (d, ev) => {
        const edgeMs = edge === "start" ? span.startMs : span.endMs;
        const to = snapEdge(edgeMs + d, targets, ev.shiftKey);
        if (to !== edgeMs + d) setSnapLine(to);
        p.onEdit(() => (tool === "ripple" ? rippleTrimRef(orig, r, edge, to, { maxDurationMs }) : trimRef(orig, r, edge, to, { maxDurationMs })), tool === "ripple" ? "Ripple trim" : "Trim", key);
      });
    }

    if (seg) {
      // V1 clips reorder: drop between two others.
      return drag(
        e,
        (_, ev) => setSnapLine(msAt(ev.clientX)),
        (ev, moved) => {
          if (!moved) return;
          const at = msAt(ev.clientX);
          let to = orig.segments.findIndex((s, i) => at < starts[i]! + segmentOutputMs(s) / 2);
          if (to < 0) to = orig.segments.length;
          if (to > segIndex) to -= 1;
          if (to !== segIndex) {
            p.onEdit(() => moveSegment(orig, seg.id, to), "Move clip");
            p.announce(`Moved the clip to position ${to + 1}`);
          }
        },
      );
    }
    const len = span.endMs - span.startMs;
    let last = orig;
    drag(
      e,
      (d, ev) => {
        const s = snapSpan(Math.max(0, span.startMs + d), len, targets, ev.shiftKey);
        if (s !== Math.max(0, span.startMs + d)) setSnapLine(s);
        last = moveRef(orig, r, s);
        p.onEdit(() => last, "Move", key);
        const row = rowAt(ev.clientY);
        setDropLane(row && row.key !== refTrackKey(r) ? row.key : null);
      },
      (ev, moved) => {
        setDropLane(null);
        if (!moved) return;
        const row = rowAt(ev.clientY);
        if (!row || row.key === refTrackKey(r)) return;
        if (isTrackLocked(last, row.key)) return p.announce("That track is locked");
        const res = moveToTrack(last, r, row.key);
        if (!res) return;
        p.onEdit(() => res.edl, "Move", key);
        p.onSelect([res.ref], "replace");
      },
    );
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const el = scroller.current!;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const s0 = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    const mv = (ev: PointerEvent) => {
      el.scrollLeft = s0.l - (ev.clientX - s0.x);
      el.scrollTop = s0.t - (ev.clientY - s0.y);
    };
    const up = () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  /** Empty lane: click seeks and clears the selection, a drag draws a selection box. */
  const onLaneDown = (t: TrackInfo, e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.button === 1 || p.tool === "hand") return startPan(e);
    if (e.button !== 0) return;
    if (p.tool === "zoom") {
      const el = scroller.current!;
      anchor.current = { ms: msAt(e.clientX), screenX: e.clientX - el.getBoundingClientRect().left - HEAD_W };
      return p.onPps(clamp(pps * (e.altKey ? 1 / 1.6 : 1.6), p.minPps, p.maxPps));
    }
    if (p.tool === "razor" && e.shiftKey) {
      const at = msAt(e.clientX);
      const res = razorAll(edl, at);
      if (res.cuts) p.onEdit(() => res.edl, "Cut every track");
      return;
    }
    e.preventDefault();
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    const cx = (cx0: number) => cx0 - r.left + el.scrollLeft;
    const cy = (cy0: number) => cy0 - r.top + el.scrollTop;
    const start = { x: cx(e.clientX), y: cy(e.clientY) };
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let box: typeof marquee = null;
    const mv = (ev: PointerEvent) => {
      const nx = cx(ev.clientX);
      const ny = cy(ev.clientY);
      if (!box && Math.hypot(nx - start.x, ny - start.y) < 5) return;
      box = { x0: start.x, y0: start.y, x1: nx, y1: ny };
      setMarquee(box);
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setMarquee(null);
      if (!box) {
        if (!additive) p.onSelect([], "replace");
        p.onSeek(Math.min(total, msAt(ev.clientX)));
        return;
      }
      const a = ((Math.min(box.x0, box.x1) - HEAD_W) / pps) * 1000;
      const b = ((Math.max(box.x0, box.x1) - HEAD_W) / pps) * 1000;
      const y0 = Math.min(box.y0, box.y1);
      const y1 = Math.max(box.y0, box.y1);
      const keys = rows.filter((row) => row.top + row.h > y0 && row.top < y1).map((row) => row.key);
      const refs = refsInRange(edl, a, b, keys);
      p.onSelect(refs, additive ? "add" : "replace");
      p.announce(`${refs.length} item${refs.length === 1 ? "" : "s"} selected`);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    void t;
  };

  /* ------------------------------------- drawing --------------------------------------- */

  /** Filmstrip frames for the visible part of a clip, from the session's sprite sheets. */
  const filmstrip = (sessionId: string, clipStart: number, clipEnd: number, srcAt: (outMs: number) => number, h: number): ReactNode => {
    const th = Math.max(16, h - 4);
    const tw = Math.round((th * 16) / 9);
    const want = (tw / pps) * 1000;
    const idx = SPRITE_TIERS.findIndex((iv) => iv >= want * 0.6);
    const sheet = p.sprites(sessionId, idx === -1 ? SPRITE_TIERS.length - 1 : idx);
    if (!sheet || sheet.status !== "ready" || sheet.sheets.length === 0) return null;
    const per = sheet.cols * sheet.rows;
    const a = Math.max(clipStart, visA - marginMs / 2);
    const b = Math.min(clipEnd, visB + marginMs / 2);
    if (b <= a) return null;
    const first = Math.floor((x(a) - x(clipStart)) / tw);
    const last = Math.ceil((x(b) - x(clipStart)) / tw);
    const tiles: ReactNode[] = [];
    for (let j = Math.max(0, first); j <= last && tiles.length < 80; j++) {
      const t = clipStart + ((j + 0.5) * tw * 1000) / pps;
      if (t > clipEnd) break;
      const k = Math.max(0, Math.round(srcAt(t) / sheet.intervalMs));
      const n = Math.min(sheet.sheets.length - 1, Math.floor(k / per));
      const cell = Math.min(k - n * per, Math.max(0, (sheet.sheets[n]?.frames ?? per) - 1));
      const col = cell % sheet.cols;
      const row = Math.floor(cell / sheet.cols);
      tiles.push(
        <span
          key={j}
          className="nle-tile"
          style={{
            left: j * tw,
            width: tw,
            height: th,
            backgroundImage: `url("${sheet.sheets[n]!.url}")`,
            backgroundSize: `${sheet.cols * tw}px ${sheet.rows * th}px`,
            backgroundPosition: `${-col * tw}px ${-row * th}px`,
          }}
        />,
      );
    }
    return (
      <span aria-hidden className="nle-film">
        {tiles}
      </span>
    );
  };

  /** Waveform of the visible part of a clip: `srcAt` maps a lane time to the file's time. */
  const waveform = (peaks: { peaks: number[]; durationMs: number } | null, clipStart: number, clipEnd: number, srcAt: (outMs: number) => number, h: number, loop = false): ReactNode => {
    if (!peaks || peaks.peaks.length === 0 || peaks.durationMs <= 0) return null;
    const a = Math.max(clipStart, visA - marginMs / 2);
    const b = Math.min(clipEnd, visB + marginMs / 2);
    if (b <= a) return null;
    const w = Math.max(1, x(b) - x(a));
    const bars = Math.max(1, Math.min(1600, Math.floor(w / 2)));
    const mid = h / 2;
    let d = "";
    for (let i = 0; i < bars; i++) {
      const t = a + ((i + 0.5) * (b - a)) / bars;
      let s = srcAt(t);
      if (loop) s %= peaks.durationMs;
      const k = Math.floor((s / peaks.durationMs) * peaks.peaks.length);
      const v = k >= 0 && k < peaks.peaks.length ? peaks.peaks[k]! : 0;
      const hh = Math.max(0.5, v * (mid - 3));
      d += `M${(i * 2 + 1).toFixed(1)} ${(mid - hh).toFixed(1)}V${(mid + hh).toFixed(1)}`;
    }
    return (
      <svg aria-hidden className="nle-wave" style={{ left: x(a) - x(clipStart), width: w, height: h }} viewBox={`0 0 ${bars * 2} ${h}`} preserveAspectRatio="none">
        <path d={d} />
      </svg>
    );
  };

  const block = (o: {
    r: TimelineRef;
    span: { startMs: number; endMs: number };
    locked: boolean;
    tone: string;
    label: string;
    title: string;
    h: number;
    children?: ReactNode;
    dim?: boolean;
    badge?: string;
  }) => {
    const k = refKeyOf(o.r);
    const on = selected.has(k);
    if (!on && !inView(o.span.startMs, o.span.endMs)) return null;
    const w = Math.max(4, x(o.span.endMs - o.span.startMs));
    const trimmable = !o.locked && (p.tool === "select" || p.tool === "ripple" || p.tool === "roll");
    return (
      <div
        key={k}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={`${o.title}, ${timecode(o.span.startMs, p.fps)} to ${timecode(o.span.endMs, p.fps)}${o.locked ? ", locked" : ""}`}
        data-ref={k}
        className={`nle-clip ${o.tone}${on ? " is-on" : ""}${o.locked ? " is-locked" : ""}${o.dim ? " is-dim" : ""} tool-${p.tool}`}
        style={{ left: x(o.span.startMs), width: w, height: o.h - 4 }}
        onPointerDown={(e) => onBlockDown(o.r, e, o.span, o.locked, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!on) p.onSelect([o.r], "replace");
          openMenu("Clip", p.clipMenu(o.r, msAt(e.clientX)), e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            pick(o.r, e);
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (!on) p.onSelect([o.r], "replace");
            openMenu("Clip", p.clipMenu(o.r, o.span.startMs), rc.left + 8, rc.bottom);
          }
        }}
      >
        {o.children}
        <span className="nle-clip-label">
          {o.badge && <b>{o.badge}</b>}
          {o.label}
        </span>
        {trimmable && (
          <>
            <span aria-hidden className="nle-trim nle-trim-l" onPointerDown={(e) => onBlockDown(o.r, e, o.span, o.locked, "start")} />
            <span aria-hidden className="nle-trim nle-trim-r" onPointerDown={(e) => onBlockDown(o.r, e, o.span, o.locked, "end")} />
          </>
        )}
      </div>
    );
  };

  const laneBody = (t: TrackInfo, h: number): ReactNode => {
    switch (t.kind) {
      case "captions":
        return edl.captionTrack.cues.map((c) => block({ r: { kind: "caption", id: c.id }, span: c, locked: false, tone: "tone-cc", label: c.text, title: `Caption “${c.text}”`, h, dim: t.hidden }));
      case "video":
      case "text": {
        const tr = edl.overlays.find((o) => o.id === t.id)!;
        return tr.items.map((it: OverlayItem) =>
          block({
            r: { kind: "overlay", trackId: tr.id, id: it.id },
            span: it,
            locked: tr.locked,
            tone: it.type === "text" ? "tone-text" : it.type === "pip" ? "tone-pip" : "tone-image",
            label: it.type === "text" ? it.text : it.type === "pip" ? p.sourceTitle(it.sessionId) : p.clipName(it.source),
            title: `${it.type === "text" ? `Text “${it.text}”` : it.type === "pip" ? `Video ${p.sourceTitle(it.sessionId)}` : `Image ${p.clipName(it.source)}`} on ${tr.name}`,
            h,
            dim: tr.hidden,
            children: it.type === "pip" ? filmstrip(it.sessionId, it.startMs, it.endMs, (o) => it.sourceInMs + (o - it.startMs), h - 4) : null,
          }),
        );
      }
      case "texts":
        return edl.texts.map((tx) => block({ r: { kind: "text", id: tx.id }, span: tx, locked: false, tone: "tone-text", label: tx.text, title: `Text “${tx.text}”`, h }));
      case "effects":
        return edl.effects.map((f) =>
          block({
            r: { kind: "effect", id: f.id },
            span: f,
            locked: false,
            tone: f.kind === "wasted" ? "tone-wasted" : f.kind === "passed" ? "tone-text" : "tone-fx",
            label: f.kind === "wasted" ? f.text || "WASTED" : f.kind === "passed" ? f.text || "MISSION PASSED" : f.kind,
            title: `${f.kind} effect${f.enabled === false ? " (off)" : ""}`,
            h,
            dim: f.enabled === false,
          }),
        );
      case "main":
        return edl.segments.map((s, i) => {
          const a = starts[i]!;
          const span = { startMs: Math.round(a), endMs: Math.round(a + segmentOutputMs(s)) };
          const speed = s.rampTo !== null ? `${s.speed}→${s.rampTo}×` : s.speed !== 1 ? `${s.speed}×` : "";
          const tr = i > 0 && s.transitionIn.kind !== "cut" ? s.transitionIn : null;
          const outLen = span.endMs - span.startMs;
          return block({
            r: { kind: "segment", id: s.id },
            span,
            locked: edl.mainTrack.locked,
            tone: "tone-v1",
            label: `${p.sourceTitle(s.sessionId)}${speed ? ` · ${speed}` : ""}`,
            badge: String(i + 1),
            title: `Segment ${i + 1}`,
            h,
            children: (
              <>
                {filmstrip(s.sessionId, span.startMs, span.endMs, (o) => s.inMs + ((o - span.startMs) / Math.max(1, outLen)) * (s.outMs - s.inMs), h - 4)}
                {tr && <span aria-hidden title={`${tr.kind} ${(tr.durationMs / 1000).toFixed(1)} s`} className="nle-xfade" style={{ width: Math.max(4, x(tr.durationMs)) }} />}
              </>
            ),
          });
        });
      case "source-audio":
        return edl.segments.map((s, i) => {
          const a = starts[i]!;
          const b = a + segmentOutputMs(s);
          if (!inView(a, b)) return null;
          const quiet = edl.sourceAudio.muted || (anySolo && !edl.sourceAudio.solo) || s.volume === 0;
          const on = selected.has(refKeyOf({ kind: "segment", id: s.id }));
          return (
            <div
              key={s.id}
              aria-hidden
              className={`nle-clip tone-a1${quiet ? " is-dim" : ""}${on ? " is-on" : ""}`}
              style={{ left: x(a), width: Math.max(4, x(b - a)), height: h - 4 }}
              onPointerDown={(e) => {
                if (e.button !== 0 || p.tool !== "select") return;
                e.stopPropagation();
                pick({ kind: "segment", id: s.id }, e);
              }}
            >
              {waveform(p.sourcePeaks(s.sessionId), a, b, (o) => s.inMs + ((o - a) / Math.max(1, b - a)) * (s.outMs - s.inMs), h - 4)}
            </div>
          );
        });
      case "audio": {
        const tr = edl.audioTracks.find((o) => o.id === t.id)!;
        const quiet = tr.muted || (anySolo && !tr.solo);
        return tr.clips.map((c) =>
          block({
            r: { kind: "audio", trackId: tr.id, id: c.id },
            span: { startMs: c.startMs, endMs: c.startMs + c.durationMs },
            locked: tr.locked,
            tone: tr.kind === "music" ? "tone-music" : tr.kind === "voice" ? "tone-voice" : "tone-sfx",
            label: p.clipName(c.source),
            title: `${p.clipName(c.source)} on ${tr.name}`,
            h,
            dim: quiet,
            children: waveform(p.clipPeaks(c.source), c.startMs, c.startMs + c.durationMs, (o) => c.offsetMs + (o - c.startMs), h - 4, c.loop),
          }),
        );
      }
    }
  };

  /** Keyframes of the selected item on a track, as draggable diamonds. */
  const keyLane = (t: TrackInfo): ReactNode => {
    const sel = p.selection.find((r) => refTrackKey(r) === t.key || (t.key === "a1" && r.kind === "segment"));
    type K = { at: number; set: (ms: number) => (e: Edl) => Edl; del: (e: Edl) => Edl };
    let keys: K[] = [];
    if (t.key === "a1") {
      keys = edl.sourceAudio.envelope.map((k, i) => ({
        at: k.atMs,
        set: (ms) => (e) => ({ ...e, sourceAudio: { ...e.sourceAudio, envelope: e.sourceAudio.envelope.map((v, j) => (j === i ? { ...v, atMs: Math.max(0, Math.round(ms)) } : v)).sort((a, b) => a.atMs - b.atMs) } }),
        del: (e) => ({ ...e, sourceAudio: { ...e.sourceAudio, envelope: e.sourceAudio.envelope.filter((_, j) => j !== i) } }),
      }));
    } else if (sel?.kind === "segment") {
      const i = edl.segments.findIndex((s) => s.id === sel.id);
      const s = edl.segments[i];
      if (s)
        keys = s.keys.map((k, n) => ({
          at: edlOutputTime(edl, i, k.atMs),
          set: (ms) => (e) => ({ ...e, segments: e.segments.map((x2) => (x2.id === s.id ? { ...x2, keys: x2.keys.map((v, j) => (j === n ? { ...v, atMs: clamp(sourceAtOutput(e, i, ms), x2.inMs, x2.outMs) } : v)).sort((a, b) => a.atMs - b.atMs) } : x2)) }),
          del: (e) => ({ ...e, segments: e.segments.map((x2) => (x2.id === s.id ? { ...x2, keys: x2.keys.filter((_, j) => j !== n) } : x2)) }),
        }));
    } else if (sel?.kind === "overlay") {
      const it = edl.overlays.find((o) => o.id === sel.trackId)?.items.find((v) => v.id === sel.id);
      if (it)
        keys = it.keys.map((k, n) => ({
          at: k.atMs,
          set: (ms) => (e) => ({ ...e, overlays: e.overlays.map((o) => (o.id === sel.trackId ? { ...o, items: o.items.map((v) => (v.id === it.id ? ({ ...v, keys: v.keys.map((q, j) => (j === n ? { ...q, atMs: clamp(Math.round(ms), v.startMs, v.endMs) } : q)).sort((a, b) => a.atMs - b.atMs) } as OverlayItem) : v)) } : o)) }),
          del: (e) => ({ ...e, overlays: e.overlays.map((o) => (o.id === sel.trackId ? { ...o, items: o.items.map((v) => (v.id === it.id ? ({ ...v, keys: v.keys.filter((_, j) => j !== n) } as OverlayItem) : v)) } : o)) }),
        }));
    } else if (sel?.kind === "audio") {
      const c = edl.audioTracks.find((o) => o.id === sel.trackId)?.clips.find((v) => v.id === sel.id);
      if (c)
        keys = c.envelope.map((k, n) => ({
          at: k.atMs,
          set: (ms) => (e) => ({ ...e, audioTracks: e.audioTracks.map((o) => (o.id === sel.trackId ? { ...o, clips: o.clips.map((v) => (v.id === c.id ? { ...v, envelope: v.envelope.map((q, j) => (j === n ? { ...q, atMs: clamp(Math.round(ms), v.startMs, v.startMs + v.durationMs) } : q)).sort((a, b) => a.atMs - b.atMs) } : v)) } : o)) }),
          del: (e) => ({ ...e, audioTracks: e.audioTracks.map((o) => (o.id === sel.trackId ? { ...o, clips: o.clips.map((v) => (v.id === c.id ? { ...v, envelope: v.envelope.filter((_, j) => j !== n) } : v)) } : o)) }),
        }));
    }
    return keys.map((k, n) => (
      <button
        key={n}
        type="button"
        className="nle-key"
        style={{ left: x(k.at) }}
        aria-label={`Keyframe ${n + 1} at ${timecode(k.at, p.fps)}. Drag to move, Alt+click to delete`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (e.altKey) {
            e.preventDefault();
            p.onEdit(k.del, "Delete keyframe");
            return;
          }
          const key = `key:${t.key}:${n}:${++dragSeq}`;
          const orig = edl;
          drag(
            e,
            (d) => p.onEdit(() => k.set(k.at + d)(orig), "Move keyframe", key),
            (_, moved) => {
              if (!moved) p.onSeek(k.at);
            },
          );
        }}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            p.onEdit(k.del, "Delete keyframe");
          }
        }}
      />
    ));
  };

  /* -------------------------------------- ruler ---------------------------------------- */

  const steps = rulerSteps(p.fps);
  const major = steps.find((s) => x(s) >= 92) ?? steps.at(-1)!;
  const minorDiv = [10, 5, 4, 2].find((d) => x(major / d) >= 9) ?? 1;
  const ticks: ReactNode[] = [];
  const t0 = Math.max(0, Math.floor((visA - marginMs) / major) * major);
  const t1 = Math.min(((contentW / pps) * 1000), visB + marginMs);
  for (let t = t0, n = 0; t <= t1 && n < 400; t += major, n++) {
    ticks.push(
      <span key={`M${t}`} className="nle-tick nle-tick-major" style={{ left: x(t) }}>
        <span>{rulerLabel(t, major, p.fps)}</span>
      </span>,
    );
    for (let m = 1; m < minorDiv; m++) ticks.push(<span key={`m${t}-${m}`} className="nle-tick" style={{ left: x(t + (major * m) / minorDiv) }} />);
  }

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    p.onSeek(Math.min(total, msAt(e.clientX)));
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => p.onSeek(Math.min(total, msAt(ev.clientX)));
    const up = () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const rangeHandle = (which: "inMs" | "outMs", e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const at0 = p.range[which]!;
    drag(e, (d) => p.onRange({ ...p.range, [which]: clamp(Math.round(at0 + d), 0, total) }));
  };

  const markers = edl.markers ?? [];
  const rIn = p.range.inMs;
  const rOut = p.range.outMs;
  const hasRange = rIn !== null || rOut !== null;
  const ra = rIn ?? 0;
  const rb = rOut ?? total;

  /* -------------------------------------- headers -------------------------------------- */

  const toggle = (t: TrackInfo, flag: "hidden" | "locked" | "muted" | "solo", on: boolean, short: string, what: string) => (
    <button type="button" aria-pressed={on} aria-label={`${what} ${t.label} ${t.name}`} title={`${what} (${t.label})`} className={`nle-tgl nle-tgl-${flag}`} onClick={() => p.onToggle(t.key, flag)}>
      {short}
    </button>
  );

  const header = (t: TrackInfo, h: number) => {
    const canKeys = t.kind === "main" || t.kind === "video" || t.kind === "text" || t.kind === "audio" || t.kind === "source-audio";
    return (
      <div
        className={`nle-head kind-${t.kind}`}
        style={{ height: h }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(`${t.label} track`, p.trackMenu(t), e.clientX, e.clientY);
        }}
      >
        <span className="nle-head-label">{t.label}</span>
        {renaming === t.key ? (
          <input
            className="nle-head-input"
            aria-label={`Name of ${t.label}`}
            defaultValue={t.name}
            maxLength={40}
            autoFocus
            onBlur={(e) => {
              p.onRename(t.key, e.target.value);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span className="nle-head-name" title={t.name} onDoubleClick={() => (t.kind === "video" || t.kind === "text" || t.kind === "audio") && setRenaming(t.key)}>
            {t.name}
          </span>
        )}
        <span className="nle-head-tools">
          {(t.kind === "video" || t.kind === "text" || t.kind === "captions") && toggle(t, "hidden", t.hidden, "◉", t.hidden ? "Show" : "Hide")}
          {(t.kind === "source-audio" || t.kind === "audio") && toggle(t, "muted", t.muted, "M", t.muted ? "Unmute" : "Mute")}
          {(t.kind === "source-audio" || t.kind === "audio") && toggle(t, "solo", t.solo, "S", t.solo ? "Unsolo" : "Solo")}
          {(t.kind === "main" || t.kind === "video" || t.kind === "text" || t.kind === "audio") && toggle(t, "locked", t.locked, "L", t.locked ? "Unlock" : "Lock")}
          {canKeys && h >= 30 && (
            <button type="button" aria-pressed={p.expanded.includes(t.key)} aria-label={`Keyframes of ${t.label}`} title="Show keyframes" className="nle-tgl" onClick={() => p.onExpand(t.key)}>
              ◆
            </button>
          )}
          <button
            type="button"
            className="nle-tgl"
            aria-label={`${t.label} track menu`}
            aria-haspopup="menu"
            onClick={(e) => {
              const rc = e.currentTarget.getBoundingClientRect();
              openMenu(`${t.label} track`, [...(t.kind === "video" || t.kind === "text" || t.kind === "audio" ? [{ label: "Rename…", onSelect: () => setRenaming(t.key) }, "sep" as const] : []), ...p.trackMenu(t)], rc.left, rc.bottom + 2);
            }}
          >
            ⋯
          </button>
        </span>
        <span
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Height of ${t.label}`}
          aria-valuemin={MIN_TRACK_H}
          aria-valuemax={MAX_TRACK_H}
          aria-valuenow={h}
          tabIndex={0}
          className="nle-head-resize"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const y0 = e.clientY;
            const mv = (ev: PointerEvent) => p.onHeight(t.key, clamp(h + ev.clientY - y0, MIN_TRACK_H, MAX_TRACK_H));
            const up = () => {
              el.removeEventListener("pointermove", mv);
              el.removeEventListener("pointerup", up);
            };
            el.addEventListener("pointermove", mv);
            el.addEventListener("pointerup", up);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              p.onHeight(t.key, clamp(h + (e.key === "ArrowDown" ? 6 : -6), MIN_TRACK_H, MAX_TRACK_H));
            }
          }}
        />
      </div>
    );
  };

  /* -------------------------------------- render --------------------------------------- */

  const accepts = (dt: DataTransfer) => isAssetDrag(dt) || isSourceDrag(dt);
  const phX = x(p.playheadMs);

  return (
    <div className="nle-tl">
      <div
        ref={scroller}
        className={`nle-tl-scroll tool-${p.tool}`}
        role="group"
        aria-label="Edit timeline"
        onDragOver={(e) => {
          if (!accepts(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropLane(rowAt(e.clientY)?.key ?? "v1");
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropLane(null);
        }}
        onDrop={(e) => {
          setDropLane(null);
          const row = rowAt(e.clientY);
          const key = (row?.key ?? "v1") as TrackKey;
          let at = Math.min(total, msAt(e.clientX));
          if (p.snapping) at = snapTime(at, [...edlEdges(edl), Math.round(p.playheadMs)], tolerance).ms;
          const src = readSourceDrag(e.dataTransfer);
          if (src) {
            e.preventDefault();
            return p.onDropSource(src, at, key);
          }
          const asset = readAssetDrag(e.dataTransfer);
          if (asset) {
            e.preventDefault();
            p.onDropAsset(asset, at, key);
          }
        }}
      >
        <div className="nle-tl-content" style={{ width: HEAD_W + contentW, height: contentH }}>
          {/* Ruler */}
          <div className="nle-row nle-ruler-row" style={{ height: RULER_H }}>
            <div className="nle-corner">
              <span className="tnum">{timecode(p.playheadMs, p.fps)}</span>
            </div>
            <div
              className="nle-ruler"
              style={{ width: contentW }}
              role="slider"
              tabIndex={0}
              aria-label="Playhead in the edit"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={Math.round(p.playheadMs)}
              aria-valuetext={timecode(p.playheadMs, p.fps)}
              onPointerDown={scrub}
              onKeyDown={(e) => {
                const stepMs = e.shiftKey ? 1000 : 1000 / p.fps;
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onSeek(clamp(p.playheadMs + (e.key === "ArrowLeft" ? -stepMs : stepMs), 0, total));
                }
              }}
            >
              {ticks}
              <span aria-hidden className="nle-ruler-end" style={{ left: x(total) }} />
              {hasRange && (
                <span aria-hidden className="nle-range-bar" style={{ left: x(ra), width: Math.max(2, x(rb - ra)) }}>
                  {rIn !== null && <span className="nle-range-h nle-range-in" onPointerDown={(e) => rangeHandle("inMs", e)} />}
                  {rOut !== null && <span className="nle-range-h nle-range-out" onPointerDown={(e) => rangeHandle("outMs", e)} />}
                </span>
              )}
              {p.aiMarkers.map((m, i) =>
                m.ms >= visA - marginMs && m.ms <= visB + marginMs ? (
                  <button
                    key={`ai-${i}`}
                    type="button"
                    tabIndex={-1}
                    className={`nle-blip ${AI_TONE[m.kind]}`}
                    style={{ left: x(m.ms) }}
                    title={`AI: ${m.label} at ${timecode(m.ms, p.fps)}`}
                    aria-label={`AI moment: ${m.label}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      p.onSeek(Math.round(m.ms));
                    }}
                  />
                ) : null,
              )}
              {markers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`nle-flag flag-${m.color}${p.selectedMarker === m.id ? " is-on" : ""}`}
                  style={{ left: x(m.atMs) }}
                  aria-label={`Marker${m.label ? ` “${m.label}”` : ""} at ${timecode(m.atMs, p.fps)}`}
                  title={m.label || "Marker"}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    p.onSelectMarker(m.id);
                    const key = `marker:${m.id}:${++dragSeq}`;
                    const orig = edl;
                    drag(
                      e,
                      (d) => p.onEdit(() => updateMarker(orig, m.id, { atMs: clamp(m.atMs + d, 0, total) }), "Move marker", key),
                      (_, moved) => {
                        if (!moved) p.onSeek(m.atMs);
                      },
                    );
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.onSelectMarker(m.id);
                    openMenu("Marker", p.markerMenu(m), e.clientX, e.clientY);
                  }}
                >
                  {m.durationMs > 0 && <span className="nle-flag-span" style={{ width: x(m.durationMs) }} />}
                </button>
              ))}
            </div>
          </div>

          {/* Tracks */}
          {tracks.map((t) => {
            const h = heightOf(t);
            const expanded = p.expanded.includes(t.key);
            return (
              <div key={t.key} className="nle-track" data-track={t.key}>
                <div className="nle-row" style={{ height: h }}>
                  {header(t, h)}
                  <div
                    className={`nle-lane kind-${t.kind}${t.locked ? " is-locked" : ""}${dropLane === t.key ? " is-drop" : ""}`}
                    style={{ width: contentW, height: h }}
                    data-lane={t.key}
                    onPointerDown={(e) => onLaneDown(t, e)}
                    onContextMenu={(e) => {
                      if (e.target !== e.currentTarget) return;
                      e.preventDefault();
                      openMenu(`${t.label} track`, p.laneMenu(t, msAt(e.clientX)), e.clientX, e.clientY);
                    }}
                  >
                    {laneBody(t, h)}
                    {t.kind === "video" && edl.overlays.find((o) => o.id === t.id)?.items.length === 0 && view.left < 200 && <span className="nle-lane-hint">Drop video, images or stickers here</span>}
                    {t.kind === "audio" && edl.audioTracks.find((o) => o.id === t.id)?.clips.length === 0 && view.left < 200 && <span className="nle-lane-hint">Drop music or sounds here</span>}
                  </div>
                </div>
                {expanded && (
                  <div className="nle-row" style={{ height: KEY_H }}>
                    <div className="nle-head nle-head-keys">
                      <span>Keyframes</span>
                    </div>
                    <div className="nle-lane nle-keylane" style={{ width: contentW, height: KEY_H }}>
                      {keyLane(t)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Overlays: in/out shading, snap line, playhead, marquee */}
          {hasRange && <span aria-hidden className="nle-range-shade" style={{ left: HEAD_W + x(ra), width: Math.max(2, x(rb - ra)), top: RULER_H, height: contentH - RULER_H }} />}
          <span aria-hidden className="nle-after-end" style={{ left: HEAD_W + x(total), width: Math.max(0, contentW - x(total)), top: RULER_H, height: contentH - RULER_H }} />
          {snapLine !== null && <span aria-hidden className="nle-snapline" style={{ left: HEAD_W + x(snapLine), height: contentH }} />}
          <span aria-hidden className="nle-playhead" style={{ left: HEAD_W + phX, height: contentH }} />
          {marquee && (
            <span
              aria-hidden
              className="nle-marquee"
              style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
            />
          )}
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
