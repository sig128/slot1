"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ASPECT_SIZE, type Edl, type MediaRef, type ProjectSourceView } from "@slot1/contracts";
import { PreviewStage, type MediaInfo, type PreviewHandle } from "../editor/PreviewStage";
import { timecode } from "./util";

export type MonitorMode = "source" | "program";
export interface Guides {
  safe: boolean;
  aspect: "none" | "9:16" | "16:9" | "1:1";
}

interface Props {
  preview: RefObject<PreviewHandle | null>;
  edl: Edl;
  total: number;
  fps: number;
  mode: MonitorMode;
  sources: ProjectSourceView[];
  srcSession: string;
  media: (ref: MediaRef) => MediaInfo | null;
  title: string;
  quality: "full" | "half";
  onQuality: (q: "full" | "half") => void;
  guides: Guides;
  onGuides: (g: Guides) => void;
  playing: boolean;
  rate: number;
  outPos: number;
  srcPos: number;
  srcDuration: number;
  onTime: (mode: MonitorMode, ms: number) => void;
  onPlayingChange: (p: boolean) => void;
  onDims: (sessionId: string, d: { width: number; height: number; durationMs: number }) => void;
  onMode: (m: MonitorMode) => void;
  onTogglePlay: () => void;
  onStep: (frames: number) => void;
  onJump: (to: "start" | "end") => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  markInLabel: string;
  markOutLabel: string;
  /** Under the picture in Source mode: the source scrubber and AI moments. */
  sourcePanel?: ReactNode;
  sourceNote?: string;
  approx: boolean;
}

const ratio = (a: Edl["aspect"]) => ASPECT_SIZE[a].width / ASPECT_SIZE[a].height;
const GUIDE_RATIO: Record<Exclude<Guides["aspect"], "none">, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };

