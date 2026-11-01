"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  EVIDENCE_CLASS_LABEL,
  evidenceClass,
  formatAge,
  formatMediaTime,
  type AnalysisStatus,
  type Observation,
  type SourceRef,
} from "@slot1/contracts";
import { clockTime, clockTimeSeconds } from "@/lib/format";
import { EvidenceGlyph } from "./EvidenceGlyph";
import type { ConnectionState } from "./useSessionStream";

export type RailMode = "live" | "replay";

export function railTime(o: Observation, mode: RailMode, sources: Map<string, SourceRef>): string {
  const src = o.sourceId ? sources.get(o.sourceId) : undefined;
  if (mode === "replay" || src?.kind === "upload") return formatMediaTime(o.mediaStartMs);
  if (src?.kind === "twitch_clip") return `clip ${formatMediaTime(o.mediaStartMs)}`;
  return clockTime(o.receivedAt);
}

const HIDE_IN_RAIL = new Set(["media_facts", "session_coverage"]);

export function railItems(observations: Observation[], mode: RailMode): Observation[] {
  const list = observations.filter((o) => !HIDE_IN_RAIL.has(o.type));
  return list.sort((a, b) =>
    mode === "replay" ? (a.mediaStartMs ?? 0) - (b.mediaStartMs ?? 0) || a.receivedAt.localeCompare(b.receivedAt) : a.receivedAt.localeCompare(b.receivedAt),
  );
}

interface Props {
  mode: RailMode;
  items: Observation[];
  sources: SourceRef[];
  status: AnalysisStatus | null;
  showHeader: boolean;
  connection: ConnectionState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  freshIds: Set<string>;
  now: number;
  emptyState: React.ReactNode;
  /**
   * Per-entry action for entries with a place in the video: an instant replay while live
   * ("Replay"), or a jump in the recording ("Play"). Omitted: no action.
   */
  onReplay?: (o: Observation, trigger: HTMLElement) => void;
  replayAction?: "Replay" | "Play";
  /** One honest line when instant replay is off, instead of a button on every entry. */
  replayNote?: string | null;
}

/**
 * The live editorial log. New observations insert at the bottom; if the viewer has scrolled
 * back, the rail stays put and offers "New observations" instead of yanking them down.
 */
