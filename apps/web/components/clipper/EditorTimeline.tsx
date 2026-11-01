"use client";

import type { ProjectSourceView } from "@slot1/contracts";
import { editTime } from "@/lib/clipper";

export interface TimelineRange {
  id: string;
  inMs: number;
  outMs: number;
  active: boolean;
}

const MARKER_COLOR: Record<ProjectSourceView["markers"][number]["kind"], string> = {
  big: "bg-gold",
  text: "bg-apricot",
  event: "bg-signal",
};

/**
 * The source timeline: the whole recording (or a zoomed window of it) with SLOT1's AI moments,
 * this edit's segments, draggable in/out handles and the playhead. Every handle is a keyboard
 * slider (arrows ±0.1 s, Shift ±1 s), so nothing here needs a mouse.
 */
export function EditorTimeline({
  durationMs,
  view,
  positionMs,
  markers,
  ranges,
  onSeek,
  onChangeRange,
}: {
  durationMs: number;
  view: { start: number; end: number };
  positionMs: number;
  markers: ProjectSourceView["markers"];
  ranges: TimelineRange[];
  onSeek: (ms: number) => void;
  onChangeRange: (id: string, edge: "in" | "out", ms: number) => void;
}) {
  const span = Math.max(1, view.end - view.start);
  const pct = (ms: number) => `${((Math.min(Math.max(ms, view.start), view.end) - view.start) / span) * 100}%`;
  const toMs = (clientX: number, el: Element) => {
    const r = (el.closest("[data-timeline]") ?? el).getBoundingClientRect();
    return Math.round(view.start + Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))) * span);
  };
  const clampMs = (ms: number) => Math.min(durationMs, Math.max(0, ms));
  const active = ranges.find((r) => r.active) ?? null;

  const keyStep = (e: React.KeyboardEvent, value: number, apply: (ms: number) => void) => {
    const step = e.shiftKey ? 1000 : 100;
    const map: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -10_000, PageUp: 10_000 };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      apply(clampMs(value + map[e.key]!));
    } else if (e.key === "Home") {
      e.preventDefault();
      apply(0);
    } else if (e.key === "End") {
      e.preventDefault();
      apply(durationMs);
    }
  };

  const startDrag = (edge: "in" | "out" | "seek", e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const apply = (x: number) => {
      const ms = clampMs(toMs(x, target));
      if (edge === "seek") onSeek(ms);
      else if (active) onChangeRange(active.id, edge, ms);
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const visible = markers.filter((m) => m.ms >= view.start && m.ms <= view.end);
  return (
    <div className="select-none">
      <div className="tnum mb-1 flex justify-between text-[0.72rem] text-ivory-3">
        <span>{editTime(view.start)}</span>
        <span>{editTime(view.end)}</span>
      </div>
      <div data-timeline className="relative h-16 touch-none border hairline bg-graphite-900">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Playhead in the source video"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={Math.round(positionMs)}
          aria-valuetext={editTime(positionMs)}
          onPointerDown={(e) => startDrag("seek", e)}
          onKeyDown={(e) => keyStep(e, positionMs, onSeek)}
          className="absolute inset-0 cursor-pointer"
        >
          {/* AI moments: decorative here; the moment list below the timeline is the accessible way to jump. */}
          {visible.map((m, i) => (
            <span
              key={`${m.ms}-${i}`}
              aria-hidden
              title={`${m.label} at ${editTime(m.ms)}`}
              className={`absolute bottom-0 w-[2px] -translate-x-1/2 ${MARKER_COLOR[m.kind]} ${m.kind === "big" ? "top-0 opacity-100" : "top-1/2 opacity-70"}`}
              style={{ left: pct(m.ms) }}
            />
          ))}
          {ranges
            .filter((r) => r.outMs >= view.start && r.inMs <= view.end)
            .map((r) => (
              <span
                key={r.id}
                aria-hidden
                className={`absolute inset-y-2 border-x-2 ${r.active ? "border-ivory bg-ivory/20" : "border-ivory-3 bg-ivory/5"}`}
                style={{ left: pct(r.inMs), width: `calc(${pct(r.outMs)} - ${pct(r.inMs)})` }}
              />
            ))}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-coral" style={{ left: pct(positionMs) }} />
        </div>
        {active &&
          (["in", "out"] as const).map((edge) => {
            const ms = edge === "in" ? active.inMs : active.outMs;
            if (ms < view.start || ms > view.end) return null;
            return (
              <span
                key={edge}
                role="slider"
                tabIndex={0}
                aria-label={edge === "in" ? "In point of the selected segment" : "Out point of the selected segment"}
                aria-valuemin={0}
                aria-valuemax={durationMs}
                aria-valuenow={ms}
                aria-valuetext={editTime(ms)}
                onPointerDown={(e) => startDrag(edge, e)}
                onKeyDown={(e) => keyStep(e, ms, (v) => onChangeRange(active.id, edge, v))}
                className="absolute inset-y-0 z-10 flex w-6 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center"
                style={{ left: pct(ms) }}
              >
                <span className="h-10 w-2 bg-ivory shadow-[0_0_0_2px_var(--color-graphite-900)]" />
              </span>
            );
          })}
      </div>
    </div>
  );
}
