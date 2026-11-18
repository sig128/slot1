"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TrackedObject } from "./AiView";
import { useLiveVision } from "./vision/useLiveVision";
import "./ai-overlay.css";

/**
 * SLOT1 VISION: live boxes around the people and vehicles in the stream, worked out in the
 * viewer's own browser on every frame it can (YOLOX-Nano, a general detector, not trained on GTA).
 * Nothing about the picture leaves the viewer's computer and nothing is kept.
 *
 * - SLOT1's own video (streams sent from OBS): the page reads the video itself, so it's on by default.
 * - Twitch's and Kick's players: no website may read another site's player, so the viewer presses
 *   the button and lets the browser share this tab (Chrome and Edge on a computer). The capture is
 *   limited to the player, and the boxes go back on top of it.
 */

/* --- on/off for SLOT1's own video, remembered per viewer ------------------------------------ */

const PREF_KEY = "slot1:ai-overlay";
const prefListeners = new Set<() => void>();
let memoryPref: boolean | null = null;
/** Saved choice, else on for computers and off for phones (the finder works the device hard). */
function readPref(): boolean {
  const byDevice = () => window.matchMedia?.("(pointer: fine)").matches ?? true;
  try {
    const saved = window.localStorage.getItem(PREF_KEY);
    return saved === null ? byDevice() : saved !== "off";
  } catch {
    return byDevice();
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

/* --- tab capture of the player (Chrome and Edge) --------------------------------------------- */

type Target = object;
interface CaptureTargets {
  RestrictionTarget?: { fromElement(el: Element): Promise<Target> };
  CropTarget?: { fromElement(el: Element): Promise<Target> };
}
type CaptureTrack = MediaStreamTrack & { restrictTo?(t: Target | null): Promise<void>; cropTo?(t: Target | null): Promise<void> };

const noSubscribe = () => () => undefined;
function canCaptureThisTab(): boolean {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
  const w = window as unknown as CaptureTargets;
  return Boolean(w.RestrictionTarget || w.CropTarget);
}
/** Whether this browser can share this tab and limit the picture to one element. */
function useCanCapture(): boolean {
  return useSyncExternalStore(noSubscribe, canCaptureThisTab, () => false);
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("The browser didn't limit the shared picture to the player in time")), ms))]);

/** Share this tab, limited to `el` (the player). Element Capture keeps SLOT1's own boxes out of the picture. */
async function captureElement(el: Element): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0] as CaptureTrack | undefined;
  try {
    if (!track || track.getSettings().displaySurface !== "browser") throw new Error("Share this tab to see the boxes");
    const w = window as unknown as CaptureTargets;
    let limited = false;
    if (w.RestrictionTarget && track.restrictTo) {
      try {
        // Element Capture needs the element to be its own stacking context.
        if (el instanceof HTMLElement && getComputedStyle(el).isolation !== "isolate") el.style.isolation = "isolate";
        await within(track.restrictTo(await w.RestrictionTarget.fromElement(el)), 4000);
        limited = true;
      } catch {
        limited = false;
      }
    }
    if (!limited && w.CropTarget && track.cropTo) {
      await within(track.cropTo(await w.CropTarget.fromElement(el)), 4000);
      limited = true;
    }
    if (!limited) throw new Error("This browser can't limit the shared picture to the player");
    return stream;
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    throw err;
  }
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

export function AiOverlay({ over }: { /** "video": SLOT1's own video. "embed": Twitch's or Kick's player. */ over: "video" | "embed" }) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useSurface(root);
  const pref = useOverlayOn();
  const canCapture = useCanCapture();
  const [capture, setCapture] = useState<{ stream: MediaStream; video: HTMLVideoElement } | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // SLOT1's own video is read directly; Twitch's and Kick's players through the tab capture.
  const ownVideo = over === "video" && surface?.el instanceof HTMLVideoElement ? surface.el : null;
  const source = over === "video" ? ownVideo : (capture?.video ?? null);
  const enabled = over === "video" ? pref : Boolean(capture);
  const vision = useLiveVision(source, enabled);

  // The viewer stopped sharing from the browser's own bar, or the page is closing.
  useEffect(() => {
    if (!capture) return;
    const track = capture.stream.getVideoTracks()[0];
    const ended = () => setCapture(null);
    track?.addEventListener("ended", ended);
    return () => {
      track?.removeEventListener("ended", ended);
      for (const t of capture.stream.getTracks()) t.stop();
    };
  }, [capture]);

  async function startCapture() {
    if (!surface) return;
    setAsking(true);
    setProblem(null);
    try {
      const stream = await captureElement(surface.el);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      setCapture({ stream, video });
    } catch (err) {
      const e = err as Error;
      // Closing the browser's prompt is a choice, not an error.
      setProblem(
        e.name === "NotAllowedError" || e.name === "AbortError"
          ? "Sharing was cancelled or blocked. Press again and choose Share."
          : e.name === "NotSupportedError"
            ? "This browser can't share a tab. Use Chrome or Edge on a computer."
            : e.message,
      );
    } finally {
      setAsking(false);
    }
  }

  if (!surface || (over === "embed" && !canCapture)) return <div ref={root} className="aio-root" />;

  const on = over === "video" ? pref : Boolean(capture);
  const live = on && vision.state === "running";
  const frame = vision.frame;
  const picture = over === "video" && frame ? contain(surface.rect, frame.width / frame.height) : { left: 0, top: 0, width: surface.rect.width, height: surface.rect.height };
  const label = asking
    ? "SLOT1 VISION · starting"
    : live
      ? `SLOT1 VISION · LIVE${vision.fps ? ` ${vision.fps} fps` : ""}`
      : on
        ? "SLOT1 VISION · loading"
        : over === "embed"
          ? "▶ SLOT1 VISION · start live tracking"
          : "SLOT1 VISION · off";
  const invite = over === "embed" && !on && !asking;

  return (
    <div ref={root} className="aio-root">
      <div className={`aio-layer ${surface.rect.width < 640 ? "aio-compact" : ""}`} style={{ left: surface.rect.left, top: surface.rect.top, width: surface.rect.width, height: surface.rect.height }}>
        <button
          type="button"
          className={`aio-toggle ${invite ? "is-invite" : ""}`}
          aria-pressed={on}
          disabled={asking}
          onClick={() => {
            if (over === "video") writePref(!pref);
            else if (capture) setCapture(null);
            else void startCapture();
          }}
          title={
            over === "video"
              ? on
                ? "Hide the live boxes"
                : "Show live boxes around people and vehicles"
              : on
                ? "Stop the live boxes (stops sharing this tab)"
                : "Live boxes around people and vehicles in this stream. Your browser asks to share this tab; the picture stays on your computer."
          }
        >
          <span className={`aio-dot ${live ? "is-on" : ""}`} aria-hidden />
          {label}
        </button>
        {problem || (on && vision.error) ? (
          <p className="aio-note">{problem ?? vision.error}</p>
        ) : invite ? (
          <p className="aio-hint">Boxes on people and cars, live. Your browser asks to share this tab; the picture stays on your computer.</p>
        ) : null}

        {live && (
          <div className="aio-picture" style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }} aria-hidden>
            <Boxes objects={vision.objects} />
          </div>
        )}
      </div>
    </div>
  );
}