/** The viewer: plays the source video or the finished edit, with transport, guides and fullscreen. */
export function Monitor(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const [frame, setFrame] = useState({ w: 320, h: 180 });
  const [full, setFull] = useState(false);
  const r = ratio(p.edl.aspect);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const bw = el.clientWidth - 8;
      const bh = el.clientHeight - 8;
      const w = Math.max(80, Math.min(bw, bh * r));
      setFrame({ w: Math.floor(w), h: Math.floor(w / r) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [r]);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const src = p.sources.find((s) => s.sessionId === p.srcSession);
  const guide = p.guides.aspect !== "none" && p.mode === "program" ? GUIDE_RATIO[p.guides.aspect] : null;
  const gw = guide ? (guide > r ? 1 : guide / r) : 1;
  const gh = guide ? (guide > r ? r / guide : 1) : 1;

  return (
    <section ref={root} aria-label="Viewer" className={`nle-monitor${full ? " is-full" : ""}`}>
      <div className="nle-mon-head">
        <div role="radiogroup" aria-label="What plays" className="nle-seg">
          {(
            [
              ["source", "Source"],
              ["program", "Program"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={p.mode === m} onClick={() => p.onMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <span className="nle-mon-title">{p.mode === "source" ? (src?.title ?? "Source") : p.title}</span>
        <span className="nle-mon-shape tnum">
          {ASPECT_SIZE[p.edl.aspect].label}, {timecode(p.total, p.fps)}
        </span>
      </div>
      <div ref={box} className="nle-mon-box">
        <div className="nle-mon-frame" style={{ width: frame.w, height: frame.h }}>
          <PreviewStage
            ref={p.preview}
            edl={p.edl}
            total={p.total}
            mode={p.mode}
            sources={p.sources}
            sourceSession={p.srcSession}
            media={p.media}
            title={p.title}
            quality={p.quality}
            onTime={p.onTime}
            onPlayingChange={p.onPlayingChange}
            onDims={p.onDims}
          />
          {p.mode === "source" && <span className="nle-mon-tag">Source</span>}
          {p.mode === "source" && !src?.playbackUrl && <p className="nle-mon-missing">This video is no longer stored.</p>}
          {p.guides.safe && (
            <>
              <span aria-hidden className="nle-safe nle-safe-action" />
              <span aria-hidden className="nle-safe nle-safe-title" />
            </>
          )}
          {guide && <span aria-hidden className="nle-guide" style={{ width: `${gw * 100}%`, height: `${gh * 100}%` }} />}
        </div>
      </div>
      {p.mode === "program" && p.approx && <p className="nle-mon-note">The preview approximates the final render: colour grades, transitions, ducking and loudness are exact only in the render.</p>}
      {p.mode === "source" && p.sourceNote && <p className="nle-mon-note">{p.sourceNote}</p>}
      <div className="nle-transport">
        <button type="button" className="nle-ico" onClick={() => p.onJump("start")} aria-label="Go to start" aria-keyshortcuts="Home">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 5h2v14H6zM20 5v14l-10-7z" />
          </svg>
        </button>
        <button type="button" className="nle-ico" onClick={() => p.onStep(-1)} aria-label="One frame back" aria-keyshortcuts="ArrowLeft">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M15 5v14l-9-7zM17 5h2v14h-2z" />
          </svg>
        </button>
        <button type="button" className="nle-ico nle-play" onClick={p.onTogglePlay} aria-label={p.playing ? "Pause" : "Play"} aria-keyshortcuts="Space">
          <svg viewBox="0 0 24 24" aria-hidden>
            {p.playing ? <path d="M6 5h4v14H6zM14 5h4v14h-4z" /> : <path d="M7 4v16l13-8z" />}
          </svg>
        </button>
        <button type="button" className="nle-ico" onClick={() => p.onStep(1)} aria-label="One frame forward" aria-keyshortcuts="ArrowRight">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M9 5v14l9-7zM5 5h2v14H5z" />
          </svg>
        </button>
        <button type="button" className="nle-ico" onClick={() => p.onJump("end")} aria-label="Go to end" aria-keyshortcuts="End">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M16 5h2v14h-2zM4 5v14l10-7z" />
          </svg>
        </button>
        <span className="nle-tc tnum" aria-live="off">
          <b>{timecode(p.mode === "program" ? p.outPos : p.srcPos, p.fps)}</b>
          <span> / {timecode(p.mode === "program" ? p.total : p.srcDuration, p.fps)}</span>
          {p.rate !== 1 && p.playing && <em> {p.rate}×</em>}
        </span>
        <span className="nle-transport-gap" />
        <button type="button" className="nle-btn" onClick={p.onMarkIn} aria-keyshortcuts="I" title={p.markInLabel}>
          In
        </button>
        <button type="button" className="nle-btn" onClick={p.onMarkOut} aria-keyshortcuts="O" title={p.markOutLabel}>
          Out
        </button>
        <button type="button" className="nle-btn" aria-pressed={p.guides.safe} onClick={() => p.onGuides({ ...p.guides, safe: !p.guides.safe })} title="Action and title safe areas">
          Safe
        </button>
        <label className="sr-only" htmlFor="mon-guide">
          Shape guide
        </label>
        <select id="mon-guide" className="nle-select" value={p.guides.aspect} onChange={(e) => p.onGuides({ ...p.guides, aspect: e.target.value as Guides["aspect"] })} title="Show another shape's crop over the picture">
          <option value="none">No guide</option>
          <option value="9:16">9:16 guide</option>
          <option value="16:9">16:9 guide</option>
          <option value="1:1">1:1 guide</option>
        </select>
        <button type="button" className="nle-btn" aria-pressed={p.quality === "half"} onClick={() => p.onQuality(p.quality === "full" ? "half" : "full")} title="Preview resolution (the render is always full quality)">
          {p.quality === "full" ? "Full" : "Half"}
        </button>
        <button
          type="button"
          className="nle-ico"
          aria-label={full ? "Exit fullscreen" : "Fullscreen viewer"}
          aria-pressed={full}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
            else void root.current?.requestFullscreen?.().catch(() => undefined);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z" />
          </svg>
        </button>
      </div>
      {p.mode === "source" && p.sourcePanel}
    </section>
  );
}
