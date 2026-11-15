"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LearningAnswer, LearningResponse, NowResponse } from "@slot1/contracts";
import { LearningGlobe } from "./LearningGlobe";
import type { ChatTurn } from "./useAsk";

const MAX = 300;

const SUGGESTIONS: { q: string; about: string }[] = [
  { q: "Where do I buy guns?", about: "Shops and the places they're at" },
  { q: "How do I lose the cops?", about: "Police chases, start to finish" },
  { q: "Which mission do people fail most?", about: "Every attempt, every result" },
  { q: "Why do I keep dying?", about: "What happens before WASTED" },
];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** SLOT1's mark beside its answers: a small globe, like the big one. */
export function SlotMark({ thinking = false }: { thinking?: boolean }) {
  return (
    <span className={`la-mark ${thinking ? "is-thinking" : ""}`} aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.6" />
        <ellipse cx="16" cy="16" rx="11" ry="4.2" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
        <ellipse cx="16" cy="16" rx="4.6" ry="11" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
        <circle cx="22.5" cy="10.5" r="2.3" fill="currentColor" />
      </svg>
    </span>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <path d="M10 16V4m0 0-5 5m5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path d="M4.5 3.2v9.6L12.6 8z" fill="currentColor" />
    </svg>
  );
}

function Answer({ a }: { a: LearningAnswer }) {
  const [copied, setCopied] = useState(false);
  const looked = [...a.about.missions, ...a.about.activities, ...a.about.places];
  const text = [a.seen?.answer, a.general ? `General GTA knowledge: ${a.general}` : null].filter(Boolean).join("\n\n");
  return (
    <div className="la-answer">
      {a.seen ? (
        <p className="la-answer-text">{a.seen.answer}</p>
      ) : (
        <p className="la-answer-text">
          SLOT1 hasn&apos;t seen this on a stream yet. <span className="text-ivory-2">Every stream sent to SLOT1 adds to what it can answer.</span>
        </p>
      )}
      {a.seen && a.seen.sources.length > 0 && (
        <div>
          <p className="la-answer-label">The moments it saw</p>
          <ul className="la-proof">
            {a.seen.sources.map((s) => (
              <li key={s.observationId}>
                <Link href={s.href} className="la-proof-card">
                  <span className="la-proof-play">
                    <PlayIcon />
                  </span>
                  <span className="min-w-0">
                    <span className="la-proof-what">{s.description}</span>
                    <span className="la-proof-where">
                      {s.channel}, {day(s.at)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.general && (
        <div className="la-general">
          <p className="la-answer-label">From general GTA knowledge, not seen on SLOT1</p>
          <p className="mt-1">{a.general}</p>
        </div>
      )}
      <div className="la-answer-meta">
        <span>{a.mode === "model" ? "Written by SLOT1's AI from what it saw" : "From SLOT1's records"}</span>
        {looked.length > 0 && <span className="min-w-0 truncate">Looked through {looked.join(", ")}</span>}
        <button
          type="button"
          className="la-copy"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Ask SLOT1: the globe is its face, the greeting and the box ask what you want to know, and every
 * answer comes back like a chat, with the moments it saw as proof and general game knowledge kept
 * apart. The box stays at the bottom of the conversation while you scroll through it.
 */
export function AskSLOT1({
  learning,
  now,
  turns,
  busy,
  ask,
  retry,
}: {
  learning: LearningResponse | null;
  now: NowResponse | null;
  turns: ChatTurn[];
  busy: boolean;
  ask: (q: string) => number | null;
  retry: (t: ChatTurn) => void;
}) {
  const [q, setQ] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const chatting = turns.length > 0;
  const lastId = turns.at(-1)?.id ?? 0;
  const streams = learning?.watched.streams ?? 0;

  // Grow the box with what's typed, up to about six lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [q]);

  // A new question: bring it to the top of the view, its answer comes in under it.
  useEffect(() => {
    if (!lastId) return;
    const el = document.getElementById(`turn-${lastId}`);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [lastId]);

  const send = (text: string) => {
    if (ask(text) !== null) setQ("");
    box.current?.focus();
  };

  return (
    <section id="ask" aria-labelledby="ask-title" className={`la-ask ${chatting ? "is-chatting" : ""}`}>
      <div className="la-globe">
        <LearningGlobe data={learning} now={now} thinking={busy} />
      </div>

      {!chatting && (
        <div className="la-greet">
          <h2 id="ask-title" className="la-greet-title">
            What do you want to know about GTA?
          </h2>
          <p className="la-greet-sub">
            SLOT1 answers from {streams > 0 ? `the ${streams.toLocaleString("en-US")} ${streams === 1 ? "stream" : "streams"} it watched` : "every stream it watches"}, with the moments to prove it.
          </p>
        </div>
      )}
      {chatting && (
        <h2 id="ask-title" className="sr-only">
          Your conversation with SLOT1
        </h2>
      )}

      {chatting && (
        <div className="la-thread" role="log" aria-live="polite" aria-label="Conversation with SLOT1">
          {turns.map((t) => (
            <article key={t.id} id={`turn-${t.id}`} className="la-turn">
              <div className="la-you">
                <p className="sr-only">You asked</p>
                <p>{t.question}</p>
              </div>
              <div className="la-bot">
                <SlotMark thinking={t.state === "asking"} />
                <div className="min-w-0">
                  <p className="la-bot-name">SLOT1</p>
                  {t.state === "asking" && (
                    <p className="la-thinking">
                      Checking every stream SLOT1 watched<span className="la-dots" aria-hidden><span /><span /><span /></span>
                    </p>
                  )}
                  {t.state === "error" && (
                    <div className="la-answer">
                      <p className="la-answer-text text-coral">{t.error}</p>
                      <button type="button" className="la-retry" disabled={busy} onClick={() => retry(t)}>
                        Try again
                      </button>
                    </div>
                  )}
                  {t.state === "answered" && t.answer && <Answer a={t.answer} />}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="la-composer-dock">
        <form
          className="la-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(q);
          }}
        >
          <label htmlFor="ask-input" className="sr-only">
            Ask SLOT1 about GTA
          </label>
          <textarea
            ref={box}
            id="ask-input"
            rows={1}
            value={q}
            maxLength={MAX}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(q);
              }
            }}
            placeholder={chatting ? "Ask SLOT1 something else" : "Ask anything about GTA"}
            className="la-input"
            autoComplete="off"
          />
          {q.length > MAX - 50 && <span className="la-count tnum">{MAX - q.length}</span>}
          <button type="submit" className="la-send" disabled={busy || q.trim().length < 3} aria-label="Send question">
            <SendIcon />
          </button>
        </form>
        <p className="la-fineprint">SLOT1 only says it saw something when it has the moment to show you.</p>
      </div>

      {!chatting && (
        <ul className="la-suggest" aria-label="Questions to try">
          {SUGGESTIONS.map((s) => (
            <li key={s.q}>
              <button type="button" className="la-sugg" disabled={busy} onClick={() => send(s.q)}>
                <span className="la-sugg-q">{s.q}</span>
                <span className="la-sugg-about">{s.about}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
