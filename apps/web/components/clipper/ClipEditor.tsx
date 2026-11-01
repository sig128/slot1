"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  ASPECT_SIZE,
  Edl,
  EDL_SPEEDS,
  edlDurationMs,
  edlOutputTime,
  type EdlAspect,
  type EdlSegment,
  type EdlText,
  type LibraryItemView,
  type ProjectSourceView,
  type ProjectView,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime, parseEditTime } from "@/lib/clipper";
import { bytes } from "@/lib/format";
import { EditorTimeline } from "./EditorTimeline";

type Mode = "source" | "program";
type SaveState = "saved" | "pending" | "saving" | "error";

const ASPECTS: EdlAspect[] = ["9:16", "16:9", "1:1"];
const ratio = (a: EdlAspect) => ASPECT_SIZE[a].width / ASPECT_SIZE[a].height;
let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Where an output-timeline time falls: which segment, and the source time inside it. */
function locate(e: Edl, outMs: number): { index: number; sourceMs: number } {
  let t = 0;
  for (let i = 0; i < e.segments.length; i++) {
    const s = e.segments[i]!;
    const d = (s.outMs - s.inMs) / s.speed;
    if (outMs < t + d || i === e.segments.length - 1) return { index: i, sourceMs: Math.round(s.inMs + Math.min(d, Math.max(0, outMs - t)) * s.speed) };
    t += d;
  }
  return { index: 0, sourceMs: e.segments[0]!.inMs };
}

/** The crop rectangle (in percent of the source) that a segment's reframe shows. */
function cropBox(src: { width: number; height: number }, aspect: EdlAspect, r: EdlSegment["reframe"]) {
  const a = ratio(aspect);
  const w = Math.min(src.width, src.height * a) / r.zoom;
  const h = w / a;
  const x = Math.min(Math.max(r.x * src.width - w / 2, 0), src.width - w);
  const y = Math.min(Math.max(r.y * src.height - h / 2, 0), src.height - h);
  return { w: w / src.width, h: h / src.height, x: x / src.width, y: y / src.height };
}

