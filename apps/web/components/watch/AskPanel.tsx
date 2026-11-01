"use client";

import { useState } from "react";
import { formatAge, formatMediaTime, type AskResponse } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

interface Exchange {
  q: string;
  a: AskResponse | null;
  error: string | null;
}

const SUGGESTIONS = ["What just happened?", "Show possible crashes", "What objective text appeared?", "Find that conversation"];

/** Questions are answered only from this session's evidence. Answering never takes an action. */
export function AskPanel({
  sessionId,
  canAsk,
  policy,
  onCite,
  fixtureAnswer,
}: {
  sessionId: string | null;
  canAsk: boolean;
  policy: "off" | "signed_in" | "anyone";
  /** A citation was clicked: select it and jump there (seek a replay, or an instant replay live). */
  onCite: (observationId: string, mediaStartMs: number | null) => void;
  fixtureAnswer?: (q: string) => AskResponse;
}) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  if (!sessionId) return <p className="p-5 text-sm text-ivory-2">There’s no session to ask about yet.</p>;
  if (!canAsk)
    return (
      <p className="p-5 text-sm text-ivory-2">
        {policy === "off" ? "The creator has turned off viewer questions for this channel." : "Sign in to ask SLOT1 about this session."}
      </p>
    );

  async function ask(question: string) {
    if (question.trim().length < 2 || busy) return;
    setBusy(true);
    const entry: Exchange = { q: question.trim(), a: null, error: null };
    setLog((l) => [...l, entry]);
    setQ("");
    try {
      const a = fixtureAnswer ? fixtureAnswer(question) : await api<AskResponse>(`/api/sessions/${sessionId}/ask`, { method: "POST", json: { question: question.trim() } });
      setLog((l) => l.map((e) => (e === entry ? { ...e, a } : e)));
    } catch (err) {
      setLog((l) => l.map((e) => (e === entry ? { ...e, error: err instanceof ApiError ? err.message : "Couldn't get an answer" } : e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4" aria-live="polite">
        {log.length === 0 && (
          <div>
            <p className="text-sm text-ivory-2">Answers come only from what SLOT1 observed in this session, with links to the evidence.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="btn btn-ghost btn-sm" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((e, i) => (
          <div key={i}>
            <p className="font-display text-lg font-semibold">{e.q}</p>
            {e.error && <p className="mt-1 text-sm text-coral">{e.error}</p>}
            {!e.a && !e.error && <p className="mt-1 text-sm text-ivory-3">Looking through the evidence</p>}
            {e.a && (
              <div className="mt-1.5">
                <p className={`text-[0.95rem] ${e.a.notObserved ? "text-ivory-2" : "text-ivory"}`}>{e.a.answer}</p>
                {e.a.freshness.stale && <p className="mt-1 text-[0.78rem] text-ivory-3">The live feed is stale, so this may be out of date.</p>}
                {e.a.citations.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {e.a.citations.map((c) => (
                      <li key={c.observationId}>
                        <button
                          type="button"
                          className="text-left text-[0.82rem] text-apricot underline-offset-2 hover:underline"
                          onClick={() => onCite(c.observationId, c.mediaStartMs)}
                          title={c.mediaStartMs === null ? "Show this evidence" : `Jump to ${formatMediaTime(c.mediaStartMs)}`}
                        >
                          <span className="tnum">{formatMediaTime(c.mediaStartMs)}</span> {c.description}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-[0.72rem] text-ivory-3">
                  {e.a.mode === "model" ? "Summarized by the configured text model from cited evidence." : "Matched from stored evidence (no AI summary)."}
                  {e.a.freshness.lastObservationAgeMs !== null ? ` Latest observation ${formatAge(e.a.freshness.lastObservationAgeMs)} old.` : ""}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t hairline p-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          void ask(q);
        }}
      >
        <label htmlFor="ask-input" className="sr-only">
          Ask SLOT1
        </label>
        <input id="ask-input" className="field" placeholder="Ask about this session" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary shrink-0" disabled={busy || q.trim().length < 2}>
          Ask
        </button>
      </form>
    </div>
  );
}
