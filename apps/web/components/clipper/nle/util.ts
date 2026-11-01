"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** Timecode HH:MM:SS:FF at the edit's frame rate. */
export function timecode(ms: number, fps = 30): string {
  const totalFrames = Math.max(0, Math.round((ms / 1000) * fps));
  const f = totalFrames % fps;
  const s = Math.floor(totalFrames / fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(f)}`;
}

/** Ruler label: frames only when zoomed in that far. */
export function rulerLabel(ms: number, stepMs: number, fps = 30): string {
  if (stepMs < 1000) return timecode(ms, fps);
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
};

/** A small settings object kept in this browser (panel sizes, track heights). Falls back silently. */
export function useStored<T extends object>(key: string, fallback: T): [T, (fn: (v: T) => T) => void] {
  const [v, setV] = useState<T>(fallback);
  useEffect(() => {
    // Read after mount so the server render and the first client render agree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setV(read(key, fallback));
    // The fallback is a literal at each call site; reading once per key is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = useCallback(
    (fn: (v: T) => T) =>
      setV((cur) => {
        const next = fn(cur);
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Private windows and full storage: the layout just isn't remembered.
        }
        return next;
      }),
    [key],
  );
  return [v, update];
}

const wideQuery = "(min-width: 1024px)";
/** True on screens wide enough for the full editor (1024 px and up). The server renders the full editor. */
export function useWideScreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(wideQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(wideQuery).matches,
    () => true,
  );
}

/** Drag a splitter: calls `onDelta` with the pointer's travel since the press. */
export function startSplitDrag(e: React.PointerEvent, axis: "x" | "y", onDelta: (d: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const start = axis === "x" ? e.clientX : e.clientY;
  const move = (ev: PointerEvent) => onDelta((axis === "x" ? ev.clientX : ev.clientY) - start);
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Drag-and-drop payload for a stored video from the media bin. */
export const SOURCE_DRAG_TYPE = "application/x-slot1-source";
export interface SourceDrag {
  sessionId: string;
  inMs: number;
  outMs: number;
}
export function isSourceDrag(dt: DataTransfer | null | undefined): boolean {
  return Boolean(dt?.types.includes(SOURCE_DRAG_TYPE));
}
export function readSourceDrag(dt: DataTransfer | null | undefined): SourceDrag | null {
  try {
    const raw = dt?.getData(SOURCE_DRAG_TYPE);
    if (!raw) return null;
    const v = JSON.parse(raw) as SourceDrag;
    return typeof v.sessionId === "string" && Number.isFinite(v.inMs) && Number.isFinite(v.outMs) ? v : null;
  } catch {
    return null;
  }
}