export function EventRail({ mode, items, sources, status, showHeader, connection, selectedId, onSelect, freshIds, now, emptyState, onReplay, replayAction = "Replay", replayNote = null }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const prevCount = useRef(items.length);
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  const stale = status?.state === "stale";

  useLayoutEffect(() => {
    const el = listRef.current;
    const added = items.length - prevCount.current;
    prevCount.current = items.length;
    if (!el || added <= 0) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + added);
  }, [items.length, atBottom]);

  useEffect(() => {
    const el = listRef.current;
    if (el && mode === "live") el.scrollTop = el.scrollHeight;
  }, [mode]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  };

  const jumpToNew = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setUnseen(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLOListElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-rail-item]") ?? [])];
    // An entry's own Replay button counts as that entry.
    const idx = buttons.findIndex((b) => b === document.activeElement || Boolean(b.parentElement?.contains(document.activeElement)));
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(buttons.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next >= 0) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  };

  const lastGameplay = [...items].reverse().find((o) => o.origin !== "twitch");
  const lastAge = lastGameplay && now > 0 ? now - new Date(lastGameplay.receivedAt).getTime() : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showHeader && (
        <dl className="grid grid-cols-3 gap-px border-b hairline text-[0.78rem]">
          <div className="px-4 py-3">
            <dt className="text-ivory-3">Last observed</dt>
            <dd className="tnum mt-0.5 text-ivory" suppressHydrationWarning>
              {lastGameplay ? clockTimeSeconds(lastGameplay.receivedAt) : "—"}
            </dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-ivory-3">Observation age</dt>
            <dd className="tnum mt-0.5 text-ivory">{lastAge === null ? "—" : formatAge(lastAge)}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-ivory-3">Source delay</dt>
            <dd className="tnum mt-0.5 text-ivory" title="Measured delay between receiving a frame and finishing its analysis">
              {status?.measuredDelayMs ? `~${formatAge(status.measuredDelayMs)}` : "—"}
            </dd>
          </div>
        </dl>
      )}
      {stale && (
        <div role="status" className="border-b border-dashed border-line-strong bg-graphite-800 px-4 py-3 text-sm">
          <p className="font-display text-base font-semibold tracking-wide">Feed stale</p>
          <p className="text-ivory-2">{status?.reason ?? "The video source stopped sending frames"}. Nothing new is being analyzed.</p>
        </div>
      )}
      {connection === "polling" && <p className="border-b hairline px-4 py-2 text-[0.78rem] text-ivory-3">Live connection interrupted, checking every 5 seconds.</p>}
      {connection === "closed" && <p className="border-b hairline px-4 py-2 text-[0.78rem] text-coral">Disconnected from SLOT1. Reload to retry.</p>}
      {replayNote && (
        <p className="border-b hairline px-4 py-2 text-[0.78rem] text-ivory-3" data-replay-note>
          {replayNote}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {items.length === 0 ? (
          <div className="p-5">{emptyState}</div>
        ) : (
          <ol
            ref={listRef}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            aria-label="SLOT1 observations"
            className="h-full max-h-[min(70vh,720px)] overflow-y-auto overscroll-contain py-1 lg:max-h-none"
          >
            {items.map((o) => {
              const cls = evidenceClass(o);
              const selected = o.id === selectedId;
              const replayable = Boolean(onReplay) && o.mediaStartMs !== null && o.origin !== "twitch" && o.reviewStatus !== "rejected";
              return (
                <li key={o.id} className={`relative ${freshIds.has(o.id) ? "rail-enter" : ""}`}>
                  <button
                    type="button"
                    data-rail-item
                    aria-pressed={selected}
                    onClick={() => onSelect(o.id)}
                    className={`grid w-full grid-cols-[4.1rem_1fr] gap-3 px-4 py-2.5 text-left transition-colors ${
                      selected ? "select-bar" : "hover:bg-graphite-700"
                    } ${o.reviewStatus === "rejected" ? "opacity-50" : ""}`}
                  >
                    <span className={`tnum pt-[1px] text-[0.82rem] ${selected ? "text-graphite/70" : "text-apricot"}`} suppressHydrationWarning>
                      {railTime(o, mode, srcMap)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[0.93rem] leading-snug">{o.description}</span>
                      <span className={`mt-1 flex items-center gap-1.5 text-[0.74rem] ${selected ? "text-graphite/70" : "text-ivory-3"} ${replayable ? "pr-20" : ""}`}>
                        <EvidenceGlyph cls={cls} />
                        {EVIDENCE_CLASS_LABEL[cls]}
                        {o.reviewStatus === "corrected" && <span>, corrected by creator</span>}
                        {o.reviewStatus === "confirmed" && <span>, confirmed by creator</span>}
                        {o.reviewStatus === "rejected" && <span>, rejected by creator</span>}
                      </span>
                    </span>
                  </button>
                  {replayable && (
                    <button
                      type="button"
                      onClick={(e) => onReplay!(o, e.currentTarget)}
                      aria-label={`${replayAction === "Play" ? `Play from ${formatMediaTime(o.mediaStartMs)}` : "Instant replay"}: ${o.description}`}
                      className={`absolute bottom-2 right-3 z-[1] inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 font-display text-[0.78rem] font-semibold tracking-[0.04em] transition-colors ${
                        selected ? "border-graphite/30 text-graphite hover:bg-graphite/10" : "border-line-strong text-apricot hover:border-apricot"
                      }`}
                    >
                      <span aria-hidden>{replayAction === "Play" ? "▶" : "↺"}</span>
                      {replayAction}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {unseen > 0 && (
          <button type="button" onClick={jumpToNew} className="btn btn-primary btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg shadow-black/40">
            {unseen} new observation{unseen === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </div>
  );
}
