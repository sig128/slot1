"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { formatMediaTime, type InstantReplayResponse, type InstantReplayStatus } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

/** Which player is the main one right now. Instant replay never covers Twitch's player. */
export type PlayerKind = "twitch" | "slot1";
export const PlayerKindContext = createContext<((kind: PlayerKind) => void) | null>(null);

/** Called by the live player switch so the workspace knows what it may overlay. */
export function useReportPlayerKind(kind: PlayerKind) {
  const report = useContext(PlayerKindContext);
  useEffect(() => {
    report?.(kind);
    return () => report?.("twitch");
  }, [report, kind]);
}

/** Whether instant replay works in this session (checked now and every 30 s while visible). */
export function useInstantReplayStatus(sessionId: string | null, enabled: boolean): InstantReplayStatus | null {
  const [status, setStatus] = useState<InstantReplayStatus | null>(null);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let alive = true;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      const r = await api<InstantReplayStatus>(`/api/sessions/${sessionId}/instant-replay`).catch(() => null);
      if (alive && r) setStatus(r);
    };
    void check();
    const t = setInterval(() => void check(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, enabled]);
  return enabled ? status : null;
}

export interface ReplayTarget {
  observationId: string;
  label: string;
  /** Where focus goes back to when the replay closes. */
  returnFocus: HTMLElement | null;
}

type Ready = Extract<InstantReplayResponse, { status: "ready" }>;
export type ReplayState =
  | { kind: "idle" }
  | { kind: "loading"; target: ReplayTarget; note: string | null }
  | { kind: "ready"; target: ReplayTarget; replay: Ready }
  | { kind: "error"; target: ReplayTarget; reason: string };

const MAX_WAIT_MS = 45_000;

/**
 * Request an instant replay and wait while SLOT1 saves the last seconds ("pending"), retrying
 * when the server says. Opening another moment replaces the current one.
 */
