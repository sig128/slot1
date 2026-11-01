import type { StudioAsset, StudioAssetsResponse } from "@slot1/contracts";
import { api } from "@/lib/api";

/**
 * Browser side of the Studio library (docs/ASSET_MANIFEST.md, "Studio library"). The editor and
 * the library panel share one manifest request per page.
 */

/** Drag-and-drop type for a library item. The payload is the item's JSON (a StudioAsset). */
export const ASSET_DRAG_TYPE = "application/x-slot1-asset";

let pending: Promise<StudioAssetsResponse> | null = null;

/** The library manifest with preview peaks and its revision. Cached for the page; `force` refetches. */
export function loadStudioAssets(force = false): Promise<StudioAssetsResponse> {
  if (!pending || force) {
    pending = api<StudioAssetsResponse>("/api/studio/assets").catch((err: unknown) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** URL of a library file, by item id. Pass the manifest's `rev` so the browser can cache it for good. */
export function studioAssetUrl(asset: Pick<StudioAsset, "id"> | string, rev?: string): string {
  const id = typeof asset === "string" ? asset : asset.id;
  return `/api/studio/assets/file/${id}${rev ? `?v=${encodeURIComponent(rev)}` : ""}`;
}

/** Put a library item on a drag (the panel does this; the timeline reads it with readAssetDrag). */
export function setAssetDrag(dt: DataTransfer, asset: StudioAsset): void {
  dt.effectAllowed = "copy";
  dt.setData(ASSET_DRAG_TYPE, JSON.stringify(asset));
  dt.setData("text/plain", asset.id);
}

/** True while a library item is being dragged (usable in dragover, where the payload is hidden). */
export function isAssetDrag(dt: DataTransfer | null | undefined): boolean {
  return Boolean(dt && Array.from(dt.types).includes(ASSET_DRAG_TYPE));
}

/** The library item that was dropped, or null when the drop carried something else. */
export function readAssetDrag(dt: DataTransfer | null | undefined): StudioAsset | null {
  if (!dt) return null;
  try {
    const v = JSON.parse(dt.getData(ASSET_DRAG_TYPE)) as Partial<StudioAsset> | null;
    if (!v || typeof v.id !== "string" || typeof v.kind !== "string" || typeof v.file !== "string") return null;
    return { ...v, tags: Array.isArray(v.tags) ? v.tags : [], loop: Boolean(v.loop) } as StudioAsset;
  } catch {
    return null;
  }
}
