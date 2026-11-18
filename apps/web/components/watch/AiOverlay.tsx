"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AiViewReading } from "@slot1/contracts";
import { useAiView, type TrackedObject } from "./AiView";
import "./ai-overlay.css";

/**
 * The AI overlay: boxes around the people, vehicles and on-screen text SLOT1's AI found, over the
 * stream. Every box comes from SLOT1's own analysis of this stream (the object finder and OCR);
 * nothing is made up. The live log stays beside the player, not on it.
 *
 * Only over SLOT1's own video: the boxes sit on the picture. Twitch's and Kick's players can't be
 * read by a website and SLOT1 only gets their preview picture, so nothing is drawn over them.
 */

/* --- on/off, remembered per viewer --------------------------------------------------------- */

const PREF_KEY = "slot1:ai-overlay";
const prefListeners = new Set<() => void>();
let memoryPref: boolean | null = null;
function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}
function writePref(on: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // Private windows and blocked storage: the switch still works for this page.
  }
  memoryPref = on;
  for (const l of prefListeners) l();
}
const subscribePref = (l: () => void) => {
  prefListeners.add(l);
  return () => void prefListeners.delete(l);
};
function useOverlayOn(): boolean {
  return useSyncExternalStore(subscribePref, () => memoryPref ?? readPref(), () => true);
}

/* --- where the player's picture is --------------------------------------------------------- */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const SURFACE = "video, iframe, [data-player-surface]";

/** The player's picture inside the overlay's parent, kept current as players swap and resize. */
function useSurface(root: React.RefObject<HTMLDivElement | null>): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const host = root.current?.parentElement;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      const target = [...host.querySelectorAll<HTMLElement>(SURFACE)].find((el) => !root.current?.contains(el));
      if (!target) {
        setRect((r) => (r === null ? r : null));
        return;
      }
      const a = host.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      const next = { left: b.left - a.left, top: b.top - a.top, width: b.width, height: b.height };
      setRect((r) =>
        r && Math.abs(r.left - next.left) < 0.5 && Math.abs(r.top - next.top) < 0.5 && Math.abs(r.width - next.width) < 0.5 && Math.abs(r.height - next.height) < 0.5 ? r : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    const mutations = new MutationObserver((list) => {
      if (list.every((m) => root.current?.contains(m.target))) return;
      for (const el of host.querySelectorAll(SURFACE)) resize.observe(el);
      schedule();
    });
    mutations.observe(host, { childList: true, subtree: true });
    for (const el of host.querySelectorAll(SURFACE)) resize.observe(el);
    // Players change their own size (fallbacks, theater mode); a slow check catches the rest.
    const slow = setInterval(schedule, 2000);
    schedule();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      clearInterval(slow);
      cancelAnimationFrame(frame);
    };
  }, [root]);
  return rect;
}

/** The picture inside a box that letterboxes it (object-fit: contain). */
function contain(r: Rect, aspect: number): Rect {
  if (!(aspect > 0) || r.height === 0) return r;
  if (r.width / r.height > aspect) {
    const width = r.height * aspect;
    return { left: (r.width - width) / 2, top: 0, width, height: r.height };
  }
  const height = r.width / aspect;
  return { left: 0, top: (r.height - height) / 2, width: r.width, height };
}

const pct = (b: readonly number[]) => ({ left: `${b[0]! * 100}%`, top: `${b[1]! * 100}%`, width: `${b[2]! * 100}%`, height: `${b[3]! * 100}%` });

/* --- the boxes ------------------------------------------------------------------------------- */

function Boxes({ objects, readings }: { objects: TrackedObject[]; readings: AiViewReading[] }) {
  return (
    <div className="aio-boxes">
      {readings.map((r, i) =>
        r.box ? (
          <div key={`t${i}`} className="aio-text" style={pct(r.box)}>
            <span className="aio-tag aio-tag-text">text</span>
          </div>
        ) : null,
      )}
      {objects.map((o) => (
        <div key={o.id} className="aio-box" style={pct(o.box)}>
          <span className="aio-tag">
            {o.label} <b>{Math.round(o.score * 100)}%</b>
          </span>
          <i className="aio-c aio-c-tl" />
          <i className="aio-c aio-c-tr" />
          <i className="aio-c aio-c-bl" />
          <i className="aio-c aio-c-br" />
        </div>
      ))}
    </div>
  );
}

/* --- the overlay ----------------------------------------------------------------------------- */

export function AiOverlay({
  sessionId,
  over,
}: {
  sessionId: string;
  /** "video": SLOT1's own video plays, boxes go on it. "preview": Twitch's or Kick's player. */
  over: "video" | "preview";
}) {
  const on = useOverlayOn();
  const root = useRef<HTMLDivElement>(null);
  const surface = useSurface(root);
  // Only poll (and so only make the worker look for objects) where there's a picture to box.
  const { shown, objects } = useAiView(sessionId, on && over === "video");

  const readings = shown ? shown.ocr.regions.flatMap((r) => r.readings) : [];
  const picture = shown && surface ? contain({ left: 0, top: 0, width: surface.width, height: surface.height }, shown.frame.analyzedWidth / shown.frame.analyzedHeight) : null;

  // Twitch's and Kick's players: SLOT1 doesn't get their live video, so there's nothing live to box.
  if (over === "preview") return null;

  return (
    <div ref={root} className="aio-root">
      {surface && (
        <div className={`aio-layer ${surface.width < 640 ? "aio-compact" : ""}`} style={{ left: surface.left, top: surface.top, width: surface.width, height: surface.height }}>
          <button type="button" className="aio-toggle" aria-pressed={on} onClick={() => writePref(!on)} title={on ? "Hide the AI boxes" : "Show the AI boxes: what SLOT1 sees on this stream"}>
            <span className={`aio-dot ${on ? "is-on" : ""}`} aria-hidden />
            SLOT1 VISION
          </button>

          {on && shown && (
            <div aria-hidden>
              {picture && (
                <div className="aio-picture" style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}>
                  <Boxes objects={objects} readings={readings} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
