"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { docEdl, docSequences, MAIN_SEQUENCE_ID, setDocEdl, type Edl, type ProjectDoc, type SequenceInfo } from "@slot1/contracts";

const LIMIT = 150;
/** Changes with the same key inside this window merge into one undo step (slider drags, typing). */
const COALESCE_MS = 900;

interface Step {
  doc: ProjectDoc;
  active: string;
  label: string;
}

export interface ProjectHistory {
  doc: ProjectDoc;
  /** The sequence being edited. */
  active: string;
  edl: Edl;
  sequences: SequenceInfo[];
  /** Change the active sequence's edit. Same `coalesce` key within a short time merges steps. */
  apply: (fn: (e: Edl) => Edl, label: string, coalesce?: string) => void;
  /** Replace the active sequence's edit as one undoable step (AI proposals, templates). */
  replace: (next: Edl, label: string) => void;
  /** Change the project's sequences (add, rename, delete…); `activate` switches to one. */
  applyDoc: (fn: (d: ProjectDoc) => ProjectDoc, label: string, activate?: string) => void;
  setActive: (id: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Bumps on every change, for autosave. */
  rev: number;
}

/**
 * One undo history for the whole project, over snapshots of every sequence. Undo and redo
 * switch to the sequence the step changed, so the change is always in view.
 */
export function useProjectHistory(initial: ProjectDoc, initialActive = MAIN_SEQUENCE_ID): ProjectHistory {
  const valid = (d: ProjectDoc, id: string) => (id === MAIN_SEQUENCE_ID || d.sequences.extra.some((s) => s.id === id) ? id : MAIN_SEQUENCE_ID);
  const [st, setSt] = useState<{ past: Step[]; doc: ProjectDoc; active: string; future: Step[]; rev: number }>(() => ({
    past: [],
    doc: initial,
    active: valid(initial, initialActive),
    future: [],
    rev: 0,
  }));
  const last = useRef<{ key: string; at: number } | null>(null);

  const commit = useCallback((fn: (s: typeof st) => { doc: ProjectDoc; active: string } | null, label: string, coalesce?: string) => {
    // Decided outside the updater so a double-invoked updater (React dev) stays pure.
    const now = Date.now();
    const merge = Boolean(coalesce && last.current && last.current.key === coalesce && now - last.current.at < COALESCE_MS);
    last.current = coalesce ? { key: coalesce, at: now } : null;
    setSt((s) => {
      const r = fn(s);
      if (!r || (r.doc === s.doc && r.active === s.active)) return s;
      const past = merge && s.past.length > 0 ? s.past : [...s.past, { doc: s.doc, active: s.active, label }].slice(-LIMIT);
      return { past, doc: r.doc, active: r.active, future: [], rev: s.rev + 1 };
    });
  }, []);

  const apply = useCallback(
    (fn: (e: Edl) => Edl, label: string, coalesce?: string) =>
      commit((s) => {
        const cur = docEdl(s.doc, s.active);
        const next = fn(cur);
        return next === cur ? null : { doc: setDocEdl(s.doc, s.active, next), active: s.active };
      }, label, coalesce),
    [commit],
  );
  const replace = useCallback((next: Edl, label: string) => {
    last.current = null;
    commit((s) => ({ doc: setDocEdl(s.doc, s.active, next), active: s.active }), label);
  }, [commit]);
  const applyDoc = useCallback(
    (fn: (d: ProjectDoc) => ProjectDoc, label: string, activate?: string) => {
      last.current = null;
      commit((s) => {
        const doc = fn(s.doc);
        return { doc, active: valid(doc, activate ?? s.active) };
      }, label);
    },
    [commit],
  );
  const setActive = useCallback((id: string) => setSt((s) => ({ ...s, active: valid(s.doc, id) })), []);

  const undo = useCallback(() => {
    last.current = null;
    setSt((s) => {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return { past: s.past.slice(0, -1), doc: prev.doc, active: valid(prev.doc, prev.active), future: [{ doc: s.doc, active: s.active, label: prev.label }, ...s.future], rev: s.rev + 1 };
    });
  }, []);
  const redo = useCallback(() => {
    last.current = null;
    setSt((s) => {
      const nxt = s.future[0];
      if (!nxt) return s;
      return { past: [...s.past, { doc: s.doc, active: s.active, label: nxt.label }], doc: nxt.doc, active: valid(nxt.doc, nxt.active), future: s.future.slice(1), rev: s.rev + 1 };
    });
  }, []);

  const sequences = useMemo(() => docSequences(st.doc), [st.doc]);
  return {
    doc: st.doc,
    active: st.active,
    edl: docEdl(st.doc, st.active),
    sequences,
    apply,
    replace,
    applyDoc,
    setActive,
    undo,
    redo,
    canUndo: st.past.length > 0,
    canRedo: st.future.length > 0,
    undoLabel: st.past.at(-1)?.label ?? null,
    redoLabel: st.future[0]?.label ?? null,
    rev: st.rev,
  };
}
