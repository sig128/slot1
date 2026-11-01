"use client";

import { AssetLibraryPanel } from "./AssetLibraryPanel";

const browseOnly = () => undefined;

/** Studio tab for browsing the built-in library: listen, look, and star favorites for the editor. */
export function SoundsSection() {
  return (
    <div>
      <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">Sounds and elements</h2>
      <p className="mt-2 max-w-[68ch] text-ivory-2">
        Everything you can drop into a clip: sound effects, music loops, ambience, stickers, overlays, frames and transitions. Press play to listen,
        and star the ones you use; Favorites finds them again in the editor.
      </p>
      <div className="mt-8">
        <AssetLibraryPanel mode="browse" onPick={browseOnly} />
      </div>
    </div>
  );
}
