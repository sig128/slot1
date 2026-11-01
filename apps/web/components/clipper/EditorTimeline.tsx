"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  edlEdges,
  moveRef,
  moveSegment,
  refKeyOf,
  rollEdit,
  segmentOutputMs,
  segmentStartsMs,
  snapTime,
  trimRef,
  trimSegment,
  type Edl,
  type MediaRef,
  type TimelineRef,
} from "@slot1/contracts";
import { editTime } from "@/lib/clipper";

export interface TimelineMarker {
  ms: number;
  label: string;
  kind: "big" | "event" | "text";
}

interface Props {
  edl: Edl;
  total: number;
  playheadMs: number;
  selection: TimelineRef[];
  /** AI moments on the edit's own timeline. */
  markers: TimelineMarker[];
  sourcePeaks: (sessionId: string) => { peaks: number[]; durationMs: number } | null;
  clipPeaks: (ref: MediaRef) => { peaks: number[]; durationMs: number } | null;
  clipName: (ref: MediaRef) => string;
  maxSourceMs: (sessionId: string) => number;
  snapping: boolean;
  rollMode: boolean;
  pps: number;
  onPps: (pps: number) => void;
  onSeek: (ms: number) => void;
  onSelect: (refs: TimelineRef[], additive: boolean) => void;
  onEdit: (fn: (e: Edl) => Edl, label: string, coalesce?: string) => void;
}

const MARKER_COLOR: Record<TimelineMarker["kind"], string> = { big: "bg-gold", text: "bg-apricot", event: "bg-signal" };
const RULER_STEPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000];
const SNAP_PX = 8;

let dragSeq = 0;

/**
 * The multi-track timeline of the finished edit: overlay tracks on top, the main video track,
 * effects, captions, the source audio and the audio tracks underneath. Drag blocks to move,
 * drag their edges to trim (Alt or Roll mode on a cut rolls it), with snapping to the playhead,
 * AI moments and every other edge.
 */
