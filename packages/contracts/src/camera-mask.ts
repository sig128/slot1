import { z } from "zod";

/**
 * "Hide your camera from the AI": boxes a creator draws over their webcam (or anything else in
 * their picture). SLOT1 fills these boxes with solid black in every frame it analyzes from that
 * video source, before OCR, AI vision, SLOT1's GTA model, stored evidence frames or "What the AI
 * sees" get the frame. Viewers, recordings, clips and forwarding still get the full stream.
 *
 * Coordinates are fractions of the picture (0..1), so a box stays put at any resolution.
 */
export const CAMERA_MASK_MAX_BOXES = 3;
/** Smallest box side, as a fraction of the picture (keeps stray clicks from saving slivers). */
export const CAMERA_MASK_MIN_SIZE = 0.03;

export const CameraMaskBox = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(CAMERA_MASK_MIN_SIZE).max(1),
    h: z.number().min(CAMERA_MASK_MIN_SIZE).max(1),
  })
  .refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, { message: "A box has to stay inside the picture" });
export type CameraMaskBox = z.infer<typeof CameraMaskBox>;

export const CameraMask = z.array(CameraMaskBox).max(CAMERA_MASK_MAX_BOXES, `At most ${CAMERA_MASK_MAX_BOXES} boxes`);
export type CameraMask = z.infer<typeof CameraMask>;

/** PUT /api/studio/sources/:id/camera-mask. An empty list removes the mask. */
export const SetCameraMaskInput = z.object({ boxes: CameraMask });
export type SetCameraMaskInput = z.infer<typeof SetCameraMaskInput>;

export type CameraMaskCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Quick presets: a typical webcam tile in each corner (16:9 picture, a quarter of the width). */
export const CAMERA_MASK_PRESETS: Record<CameraMaskCorner, CameraMaskBox> = {
  "top-left": { x: 0.01, y: 0.02, w: 0.26, h: 0.3 },
  "top-right": { x: 0.73, y: 0.02, w: 0.26, h: 0.3 },
  "bottom-left": { x: 0.01, y: 0.68, w: 0.26, h: 0.3 },
  "bottom-right": { x: 0.73, y: 0.68, w: 0.26, h: 0.3 },
};

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Round to four decimals and pull each box fully inside the picture. Pure; never grows the list. */
export function normalizeCameraMask(boxes: readonly CameraMaskBox[]): CameraMaskBox[] {
  return boxes.slice(0, CAMERA_MASK_MAX_BOXES).map((b) => {
    const w = r4(Math.min(1, Math.max(CAMERA_MASK_MIN_SIZE, b.w)));
    const h = r4(Math.min(1, Math.max(CAMERA_MASK_MIN_SIZE, b.h)));
    return { x: r4(Math.min(1 - w, Math.max(0, b.x))), y: r4(Math.min(1 - h, Math.max(0, b.y))), w, h };
  });
}

/** The same boxes, as the [x, y, w, h] tuples the AI view uses. */
export function cameraMaskTuples(boxes: readonly CameraMaskBox[]): [number, number, number, number][] {
  return boxes.map((b) => [b.x, b.y, b.w, b.h]);
}

/**
 * The demo stream's placeholder webcam tile (a silhouette with a CAM label, no face), drawn by
 * apps/worker/src/demo/scene.ts above every OCR region, and the box the demo source hides from
 * the AI by default, slightly larger than the tile.
 */
export const DEMO_CAMERA_TILE = { x: 0.022, y: 0.1, w: 0.2, h: 0.2 } as const;
export const DEMO_CAMERA_MASK: CameraMaskBox[] = [{ x: 0.014, y: 0.088, w: 0.216, h: 0.224 }];
