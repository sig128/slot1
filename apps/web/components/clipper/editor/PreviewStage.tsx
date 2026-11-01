"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import {
  ASPECT_SIZE,
  edlLocate,
  edlOutputTime,
  interpolateKeys,
  segmentStartsMs,
  speedAt,
  type Edl,
  type MediaRef,
  type ProjectSourceView,
} from "@slot1/contracts";
import { drawFrame, makeNoise, type FrameSource } from "./compositor";

export interface MediaInfo {
  url: string;
  kind: "image" | "video" | "audio";
  name: string;
}

export interface PreviewHandle {
  play: (rate?: number) => void;
  pause: () => void;
  seekProgram: (ms: number) => void;
  seekSource: (sessionId: string, ms: number) => void;
  isPlaying: () => boolean;
  /** The source video element for a session (for frame grabs). */
  video: (sessionId: string) => HTMLVideoElement | null;
}

interface Props {
  ref?: Ref<PreviewHandle>;
  edl: Edl;
  total: number;
  mode: "program" | "source";
  sources: ProjectSourceView[];
  sourceSession: string;
  media: (ref: MediaRef) => MediaInfo | null;
  title: string;
  /** Throttled position updates while playing, and after seeks. */
  onTime: (mode: "program" | "source", ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onDims: (sessionId: string, d: { width: number; height: number; durationMs: number }) => void;
}

const PREVIEW_LONG_SIDE = 960;

function frameOf(el: HTMLVideoElement | HTMLImageElement | null | undefined): FrameSource | null {
  if (!el) return null;
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth ? { src: el, w: el.videoWidth, h: el.videoHeight } : null;
  return el.complete && el.naturalWidth ? { src: el, w: el.naturalWidth, h: el.naturalHeight } : null;
}

/**
 * The preview: hidden media elements feed a canvas compositor. In edit mode it plays the
 * finished edit (segments in order, speed ramps, overlays, captions, effects, audio clips); in
 * source mode it plays the raw recording for picking in and out points.
 */
export function PreviewStage({ ref, edl, total, mode, sources, sourceSession, media, title, onTime, onPlayingChange, onDims }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const pipEls = useRef(new Map<string, HTMLVideoElement>());
  const imgEls = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const noise = useRef<HTMLCanvasElement | null>(null);
  const frozen = useRef<{ id: string; frame: FrameSource } | null>(null);
  const st = useRef({ playing: false, out: 0, src: 0, seg: 0, rate: 1, lastReport: 0, jitter: 0, pending: new Map<string, number>() });
  const props = useRef({ edl, total, mode, sourceSession, media, onTime, onPlayingChange });
  useEffect(() => {
    props.current = { edl, total, mode, sourceSession, media, onTime, onPlayingChange };
  });

  const size = ASPECT_SIZE[edl.aspect];
  const scale = PREVIEW_LONG_SIDE / Math.max(size.width, size.height);
  const W = Math.round(size.width * scale);
  const H = Math.round(size.height * scale);
  const sessionIds = useMemo(() => {
    const ids = [...new Set([...edl.segments.map((s) => s.sessionId), sourceSession])];
    return ids.filter((id) => sources.some((s) => s.sessionId === id && s.playbackUrl));
  }, [edl.segments, sourceSession, sources]);
  const pips = useMemo(() => edl.overlays.flatMap((t) => (t.hidden ? [] : t.items.filter((x) => x.type === "pip"))), [edl.overlays]);
  const audible = useMemo(() => {
    const anySolo = edl.sourceAudio.solo || edl.audioTracks.some((t) => t.solo);
    return edl.audioTracks.flatMap((t) => (t.muted || (anySolo && !t.solo) ? [] : t.clips.map((c) => ({ c, t }))));
  }, [edl.audioTracks, edl.sourceAudio.solo]);
  const images = useMemo(() => {
    const out = new Map<string, MediaInfo>();
    for (const t of edl.overlays) for (const it of t.items) if (it.type === "image") {
      const m = media(it.source);
      if (m) out.set(m.url, m);
    }
    return [...out.values()];
  }, [edl.overlays, media]);

  const draw = useCallback(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const { edl: e, total: tot, mode: m, sourceSession: ss, media: mf } = props.current;
    const s = st.current;
    if (m === "source") {
      const v = videos.current.get(ss);
      g.fillStyle = "#000";
      g.fillRect(0, 0, c.width, c.height);
      const f = frameOf(v);
      if (f) {
        const k = Math.min(c.width / f.w, c.height / f.h);
        g.drawImage(f.src, (c.width - f.w * k) / 2, (c.height - f.h * k) / 2, f.w * k, f.h * k);
      }
      return;
    }
    const seg = e.segments[s.seg] ?? e.segments[0]!;
    const main = frameOf(videos.current.get(seg.sessionId));
    const w = e.effects.find((f) => f.kind === "wasted" && s.out >= f.startMs && s.out < f.endMs);
    if (!w) frozen.current = null;
    else if (frozen.current?.id !== w.id && main && s.playing) {
      // Hold the frame where the WASTED starts (the render freezes the same way).
      const fc = document.createElement("canvas");
      const k = Math.min(1, 1280 / main.w);
      fc.width = Math.round(main.w * k);
      fc.height = Math.round(main.h * k);
      fc.getContext("2d")?.drawImage(main.src, 0, 0, fc.width, fc.height);
      frozen.current = { id: w.id, frame: { src: fc, w: fc.width, h: fc.height } };
    }
    if (!noise.current && e.grade.grain > 0) noise.current = makeNoise();
    drawFrame(g, c.width, c.height, {
      edl: e,
      t: s.out,
      total: tot,
      main,
      frozen: frozen.current?.frame ?? null,
      pip: (id) => frameOf(pipEls.current.get(id)),
      image: (r) => {
        const info = mf(r);
        return info ? frameOf(imgEls.current.get(info.url)) : null;
      },
      noise: noise.current,
      jitter: s.jitter,
    });
  }, []);

