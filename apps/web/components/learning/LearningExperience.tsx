"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { LearningResponse, NowResponse } from "@slot1/contracts";
import { AskSLOT1 } from "./AskSLOT1";
import { LiveEyes } from "./LiveEyes";
import { useAsk } from "./useAsk";

const n = (v: number) => v.toLocaleString("en-US");

/** The page's parts, in order, for the sidebar (ids of the sections below). */
const PARTS: { id: string; label: string }[] = [
  { id: "ask", label: "Ask SLOT1" },
  { id: "missions", label: "Missions" },
  { id: "causes", label: "What leads to it" },
  { id: "sorted", label: "Everything sorted" },
  { id: "places", label: "Places on the map" },
  { id: "eyes", label: "Its eyes right now" },
  { id: "how", label: "How it learns" },
];

/**
 * The Learning page as an app: a sidebar with the conversation and everything SLOT1 knows, and a
 * main column that opens on its globe and the question box, then the knowledge itself. Polls
 * "Right now" every few seconds and the learning totals every 30 s, while the page is visible.
 */
export function LearningExperience({
  initialLearning,
  initialNow,
  knowledge,
  footer,
}: {
  initialLearning: LearningResponse | null;
  initialNow: NowResponse | null;
  knowledge: ReactNode;
  footer: ReactNode;
}) {
  const [learning, setLearning] = useState(initialLearning);
  const [now, setNow] = useState(initialNow);
  const [clock, setClock] = useState(() => Date.now());
  const [active, setActive] = useState("ask");
  const chat = useAsk();

  useEffect(() => {
    let stop = false;
    const poll = async (path: string, set: (v: never) => void) => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(path, { cache: "no-store" });
        if (r.ok && !stop) set((await r.json()) as never);
      } catch {
        // Keep what we have; the next poll tries again.
      }
    };
    const fast = setInterval(() => {
      void poll("/api/now", setNow as (v: never) => void);
      setClock(Date.now());
    }, initialNow?.refreshMs ?? 5000);
    const slow = setInterval(() => void poll("/api/learning", setLearning as (v: never) => void), 30_000);
    return () => {
      stop = true;
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [initialNow?.refreshMs]);

  // The part of the page in view, lit in the sidebar.
  useEffect(() => {
    const els = PARTS.map((p) => document.getElementById(p.id)).filter((e): e is HTMLElement => Boolean(e));
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const live = (now?.streams ?? []).filter((s) => s.kind === "slot1" && s.activity).length;
  const counts: Record<string, string | null> = learning
    ? {
        missions: learning.missions.length ? n(learning.missions.length) : null,
        sorted: `${learning.activities.filter((a) => a.seen > 0).length}/${learning.activities.length}`,
        places: learning.places.length ? n(learning.places.length) : null,
        eyes: live ? n(live) : null,
      }
    : {};
  const stats: [string, string][] = learning
    ? [
        ["Live now", n(live)],
        ["Moments caught", n(learning.watched.caught)],
        ["Hours watched", learning.watched.hours.toLocaleString("en-US")],
        ["Frames learned", n(learning.learning.labeledFrames + learning.learning.frames)],
        ["Lines heard", n(learning.heard.lines)],
        ["Streams", n(learning.watched.streams)],
      ]
    : [];
  const jump = (id: string) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="la">
      <aside className="la-side" aria-label="SLOT1 is learning">
        <button
          type="button"
          className="la-new"
          disabled={chat.busy}
          onClick={() => {
            chat.reset();
            jump("ask");
            setTimeout(() => document.getElementById("ask-input")?.focus(), 50);
          }}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
            <path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          New question
        </button>

        {chat.turns.length > 0 && (
          <nav aria-label="This conversation" className="la-side-group">
            <p className="la-side-label">This conversation</p>
            <ul className="la-side-list">
              {chat.turns.map((t) => (
                <li key={t.id}>
                  <button type="button" className="la-side-item" onClick={() => jump(`turn-${t.id}`)}>
                    <span className="min-w-0 truncate">{t.question}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <nav aria-label="What SLOT1 knows" className="la-side-group">
          <p className="la-side-label">What it knows</p>
          <ul className="la-side-list">
            {PARTS.map((p) => (
              <li key={p.id}>
                <a href={`#${p.id}`} className="la-side-item" aria-current={active === p.id ? "true" : undefined}>
                  <span className="min-w-0 truncate">{p.label}</span>
                  {counts[p.id] && <span className="la-side-count tnum">{counts[p.id]}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {stats.length > 0 && (
          <dl className="la-side-stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dd className="tnum">{value}</dd>
                <dt>{label}</dt>
              </div>
            ))}
          </dl>
        )}
        <ul className="la-legend" aria-label="On the globe">
          <li>
            <span className="bg-coral" aria-hidden /> What&apos;s happening
          </li>
          <li>
            <span className="bg-signal" aria-hidden /> Where the player is
          </li>
          <li>
            <span className="bg-apricot" aria-hidden /> Reading the screen
          </li>
        </ul>
      </aside>

      <div className="la-main">
        <div className="la-top">
          <h1 className="la-title">SLOT1 is learning</h1>
          <p className={`la-live ${live ? "is-live" : ""}`}>
            <span aria-hidden />
            {live ? `Watching ${live} ${live === 1 ? "stream" : "streams"} now` : "No stream live right now"}
          </p>
        </div>
        <nav aria-label="On this page" className="la-mnav">
          {PARTS.map((p) => (
            <a key={p.id} href={`#${p.id}`} aria-current={active === p.id ? "true" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>

        <AskSLOT1 learning={learning} now={now} turns={chat.turns} busy={chat.busy} ask={chat.ask} retry={chat.retry} />

        {stats.length > 0 && (
          <dl className="la-mstats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dd className="tnum">{value}</dd>
                <dt>{label}</dt>
              </div>
            ))}
          </dl>
        )}

        <div className="la-knowledge">
          {knowledge}
          <section id="eyes" aria-labelledby="eyes-title" className="la-section">
            <div className="la-section-head">
              <h2 id="eyes-title" className="la-section-title">
                Its eyes right now
              </h2>
            </div>
            <p className="la-section-lead">The streams SLOT1 is watching this second, and what it sees in each.</p>
            {learning && learning.heard.languages.length > 0 && (
              <p className="mt-2 text-[0.9rem] text-ivory-3">
                Heard in {learning.heard.languages.length === 1 ? "1 language" : `${learning.heard.languages.length} languages`}:{" "}
                {learning.heard.languages
                  .slice(0, 8)
                  .map((l) => `${l.name} (${n(l.lines)})`)
                  .join(", ")}
              </p>
            )}
            <div className="mt-6">
              <LiveEyes data={now} now={clock} />
            </div>
          </section>
          {footer}
        </div>
      </div>
    </div>
  );
}
