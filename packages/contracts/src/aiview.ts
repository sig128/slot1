import { z } from "zod";
import { SourceLabel } from "./enums";

/**
 * "What the AI sees": the last frame SLOT1 actually analyzed in a live session, the screen
 * regions OCR read and what it read there, what the vision provider and the GTA model said,
 * and which observations that frame produced. Every value comes from the real pipeline run on
 * that frame; nothing is summarized or filled in.
 */

/** Normalized [x, y, width, height] inside the frame (0..1). */
export const NormBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type NormBox = z.infer<typeof NormBox>;

export const AiViewReading = z.object({
  text: z.string(),
  /** Tesseract's mean word confidence for the line, 0–100. */
  confidence: z.number(),
  /** Observation type the line is evidence for (subtitle, objective_text, result_screen…). */
  type: z.string(),
  /** Tight box around the line, when tesseract reported one. */
  box: NormBox.nullable(),
});
export type AiViewReading = z.infer<typeof AiViewReading>;

export const AiViewRegion = z.object({
  id: z.string(),
  /** Plain-words name of the region, e.g. "Subtitles and objectives". */
  label: z.string(),
  box: NormBox,
  readings: z.array(AiViewReading),
});
export type AiViewRegion = z.infer<typeof AiViewRegion>;

export const AiViewProduced = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string(),
  /** "new": a new observation; "extended": an existing one got more evidence from this frame. */
  action: z.enum(["new", "extended"]),
});
export type AiViewProduced = z.infer<typeof AiViewProduced>;

export const AiViewSnapshot = z.object({
  /** Changes with every analyzed frame; also the id of the frame image. */
  id: z.string(),
  sessionId: z.string(),
  frame: z.object({
    /** Same-origin URL of the downscaled JPEG of exactly this frame. */
    url: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    /** Size the frame was analyzed at (the JPEG above is a smaller copy). */
    analyzedWidth: z.number().int(),
    analyzedHeight: z.number().int(),
    mediaMs: z.number().nullable(),
    capturedAt: z.string().nullable(),
    receivedAt: z.string(),
    analyzedAt: z.string(),
  }),
  /** Time from the frame reaching the worker to the end of its analysis. */
  latencyMs: z.number(),
  sampling: z.object({ intervalMs: z.number(), measuredCadenceMs: z.number().nullable() }),
  ocr: z.object({
    status: z.enum(["read", "off", "error"]),
    engine: z.string().nullable(),
    profile: z.object({ id: z.string(), name: z.string(), validation: z.string() }),
    regions: z.array(AiViewRegion),
    durationMs: z.number().nullable(),
    note: z.string().nullable(),
  }),
  vision: z.object({
    status: z.enum(["analyzed", "batching", "skipped", "error", "off"]),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    /** The model's own one-line scene summary for the batch this frame was in. */
    summary: z.string().nullable(),
    findings: z.array(z.object({ type: z.string(), description: z.string(), confidence: z.number().nullable() })),
    note: z.string().nullable(),
  }),
  gtaModel: z.object({
    status: z.enum(["predicted", "skipped", "error", "none"]),
    label: z.string().nullable(),
    /** Top classes with the probability the model gave them. */
    top: z.array(z.object({ label: z.string(), p: z.number() })),
    note: z.string().nullable(),
  }),
  produced: z.array(AiViewProduced),
  source: z.object({ label: SourceLabel, demo: z.boolean() }),
});
export type AiViewSnapshot = z.infer<typeof AiViewSnapshot>;

export const AiViewResponse = z.object({
  available: z.boolean(),
  /** Why there's nothing to show, in plain words. Null when a snapshot is returned. */
  reason: z.string().nullable(),
  snapshot: AiViewSnapshot.nullable(),
  /** Clients poll this often while the panel is open. */
  refreshMs: z.number().int(),
});
export type AiViewResponse = z.infer<typeof AiViewResponse>;

/** The demo channel's login. A hyphen keeps it apart from every Twitch account (Twitch logins can't contain one). */
export const DEMO_LOGIN = "slot1-demo";
/** Stream name the demo generator publishes to (gateway path live/<name>). */
export const DEMO_STREAM_NAME = "slot1demo";
export const DEMO_PUBLISH_PATH = `live/${DEMO_STREAM_NAME}`;

/** GET /api/demo: whether the demo broadcast runs here and where to watch it. */
export const DemoInfo = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  watchPath: z.string().nullable(),
  profilePath: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** The generator is publishing right now. */
  onAir: z.boolean(),
  gateway: z.string().nullable(),
  liveVideo: z.boolean(),
  ocr: z.boolean(),
  /** Paid vision analysis of the demo (off unless SLOT1_DEMO_VISION=true). */
  vision: z.boolean(),
  sampleIntervalMs: z.number().int(),
});
export type DemoInfo = z.infer<typeof DemoInfo>;