export function ClipEditor({ initial }: { initial: ProjectView }) {
  const [edl, setEdl] = useState<Edl>(initial.edl);
  const [title, setTitle] = useState(initial.title);
  const [rev, setRev] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [renders, setRenders] = useState<LibraryItemView[]>(initial.renders);
  const [rendering, setRendering] = useState(false);
  const [activeId, setActiveId] = useState(initial.edl.segments[0]!.id);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [srcSession, setSrcSession] = useState(initial.edl.segments[0]!.sessionId);
  const [srcPos, setSrcPos] = useState(initial.edl.segments[0]!.inMs);
  const [playIdx, setPlayIdx] = useState(0);
  const [outPos, setOutPos] = useState(0);
  const [dims, setDims] = useState<Record<string, { width: number; height: number; durationMs: number }>>({});
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const backdrop = useRef<HTMLCanvasElement>(null);
  const pending = useRef<{ ms: number; rate: number; play: boolean } | null>({ ms: initial.edl.segments[0]!.inMs, rate: 1, play: false });

  const sources = initial.sources;
  const sourceOf = useCallback((sessionId: string): ProjectSourceView | undefined => sources.find((s) => s.sessionId === sessionId), [sources]);
  const validation = useMemo(() => Edl.safeParse(edl), [edl]);
  const invalid = validation.success ? null : (validation.error.issues[0]?.message ?? "This edit isn't valid yet");
  const total = edlDurationMs(edl);
  const activeIdx = Math.max(0, edl.segments.findIndex((s) => s.id === activeId));
  const active = edl.segments[activeIdx]!;
  const src = sourceOf(srcSession);
  const srcDims = dims[srcSession] ?? { width: src?.width ?? 1920, height: src?.height ?? 1080, durationMs: src?.durationMs ?? Math.max(active.outMs, 60_000) };
  const durationMs = srcDims.durationMs;
  const captionLines = sources.reduce((n, s) => n + s.captionLines, 0);

  /* --------------------------------- editing -------------------------------------------- */

  const change = (fn: (e: Edl) => Edl) => {
    setEdl((e) => fn(e));
    setRev((r) => r + 1);
  };
  const changeSegment = (id: string, fn: (s: EdlSegment) => EdlSegment) => change((e) => ({ ...e, segments: e.segments.map((s) => (s.id === id ? fn(s) : s)) }));
  const setEdge = (id: string, edge: "in" | "out", ms: number) =>
    changeSegment(id, (s) => {
      const max = dims[s.sessionId]?.durationMs ?? sourceOf(s.sessionId)?.durationMs ?? Number.MAX_SAFE_INTEGER;
      if (edge === "in") return { ...s, inMs: Math.max(0, Math.min(Math.round(ms), s.outMs - 300)) };
      return { ...s, outMs: Math.min(max, Math.max(Math.round(ms), s.inMs + 300)) };
    });
  const changeText = (id: string, fn: (t: EdlText) => EdlText) => change((e) => ({ ...e, texts: e.texts.map((t) => (t.id === id ? fn(t) : t)) }));

  // Autosave valid edits shortly after the last change.
  useEffect(() => {
    if (rev === 0 || !validation.success) return;
    const data = validation.data;
    const t = setTimeout(() => {
      setSave("saving");
      api<ProjectView>(`/api/projects/${initial.id}`, { method: "PATCH", json: { title: title.trim() || initial.title, edl: data } })
        .then((v) => {
          setSave("saved");
          setRenders(v.renders);
          setError(null);
        })
        .catch((err: unknown) => {
          setSave("error");
          setError(err instanceof ApiError ? err.message : "Couldn't save the edit");
        });
    }, 700);
    return () => clearTimeout(t);
  }, [rev, validation, title, initial.id, initial.title]);
  const saveLabel = rev === 0 ? "Saved" : !validation.success ? "Not saved: fix the edit" : save === "saving" ? "Saving" : save === "error" ? "Not saved" : save === "saved" ? "Saved" : "Unsaved changes";

  // Renders run in the background: poll while one is still processing.
  const renderBusy = renders.some((r) => r.status === "processing");
  useEffect(() => {
    if (!renderBusy) return;
    const t = setInterval(() => {
      api<ProjectView>(`/api/projects/${initial.id}`)
        .then((v) => setRenders(v.renders))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [renderBusy, initial.id]);

  const render = async () => {
    if (!validation.success) return;
    setRendering(true);
    setError(null);
    try {
      // Make sure the server has exactly what is on screen before rendering it.
      const v = await api<ProjectView>(`/api/projects/${initial.id}`, { method: "PATCH", json: { title: title.trim() || initial.title, edl: validation.data } });
      setSave("saved");
      setRev(0);
      const item = await api<LibraryItemView>(`/api/projects/${initial.id}/render`, { method: "POST" });
      setRenders([item, ...v.renders]);
      setAnnounce("Render started");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}.` : ""}` : "Couldn't start the render");
    } finally {
      setRendering(false);
    }
  };

  /* --------------------------------- playback ------------------------------------------- */

  const showSource = (sessionId: string, ms: number, opts: { rate?: number; play?: boolean } = {}) => {
    const v = video.current;
    const wanted = { ms, rate: opts.rate ?? 1, play: opts.play ?? false };
    if (sessionId !== srcSession || !v || v.readyState < 1) {
      pending.current = wanted;
      setSrcSession(sessionId);
      return;
    }
    v.currentTime = ms / 1000;
    v.playbackRate = wanted.rate;
    setSrcPos(ms);
    if (wanted.play) void v.play().catch(() => setPlaying(false));
  };

  const seekSource = (ms: number) => {
    setMode("source");
    if (active.sessionId !== srcSession) return showSource(active.sessionId, ms);
    video.current?.pause();
    showSource(srcSession, ms);
  };

  const playSegment = (i: number, offsetSourceMs = 0, play = true) => {
    const s = edl.segments[i];
    if (!s) return;
    setPlayIdx(i);
    showSource(s.sessionId, s.inMs + offsetSourceMs, { rate: s.speed, play });
  };

  const seekProgram = (outMs: number, play = playing) => {
    setMode("program");
    const { index, sourceMs } = locate(edl, outMs);
    setOutPos(outMs);
    playSegment(index, sourceMs - edl.segments[index]!.inMs, play);
  };

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    if (mode === "program") {
      const at = outPos >= total - 50 ? 0 : outPos;
      return seekProgram(at, true);
    }
    v.playbackRate = rate;
    void v.play().catch(() => setPlaying(false));
  };

  const onMetadata = () => {
    const v = video.current!;
    setDims((d) => ({ ...d, [srcSession]: { width: v.videoWidth || srcDims.width, height: v.videoHeight || srcDims.height, durationMs: Math.round((v.duration || 0) * 1000) || srcDims.durationMs } }));
    const p = pending.current;
    pending.current = null;
    if (p) {
      v.currentTime = p.ms / 1000;
      v.playbackRate = p.rate;
      setSrcPos(p.ms);
      if (p.play) void v.play().catch(() => setPlaying(false));
    }
  };

  const drawBackdrop = () => {
    const c = backdrop.current;
    const v = video.current;
    if (!c || !v || edl.layout !== "fit" || v.readyState < 2) return;
    const g = c.getContext("2d");
    if (!g) return;
    const scale = Math.max(c.width / (v.videoWidth || 1), c.height / (v.videoHeight || 1));
    const w = (v.videoWidth || 1) * scale;
    const h = (v.videoHeight || 1) * scale;
    g.filter = "blur(10px) brightness(0.85)";
    g.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
  };

  // While playing: follow the playhead, cross segment boundaries in program mode, draw the
  // blurred backdrop for the "fit" layout.
  const tick = useEffectEvent(() => {
    const v = video.current;
    if (!v) return;
    const t = v.currentTime * 1000;
    setSrcPos(t);
    if (mode === "program") {
      const s = edl.segments[playIdx];
      if (s && t >= s.outMs - 20) {
        if (playIdx + 1 >= edl.segments.length) {
          v.pause();
          setOutPos(total);
          return;
        }
        playSegment(playIdx + 1, 0, true);
        return;
      }
      setOutPos(edlOutputTime(edl, playIdx, t));
    }
    drawBackdrop();
  });
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /* --------------------------------- keyboard ------------------------------------------- */

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || el.getAttribute("role") === "slider")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Space and Enter on a focused button or link belong to that control.
    if ((e.key === " " || e.key === "Enter") && el && (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY")) return;
    const v = video.current;
    const key = e.key.toLowerCase();
    const here = Math.round((v?.currentTime ?? srcPos / 1000) * 1000);
    const onActiveSource = srcSession === active.sessionId;
    if (key === " " || key === "k") {
      e.preventDefault();
      if (key === "k") v?.pause();
      else togglePlay();
    } else if (key === "l") {
      e.preventDefault();
      if (mode === "program") return togglePlay();
      const next = v && !v.paused ? Math.min(4, rate * 2) : 1;
      setRate(next);
      if (v) {
        v.playbackRate = next;
        void v.play().catch(() => setPlaying(false));
      }
    } else if (key === "j") {
      e.preventDefault();
      if (mode === "program") seekProgram(Math.max(0, outPos - 1000), false);
      else seekSource(Math.max(0, here - 1000));
    } else if (key === "i" || key === "o") {
      e.preventDefault();
      if (!onActiveSource) return;
      setEdge(active.id, key === "i" ? "in" : "out", here);
      setAnnounce(`${key === "i" ? "In" : "Out"} point set at ${editTime(here)}`);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.shiftKey ? 1000 : 1000 / 30) * (e.key === "ArrowLeft" ? -1 : 1);
      if (mode === "program") seekProgram(Math.min(total, Math.max(0, outPos + step)), false);
      else seekSource(Math.min(durationMs, Math.max(0, here + step)));
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* --------------------------------- derived view --------------------------------------- */

  const view = useMemo(() => {
    if (zoom) return zoom;
    if (durationMs <= 10 * 60_000) return { start: 0, end: durationMs };
    const mid = (active.inMs + active.outMs) / 2;
    const half = Math.max(60_000, (active.outMs - active.inMs) * 1.5);
    const start = Math.max(0, Math.min(durationMs - 2 * half, mid - half));
    return { start, end: Math.min(durationMs, start + 2 * half) };
  }, [zoom, durationMs, active.inMs, active.outMs]);
  const zoomBy = (f: number) => {
    const span = Math.min(durationMs, Math.max(4000, (view.end - view.start) * f));
    const center = Math.min(Math.max(srcPos, view.start), view.end);
    const start = Math.max(0, Math.min(durationMs - span, center - span / 2));
    setZoom({ start, end: start + span });
  };

  const showing = mode === "program" ? edl.segments[playIdx] : active;
  const outNow = mode === "program" ? outPos : srcPos >= active.inMs && srcPos <= active.outMs ? edlOutputTime(edl, activeIdx, srcPos) : null;
  const crop = showing && edl.layout === "crop" ? cropBox(srcDims, edl.aspect, showing.reframe) : null;
  const fadeOpacity =
    outNow === null ? 0 : edl.fadeInMs > 0 && outNow < edl.fadeInMs ? 1 - outNow / edl.fadeInMs : edl.fadeOutMs > 0 && outNow > total - edl.fadeOutMs ? (outNow - (total - edl.fadeOutMs)) / edl.fadeOutMs : 0;
  const texts = outNow === null ? [] : edl.texts.filter((t) => outNow >= t.startMs && outNow < t.endMs);
  const bigMarkers = (src?.markers ?? []).filter((m) => m.kind === "big").slice(0, 24);
  const frameWidth = `min(100%, calc(min(62vh, 600px) * ${ratio(edl.aspect).toFixed(4)}))`;

  // Keep the HTML volume in step with the edit (the render can boost up to 200%).
  useEffect(() => {
    if (video.current) video.current.volume = Math.min(1, edl.volume);
  }, [edl.volume, srcSession]);

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-20 pt-6 sm:px-6 lg:px-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <Link href="/studio#library" className="text-sm text-ivory-2 hover:text-ivory">
            ← Library
          </Link>
          <label htmlFor="edit-title" className="sr-only">
            Title
          </label>
          <input
            id="edit-title"
            value={title}
            maxLength={120}
            onChange={(e) => {
              setTitle(e.target.value);
              setRev((r) => r + 1);
            }}
            className="poster-title mt-1 block w-full min-w-0 bg-transparent text-[length:var(--text-display-md)] font-black leading-[0.95] outline-none focus-visible:outline-2"
          />
          <p className="mt-1 text-sm text-ivory-3" aria-live="polite">
            {initial.origin === "auto" ? "Auto clip draft. " : ""}
            {saveLabel}
            {invalid && rev > 0 ? `: ${invalid}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tnum text-sm text-ivory-2">
            {ASPECT_SIZE[edl.aspect].label}, {editTime(total)}
          </span>
          <button type="button" className="btn btn-coral" disabled={rendering || !validation.success} onClick={() => void render()}>
            {rendering ? "Starting render" : "Render"}
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="mt-3 text-sm text-coral">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="assertive">
        {announce}
      </p>

      <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="min-w-0">
          {/* Preview: the output frame at the chosen aspect, with crop, texts and fades applied. */}
          <div className="flex justify-center bg-graphite-900 py-3">
            <div className="relative overflow-hidden bg-black [container-type:size]" style={{ width: frameWidth, aspectRatio: `${ASPECT_SIZE[edl.aspect].width} / ${ASPECT_SIZE[edl.aspect].height}` }}>
              {edl.layout === "fit" && <canvas ref={backdrop} width={144} height={256} aria-hidden className="absolute inset-0 h-full w-full" />}
              <video
                ref={video}
                key={srcSession}
                src={src?.playbackUrl ?? undefined}
                poster={src?.posterUrl ?? undefined}
                preload="auto"
                playsInline
                aria-label={`Preview of ${title}`}
                onLoadedMetadata={onMetadata}
                onSeeked={() => drawBackdrop()}
                onLoadedData={() => drawBackdrop()}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(e) => !playing && setSrcPos(e.currentTarget.currentTime * 1000)}
                className={crop ? "absolute max-w-none" : "absolute inset-0 h-full w-full object-contain"}
                style={crop ? { width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%` } : undefined}
              />
              {texts.map((t) => (
                <p
                  key={t.id}
                  className={`pointer-events-none absolute inset-x-[4%] text-center leading-[1.05] ${
                    t.position === "top" ? "top-[9%]" : t.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-[20%]"
                  } ${
                    t.style === "poster"
                      ? "moment-banner-title text-[length:7cqh]"
                      : t.style === "banner"
                        ? "mx-auto w-fit bg-coral px-[0.35em] font-[family-name:var(--font-poster)] text-[length:5cqh] font-black text-graphite"
                        : "mx-auto w-fit bg-black/60 px-[0.4em] text-[length:3.5cqh] text-white"
                  }`}
                >
                  {t.text}
                </p>
              ))}
              {fadeOpacity > 0 && <span aria-hidden className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: Math.min(1, fadeOpacity) }} />}
              {!src?.playbackUrl && <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-ivory-2">This session&apos;s video is no longer stored.</p>}
            </div>
          </div>

          {/* Transport */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm min-w-[5.5rem]" onClick={togglePlay} aria-keyshortcuts="Space">
              {playing ? "Pause" : "Play"}
            </button>
            <div role="radiogroup" aria-label="What plays" className="flex border hairline">
              {(
                [
                  ["source", "Source"],
                  ["program", "Edit"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => {
                    video.current?.pause();
                    if (m === "program") seekProgram(0, false);
                    else seekSource(active.inMs);
                  }}
                  className={`h-8 px-3 font-display text-[0.92rem] font-semibold ${mode === m ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="tnum text-sm text-ivory-2" aria-live="off">
              {mode === "program" ? `${editTime(outPos)} / ${editTime(total)}` : `${editTime(srcPos)}${rate !== 1 && playing ? ` (${rate}×)` : ""}`}
            </span>
            <button type="button" className="btn btn-ghost btn-sm ml-auto" disabled={srcSession !== active.sessionId} onClick={() => setEdge(active.id, "in", srcPos)} aria-keyshortcuts="I">
              Set in
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={srcSession !== active.sessionId} onClick={() => setEdge(active.id, "out", srcPos)} aria-keyshortcuts="O">
              Set out
            </button>
          </div>

          {mode === "program" ? (
            <div className="mt-4">
              <label htmlFor="program-pos" className="label">
                Position in the edit
              </label>
              <input
                id="program-pos"
                type="range"
                min={0}
                max={total}
                step={100}
                value={Math.min(total, Math.round(outPos))}
                onChange={(e) => seekProgram(Number(e.target.value), false)}
                className="w-full accent-[#ffad72]"
              />
            </div>
          ) : (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ivory-2">
                  {src?.title ?? "Source"}
                  <span className="text-ivory-3"> · drag the white handles or press I and O</span>
                </p>
                <div className="flex gap-1">
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => zoomBy(0.5)} aria-label="Zoom the timeline in">
                    Zoom in
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => zoomBy(2)} aria-label="Zoom the timeline out">
                    Zoom out
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setZoom({ start: 0, end: durationMs })}>
                    Fit
                  </button>
                </div>
              </div>
              <EditorTimeline
                durationMs={durationMs}
                view={view}
                positionMs={srcSession === active.sessionId ? srcPos : active.inMs}
                markers={src?.markers ?? []}
                ranges={edl.segments.filter((s) => s.sessionId === active.sessionId).map((s) => ({ id: s.id, inMs: s.inMs, outMs: s.outMs, active: s.id === active.id }))}
                onSeek={seekSource}
                onChangeRange={(id, edge, ms) => {
                  setActiveId(id);
                  setEdge(id, edge, ms);
                }}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[0.8rem] text-ivory-3">AI moments</span>
                {bigMarkers.map((m, i) => (
                  <button key={`${m.ms}-${i}`} type="button" className="chip hover:border-ivory-2" onClick={() => seekSource(Math.max(0, m.ms - 1000))}>
                    <span className="text-gold">{m.label}</span>
                    <span className="tnum text-ivory-3">{editTime(m.ms)}</span>
                  </button>
                ))}
                {(src?.markers.length ?? 0) > 0 ? (
                  <>
                    <label htmlFor="jump" className="sr-only">
                      Jump to an AI moment
                    </label>
                    <select
                      id="jump"
                      className="field h-8 w-auto max-w-full py-0 text-[0.85rem]"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) seekSource(Math.max(0, Number(e.target.value) - 1000));
                      }}
                    >
                      <option value="">Jump to a moment ({src!.markers.length})</option>
                      {src!.markers.slice(0, 400).map((m, i) => (
                        <option key={`${m.ms}-${i}`} value={m.ms}>
                          {editTime(m.ms)} {m.label.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="text-[0.8rem] text-ivory-3">none on this source</span>
                )}
              </div>
            </div>
          )}

          <details className="mt-5 text-sm text-ivory-2">
            <summary className="cursor-pointer text-ivory-3 hover:text-ivory">Keyboard shortcuts</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="font-display font-semibold">Space</dt>
              <dd>Play or pause</dd>
              <dt className="font-display font-semibold">J / K / L</dt>
              <dd>Back one second / pause / play (press L again for 2× and 4×)</dd>
              <dt className="font-display font-semibold">I / O</dt>
              <dd>Set the selected segment&apos;s in or out point at the playhead</dd>
              <dt className="font-display font-semibold">← / →</dt>
              <dd>One frame back or forward (Shift: one second)</dd>
            </dl>
          </details>
        </div>

        <div className="min-w-0 space-y-8">
          <Panel title="Segments">
            <ol className="space-y-3">
              {edl.segments.map((s, i) => (
                <SegmentRow
                  key={s.id}
                  seg={s}
                  index={i}
                  count={edl.segments.length}
                  active={s.id === activeId}
                  layout={edl.layout}
                  sourceTitle={sources.length > 1 ? (sourceOf(s.sessionId)?.title ?? "Source") : null}
                  onSelect={() => {
                    setActiveId(s.id);
                    if (mode === "source") seekSource(s.inMs);
                  }}
                  onChange={(fn) => changeSegment(s.id, fn)}
                  onMove={(d) =>
                    change((e) => {
                      const segs = [...e.segments];
                      const [x] = segs.splice(i, 1);
                      segs.splice(Math.max(0, Math.min(segs.length, i + d)), 0, x!);
                      return { ...e, segments: segs };
                    })
                  }
                  onDuplicate={() => change((e) => ({ ...e, segments: [...e.segments.slice(0, i + 1), { ...s, id: newId("s") }, ...e.segments.slice(i + 1)] }))}
                  onDelete={() => {
                    change((e) => ({ ...e, segments: e.segments.filter((x) => x.id !== s.id) }));
                    if (s.id === activeId) setActiveId(edl.segments[i === 0 ? 1 : i - 1]!.id);
                  }}
                />
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={edl.segments.length >= 20}
                onClick={() => {
                  const at = srcSession === active.sessionId ? Math.round(srcPos) : active.outMs;
                  const seg: EdlSegment = { ...active, id: newId("s"), inMs: Math.min(at, Math.max(0, durationMs - 1000)), outMs: Math.min(durationMs, at + 5000) };
                  change((e) => ({ ...e, segments: [...e.segments.slice(0, activeIdx + 1), seg, ...e.segments.slice(activeIdx + 1)] }));
                  setActiveId(seg.id);
                }}
              >
                Add segment at playhead
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={srcSession !== active.sessionId || srcPos <= active.inMs + 300 || srcPos >= active.outMs - 300 || edl.segments.length >= 20}
                onClick={() => {
                  const at = Math.round(srcPos);
                  const second: EdlSegment = { ...active, id: newId("s"), inMs: at };
                  change((e) => ({ ...e, segments: e.segments.flatMap((x) => (x.id === active.id ? [{ ...x, outMs: at }, second] : [x])) }));
                }}
              >
                Split at playhead
              </button>
            </div>
          </Panel>

          <Panel title="Format">
            <div role="radiogroup" aria-label="Output size" className="grid grid-cols-3 border hairline">
              {ASPECTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={edl.aspect === a}
                  onClick={() => change((e) => ({ ...e, aspect: a }))}
                  className={`px-2 py-2 text-left ${edl.aspect === a ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                >
                  <span className="block font-display text-[1.05rem] font-bold leading-none">{ASPECT_SIZE[a].label.split(" ")[0]}</span>
                  <span className="tnum mt-0.5 block text-[0.74rem] opacity-80">{ASPECT_SIZE[a].label.split(" ")[1]}</span>
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Framing" className="mt-3 grid grid-cols-2 border hairline">
              {(
                [
                  ["crop", "Fill and reframe"],
                  ["fit", "Whole frame, blurred backdrop"],
                ] as const
              ).map(([l, label]) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={edl.layout === l}
                  onClick={() => change((e) => ({ ...e, layout: l }))}
                  className={`px-2 py-2 text-left text-[0.88rem] leading-tight ${edl.layout === l ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <RangeField id="fade-in" label="Fade in" value={edl.fadeInMs} min={0} max={5000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => change((e) => ({ ...e, fadeInMs: v }))} />
              <RangeField id="fade-out" label="Fade out" value={edl.fadeOutMs} min={0} max={5000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => change((e) => ({ ...e, fadeOutMs: v }))} />
              <RangeField id="volume" label="Volume" value={Math.round(edl.volume * 100)} min={0} max={200} step={5} format={(v) => `${v}%`} onChange={(v) => change((e) => ({ ...e, volume: v / 100 }))} />
              <div>
                <p className="label">Cover frame</p>
                <p className="tnum text-sm">{edl.coverMs === null ? "Automatic" : editTime(edl.coverMs)}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button type="button" className="btn btn-quiet btn-sm px-0" disabled={outNow === null} onClick={() => outNow !== null && change((e) => ({ ...e, coverMs: Math.round(outNow) }))}>
                    Use this frame
                  </button>
                  {edl.coverMs !== null && (
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => change((e) => ({ ...e, coverMs: null }))}>
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </div>
            {edl.volume > 1 && <p className="mt-2 text-[0.78rem] text-ivory-3">The preview plays at full volume; the boost above 100% is applied in the render.</p>}
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-[#ffad72]"
                checked={edl.captions}
                disabled={captionLines === 0 && !edl.captions}
                onChange={(e) => change((x) => ({ ...x, captions: e.target.checked }))}
              />
              <span>
                Burn in captions from the transcript
                <span className="block text-[0.78rem] text-ivory-3">
                  {captionLines === 0 ? "No transcript exists for this video yet." : `${captionLines} transcript line${captionLines === 1 ? "" : "s"} available; lines inside your segments are captioned in the render.`}
                </span>
              </span>
            </label>
          </Panel>

          <Panel title="Text">
            {edl.texts.length === 0 && <p className="text-sm text-ivory-3">No text yet.</p>}
            <ul className="space-y-4">
              {edl.texts.map((t) => (
                <TextRow
                  key={t.id}
                  text={t}
                  total={total}
                  playhead={outNow}
                  onChange={(fn) => changeText(t.id, fn)}
                  onDelete={() => change((e) => ({ ...e, texts: e.texts.filter((x) => x.id !== t.id) }))}
                />
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-ghost btn-sm mt-3"
              disabled={edl.texts.length >= 20}
              onClick={() => {
                const start = Math.min(Math.max(0, total - 500), Math.round(outNow ?? 0));
                change((e) => ({ ...e, texts: [...e.texts, { id: newId("t"), text: "MISSION PASSED", startMs: start, endMs: Math.min(total, start + 3000), position: "top", style: "poster" }] }));
              }}
            >
              Add text at playhead
            </button>
            <p className="mt-2 text-[0.78rem] text-ivory-3">Rendered in Passion One (SIL Open Font License).</p>
          </Panel>

          <Panel title="Renders">
            {renders.length === 0 ? (
              <p className="text-sm text-ivory-3">Press Render to export this edit as an MP4. Renders land in your library.</p>
            ) : (
              <ul className="space-y-3">
                {renders.map((r) => (
                  <li key={r.id} className="border hairline p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="tnum text-sm">
                        {r.width && r.height ? `${r.width}×${r.height}` : ASPECT_SIZE[edl.aspect].label}
                        {r.durationMs ? `, ${editTime(r.durationMs)}` : ""}
                        {r.bytes ? `, ${bytes(r.bytes)}` : ""}
                      </span>
                      <span className={`text-[0.8rem] ${r.status === "failed" ? "text-coral" : r.status === "ready" ? "text-signal" : "text-apricot"}`}>
                        {r.status === "processing" ? `Rendering ${Math.round((r.progress ?? 0) * 100)}%` : r.status === "ready" ? "Ready" : "Failed"}
                      </span>
                    </div>
                    {r.status === "processing" && (
                      <div role="progressbar" aria-label="Render progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((r.progress ?? 0) * 100)} className="mt-2 h-1 bg-graphite-600">
                        <span className="block h-full bg-apricot transition-[width]" style={{ width: `${Math.max(3, Math.round((r.progress ?? 0) * 100))}%` }} />
                      </div>
                    )}
                    {r.status === "failed" && r.error && <p className="mt-1 text-[0.8rem] text-coral">{r.error}</p>}
                    {r.status === "ready" && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Link href={r.viewPath} className="btn btn-quiet btn-sm px-0">
                          Open
                        </Link>
                        {r.url && (
                          <a href={r.url} download={`${(title || "slot1").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "slot1"}.mp4`} className="btn btn-quiet btn-sm">
                            Download
                          </a>
                        )}
                        <Link href="/studio#library" className="btn btn-quiet btn-sm">
                          Share from Library
                        </Link>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 border-b hairline pb-2 font-display text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

function RangeField({ id, label, value, min, max, step, format, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label flex justify-between">
        <span>{label}</span>
        <span className="tnum text-ivory">{format(value)}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#ffad72]" />
    </div>
  );
}

function TimeField({ id, label, value, onCommit }: { id: string; label: string; value: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="field tnum h-9"
        inputMode="decimal"
        value={text ?? editTime(value)}
        onFocus={() => setText(editTime(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const ms = text === null ? null : parseEditTime(text);
          if (ms !== null && ms !== value) onCommit(ms);
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function SegmentRow({
  seg: s,
  index,
  count,
  active,
  layout,
  sourceTitle,
  onSelect,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: {
  seg: EdlSegment;
  index: number;
  count: number;
  active: boolean;
  layout: Edl["layout"];
  sourceTitle: string | null;
  onSelect: () => void;
  onChange: (fn: (s: EdlSegment) => EdlSegment) => void;
  onMove: (d: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`border p-3 ${active ? "border-ivory-2 bg-graphite-800" : "hairline"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-left font-display text-[1.05rem] font-bold hover:text-apricot" aria-pressed={active} onClick={onSelect}>
          Segment {index + 1}
          {sourceTitle && <span className="ml-2 font-sans text-[0.8rem] font-normal text-ivory-3">{sourceTitle}</span>}
        </button>
        <span className="tnum text-[0.8rem] text-ivory-3">{editTime((s.outMs - s.inMs) / s.speed)} in the edit</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <TimeField id={`in-${s.id}`} label="In" value={s.inMs} onCommit={(ms) => onChange((x) => ({ ...x, inMs: Math.max(0, Math.min(ms, x.outMs - 300)) }))} />
        <TimeField id={`out-${s.id}`} label="Out" value={s.outMs} onCommit={(ms) => onChange((x) => ({ ...x, outMs: Math.max(ms, x.inMs + 300) }))} />
        <div className="min-w-0">
          <label htmlFor={`sp-${s.id}`} className="label">
            Speed
          </label>
          <select id={`sp-${s.id}`} className="field tnum h-9" value={s.speed} onChange={(e) => onChange((x) => ({ ...x, speed: Number(e.target.value) as EdlSegment["speed"] }))}>
            {EDL_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </div>
      </div>
      {active && layout === "crop" && (
        <div className="mt-3 grid grid-cols-3 gap-3">
          <RangeField id={`rx-${s.id}`} label="Left–right" value={Math.round(s.reframe.x * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange((x) => ({ ...x, reframe: { ...x.reframe, x: v / 100 } }))} />
          <RangeField id={`ry-${s.id}`} label="Up–down" value={Math.round(s.reframe.y * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange((x) => ({ ...x, reframe: { ...x.reframe, y: v / 100 } }))} />
          <RangeField id={`rz-${s.id}`} label="Zoom" value={Math.round(s.reframe.zoom * 100)} min={100} max={400} step={5} format={(v) => `${(v / 100).toFixed(2)}×`} onChange={(v) => onChange((x) => ({ ...x, reframe: { ...x.reframe, zoom: v / 100 } }))} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={index === 0} onClick={() => onMove(-1)}>
          Move up<span className="sr-only"> segment {index + 1}</span>
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={index === count - 1} onClick={() => onMove(1)}>
          Move down<span className="sr-only"> segment {index + 1}</span>
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={count >= 20} onClick={onDuplicate}>
          Duplicate<span className="sr-only"> segment {index + 1}</span>
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5 text-coral" disabled={count <= 1} onClick={onDelete}>
          Remove<span className="sr-only"> segment {index + 1}</span>
        </button>
      </div>
    </li>
  );
}

function TextRow({ text: t, total, playhead, onChange, onDelete }: { text: EdlText; total: number; playhead: number | null; onChange: (fn: (t: EdlText) => EdlText) => void; onDelete: () => void }) {
  return (
    <li className="border hairline p-3">
      <label htmlFor={`tx-${t.id}`} className="sr-only">
        Text
      </label>
      <input id={`tx-${t.id}`} className="field h-9" value={t.text} maxLength={90} onChange={(e) => onChange((x) => ({ ...x, text: e.target.value }))} />
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TimeField id={`ts-${t.id}`} label="From" value={t.startMs} onCommit={(ms) => onChange((x) => ({ ...x, startMs: Math.max(0, Math.min(ms, total - 100)) }))} />
        <TimeField id={`te-${t.id}`} label="To" value={t.endMs} onCommit={(ms) => onChange((x) => ({ ...x, endMs: Math.max(x.startMs + 100, Math.min(ms, total)) }))} />
        <div className="min-w-0">
          <label htmlFor={`tp-${t.id}`} className="label">
            Where
          </label>
          <select id={`tp-${t.id}`} className="field h-9" value={t.position} onChange={(e) => onChange((x) => ({ ...x, position: e.target.value as EdlText["position"] }))}>
            <option value="top">Top</option>
            <option value="center">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`tst-${t.id}`} className="label">
            Style
          </label>
          <select id={`tst-${t.id}`} className="field h-9" value={t.style} onChange={(e) => onChange((x) => ({ ...x, style: e.target.value as EdlText["style"] }))}>
            <option value="poster">Poster</option>
            <option value="banner">Banner</option>
            <option value="caption">Caption</option>
          </select>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={playhead === null} onClick={() => playhead !== null && onChange((x) => ({ ...x, startMs: Math.round(Math.min(playhead, x.endMs - 100)) }))}>
          Start here
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5" disabled={playhead === null} onClick={() => playhead !== null && onChange((x) => ({ ...x, endMs: Math.round(Math.max(playhead, x.startMs + 100)) }))}>
          End here
        </button>
        <button type="button" className="btn btn-quiet btn-sm px-1.5 text-coral" onClick={onDelete}>
          Remove text
        </button>
      </div>
    </li>
  );
}
