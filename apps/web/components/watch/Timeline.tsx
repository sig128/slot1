"use client";

import { evidenceClass, formatMediaTime, type Coverage, type Observation } from "@slot1/contracts";
import { clockTime } from "@/lib/format";

const TICK: Record<string, string> = {
  visible_text: "bg-ivory",
  visible: "bg-ivory-2",
  inferred: "bg-apricot",
  heard: "bg-ivory-2",
  measured: "bg-ivory-3",
  platform: "bg-coral",
  correction: "bg-apricot",
};

/**
 * Compact session timeline. Replays map events by media time and can seek the replay (we own
 * that media). Live sessions map by arrival time over the last 30 minutes and only select
 * events — they never pretend to rewind the Twitch player.
 */
export function Timeline({
  mode,
  items,
  selectedId,
  onSelect,
  durationMs,
  positionMs,
  onSeek,
  coverage,
  now,
}: {
  mode: "live" | "replay";
  items: Observation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  durationMs: number | null;
  positionMs?: number | null;
  onSeek?: (ms: number) => void;
  coverage?: Coverage | null;
  now: number;
}) {
  const windowMs = 30 * 60_000;
  const start = mode === "live" ? now - windowMs : 0;
  const span = mode === "live" ? windowMs : Math.max(1, durationMs ?? 1);
  const pos = (o: Observation) => {
    const t = mode === "live" ? new Date(o.receivedAt).getTime() : (o.mediaStartMs ?? 0);
    return Math.min(1, Math.max(0, (t - start) / span));
  };
  const visible = items.filter((o) => (mode === "live" ? now > 0 && new Date(o.receivedAt).getTime() >= start : o.mediaStartMs !== null));

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== "replay" || !onSeek || !durationMs) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.round(((e.clientX - r.left) / r.width) * durationMs));
  };

  return (
    <div className="select-none">
      <div className="mb-1.5 flex justify-between text-[0.72rem] text-ivory-3">
        <span className="tnum" suppressHydrationWarning>
          {mode === "live" ? (now > 0 ? clockTime(new Date(start).toISOString()) : "") : "00:00"}
        </span>
        <span>{mode === "live" ? "Last 30 minutes by arrival time" : "Replay timeline"}</span>
        <span className="tnum">{mode === "live" ? "Now" : formatMediaTime(durationMs)}</span>
      </div>
      <div
        className={`relative h-9 border-y hairline ${mode === "replay" && onSeek ? "cursor-pointer" : ""}`}
        onClick={onTrackClick}
        aria-hidden={mode === "replay" ? undefined : true}
      >
        {mode === "replay" &&
          durationMs &&
          coverage?.gaps.map((g, i) => (
            <span
              key={i}
              title={`Not analyzed: ${g.reason}`}
              className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,rgb(244_237_226/0.08)_0_4px,transparent_4px_8px)]"
              style={{ left: `${(g.startMs / durationMs) * 100}%`, width: `${Math.max(0.4, ((g.endMs - g.startMs) / durationMs) * 100)}%` }}
            />
          ))}
        {visible.map((o) => {
          const cls = evidenceClass(o);
          const sel = o.id === selectedId;
          return (
            <button
              key={o.id}
              type="button"
              tabIndex={-1}
              title={o.description}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(o.id);
              }}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 ${sel ? "h-7 w-[3px] bg-ivory" : `h-4 w-[2px] ${TICK[cls]}`} hover:h-6`}
              style={{ left: `${pos(o) * 100}%` }}
            >
              <span className="sr-only">{o.description}</span>
            </button>
          );
        })}
        {mode === "replay" && positionMs !== null && positionMs !== undefined && durationMs ? (
          <span className="pointer-events-none absolute inset-y-[-4px] w-px bg-signal" style={{ left: `${Math.min(100, (positionMs / durationMs) * 100)}%` }} />
        ) : null}
        {mode === "live" && <span className="pointer-events-none absolute inset-y-[-4px] right-0 w-px bg-coral" />}
      </div>
    </div>
  );
}
