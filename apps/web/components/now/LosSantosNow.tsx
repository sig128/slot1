"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatAge, SOURCE_LABEL_TEXT, type NowResponse, type NowStream } from "@slot1/contracts";
import { useWideEnough } from "@/components/watch/InstantReplay";
import { LivePlayerSwitch } from "@/components/watch/LivePlayerSwitch";
import { TwitchPlayer } from "@/components/watch/TwitchPlayer";
import { useNow } from "@/components/watch/useSessionStream";
import { api } from "@/lib/api";
import { clockTime, compactNumber } from "@/lib/format";
import { RadioWheel, type WheelOption } from "./RadioWheel";

const TIER_TEXT: Record<string, string> = {
  event: "Event SLOT1 saw",
  scene: "Scene SLOT1 recognized",
  mission: "Mission text SLOT1 read",
  none: "",
};

function badge(s: NowStream): string | null {
  if (s.kind === "twitch") return "Twitch only";
  if (s.label === "test") return "Test stream";
  return null;
}

function activityText(s: NowStream): string {
  if (s.kind === "twitch") return "Not analyzed by SLOT1";
  return s.activity?.label ?? "Live";
}

const isTyping = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

/**
 * "Los Santos right now": every public live stream with what SLOT1 saw on it in the last minute.
 * The list is a cheap cached poll (same answer for every viewer), paused while the tab is hidden.
 */
