"use client";

import type { StudioAsset, StudioAssetKind } from "@slot1/contracts";

export interface AssetLibraryPanelProps {
  /** Limit the browser to these kinds (e.g. only audio while an audio track is selected). */
  kinds?: StudioAssetKind[];
  /** The creator picked an asset (click, Enter, or drop): the editor places it at the playhead. */
  onPick: (asset: StudioAsset) => void;
}

/** The Studio's sound and element library browser. Placeholder until the library is implemented. */
export function AssetLibraryPanel(_props: AssetLibraryPanelProps) {
  return null;
}
