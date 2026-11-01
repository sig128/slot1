"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ASPECT_SIZE, type Edl } from "@slot1/contracts";
import { editTime } from "@/lib/clipper";
import { CaptionsPanel } from "../editor/panels";
import { SegmentsPanel } from "../editor/Inspector";
import { ExportPanel } from "../editor/ExportPanel";
import type { LibraryItemView } from "@slot1/contracts";

type PhoneTab = "trim" | "captions" | "export";

/**
 * The editor on small screens: watch, trim, captions and export. Everything else waits for a
 * screen at least 1024 px wide, where the full editor opens.
 */
export function PhoneEditor({
  title,
  onTitle,
  saveLabel,
  edl,
  total,
  viewer,
  playing,
  onTogglePlay,
  outPos,
  onSeek,
  renders,
  onRenders,
  undo,
  redo,
}: {
  title: string;
  onTitle: (t: string) => void;
  saveLabel: string;
  edl: Edl;
  total: number;
  viewer: ReactNode;
  playing: boolean;
  onTogglePlay: () => void;
  outPos: number;
  onSeek: (ms: number) => void;
  renders: LibraryItemView[];
  onRenders: (fn: (r: LibraryItemView[]) => LibraryItemView[]) => void;
  undo: { can: boolean; run: () => void };
  redo: { can: boolean; run: () => void };
}) {
  const [tab, setTab] = useState<PhoneTab>("trim");
  return (
    <div className="nle-phone" data-nle>
      <header className="nle-bar">
        <Link href="/studio#library" className="nle-back" aria-label="Back to Studio">
          ←
        </Link>
        <label htmlFor="edit-title" className="sr-only">
          Title
        </label>
        <input id="edit-title" className="nle-title" value={title} maxLength={120} onChange={(e) => onTitle(e.target.value)} />
        <span className="nle-save" aria-live="polite">
          {saveLabel}
        </span>
      </header>
      <p className="nle-phone-note">The full editor (tracks, timelines, effects) opens on screens at least 1024 px wide. Here you can watch, trim, caption and export.</p>
      <div className="nle-phone-viewer">{viewer}</div>
      <div className="nle-phone-transport">
        <button type="button" className="nle-btn nle-btn-gold" onClick={onTogglePlay}>
          {playing ? "Pause" : "Play"}
        </button>
        <label htmlFor="phone-scrub" className="sr-only">
          Position in the edit
        </label>
        <input id="phone-scrub" type="range" min={0} max={Math.max(1, total)} step={33} value={Math.min(outPos, total)} onChange={(e) => onSeek(Number(e.target.value))} />
        <span className="tnum">{editTime(outPos)}</span>
        <button type="button" className="nle-btn" disabled={!undo.can} onClick={undo.run}>
          Undo
        </button>
        <button type="button" className="nle-btn" disabled={!redo.can} onClick={redo.run}>
          Redo
        </button>
      </div>
      <p className="nle-phone-shape tnum">
        {ASPECT_SIZE[edl.aspect].label}, {editTime(total)}
      </p>
      <div role="tablist" aria-label="Editor panels" className="nle-tabs">
        {(
          [
            ["trim", "Trim"],
            ["captions", "Captions"],
            ["export", "Export"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} id={`ptab-${id}`} aria-controls={`ppanel-${id}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ppanel-${tab}`} aria-labelledby={`ptab-${tab}`} className="nle-phone-body nle-panels">
        {tab === "trim" && <SegmentsPanel />}
        {tab === "captions" && <CaptionsPanel />}
        {tab === "export" && <ExportPanel renders={renders} onRenders={onRenders} />}
      </div>
    </div>
  );
}
