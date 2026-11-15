"use client";

import { useCallback, useRef, useState } from "react";
import type { LearningAnswer } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";

export interface ChatTurn {
  id: number;
  question: string;
  state: "asking" | "answered" | "error";
  answer?: LearningAnswer;
  error?: string;
}

/** The conversation with SLOT1 on the Learning page: each question answered on its own. */
export function useAsk() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const seq = useRef(0);
  const busyRef = useRef(false);

  const run = useCallback(async (id: number, question: string) => {
    busyRef.current = true;
    try {
      const answer = await api<LearningAnswer>("/api/learning/ask", { method: "POST", json: { question } });
      setTurns((all) => all.map((t) => (t.id === id ? { id, question, state: "answered", answer } : t)));
    } catch (err) {
      const error = err instanceof ApiError && err.status === 429 ? "That's a lot of questions. Wait a minute and ask again." : "SLOT1 couldn't answer just now.";
      setTurns((all) => all.map((t) => (t.id === id ? { id, question, state: "error", error } : t)));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Asks a question; returns its turn id, or null when it can't be asked right now. */
  const ask = useCallback(
    (raw: string): number | null => {
      const question = raw.trim();
      if (question.length < 3 || busyRef.current) return null;
      const id = ++seq.current;
      setTurns((all) => [...all, { id, question, state: "asking" }]);
      void run(id, question);
      return id;
    },
    [run],
  );

  const retry = useCallback(
    (turn: Pick<ChatTurn, "id" | "question">) => {
      if (busyRef.current) return;
      setTurns((all) => all.map((t) => (t.id === turn.id ? { id: turn.id, question: turn.question, state: "asking" } : t)));
      void run(turn.id, turn.question);
    },
    [run],
  );

  const reset = useCallback(() => {
    if (!busyRef.current) setTurns([]);
  }, []);

  return { turns, busy: turns.some((t) => t.state === "asking"), ask, retry, reset };
}