  const raf = useRef(0);
  const requestDraw = useCallback(() => {
    if (st.current.playing || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  }, [draw]);

  /* ------------------------------------- media sync ---------------------------------------- */

  const syncSide = useCallback((out: number, playing: boolean) => {
    const e = props.current.edl;
    for (const it of e.overlays.flatMap((t) => (t.hidden ? [] : t.items))) {
      if (it.type !== "pip") continue;
      const el = pipEls.current.get(it.id);
      if (!el || el.readyState < 1) continue;
      const inside = out >= it.startMs && out < it.endMs;
      const want = (it.sourceInMs + Math.max(0, out - it.startMs)) / 1000;
      if (!inside) {
        if (!el.paused) el.pause();
        continue;
      }
      if (playing) {
        if (el.paused) void el.play().catch(() => undefined);
        if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
      } else if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want;
    }
    const anySolo = e.sourceAudio.solo || e.audioTracks.some((t) => t.solo);
    for (const tr of e.audioTracks) {
      const heard = !tr.muted && (!anySolo || tr.solo);
      for (const c of tr.clips) {
        const el = audioEls.current.get(c.id);
        if (!el) continue;
        const inside = heard && playing && out >= c.startMs && out < c.startMs + c.durationMs;
        if (!inside) {
          if (!el.paused) el.pause();
          continue;
        }
        let want = (out - c.startMs + c.offsetMs) / 1000;
        if (c.loop && el.duration > 0) want %= el.duration;
        if (el.paused) {
          el.currentTime = want;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        const local = out - c.startMs;
        const fade = Math.min(c.fadeInMs > 0 ? local / c.fadeInMs : 1, c.fadeOutMs > 0 ? (c.durationMs - local) / c.fadeOutMs : 1, 1);
        const env = c.envelope.length ? interpolateKeys(c.envelope, out, (k) => k.volume) : 1;
        el.volume = Math.max(0, Math.min(1, tr.volume * c.volume * fade * env));
      }
    }
    // Source audio level for the main picture.
    const seg = e.segments[st.current.seg];
    const v = seg ? videos.current.get(seg.sessionId) : null;
    if (v) {
      const env = e.sourceAudio.envelope.length ? interpolateKeys(e.sourceAudio.envelope, out, (k) => k.volume) : 1;
      v.muted = e.sourceAudio.muted || (anySolo && !e.sourceAudio.solo);
      v.volume = Math.max(0, Math.min(1, e.volume * (seg?.volume ?? 1) * env));
    }
  }, []);

  const pauseAll = useCallback(() => {
    for (const v of videos.current.values()) if (!v.paused) v.pause();
    for (const v of pipEls.current.values()) if (!v.paused) v.pause();
    for (const a of audioEls.current.values()) if (!a.paused) a.pause();
  }, []);

  const report = useCallback((m: "program" | "source", ms: number, force = false) => {
    const now = performance.now();
    if (!force && now - st.current.lastReport < 66) return;
    st.current.lastReport = now;
    props.current.onTime(m, ms);
  }, []);

  const setPlaying = useCallback(
    (p: boolean) => {
      if (st.current.playing === p) return;
      st.current.playing = p;
      props.current.onPlayingChange(p);
      if (!p) {
        pauseAll();
        requestDraw();
      }
    },
    [pauseAll, requestDraw],
  );

  /** Show segment `i` at output time `out` (switching videos when the session changes). */
  const enter = useCallback((i: number, out: number, play: boolean) => {
    const e = props.current.edl;
    const s = st.current;
    const prev = e.segments[s.seg];
    s.seg = i;
    s.out = out;
    const seg = e.segments[i]!;
    const { sourceMs } = edlLocate(e, out);
    const v = videos.current.get(seg.sessionId);
    if (prev && prev.sessionId !== seg.sessionId) videos.current.get(prev.sessionId)?.pause();
    if (!v) return;
    if (v.readyState < 1) {
      s.pending.set(seg.sessionId, sourceMs);
      return;
    }
    if (Math.abs(v.currentTime * 1000 - sourceMs) > 30) v.currentTime = sourceMs / 1000;
    v.playbackRate = speedAt(seg, sourceMs);
    if (play) void v.play().catch(() => setPlaying(false));
  }, [setPlaying]);

  const tick = useCallback(() => {
    const s = st.current;
    const { edl: e, total: tot, mode: m, sourceSession: ss } = props.current;
    s.jitter = (s.jitter + 1) % 100_000;
    if (m === "source") {
      const v = videos.current.get(ss);
      if (v) {
        s.src = v.currentTime * 1000;
        report("source", s.src);
        if (v.paused || v.ended) setPlaying(false);
      }
      draw();
      return;
    }
    const seg = e.segments[s.seg];
    const v = seg ? videos.current.get(seg.sessionId) : null;
    if (!seg || !v) return;
    const src = v.currentTime * 1000;
    let out = edlOutputTime(e, s.seg, src);
    const starts = segmentStartsMs(e);
    const nextStart = starts[s.seg + 1];
    if (nextStart !== undefined && (out >= nextStart || src >= seg.outMs - 15)) {
      out = Math.max(out, nextStart);
      enter(s.seg + 1, out, true);
    } else if (src >= seg.outMs - 15 || out >= tot) {
      s.out = tot;
      report("program", tot, true);
      setPlaying(false);
      draw();
      return;
    } else {
      s.out = out;
      const rate = speedAt(seg, src);
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
      if (v.paused && !v.seeking) void v.play().catch(() => setPlaying(false));
    }
    syncSide(s.out, true);
    report("program", s.out);
    draw();
  }, [draw, enter, report, setPlaying, syncSide]);

  useEffect(() => {
    let id = 0;
    const loop = () => {
      if (st.current.playing) tick();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [tick]);

  useImperativeHandle(
    ref,
    (): PreviewHandle => ({
      play: (rate = 1) => {
        const { mode: m, sourceSession: ss, edl: e, total: tot } = props.current;
        if (m === "source") {
          const v = videos.current.get(ss);
          if (!v) return;
          v.playbackRate = rate;
          v.muted = false;
          void v.play().catch(() => setPlaying(false));
          setPlaying(true);
          return;
        }
        const s = st.current;
        const at = s.out >= tot - 40 ? 0 : s.out;
        setPlaying(true);
        enter(edlLocate(e, at).index, at, true);
      },
      pause: () => setPlaying(false),
      seekProgram: (ms) => {
        const { edl: e, total: tot } = props.current;
        const out = Math.max(0, Math.min(tot, Math.round(ms)));
        const wasPlaying = st.current.playing;
        enter(edlLocate(e, out).index, out, wasPlaying);
        syncSide(out, wasPlaying);
        report("program", out, true);
        requestDraw();
      },
      seekSource: (sessionId, ms) => {
        const v = videos.current.get(sessionId);
        st.current.src = ms;
        if (!v || v.readyState < 1) st.current.pending.set(sessionId, ms);
        else v.currentTime = ms / 1000;
        report("source", ms, true);
        requestDraw();
      },
      isPlaying: () => st.current.playing,
      video: (sessionId) => videos.current.get(sessionId) ?? null,
    }),
    [enter, report, requestDraw, setPlaying, syncSide],
  );

  // Redraw on any change to the edit or mode while paused.
  useEffect(() => {
    if (mode === "program") syncSide(st.current.out, st.current.playing);
    requestDraw();
  }, [edl, mode, sourceSession, requestDraw, syncSide]);

  // The preview uses the poster face for titles; draw again once it has loaded.
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    void document.fonts.load('40px "Passion One"').then(() => requestDraw()).catch(() => undefined);
  }, [requestDraw]);

  const sourceOf = (id: string) => sources.find((s) => s.sessionId === id);

  return (
    <>
      <canvas ref={canvas} width={W} height={H} role="img" aria-label={`Preview of ${title}`} className="absolute inset-0 h-full w-full" />
      {/* Media feeding the canvas. Kept in the page (not display:none) so browsers keep decoding frames. */}
      <div aria-hidden className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-hidden opacity-0">
        {sessionIds.map((id) => (
          <video
            key={id}
            ref={(el) => {
              if (el) videos.current.set(id, el);
              else videos.current.delete(id);
            }}
            src={sourceOf(id)?.playbackUrl ?? undefined}
            preload="auto"
            playsInline
            tabIndex={-1}
            onLoadedMetadata={(ev) => {
              const v = ev.currentTarget;
              onDims(id, { width: v.videoWidth, height: v.videoHeight, durationMs: Math.round((v.duration || 0) * 1000) });
              const p = st.current.pending.get(id);
              if (p !== undefined) {
                st.current.pending.delete(id);
                v.currentTime = p / 1000;
              }
            }}
            onSeeked={requestDraw}
            onLoadedData={requestDraw}
            onEnded={() => {
              if (props.current.mode === "source") setPlaying(false);
            }}
          />
        ))}
        {pips.map((it) => (
          <video
            key={it.id}
            ref={(el) => {
              if (el) pipEls.current.set(it.id, el);
              else pipEls.current.delete(it.id);
            }}
            src={sourceOf(it.sessionId)?.playbackUrl ?? undefined}
            preload="auto"
            muted
            playsInline
            tabIndex={-1}
            onSeeked={requestDraw}
            onLoadedData={requestDraw}
          />
        ))}
        {images.map((m) =>
          m.kind === "video" ? (
            <video
              key={m.url}
              ref={(el) => {
                if (el) imgEls.current.set(m.url, el);
                else imgEls.current.delete(m.url);
              }}
              src={m.url}
              muted
              loop
              autoPlay
              playsInline
              tabIndex={-1}
              onLoadedData={requestDraw}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- drawn onto the preview canvas, never shown
            <img
              key={m.url}
              ref={(el) => {
                if (el) imgEls.current.set(m.url, el);
                else imgEls.current.delete(m.url);
              }}
              src={m.url}
              alt=""
              onLoad={requestDraw}
            />
          ),
        )}
        {audible.map(({ c }) => {
          const m = media(c.source);
          return m ? (
            <audio
              key={c.id}
              ref={(el) => {
                if (el) audioEls.current.set(c.id, el);
                else audioEls.current.delete(c.id);
              }}
              src={m.url}
              preload="auto"
              loop={c.loop}
            />
          ) : null;
        })}
      </div>
    </>
  );
}
