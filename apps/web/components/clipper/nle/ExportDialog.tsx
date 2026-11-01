"use client";

import { useRef, useState } from "react";
import type { LibraryItemView } from "@slot1/contracts";
import { ExportPanel } from "../editor/ExportPanel";
import { Dialog } from "./Menu";

const SECTIONS = ["Export", "Thumbnail", "Renders"] as const;

/**
 * Export, styled like a pause menu: section tabs across the top, the project underneath.
 * Holds the presets, the batch export across timelines, thumbnails and the render queue.
 */
export function ExportDialog({ title, renders, onRenders, onClose, busy }: { title: string; renders: LibraryItemView[]; onRenders: (fn: (r: LibraryItemView[]) => LibraryItemView[]) => void; onClose: () => void; busy: number }) {
  const body = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<(typeof SECTIONS)[number]>("Export");
  const go = (s: (typeof SECTIONS)[number]) => {
    setAt(s);
    body.current?.querySelector<HTMLElement>(`section[aria-label="${s}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <Dialog title="Export" onClose={onClose} className="nle-pause">
      <div className="nle-pause-top">
        <span className="nle-pause-kicker">SLOT1 Studio</span>
        <span className="nle-pause-title">{title}</span>
        <button type="button" className="nle-btn" onClick={onClose} autoFocus>
          Back <kbd>Esc</kbd>
        </button>
      </div>
      <nav aria-label="Export sections" className="nle-pause-tabs">
        {SECTIONS.map((s) => (
          <button key={s} type="button" aria-current={at === s ? "true" : undefined} onClick={() => go(s)}>
            {s}
            {s === "Renders" && busy > 0 && <span className="nle-pause-badge">{busy}</span>}
          </button>
        ))}
      </nav>
      <div ref={body} className="nle-pause-body nle-panels">
        <ExportPanel renders={renders} onRenders={onRenders} />
      </div>
    </Dialog>
  );
}