export function LosSantosNow({ initial, embedParents, initialStream }: { initial: NowResponse | null; embedParents: string[]; initialStream: string | null }) {
  const [data, setData] = useState<NowResponse | null>(initial);
  const [error, setError] = useState<string | null>(initial ? null : "Couldn't reach SLOT1");
  const [selected, setSelected] = useState<string | null>(() => initial?.streams.find((s) => s.login.toLowerCase() === initialStream?.toLowerCase())?.broadcasterId ?? initial?.streams[0]?.broadcasterId ?? null);
  const [wheelOpen, setWheelOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const wide = useWideEnough();
  const now = useNow(1000);

  const refresh = useCallback(async () => {
    try {
      const r = await api<NowResponse>("/api/now");
      setData(r);
      setError(null);
    } catch {
      setError("Couldn't reach SLOT1. Showing the last update.");
    }
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const loop = async () => {
      if (document.visibilityState !== "hidden") await refresh();
      if (alive) t = setTimeout(() => void loop(), data?.refreshMs ?? 5000);
    };
    t = setTimeout(() => void loop(), data?.refreshMs ?? 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (t) clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, data?.refreshMs]);

  const streams = data?.streams ?? [];
  const current = streams.find((s) => s.broadcasterId === selected) ?? streams[0] ?? null;

  const choose = useCallback(
    (id: string) => {
      setSelected(id);
      const s = data?.streams.find((x) => x.broadcasterId === id);
      if (s) {
        const url = new URL(window.location.href);
        url.searchParams.set("stream", s.login);
        window.history.replaceState(null, "", url);
      }
    },
    [data],
  );

  // Q opens the selector (like holding the radio key in a game).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "q" && e.key !== "Q") || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || wheelOpen) return;
      if (isTyping(document.activeElement) || streams.length === 0) return;
      e.preventDefault();
      setWheelOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wheelOpen, streams.length]);

  const options: WheelOption[] = streams.map((s) => ({
    id: s.broadcasterId,
    label: s.displayName,
    detail: activityText(s),
    imageUrl: s.thumbnailUrl ?? s.avatarUrl,
    badge: badge(s),
  }));
  const updated = data && now > 0 ? Math.max(0, now - new Date(data.generatedAt).getTime()) : null;

  return (
    <section className="mx-auto max-w-[1600px] px-4 pb-20 pt-8 sm:px-6 lg:px-10" aria-labelledby="ls-title">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 id="ls-title" className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">
            Los Santos right now
          </h1>
          <p className="mt-3 max-w-[64ch] text-ivory-2">Every public stream SLOT1 is watching, and what it actually saw on each one in the last minute. Nothing here is guessed.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="tnum text-[0.8rem] text-ivory-3" aria-live="off">
            {updated === null ? "" : updated < 2000 ? "Updated just now" : `Updated ${formatAge(updated)} ago`}
          </span>
          {streams.length > 0 && (
            <button ref={opener} type="button" className="btn btn-primary" aria-haspopup="dialog" aria-keyshortcuts="Q" onClick={() => setWheelOpen(true)}>
              Choose stream <kbd className="ml-1 rounded-sm border border-graphite/30 px-1.5 font-sans text-[0.75rem]">Q</kbd>
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="status" className="mt-4 text-sm text-coral">
          {error}
        </p>
      )}

      {streams.length === 0 ? (
        <div className="mt-14 max-w-[64ch]" data-now-empty>
          <p className="font-display text-3xl font-bold">Nobody’s live in Los Santos right now</p>
          <p className="mt-2 text-ivory-2">{data?.emptyReason ?? "SLOT1 couldn’t check who’s live."}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/setup" className="btn btn-ghost">
              Send your stream to SLOT1
            </Link>
            <Link href="/" className="btn btn-quiet">
              On Air directory
            </Link>
          </div>
        </div>
      ) : (
        current && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(300px,3fr)]">
            <div className="min-w-0">
              <MainPlayer key={current.broadcasterId} s={current} embedParents={embedParents} />
              <Activity s={current} now={now} />
            </div>
            <aside aria-label="Live streams" className="min-w-0">
              <h2 className="font-display text-[1.05rem] font-semibold tracking-[0.06em] text-ivory-2">
                {streams.length} LIVE {streams.length === 1 ? "STREAM" : "STREAMS"}
              </h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {streams.map((s) => (
                  <li key={s.broadcasterId}>
                    <StreamCard s={s} selected={s.broadcasterId === current.broadcasterId} onSelect={() => choose(s.broadcasterId)} />
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )
      )}

      <RadioWheel
        open={wheelOpen}
        onOpenChange={setWheelOpen}
        options={options}
        value={current?.broadcasterId ?? null}
        onChoose={choose}
        variant={wide ? "wheel" : "strip"}
        returnFocus={opener}
      />
    </section>
  );
}

function MainPlayer({ s, embedParents }: { s: NowStream; embedParents: string[] }) {
  const twitch = s.twitchUrl ? (
    <TwitchPlayer login={s.login} displayName={s.displayName} parents={embedParents} thumbnailUrl={s.thumbnailUrl} twitchUrl={s.twitchUrl} />
  ) : (
    <div className="relative aspect-video w-full overflow-hidden bg-graphite-800">
      {s.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={s.thumbnailUrl} alt={`Latest frame SLOT1 received from ${s.displayName}`} className="h-full w-full object-contain" />
      ) : (
        <span className="grid h-full place-items-center text-sm text-ivory-2">No frame received yet</span>
      )}
      <span className="absolute bottom-2 left-2 bg-graphite/85 px-2 py-0.5 text-[0.75rem] text-ivory-2">Latest frame SLOT1 received, refreshed every few seconds</span>
    </div>
  );
  return (
    <div className="min-w-0" data-now-player={s.kind}>
      {s.kind === "slot1" && s.sessionId ? (
        <LivePlayerSwitch
          sessionId={s.sessionId}
          title={`Live video from ${s.displayName}`}
          twitch={twitch}
          fallback={s.twitchUrl ? undefined : { name: "Latest frame", note: "The latest frame SLOT1 received." }}
        />
      ) : (
        twitch
      )}
    </div>
  );
}