export function useInstantReplay(sessionId: string | null) {
  const [state, setState] = useState<ReplayState>({ kind: "idle" });
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<ReplayTarget | null>(null);

  const cancel = useCallback(() => {
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const open = useCallback(
    (target: ReplayTarget) => {
      if (!sessionId) return;
      cancel();
      current.current = target;
      const id = run.current;
      const started = Date.now();
      setState({ kind: "loading", target, note: null });
      const attempt = async () => {
        let r: InstantReplayResponse;
        try {
          r = await api<InstantReplayResponse>(`/api/sessions/${sessionId}/instant-replay`, { method: "POST", json: { observationId: target.observationId } });
        } catch (err) {
          if (id === run.current) setState({ kind: "error", target, reason: err instanceof ApiError ? err.message : "Couldn't reach SLOT1 for the replay" });
          return;
        }
        if (id !== run.current) return;
        if (r.status === "ready") setState({ kind: "ready", target, replay: r });
        else if (r.status === "unavailable") setState({ kind: "error", target, reason: r.reason });
        else if (Date.now() - started > MAX_WAIT_MS) setState({ kind: "error", target, reason: `${r.reason}: still not saved, try again in a moment` });
        else {
          setState({ kind: "loading", target, note: r.reason });
          timer.current = setTimeout(() => void attempt(), Math.min(8000, Math.max(1000, r.retryAfterMs)));
        }
      };
      void attempt();
    },
    [sessionId, cancel],
  );

  const close = useCallback(() => {
    cancel();
    const back = current.current?.returnFocus ?? null;
    current.current = null;
    setState({ kind: "idle" });
    requestAnimationFrame(() => {
      if (back && back.isConnected) back.focus({ preventScroll: true });
    });
  }, [cancel]);

  return { state, open, close };
}

/** True from 640 px up, where a corner player over SLOT1's own video leaves the action visible. */
export function useWideEnough(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

const isTyping = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

/**
 * The instant replay player. "overlay" sits in the corner of SLOT1's own video; "dock" sits in
 * SLOT1's own rail when the main player is Twitch's, so Twitch's player is never covered.
 */
export function InstantReplayPlayer({ state, variant, onClose }: { state: Exclude<ReplayState, { kind: "idle" }>; variant: "overlay" | "dock"; onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pos, setPos] = useState(0);
  const target = state.target;
  const ready = state.kind === "ready" ? state.replay : null;

  // Move focus into the player when it opens or switches moment, so the keyboard can drive it.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-replay-focus]")?.focus({ preventScroll: true });
    if (variant === "dock") root.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [target.observationId, variant]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement;
      if (isTyping(active) && !root.current?.contains(active)) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Start playing as soon as the cut is ready; fall back to muted if the browser insists.
  useEffect(() => {
    const v = video.current;
    if (!v || !ready) return;
    v.currentTime = 0;
    v.play().catch(() => {
      v.muted = true;
      setMuted(true);
      void v.play().catch(() => undefined);
    });
  }, [ready]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (ended || v.ended) {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    } else if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const duration = ready?.durationMs ?? 0;
  const progress = duration > 0 ? Math.min(1, pos / duration) : 0;
  const marker = ready && ready.momentOffsetMs !== null && duration > 0 ? Math.min(1, ready.momentOffsetMs / duration) : null;
  const labelId = `ireplay-${target.observationId}`;

  return (
    <section
      ref={root}
      aria-labelledby={labelId}
      data-instant-replay={state.kind}
      data-variant={variant}
      className={`rail-enter border hairline bg-graphite-900 text-ivory ${
        variant === "overlay" ? "absolute right-3 top-3 z-20 w-[min(46%,26rem)] shadow-xl shadow-black/50" : "w-full"
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2">
        <h2 id={labelId} className="min-w-0 font-display text-[0.95rem] font-semibold tracking-[0.04em]">
          <span className="text-apricot">Instant replay</span>
          <span className="sr-only">: </span>
          <span className="ml-2 truncate font-sans text-[0.8rem] font-normal tracking-normal text-ivory-2">{target.label}</span>
        </h2>
        <button type="button" className="btn btn-quiet btn-sm -mr-1 shrink-0" aria-label="Close instant replay" onClick={onClose}>
          <span aria-hidden>✕</span>
        </button>
      </div>
      <div className="relative aspect-video w-full bg-black">
        {ready ? (
          <video
            ref={video}
            src={ready.url}
            playsInline
            preload="auto"
            muted={muted}
            className="block h-full w-full object-contain"
            aria-label={`Replay of ${target.label}`}
            onPlay={() => {
              setPlaying(true);
              setEnded(false);
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setEnded(true);
            }}
            onTimeUpdate={(e) => setPos(Math.round(e.currentTarget.currentTime * 1000))}
          />
        ) : (
          <div className="grid h-full place-items-center p-4 text-center text-sm text-ivory-2" role="status">
            {state.kind === "error" ? (
              <span className="text-coral">{state.reason}</span>
            ) : (
              <span>{state.kind === "loading" && state.note ? `${state.note}…` : "Cutting the replay…"}</span>
            )}
          </div>
        )}
        {ready && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-graphite/85 px-1.5 py-0.5 font-display text-[0.78rem] font-semibold tracking-[0.06em] text-ivory">
            REPLAY
          </span>
        )}
      </div>
      {ready && (
        <div aria-hidden className="relative h-1 w-full bg-graphite-600">
          <div className="absolute inset-y-0 left-0 bg-apricot" style={{ width: `${progress * 100}%` }} />
          {marker !== null && <div className="absolute -top-1 h-3 w-0.5 bg-gold" style={{ left: `${marker * 100}%` }} title="The moment" />}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          data-replay-focus
          className="btn btn-ghost btn-sm"
          disabled={!ready}
          aria-label={!ready ? "Replay loading" : ended ? "Play the replay again" : playing ? "Pause the replay" : "Play the replay"}
          onClick={toggle}
        >
          <span aria-hidden>{ended ? "↺" : playing ? "❚❚" : "▶"}</span>
          <span className="hidden sm:inline">{ended ? "Again" : playing ? "Pause" : "Play"}</span>
        </button>
        {ready && (
          <span className="tnum text-[0.8rem] text-ivory-2">
            {formatMediaTime(pos)} / {formatMediaTime(duration)}
          </span>
        )}
        {ready && muted && (
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => {
              setMuted(false);
              if (video.current) video.current.muted = false;
            }}
          >
            Unmute
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={onClose}>
          Back to live
        </button>
      </div>
      {ready && (
        <p className="px-3 pb-2 text-[0.72rem] text-ivory-3">
          {ready.source === "buffer" ? "From SLOT1’s rolling buffer." : "From the creator’s recording."} Not saved to any library; the link expires in 15 minutes.
        </p>
      )}
    </section>
  );
}
