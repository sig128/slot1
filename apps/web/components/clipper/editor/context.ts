"use client";

import { createContext, useContext } from "react";
import type { Edl, MediaRef, ProjectMediaView, ProjectSourceView, StudioAsset, TimelineRef } from "@slot1/contracts";
import type { MediaInfo } from "./PreviewStage";

/** What every inspector panel needs from the editor. */
export interface EditorCtx {
  projectId: string;
  title: string;
  edl: Edl;
  total: number;
  playheadMs: number;
  apply: (fn: (e: Edl) => Edl, label: string, coalesce?: string) => void;
  replace: (next: Edl, label: string) => void;
  selection: TimelineRef[];
  select: (refs: TimelineRef[]) => void;
  seek: (ms: number) => void;
  sources: ProjectSourceView[];
  sourceOf: (sessionId: string) => ProjectSourceView | undefined;
  dims: (sessionId: string) => { width: number; height: number; durationMs: number };
  uploads: ProjectMediaView[];
  setUploads: (fn: (m: ProjectMediaView[]) => ProjectMediaView[]) => void;
  assets: StudioAsset[];
  mediaInfo: (ref: MediaRef) => MediaInfo | null;
  refName: (ref: MediaRef) => string;
  refDurationMs: (ref: MediaRef) => number | null;
  announce: (msg: string) => void;
  /** Save the edit now (before renders and server jobs that read it). */
  saveNow: () => Promise<boolean>;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const c = useContext(EditorContext);
  if (!c) throw new Error("useEditor outside the editor");
  return c;
}
