import type { LibraryItemView, LibraryVisibility } from "@slot1/contracts";

/** Precise media time for editing: m:ss.t (or h:mm:ss.t). */
export function editTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--:--.-";
  const t = Math.max(0, Math.round(ms / 100));
  const tenths = t % 10;
  const total = Math.floor(t / 10);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}.${tenths}` : `${m}:${s}.${tenths}`;
}

/** Parse "1:23.4", "83.4" or "1:02:03" back to milliseconds; null when it isn't a time. */
export function parseEditTime(text: string): number | null {
  const v = text.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(v)) return null;
  const parts = v.split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

export function itemKindLabel(i: Pick<LibraryItemView, "kind" | "auto">): string {
  switch (i.kind) {
    case "recording":
      return "Recording";
    case "screenshot":
      return "Screenshot";
    case "twitch_clip":
      return "Twitch clip";
    case "clip_export":
      return "Clip";
    case "render":
      return i.auto ? "Auto clip" : "Edited clip";
  }
}

export const VISIBILITY_TEXT: Record<LibraryVisibility, { label: string; detail: string }> = {
  private: { label: "Private", detail: "Only you" },
  unlisted: { label: "Unlisted", detail: "Anyone with the link" },
  public: { label: "Public", detail: "On your profile" },
};

/** Where an item opens for its owner: recordings open as a replay with the AI log. */
export function ownerOpenPath(i: Pick<LibraryItemView, "kind" | "sessionId" | "viewPath">): string {
  return i.kind === "recording" && i.sessionId ? `/replay/${i.sessionId}` : i.viewPath;
}
