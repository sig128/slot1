import { z } from "zod";

/**
 * Structured output a vision provider must return for a batch of sampled frames.
 * The JSON Schema sent to providers is derived from this (see toProviderJsonSchema) and the
 * response is validated again with zod before anything is stored.
 */
export const VISION_FINDING_TYPES = [
  "objective_text",
  "mission_title",
  "subtitle",
  "result_screen",
  "hud_reading",
  "place_name",
  "visible_text",
  "vehicle",
  "vehicle_enter_exit",
  "possible_collision",
  "movement",
  "combat",
  "landmark",
  "environment",
  "highlight_candidate",
] as const;

export const VisionFindingType = z.enum(VISION_FINDING_TYPES);
export type VisionFindingType = z.infer<typeof VisionFindingType>;

export const VisionFinding = z.object({
  type: VisionFindingType,
  /** Indexes (0-based) of the frames in the batch that support this finding. */
  frameIndexes: z.array(z.number().int().min(0)),
  description: z.string().min(1).max(200),
  interpretation: z.enum(["directly_visible", "inferred"]),
  /** Exact on-screen text when the finding is a reading of visible text; otherwise null. */
  visibleText: z.string().max(400).nullable(),
  /** Self-reported by the model, 0..1. Uncalibrated. */
  confidence: z.number().min(0).max(1).nullable(),
  entities: z.array(
    z.object({
      kind: z.enum(["vehicle", "person", "place", "item", "text", "other"]),
      label: z.string().min(1).max(80),
      certainty: z.enum(["visible", "likely", "uncertain"]),
    }),
  ),
});
export type VisionFinding = z.infer<typeof VisionFinding>;

export const FrameBatchAnalysis = z.object({
  scene: z.object({
    summary: z.string().max(300),
    isGameplay: z.enum(["yes", "no", "unclear"]),
  }),
  findings: z.array(VisionFinding),
});
export type FrameBatchAnalysis = z.infer<typeof FrameBatchAnalysis>;

/** Answer format for evidence-grounded questions (Ask SLOT1 / !slot1 ask). */
export const EvidenceAnswer = z.object({
  answer: z.string().max(450),
  citedObservationIds: z.array(z.string()),
  notObserved: z.boolean(),
});
export type EvidenceAnswer = z.infer<typeof EvidenceAnswer>;

const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "format",
  "pattern",
]);

/**
 * Convert a zod schema into a conservative JSON Schema accepted by strict structured-output
 * providers: every object gets additionalProperties:false and every property is required,
 * numeric/string constraints are removed (they are re-checked by zod after the response).
 */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    out[key] = sanitize(value);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}
