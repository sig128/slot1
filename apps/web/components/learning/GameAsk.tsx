"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { LearningAnswer } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

const SUGGESTIONS = ["Where do I buy guns?", "How do I lose the cops?", "Where do police chases happen most?", "How do people make money?"];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * "Ask SLOT1 about the game": one question, answered from everything SLOT1 saw on public streams
 * (with the moments as proof) and, kept apart, from general game knowledge.
 */
export function GameAsk() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<LearningAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function ask(question: string) {
    const text = question.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api<LearningAnswer>("/api/learning/ask", { method: "POST", json: { question: text } }));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "That's a lot of questions. Wait a minute and ask again." : "SLOT1 couldn't answer just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ask-game-title" className="learn-ask mt-16">
      <h2 id="ask-game-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
        Ask SLOT1 about the game
      </h2>
      <p className="mt-3 max-w-[60ch] text-ivory-2">Answers come from what SLOT1 saw on every stream, with the moments to prove it.</p>
      <form
        className="learn-ask-form mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <label htmlFor="ask-game" className="sr-only">
          Your question about GTA
        </label>
        <input
          ref={input}
          id="ask-game"
          className="learn-ask-input"
          value={q}
          maxLength={300}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Where do I buy guns?"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-coral learn-ask-go" disabled={busy || q.trim().length < 3}>
          {busy ? "Asking" : "Ask"}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="learn-ask-chip"
            disabled={busy}
            onClick={() => {
              setQ(s);
              void ask(s);
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="mt-8 max-w-[72ch]">
        {error && <p className="text-coral">{error}</p>}
        {answer && !error && (
          <div className="grid gap-6">
            <div className="learn-answer learn-answer-seen">
              <p className="learn-answer-label">Seen on SLOT1</p>
              {answer.seen ? (
                <>
                  <p className="mt-2 text-[1.05rem] text-ivory">{answer.seen.answer}</p>
                  {answer.seen.sources.length > 0 && (
                    <ul className="mt-4 grid gap-2">
                      {answer.seen.sources.map((s) => (
                        <li key={s.observationId}>
                          <Link href={s.href} className="learn-source">
                            <span className="text-ivory">{s.description}</span>
                            <span className="text-ivory-3">
                              {s.channel}, {day(s.at)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="mt-2 text-ivory-2">SLOT1 hasn&apos;t seen this on a stream yet. Every stream sent to SLOT1 adds to what it can answer.</p>
              )}
            </div>
            {answer.general && (
              <div className="learn-answer learn-answer-general">
                <p className="learn-answer-label">From general GTA knowledge, not seen on SLOT1</p>
                <p className="mt-2 text-ivory-2">{answer.general}</p>
              </div>
            )}
            {(answer.about.activities.length > 0 || answer.about.places.length > 0) && (
              <p className="text-[0.85rem] text-ivory-3">Looked through: {[...answer.about.activities, ...answer.about.places].join(", ")}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