export function EditorTimeline(p: Props) {
  const { edl, total, pps } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const contentW = Math.max(320, Math.ceil(((total + 2000) / 1000) * pps));
  const x = (ms: number) => (ms / 1000) * pps;
  const starts = useMemo(() => segmentStartsMs(edl), [edl]);
  const selected = useMemo(() => new Set(p.selection.map(refKeyOf)), [p.selection]);
  const anySolo = edl.sourceAudio.solo || edl.audioTracks.some((t) => t.solo);

  // Keep the playhead in view while it moves.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const px = (p.playheadMs / 1000) * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, px - el.clientWidth * 0.3);
  }, [p.playheadMs, pps]);

  // Ctrl/⌘ + wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = ((el.scrollLeft + e.clientX - r.left) / pps) * 1000;
      const next = Math.min(400, Math.max(6, pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      p.onPps(next);
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, (at / 1000) * next - (e.clientX - r.left))));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [pps, p]);

  const msAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.round(((el.scrollLeft + clientX - r.left) / pps) * 1000));
  };

  /** Generic pointer drag with pointer capture; `move` gets the ms delta and the event. */
  const drag = (e: React.PointerEvent, move: (dMs: number, ev: PointerEvent) => void, done?: (ev: PointerEvent) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const mv = (ev: PointerEvent) => move(((ev.clientX - x0) / pps) * 1000, ev);
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      done?.(ev);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const snapTargets = (exclude: TimelineRef[]) => (p.snapping ? [...edlEdges(edl, exclude), Math.round(p.playheadMs), ...p.markers.map((m) => Math.round(m.ms))] : []);
  const tolerance = (SNAP_PX / pps) * 1000;
  /** Snap a moving span by whichever of its edges is closest to a target. */
  const snapSpan = (start: number, len: number, targets: number[], free: boolean) => {
    if (free || targets.length === 0) return start;
    const a = snapTime(start, targets, tolerance);
    const b = snapTime(start + len, targets, tolerance);
    if (a.snapped && (!b.snapped || Math.abs(a.ms - start) <= Math.abs(b.ms - start - len))) return a.ms;
    if (b.snapped) return b.ms - len;
    return start;
  };
  const snapEdge = (ms: number, targets: number[], free: boolean) => (free ? ms : snapTime(ms, targets, tolerance).ms);

  const select = (r: TimelineRef, e: React.PointerEvent | React.KeyboardEvent) => {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive || !selected.has(refKeyOf(r))) p.onSelect([r], additive);
  };

  /* ------------------------------------- blocks -------------------------------------------- */

  const startMove = (r: TimelineRef, e: React.PointerEvent, span: { startMs: number; endMs: number }, locked: boolean) => {
    select(r, e);
    if (locked) return;
    const orig = edl;
    const key = `move:${refKeyOf(r)}:${++dragSeq}`;
    const targets = snapTargets([r]);
    if (r.kind === "segment") {
      // Segments reorder: drop between two others.
      drag(
        e,
        () => undefined,
        (ev) => {
          const at = msAt(ev.clientX);
          const from = orig.segments.findIndex((s) => s.id === r.id);
          if (Math.abs(ev.clientX - e.clientX) < 6 || from < 0) return;
          let to = orig.segments.findIndex((s, i) => at < starts[i]! + segmentOutputMs(s) / 2);
          if (to < 0) to = orig.segments.length;
          if (to > from) to -= 1;
          if (to !== from) p.onEdit(() => moveSegment(orig, r.id, to), "Move segment");
        },
      );
      return;
    }
    const len = span.endMs - span.startMs;
    drag(e, (d, ev) => {
      if (Math.abs(d) < 1) return;
      const s = snapSpan(Math.max(0, span.startMs + d), len, targets, ev.altKey);
      p.onEdit(() => moveRef(orig, r, s), "Move", key);
    });
  };

  const startTrim = (r: TimelineRef, edge: "start" | "end", e: React.PointerEvent, span: { startMs: number; endMs: number }, locked: boolean) => {
    select(r, e);
    if (locked) return;
    const orig = edl;
    const key = `trim:${refKeyOf(r)}:${edge}:${++dragSeq}`;
    const targets = snapTargets([r]);
    if (r.kind === "segment") {
      const i = orig.segments.findIndex((s) => s.id === r.id);
      const seg = orig.segments[i]!;
      const roll = edge === "end" && i < orig.segments.length - 1;
      drag(e, (d, ev) => {
        const edgeMs = edge === "start" ? span.startMs : span.endMs;
        const to = snapEdge(edgeMs + d, targets, ev.shiftKey);
        const dOut = to - edgeMs;
        if ((p.rollMode || ev.altKey) && roll) {
          p.onEdit(() => rollEdit(orig, i, dOut, p.maxSourceMs), "Roll cut", key);
          return;
        }
        const speed = edge === "start" ? seg.speed : (seg.rampTo ?? seg.speed);
        const src = edge === "start" ? seg.inMs + dOut * speed : seg.outMs + dOut * speed;
        p.onEdit(() => trimSegment(orig, r.id, edge === "start" ? "in" : "out", src, p.maxSourceMs(seg.sessionId)), "Trim segment", key);
      });
      return;
    }
    const fileMs = r.kind === "audio" ? (orig.audioTracks.find((t) => t.id === r.trackId)?.clips.find((c) => c.id === r.id)?.source ?? null) : null;
    const maxDurationMs = fileMs ? (p.clipPeaks(fileMs)?.durationMs ?? undefined) : undefined;
    drag(e, (d, ev) => {
      const edgeMs = edge === "start" ? span.startMs : span.endMs;
      const to = snapEdge(edgeMs + d, targets, ev.shiftKey);
      p.onEdit(() => trimRef(orig, r, edge, to, { maxDurationMs }), "Trim", key);
    });
  };

  // Plain render helpers (not components) so blocks keep their DOM node, and pointer capture, while dragging.
  const block = ({
    r,
    span,
    locked,
    tone,
    label,
    title,
    children,
    trim = true,
  }: {
    r: TimelineRef;
    span: { startMs: number; endMs: number };
    locked: boolean;
    tone: string;
    label: string;
    title: string;
    children?: ReactNode;
    trim?: boolean;
  }) => {
    const on = selected.has(refKeyOf(r));
    const w = Math.max(6, x(span.endMs - span.startMs));
    return (
      <div
        key={refKeyOf(r)}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={`${title}, ${editTime(span.startMs)} to ${editTime(span.endMs)}${locked ? ", locked" : ""}`}
        data-ref={refKeyOf(r)}
        onPointerDown={(e) => startMove(r, e, span, locked)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            select(r, e);
          }
        }}
        className={`absolute inset-y-1 touch-none overflow-hidden border text-left text-[0.72rem] leading-tight outline-offset-1 ${tone} ${on ? "z-[2] border-ivory shadow-[0_0_0_1px_var(--color-ivory)]" : "border-black/40"} ${locked ? "cursor-not-allowed opacity-80" : "cursor-grab active:cursor-grabbing"}`}
        style={{ left: x(span.startMs), width: w }}
      >
        {children}
        <span className="pointer-events-none relative block truncate px-1.5 pt-0.5 font-semibold text-graphite-900 [text-shadow:0_1px_0_rgb(255_255_255/0.25)]">{label}</span>
        {trim && !locked && on && (
          <>
            <span aria-hidden onPointerDown={(e) => startTrim(r, "start", e, span, locked)} className="absolute inset-y-0 left-0 z-[3] w-2.5 cursor-ew-resize touch-none bg-ivory/80" />
            <span aria-hidden onPointerDown={(e) => startTrim(r, "end", e, span, locked)} className="absolute inset-y-0 right-0 z-[3] w-2.5 cursor-ew-resize touch-none bg-ivory/80" />
          </>
        )}
      </div>
    );
  };

  /** Waveform bars for a slice of a file's peaks, fitted to a block's width. */
  const wave = ({ peaks, durationMs, fromMs, toMs, width, loop }: { peaks: number[]; durationMs: number; fromMs: number; toMs: number; width: number; loop?: boolean }) => {
    if (!peaks.length || durationMs <= 0 || width < 4) return null;
    const bars = Math.max(1, Math.min(400, Math.floor(width / 3)));
    const per = (toMs - fromMs) / bars;
    let path = "";
    for (let i = 0; i < bars; i++) {
      let at = fromMs + i * per;
      if (loop) at %= durationMs;
      const k = Math.floor((at / durationMs) * peaks.length);
      const v = k >= 0 && k < peaks.length ? peaks[k]! : 0;
      const h = Math.max(0.5, v * 18);
      path += `M${(i * 3 + 1).toFixed(1)} ${20 - h}V${20 + h}`;
    }
    return (
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full" width={width} viewBox={`0 0 ${width} 40`} preserveAspectRatio="none">
        <path d={path} stroke="rgb(11 11 14 / 0.55)" strokeWidth="2" />
      </svg>
    );
  };

  /* ------------------------------------- lanes --------------------------------------------- */

  type Lane = { key: string; label: string; height: number; header?: ReactNode; body: ReactNode };
  const lanes: Lane[] = [];
  const toggle = (label: string, pressed: boolean, onClick: () => void, short: string) => (
    <button type="button" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick} className={`h-5 w-5 shrink-0 border text-[0.62rem] font-bold leading-none ${pressed ? "border-apricot bg-apricot text-graphite-900" : "border-line-strong text-ivory-3 hover:text-ivory"}`}>
      {short}
    </button>
  );

  [...edl.overlays].reverse().forEach((t) => {
    lanes.push({
      key: `ov-${t.id}`,
      label: t.name,
      height: 34,
      header: (
        <>
          {toggle(`${t.hidden ? "Show" : "Hide"} ${t.name}`, t.hidden, () => p.onEdit((e) => ({ ...e, overlays: e.overlays.map((x) => (x.id === t.id ? { ...x, hidden: !x.hidden } : x)) }), t.hidden ? "Show track" : "Hide track"), "H")}
          {toggle(`${t.locked ? "Unlock" : "Lock"} ${t.name}`, t.locked, () => p.onEdit((e) => ({ ...e, overlays: e.overlays.map((x) => (x.id === t.id ? { ...x, locked: !x.locked } : x)) }), t.locked ? "Unlock track" : "Lock track"), "L")}
        </>
      ),
      body: t.items.map((it) => (
        block({
          r: { kind: "overlay", trackId: t.id, id: it.id },
          span: it,
          locked: t.locked,
          tone: it.type === "text" ? "bg-gold/90" : it.type === "pip" ? "bg-signal/80" : "bg-apricot/85",
          label: it.type === "text" ? it.text : it.type === "pip" ? "Picture in picture" : p.clipName(it.source),
          title: `${it.type === "text" ? `Text “${it.text}”` : it.type === "pip" ? "Picture in picture" : `Image ${p.clipName(it.source)}`} on ${t.name}`,
          children: t.hidden ? <span aria-hidden className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent_0_6px,rgb(0_0_0/0.35)_6px_12px)]" /> : null,
        })
      )),
    });
  });
  if (edl.texts.length) {
    lanes.push({
      key: "texts",
      label: "Classic text",
      height: 30,
      body: edl.texts.map((t) => block({ r: { kind: "text", id: t.id }, span: t, locked: false, tone: "bg-gold/70", label: t.text, title: `Text “${t.text}”` })),
    });
  }
  lanes.push({
    key: "video",
    label: "Video",
    height: 54,
    header: toggle(`${edl.mainTrack.locked ? "Unlock" : "Lock"} the video track`, edl.mainTrack.locked, () => p.onEdit((e) => ({ ...e, mainTrack: { locked: !e.mainTrack.locked } }), edl.mainTrack.locked ? "Unlock video" : "Lock video"), "L"),
    body: edl.segments.map((s, i) => {
      const a = starts[i]!;
      const span = { startMs: Math.round(a), endMs: Math.round(a + segmentOutputMs(s)) };
      const speed = s.rampTo !== null ? `${s.speed}→${s.rampTo}×` : s.speed !== 1 ? `${s.speed}×` : "";
      const tr = i > 0 && s.transitionIn.kind !== "cut" ? s.transitionIn : null;
      return block({
        r: { kind: "segment", id: s.id },
        span,
        locked: edl.mainTrack.locked,
        tone: "bg-ivory-2/90",
        label: `${i + 1}${speed ? ` · ${speed}` : ""}`,
        title: `Segment ${i + 1}`,
        children: tr ? <span aria-hidden title={`${tr.kind} ${(tr.durationMs / 1000).toFixed(1)} s`} className="absolute inset-y-0 left-0 bg-[linear-gradient(110deg,rgb(255_79_135/0.65),transparent)]" style={{ width: Math.max(4, x(tr.durationMs)) }} /> : null,
      });
    }),
  });
  lanes.push({
    key: "fx",
    label: "Effects",
    height: 30,
    body: edl.effects.map((f) =>
      block({ r: { kind: "effect", id: f.id }, span: f, locked: false, tone: f.kind === "wasted" ? "bg-[#e0565b]/90" : f.kind === "passed" ? "bg-gold/90" : "bg-coral/80", label: f.kind === "wasted" ? "WASTED" : f.kind === "passed" ? "MISSION PASSED" : f.kind, title: `${f.kind} effect` }),
    ),
  });
  lanes.push({
    key: "cc",
    label: "Captions",
    height: 30,
    header: toggle(`${edl.captionTrack.hidden ? "Show" : "Hide"} captions`, edl.captionTrack.hidden, () => p.onEdit((e) => ({ ...e, captionTrack: { ...e.captionTrack, hidden: !e.captionTrack.hidden } }), "Toggle captions"), "H"),
    body: edl.captionTrack.cues.map((c) => block({ r: { kind: "caption", id: c.id }, span: c, locked: false, tone: "bg-ivory/80", label: c.text, title: `Caption “${c.text}”` })),
  });
  lanes.push({
    key: "src-audio",
    label: "Game audio",
    height: 40,
    header: (
      <>
        {toggle("Mute game audio", edl.sourceAudio.muted, () => p.onEdit((e) => ({ ...e, sourceAudio: { ...e.sourceAudio, muted: !e.sourceAudio.muted } }), "Mute game audio"), "M")}
        {toggle("Solo game audio", edl.sourceAudio.solo, () => p.onEdit((e) => ({ ...e, sourceAudio: { ...e.sourceAudio, solo: !e.sourceAudio.solo } }), "Solo game audio"), "S")}
      </>
    ),
    body: edl.segments.map((s, i) => {
      const a = starts[i]!;
      const w = x(segmentOutputMs(s));
      const wf = p.sourcePeaks(s.sessionId);
      const quiet = edl.sourceAudio.muted || (anySolo && !edl.sourceAudio.solo);
      return (
        <div key={s.id} aria-hidden className={`absolute inset-y-1 overflow-hidden border border-black/40 ${quiet ? "bg-graphite-600" : "bg-signal/60"}`} style={{ left: x(a), width: Math.max(4, w) }}>
          {wf && wave({ peaks: wf.peaks, durationMs: wf.durationMs, fromMs: s.inMs, toMs: s.outMs, width: w })}
        </div>
      );
    }),
  });
  edl.audioTracks.forEach((t) => {
    const quiet = t.muted || (anySolo && !t.solo);
    lanes.push({
      key: `au-${t.id}`,
      label: t.name,
      height: 40,
      header: (
        <>
          {toggle(`Mute ${t.name}`, t.muted, () => p.onEdit((e) => ({ ...e, audioTracks: e.audioTracks.map((x) => (x.id === t.id ? { ...x, muted: !x.muted } : x)) }), "Mute track"), "M")}
          {toggle(`Solo ${t.name}`, t.solo, () => p.onEdit((e) => ({ ...e, audioTracks: e.audioTracks.map((x) => (x.id === t.id ? { ...x, solo: !x.solo } : x)) }), "Solo track"), "S")}
          {toggle(`${t.locked ? "Unlock" : "Lock"} ${t.name}`, t.locked, () => p.onEdit((e) => ({ ...e, audioTracks: e.audioTracks.map((x) => (x.id === t.id ? { ...x, locked: !x.locked } : x)) }), "Lock track"), "L")}
        </>
      ),
      body: t.clips.map((c) => {
        const wf = p.clipPeaks(c.source);
        return block({
          r: { kind: "audio", trackId: t.id, id: c.id },
          span: { startMs: c.startMs, endMs: c.startMs + c.durationMs },
          locked: t.locked,
          tone: quiet ? "bg-graphite-600" : t.kind === "music" ? "bg-[#b48cff]/80" : t.kind === "voice" ? "bg-signal/80" : "bg-[#5fd3a0]/80",
          label: p.clipName(c.source),
          title: `${p.clipName(c.source)} on ${t.name}`,
          children: wf ? wave({ peaks: wf.peaks, durationMs: wf.durationMs, fromMs: c.offsetMs, toMs: c.offsetMs + c.durationMs, width: x(c.durationMs), loop: c.loop }) : null,
        });
      }),
    });
  });

  /* ------------------------------------- ruler --------------------------------------------- */

  const step = RULER_STEPS.find((s) => (s / 1000) * pps >= 64) ?? 120_000;
  const ticks: number[] = [];
  for (let t = 0; t <= total + step; t += step) ticks.push(t);
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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

  const rows = lanes.reduce((n, l) => n + l.height, 0);
  return (
    <div className="select-none border hairline bg-graphite-900">
      <div className="flex">
        {/* Track headers stay put while the lanes scroll. */}
        <div className="w-[88px] shrink-0 border-r hairline sm:w-[132px]">
          <div className="h-7 border-b hairline" />
          {lanes.map((l) => (
            <div key={l.key} className="flex items-center gap-1 overflow-hidden border-b hairline px-1.5" style={{ height: l.height }}>
              <span className="min-w-0 flex-1 truncate text-[0.72rem] font-semibold text-ivory-2" title={l.label}>
                {l.label}
              </span>
              <span className="flex shrink-0 gap-0.5">{l.header}</span>
            </div>
          ))}
        </div>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" aria-label="Edit timeline" role="group">
          <div className="relative" style={{ width: contentW }}>
            <div
              role="slider"
              tabIndex={0}
              aria-label="Playhead in the edit"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={Math.round(p.playheadMs)}
              aria-valuetext={editTime(p.playheadMs)}
              onPointerDown={scrub}
              onKeyDown={(e) => {
                const stepMs = e.shiftKey ? 1000 : 1000 / 30;
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  p.onSeek(Math.min(total, Math.max(0, p.playheadMs + (e.key === "ArrowLeft" ? -stepMs : stepMs))));
                }
              }}
              className="relative h-7 cursor-pointer touch-none border-b hairline"
            >
              {ticks.map((t) => (
                <span key={t} aria-hidden className="tnum absolute top-0 h-full border-l border-line-strong pl-1 text-[0.66rem] text-ivory-3" style={{ left: x(t) }}>
                  {editTime(t).replace(/\.\d$/, "")}
                </span>
              ))}
              {p.markers.map((m, i) => (
                <span key={`${m.ms}-${i}`} aria-hidden title={`${m.label} at ${editTime(m.ms)}`} className={`absolute bottom-0 h-3 w-[3px] -translate-x-1/2 ${MARKER_COLOR[m.kind]}`} style={{ left: x(m.ms) }} />
              ))}
            </div>
            {lanes.map((l) => (
              <div
                key={l.key}
                className="relative border-b hairline"
                style={{ height: l.height }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget && e.button === 0) {
                    p.onSelect([], false);
                    p.onSeek(Math.min(total, msAt(e.clientX)));
                  }
                }}
              >
                {l.body}
              </div>
            ))}
            <span aria-hidden className="pointer-events-none absolute top-0 z-[4] w-[2px] -translate-x-1/2 bg-coral" style={{ left: x(p.playheadMs), height: 28 + rows + lanes.length }} />
            <span aria-hidden className="pointer-events-none absolute top-0 z-[4] h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-coral" style={{ left: x(p.playheadMs) }} />
            <span aria-hidden className="pointer-events-none absolute top-0 z-[1] h-full bg-black/40" style={{ left: x(total), width: Math.max(0, contentW - x(total)) }} />
          </div>
        </div>
      </div>
    </div>
  );
}
