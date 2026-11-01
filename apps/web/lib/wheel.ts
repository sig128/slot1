/**
 * The "Right now" stream selector, laid out like a game's radio wheel: options sit around a
 * circle, the first at the top, then clockwise. Pure helpers so the keyboard and pointer rules
 * are tested without a browser.
 */

export type WheelAction = { type: "move"; index: number } | { type: "commit" } | { type: "close" } | null;

/**
 * What a key does. Right/Down go clockwise (next), Left/Up counter-clockwise (previous), with
 * wrap-around; Home/End jump to the ends; Enter or Space switches to the highlighted stream;
 * Escape or Q closes without switching.
 */
export function wheelKey(key: string, index: number, count: number): WheelAction {
  if (count <= 0) return key === "Escape" || key === "q" || key === "Q" ? { type: "close" } : null;
  const at = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return { type: "move", index: (at + 1) % count };
    case "ArrowLeft":
    case "ArrowUp":
      return { type: "move", index: (at - 1 + count) % count };
    case "Home":
      return { type: "move", index: 0 };
    case "End":
      return { type: "move", index: count - 1 };
    case "Enter":
    case " ":
      return { type: "commit" };
    case "Escape":
    case "q":
    case "Q":
      return { type: "close" };
    default:
      return null;
  }
}

/** Where option `i` of `count` sits, as a fraction of the radius from the center (0 = top). */
export function wheelPosition(i: number, count: number): { x: number; y: number; angle: number } {
  const angle = count > 0 ? (i / count) * 2 * Math.PI : 0;
  return { x: Math.sin(angle), y: -Math.cos(angle), angle };
}

/**
 * The option a pointer at (dx, dy) from the wheel's center points at, or null in the dead zone
 * around the center (so a pointer resting there doesn't flicker between options).
 */
export function wheelIndexFromPoint(dx: number, dy: number, count: number, deadZone = 0): number | null {
  if (count <= 0 || Math.hypot(dx, dy) < deadZone) return null;
  // 0 at the top, increasing clockwise (screen y grows downwards).
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += 2 * Math.PI;
  const slice = (2 * Math.PI) / count;
  return Math.round(a / slice) % count;
}
