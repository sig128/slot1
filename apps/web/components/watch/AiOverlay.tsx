"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TrackedObject } from "./AiView";
import { useLiveVision } from "./vision/useLiveVision";
import "./ai-overlay.css";

/**
 * SLOT1 VISION: live boxes around the people and vehicles in SLOT1's own video (streams sent to
 * SLOT1 from OBS), worked out in the viewer's browser on every frame it can (YOLOX-Nano, a general
 * detector, not trained on GTA). On by default for every viewer; nothing about the picture leaves the
 * viewer's computer. Twitch's and Kick's players can't be read by a website, so nothing is drawn
 * over them.
 */

/* --- on/off for SLOT1's own video, remembered per viewer ------------------------------------ */

const PREF_KEY = "slot1:ai-overlay";
const prefListeners = new Set<() => void>();
let memoryPref: boolean | null = null;
/** On for everyone unless this viewer switched it off. */
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

/** The player's element and its box inside the overlay's parent, kept current as players swap and resize. */
function useSurface(root: React.RefObject<HTMLDivElement | null>): { el: HTMLElement; rect: Rect } | null {
  const [surface, setSurface] = useState<{ el: HTMLElement; rect: Rect } | null>(null);
  useLayoutEffect(() => {
    const host = root.current?.parentElement;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      const el = [...host.querySelectorAll<HTMLElement>(SURFACE)].find((x) => !root.current?.contains(x));
      if (!el) {
        setSurface((s) => (s === null ? s : null));
        return;
      }
      const a = host.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const rect = { left: b.left - a.left, top: b.top - a.top, width: b.width, height: b.height };
      setSurface((s) =>
        s && s.el === el && Math.abs(s.rect.left - rect.left) < 0.5 && Math.abs(s.rect.top - rect.top) < 0.5 && Math.abs(s.rect.width - rect.width) < 0.5 && Math.abs(s.rect.height - rect.height) < 0.5
          ? s
          : { el, rect },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      // Background tabs don't run animation frames: measure straight away there.
      if (document.hidden) measure();
      else frame = requestAnimationFrame(measure);
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
    measure();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      clearInterval(slow);
      cancelAnimationFrame(frame);
    };
  }, [root]);
  return surface;
}

/** The picture inside a box that letterboxes it (object-fit: contain). */
function contain(r: Rect, aspect: number): Rect {
  if (!(aspect > 0) || r.height === 0) return { left: 0, top: 0, width: r.width, height: r.height };
  if (r.width / r.height > aspect) {
    const width = r.height * aspect;
    return { left: (r.width - width) / 2, top: 0, width, height: r.height };
  }
  const height = r.width / aspect;
  return { left: 0, top: (r.height - height) / 2, width: r.width, height };
}

const pct = (b: readonly number[]) => ({ left: `${b[0]! * 100}%`, top: `${b[1]! * 100}%`, width: `${b[2]! * 100}%`, height: `${b[3]! * 100}%` });

function Boxes({ objects }: { objects: TrackedObject[] }) {
  return (
    <div className="aio-boxes aio-live">
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

export function AiOverlay({ over }: { /** "video": SLOT1's own video. "embed": Twitch's or Kick's player (nothing drawn). */ over: "video" | "embed" }) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useSurface(root);
  const on = useOverlayOn();
  const video = over === "video" && surface?.el instanceof HTMLVideoElement ? surface.el : null;
  const vision = useLiveVision(video, on);

  if (!surface || !video) return <div ref={root} className="aio-root" />;

  const live = on && vision.state === "running";
  const frame = vision.frame;
  const picture = frame ? contain(surface.rect, frame.width / frame.height) : { left: 0, top: 0, width: surface.rect.width, height: surface.rect.height };
  const label = live ? `SLOT1 VISION · LIVE${vision.fps ? ` ${vision.fps} fps` : ""}` : on ? "SLOT1 VISION · loading" : "SLOT1 VISION · off";

  return (
    <div ref={root} className="aio-root">
      <div className={`aio-layer ${surface.rect.width < 640 ? "aio-compact" : ""}`} style={{ left: surface.rect.left, top: surface.rect.top, width: surface.rect.width, height: surface.rect.height }}>
        <button type="button" className="aio-toggle" aria-pressed={on} onClick={() => writePref(!on)} title={on ? "Hide the live boxes" : "Show live boxes around people and vehicles"}>
          <span className={`aio-dot ${live ? "is-on" : ""}`} aria-hidden />
          {label}
        </button>
        {on && vision.error && <p className="aio-note">{vision.error}</p>}
        {live && (
          <div className="aio-picture" style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }} aria-hidden>
            <Boxes objects={vision.objects} />
          </div>
        )}
      </div>
    </div>
  );
}
