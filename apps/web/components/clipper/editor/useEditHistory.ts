"use client";

import { useCallback, useRef, useState } from "react";
import type { Edl } from "@slot1/contracts";

const LIMIT = 120;
/** Changes with the same key inside this window merge into one undo step (slider drags, typing). */
const COALESCE_MS = 900;

export interface EditHistory {
  edl: Edl;
  /** Apply a change. Same `coalesce` key within a short time merges into the previous step. */
  apply: (fn: (e: Edl) => Edl, label: string, coalesce?: string) => void;
  /** Replace the whole edit as one undoable step (AI proposals, templates). */
  replace: (next: Edl, label: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Bumps on every change, for autosave. */
  rev: number;
}

interface Step {
  edl: Edl;
  label: string;
}

/** Undo/redo over whole-EDL snapshots: cheap to keep, exact to restore. */
export function useEditHistory(initial: Edl): EditHistory {
  const [state, setState] = useState<{ past: Step[]; present: Edl; future: Step[]; rev: number }>({ past: [], present: initial, future: [], rev: 0 });
  const last = useRef<{ key: string; at: number } | null>(null);

  const apply = useCallback((fn: (e: Edl) => Edl, label: string, coalesce?: string) => {
    // Decided outside the updater so a double-invoked updater (React dev) stays pure.
    const now = Date.now();
    const merge = Boolean(coalesce && last.current && last.current.key === coalesce && now - last.current.at < COALESCE_MS);
    last.current = coalesce ? { key: coalesce, at: now } : null;
    setState((s) => {
      const next = fn(s.present);
      if (next === s.present) return s;
      const past = merge && s.past.length > 0 ? s.past : [...s.past, { edl: s.present, label }].slice(-LIMIT);
      return { past, present: next, future: [], rev: s.rev + 1 };
    });
  }, []);

  const replace = useCallback((next: Edl, label: string) => {
    last.current = null;
    setState((s) => ({ past: [...s.past, { edl: s.present, label }].slice(-LIMIT), present: next, future: [], rev: s.rev + 1 }));
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setState((s) => {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return { past: s.past.slice(0, -1), present: prev.edl, future: [{ edl: s.present, label: prev.label }, ...s.future], rev: s.rev + 1 };
    });
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setState((s) => {
      const nxt = s.future[0];
      if (!nxt) return s;
      return { past: [...s.past, { edl: s.present, label: nxt.label }], present: nxt.edl, future: s.future.slice(1), rev: s.rev + 1 };
    });
  }, []);

  return {
    edl: state.present,
    apply,
    replace,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    undoLabel: state.past.at(-1)?.label ?? null,
    redoLabel: state.future[0]?.label ?? null,
    rev: state.rev,
  };
}