function Activity({ s, now }: { s: NowStream; now: number }) {
  const a = s.activity;
  const age = a?.observedAt && now > 0 ? Math.max(0, now - new Date(a.observedAt).getTime()) : null;
  return (
    <div className="mt-5 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-labelledby="ls-activity">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={s.watchPath} className="font-display text-[1.6rem] font-bold leading-tight hover:text-apricot">
            {s.displayName}
          </Link>
          {s.kind === "twitch" ? <span className="chip chip-muted">Twitch only</span> : <span className="chip chip-live">Live</span>}
          {s.label === "test" && <span className="chip chip-replay">{SOURCE_LABEL_TEXT.test}</span>}
          {s.analysisState === "stale" && <span className="chip chip-stale">Feed stale</span>}
          {s.viewerCount !== null && <span className="tnum text-[0.8rem] text-ivory-3">{compactNumber(s.viewerCount)} watching on Twitch</span>}
        </div>
        {s.title && <p className="mt-1 max-w-[70ch] text-sm text-ivory-2">{s.title}</p>}
        <p className="mt-4 text-[0.78rem] text-ivory-3">{s.kind === "twitch" ? "What SLOT1 sees" : a && a.tier !== "none" ? TIER_TEXT[a.tier] : "What SLOT1 sees"}</p>
        <p id="ls-activity" className="poster-title mt-1 text-[clamp(2rem,4.6vw,3.4rem)] leading-[0.92]" aria-live="polite" data-activity={a?.key ?? "none"}>
          {activityText(s)}
        </p>
        <p className="mt-2 max-w-[60ch] text-sm text-ivory-2">
          {s.kind === "twitch"
            ? "This channel streams to Twitch only, so SLOT1 can’t see its gameplay. You’re watching Twitch’s own player."
            : a?.tier === "none"
              ? (a.detail ?? "Nothing SLOT1 could name in the last minute")
              : `${a?.detail ?? ""}${age !== null ? ` · seen ${age < 2000 ? "just now" : `${formatAge(age)} ago`}` : ""}`}
        </p>
        <Link href={s.watchPath} className="btn btn-ghost btn-sm mt-4">
          {s.kind === "twitch" ? "Watch page" : "Full AI log"}
        </Link>
      </section>
      {s.kind === "slot1" && (
        <section aria-labelledby="ls-recent">
          <h2 id="ls-recent" className="font-display text-[1.05rem] font-semibold tracking-[0.06em] text-ivory-2">
            RECENT AI ENTRIES
          </h2>
          {s.recent.length === 0 ? (
            <p className="mt-2 text-sm text-ivory-3">Nothing logged in the last 15 minutes.</p>
          ) : (
            <ol className="mt-2 divide-y divide-line border-y hairline">
              {s.recent.map((r) => (
                <li key={r.id}>
                  <Link href={`/m/${r.id}`} className="grid grid-cols-[3.4rem_1fr] gap-3 py-2 text-sm hover:bg-graphite-800" aria-label={`${r.description}, at ${clockTime(r.receivedAt)}. Open this moment`}>
                    <span className="tnum text-apricot" suppressHydrationWarning>
                      {clockTime(r.receivedAt)}
                    </span>
                    <span className="min-w-0 break-words">{r.description}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function StreamCard({ s, selected, onSelect }: { s: NowStream; selected: boolean; onSelect: () => void }) {
  const img = s.thumbnailUrl ?? s.avatarUrl;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`grid w-full grid-cols-[6.5rem_1fr] items-center gap-3 border p-2 text-left transition-colors ${selected ? "border-apricot bg-graphite-800" : "hairline hover:bg-graphite-800"}`}
    >
      <span className="relative block aspect-video overflow-hidden bg-graphite-700">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center font-display text-lg font-bold">{s.displayName.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-display text-[1.1rem] font-bold">{s.displayName}</span>
          {badge(s) && <span className="shrink-0 text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-apricot">{badge(s)}</span>}
        </span>
        <span className={`block truncate text-[0.82rem] ${s.kind === "twitch" ? "text-ivory-3" : "text-ivory"}`}>{activityText(s)}</span>
        {s.category && <span className="block truncate text-[0.75rem] text-ivory-3">{s.category}</span>}
      </span>
    </button>
  );
}
