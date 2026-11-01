"use client";

import type { Edl, ProjectView } from "@slot1/contracts";

export interface ClipAiPanelProps {
  /** The project open in the editor (its source, markers and current saved state). */
  project: ProjectView;
  /** The editor's current, possibly unsaved, edit. */
  edl: Edl;
  /** Replace the editor's edit with a proposal the creator accepted (undoable in the editor). */
  onApplyEdl: (next: Edl) => void;
}

/** AI tools inside the clip editor. Placeholder until the AI clip assistant is implemented. */
export function ClipAiPanel(_props: ClipAiPanelProps) {
  return null;
}
