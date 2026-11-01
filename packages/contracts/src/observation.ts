import { z } from "zod";
import { Interpretation, ObservationOrigin, ObservationType, ReviewStatus } from "./enums";

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

export const IsoDateTime = z.iso.datetime({ offset: true });

export const EvidenceRef = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["frame", "clip", "audio", "transcript"]),
  /** Media presentation timestamp of this evidence within its source, if known. */
  mediaPtsMs: z.number().int().nonnegative().nullable(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const RelatedEntity = z.object({
  id: z.string().min(1),
  kind: z.enum(["vehicle", "person", "place", "item", "text", "other"]),
  label: z.string().min(1).max(80),
  /** Uncertainty in plain categories; never a fabricated probability. */
  certainty: z.enum(["visible", "likely", "uncertain"]),
});
export type RelatedEntity = z.infer<typeof RelatedEntity>;

export const ModelRef = z.object({
  provider: z.string().min(1),
  version: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * Evidence-backed observation. Every gameplay observation must reference real evidence
 * (frame, clip, audio or transcript) from an authorized source. Twitch platform facts have
 * no media timeline (`mediaStartMs = null`) and never carry a vision model confidence.
 */
export const Observation = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
    broadcasterId: z.string().min(1),
    sessionId: z.string().min(1),
    sourceId: z.string().min(1).nullable(),
    /** Media PTS / source offset of the first supporting evidence. */
    mediaStartMs: z.number().int().nonnegative().nullable(),
    mediaEndMs: z.number().int().nonnegative().nullable(),
    /** Source capture time — only when the source actually provides it. Never manufactured. */
    capturedAt: IsoDateTime.nullable(),
    receivedAt: IsoDateTime,
    analyzedAt: IsoDateTime.nullable(),
    publishedAt: IsoDateTime.nullable(),
    type: ObservationType,
    description: z.string().min(1).max(280),
    origin: ObservationOrigin,
    interpretation: Interpretation,
    evidence: z.array(EvidenceRef),
    rawText: z.string().max(2000).nullable(),
    model: ModelRef.nullable(),
    /** Model-reported, uncalibrated. NOT measured correctness. */
    modelConfidence: z.number().min(0).max(1).nullable(),
    reviewStatus: ReviewStatus,
    relatedEntities: z.array(RelatedEntity),
  })
  .superRefine((o, ctx) => {
    if (o.mediaStartMs !== null && o.mediaEndMs !== null && o.mediaEndMs < o.mediaStartMs) {
      ctx.addIssue({ code: "custom", message: "mediaEndMs must be >= mediaStartMs", path: ["mediaEndMs"] });
    }
    if (o.origin === "twitch") {
      if (o.modelConfidence !== null || o.model !== null) {
        ctx.addIssue({
          code: "custom",
          message: "Twitch platform facts must not carry model confidence",
          path: ["modelConfidence"],
        });
      }
    } else if (o.origin !== "user_correction" && o.evidence.length === 0) {
      ctx.addIssue({ code: "custom", message: "Gameplay observations require evidence", path: ["evidence"] });
    }
  });
export type Observation = z.infer<typeof Observation>;

export const CorrectionInput = z.object({
  description: z.string().trim().min(1).max(280).optional(),
  type: ObservationType.optional(),
  reviewStatus: z.enum(["confirmed", "corrected", "rejected"]),
  reason: z.string().trim().max(500).optional(),
});
export type CorrectionInput = z.infer<typeof CorrectionInput>;
