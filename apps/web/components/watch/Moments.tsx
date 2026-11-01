"use client";

import { formatMediaTime, type Observation } from "@slot1/contracts";

/** On-screen result messages that deserve an in-game-style banner, read by OCR or the GTA model. */
const BIG = /\b(MISSION PASSED|MISSION FAILED|WASTED|BUSTED|MISSION COMPLETE)\b/i;
const BAD = /FAILED|WASTED|BUSTED/i;

export function bigMoment(o: Observation): { text: string; tone: "good" | "bad" } | null {
  const source = o.rawText ?? (o.type === "result_screen" ? o.description : null);
  const m = source?.match(BIG);
  if (!m) return null;
  const text = m[1]!.toUpperCase();
  return { text, tone: BAD.test(text) ? "bad" : "good" };
}

/**
 * The banner shown when SLOT1 actually read a result message on screen. In replays it follows the
 * playhead; in live sessions it shows for a few seconds after the observation arrives. It never
 * covers Twitch's player: the caller places it over SLOT1-owned video or SLOT1's own UI only.
 */
export function MomentBanner({
  items,
  mode,
  positionMs,
  freshIds,
  now,
  className = "",
  onReplay,
}: {
  items: Observation[];
  mode: "live" | "replay";
  positionMs: number | null;
  freshIds: Set<string>;
  now: number;
  className?: string;
  /** Live only: open an instant replay of the moment on the banner. */
  onReplay?: (o: Observation, trigger: HTMLElement) => void;
}) {
  let hit: { o: Observation; text: string; tone: "good" | "bad" } | null = null;
  for (const o of items) {
    const b = bigMoment(o);
    if (!b) continue;
    const showing =
      mode === "replay"
        ? positionMs !== null && o.mediaStartMs !== null && positionMs >= o.mediaStartMs && positionMs <= o.mediaStartMs + 3500
        : freshIds.has(o.id) && now > 0 && now - new Date(o.receivedAt).getTime() < 6000;
    if (showing && (!hit || (o.mediaStartMs ?? 0) >= (hit.o.mediaStartMs ?? 0))) hit = { o, ...b };
  }
  const moment = hit?.o ?? null;
  return (
    <div role="status" aria-live="polite" className={`pointer-events-none ${className}`}>
      {hit && (
        <div key={hit.o.id} className="moment-banner-in flex flex-col items-center px-4 text-center">
          <span data-tone={hit.tone} className="moment-banner-title text-[clamp(2.4rem,7vw,5.5rem)]">
            {hit.text}
          </span>
          <span className="mt-2 bg-graphite-900/80 px-2 py-0.5 font-display text-[0.95rem] font-semibold tracking-[0.04em] text-ivory">
            {mode === "replay" ? `Read on screen at ${formatMediaTime(hit.o.mediaStartMs)}` : "Read on screen just now"}
          </span>
          {onReplay && hit.o.mediaStartMs !== null && (
            <button type="button" className="btn btn-primary btn-sm pointer-events-auto mt-2" onClick={(e) => moment && onReplay(moment, e.currentTarget)}>
              <span aria-hidden>↺</span> Replay {hit.text.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const WEIGHTS: Partial<Record<Observation["type"], number>> = {
  result_screen: 3,
  possible_collision: 3,
  combat: 2,
  mission_title: 2,
  reaction: 1,
  siren: 1,
  vehicle_enter_exit: 1,
  objective_text: 1,
};

/**
 * Action level: how much SLOT1 has seen happen recently, shown as five stars. It is derived only
 * from observations (never the game's own wanted level, which only a HUD reading can provide).
 */
export function actionLevel(items: Observation[], mode: "live" | "replay", positionMs: number | null, now: number): number | null {
  if (mode === "live" && now === 0) return null;
  const inWindow = (o: Observation) =>
    mode === "live"
      ? now - new Date(o.receivedAt).getTime() <= 5 * 60_000
      : positionMs !== null && o.mediaStartMs !== null && o.mediaStartMs <= positionMs && o.mediaStartMs >= positionMs - 150_000;
  let score = 0;
  for (const o of items) {
    if (o.origin === "twitch" || !inWindow(o)) continue;
    score += bigMoment(o) ? 3 : (WEIGHTS[o.type] ?? 0);
  }
  return Math.min(5, Math.round(score / 3));
}

export function ActionStars({ level }: { level: number | null }) {
  if (level === null) return null;
  const label = `Action level ${level} of 5, from events SLOT1 observed in the last few minutes. Not the game's wanted level.`;
  return (
    <div className="flex items-center gap-2" title={label}>
      <span className="text-[0.78rem] text-ivory-3">Action</span>
      <span className="flex gap-0.5" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <svg key={i} viewBox="0 0 24 24" className="h-[18px] w-[18px]">
            <path
              d="M12 2.6l2.8 6.2 6.7.6-5.1 4.4 1.5 6.6L12 17l-5.9 3.4 1.5-6.6-5.1-4.4 6.7-.6z"
              fill={i < level ? "var(--color-gold)" : "none"}
              stroke={i < level ? "var(--color-graphite-900)" : "var(--color-ivory-3)"}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        ))}
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
