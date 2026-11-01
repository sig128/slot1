"use client";

import { useEffect, useMemo, useState } from "react";
import type { EditorSourcesResponse, EditorSourceView, ProjectSourceView, StudioAsset } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { editTime } from "@/lib/clipper";
import { AssetLibraryPanel } from "../library/AssetLibraryPanel";
import { UploadsPanel } from "../editor/panels";
import { SOURCE_DRAG_TYPE } from "./util";

type BinTab = "project" | "recordings" | "library" | "uploads";
const TABS: [BinTab, string][] = [
  ["project", "Project"],
  ["recordings", "Recordings"],
  ["library", "Library"],
  ["uploads", "Uploads"],
];

interface Props {
  projectSources: ProjectSourceView[];
  /** Sessions used on the timeline being edited. */
  inEdit: Set<string>;
  onOpen: (s: ProjectSourceView) => void;
  onInsert: (s: ProjectSourceView) => void;
  dragRange: (s: ProjectSourceView) => { inMs: number; outMs: number };
  onPickAsset: (a: StudioAsset) => void;
  libraryAvailable: boolean;
  /** A video is being dragged out of the bin (so the editor can load it before the drop). */
  onDragSource: (s: ProjectSourceView) => void;
}

/** Everything the edit can use: its own videos, the creator's other recordings, the Studio library and uploads. */
export function MediaBin(p: Props) {
  const [tab, setTab] = useState<BinTab>("project");
  const [q, setQ] = useState("");
  const [all, setAll] = useState<EditorSourceView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "recordings" || all) return;
    api<EditorSourcesResponse>("/api/editor/sources")
      .then((r) => setAll(r.sources))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Couldn't load your recordings"));
  }, [tab, all]);

  const match = (s: { title: string }) => !q.trim() || s.title.toLowerCase().includes(q.trim().toLowerCase());
  const list = useMemo(() => (tab === "project" ? p.projectSources : (all ?? [])).filter(match), [tab, p.projectSources, all, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = (s: ProjectSourceView | EditorSourceView) => {
    const range = p.dragRange(s);
    return (
      <li key={s.sessionId}>
        <div
          className="nle-bin-item"
          draggable={Boolean(s.playbackUrl)}
          tabIndex={0}
          role="button"
          aria-label={`${s.title}, ${editTime(s.durationMs)}. Enter opens it in the Source monitor`}
          onDragStart={(e) => {
            p.onDragSource(s);
            e.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify({ sessionId: s.sessionId, ...range }));
            e.dataTransfer.setData("text/plain", s.title);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onDoubleClick={() => p.onOpen(s)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              p.onOpen(s);
            }
          }}
        >
          <span className="nle-bin-thumb">
            {s.posterUrl ? (
              // Signed storage URLs: a plain img keeps them out of the image optimizer.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.posterUrl} alt="" loading="lazy" />
            ) : (
              <span className="nle-bin-noposter" aria-hidden>
                REC
              </span>
            )}
            <span className="nle-bin-dur tnum">{editTime(s.durationMs)}</span>
          </span>
          <span className="nle-bin-meta">
            <span className="nle-bin-title">{s.title}</span>
            <span className="nle-bin-sub">
              {"kind" in s ? (s.kind === "upload" ? "Upload" : "Recording") : "In this project"}
              {p.inEdit.has(s.sessionId) ? " · on this timeline" : ""}
              {!s.playbackUrl ? " · no longer stored" : ""}
            </span>
          </span>
        </div>
        <div className="nle-bin-actions">
          <button type="button" className="nle-btn" disabled={!s.playbackUrl} onClick={() => p.onOpen(s)}>
            Source
          </button>
          <button type="button" className="nle-btn" disabled={!s.playbackUrl} onClick={() => p.onInsert(s)} title="Insert at the playhead on V1 (,)">
            Insert
          </button>
        </div>
      </li>
    );
  };

  return (
    <section aria-label="Media" className="nle-bin">
      <div role="tablist" aria-label="Media bin" className="nle-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`bin-${id}`} aria-selected={tab === id} aria-controls={`binp-${id}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`binp-${tab}`} aria-labelledby={`bin-${tab}`} className="nle-bin-body">
        {(tab === "project" || tab === "recordings") && (
          <>
            <label className="sr-only" htmlFor="bin-search">
              Search media
            </label>
            <input id="bin-search" className="nle-input" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            {tab === "recordings" && !all && !err && <p className="nle-empty">Loading your recordings…</p>}
            {err && (
              <p role="alert" className="nle-empty nle-empty-bad">
                {err}
              </p>
            )}
            {list.length > 0 ? (
              <ul className="nle-bin-list">{list.map(item)}</ul>
            ) : (
              (tab === "project" || all) && (
                <div className="nle-empty nle-empty-card">
                  <b>{q ? "Nothing matches" : tab === "project" ? "No videos yet" : "No stored recordings"}</b>
                  <span>{tab === "project" ? "Open Recordings to bring in another video." : "Upload a recording in Studio, or turn on Recording for live streams."}</span>
                </div>
              )
            )}
            <p className="nle-bin-hint">Drag onto the timeline, or open in the Source monitor and press I and O first.</p>
          </>
        )}
        {tab === "library" && (
          <>
            <AssetLibraryPanel onPick={p.onPickAsset} />
            <p className="nle-bin-hint">Click to add at the playhead, or drag onto a track.</p>
            {!p.libraryAvailable && <p className="nle-empty">The sound and element library isn&apos;t available right now.</p>}
          </>
        )}
        {tab === "uploads" && <UploadsPanel />}
      </div>
    </section>
  );
}
