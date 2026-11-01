import { estimateCostUsd, type PipelineSink, type SampledFrame, type VisionResult } from "@slot1/analysis";
import type { ChannelSettings, Observation } from "@slot1/contracts";
import {
  extendObservation,
  insertAsset,
  insertObservation,
  recordFrameReceived,
  recordFramesAnalyzed,
  recordOpsError,
  recordUsage,
  upsertSourceHealth,
  visionCallsInLastHour,
  type MediaSourceRow,
  type StreamSessionRow,
} from "@slot1/db";
import { sanitizeErrorMessage, storageKeys } from "@slot1/platform";
import type { ServerContext } from "./context";
import { emitObservation } from "./events";
import { maybeAutoClip } from "./library";
import { createTrainingCollector } from "./training";

export interface SinkOptions {
  session: StreamSessionRow;
  source: MediaSourceRow;
  settings: ChannelSettings;
  /** Evidence frames expire with the channel's retention policy. */
  retentionDays: number;
  /** Called after every newly created observation (used for live commentary). */
  onObservation?: (o: Observation) => Promise<void>;
  onFrameStored?: (info: { assetId: string; ptsMs: number; receivedAt: Date }) => Promise<void>;
  /** Live only: the current recording run, so auto clips can be cut from recorded segments. */
  autoClipRunId?: () => string | null;
}

/** Postgres + object-storage implementation of the shared pipeline sink. */
export function createPipelineSink(ctx: ServerContext, o: SinkOptions): PipelineSink {
  const env = ctx.config.env;
  const priceIn = env.VISION_PRICE_INPUT_PER_MTOK ? Number(env.VISION_PRICE_INPUT_PER_MTOK) : null;
  const priceOut = env.VISION_PRICE_OUTPUT_PER_MTOK ? Number(env.VISION_PRICE_OUTPUT_PER_MTOK) : null;
  const reported = new Map<string, number>();
  const b = o.session.broadcaster_id;
  const s = o.session.id;
  const collectTraining = createTrainingCollector(ctx, o.session, o.source);

  return {
    trainingFrame: (input) => collectTraining(input),

    /** A frame the GTA model skipped (shared inference service busy or unreachable) counts as dropped. */
    async modelFrameSkipped() {
      await upsertSourceHealth(ctx.db, o.source.id, { framesDroppedDelta: 1 });
    },

    async storeFrame(frame: SampledFrame) {
      const key = storageKeys.frame(b, s, o.source.id, frame.ptsMs);
      const { bytes } = await ctx.storage.putBuffer(key, frame.jpeg, "image/jpeg");
      const asset = await insertAsset(ctx.db, {
        broadcasterId: b,
        sessionId: s,
        sourceId: o.source.id,
        kind: "frame",
        storageKey: key,
        contentType: "image/jpeg",
        bytes,
        width: frame.width,
        height: frame.height,
        mediaPtsMs: frame.ptsMs,
        expiresAt: new Date(Date.now() + o.retentionDays * 86_400_000),
      });
      await upsertSourceHealth(ctx.db, o.source.id, {
        framesReceivedDelta: 1,
        lastFrameAt: frame.receivedAt,
        lastFrameAssetId: asset.id,
        lastFramePtsMs: frame.ptsMs,
      });
      await recordFrameReceived(ctx.db, s, null);
      await o.onFrameStored?.({ assetId: asset.id, ptsMs: frame.ptsMs, receivedAt: frame.receivedAt });
      return { assetId: asset.id };
    },

    async persist(action) {
      if (action.kind === "insert") {
        const c = action.candidate;
        const { observation, created } = await insertObservation(ctx.db, {
          broadcasterId: b,
          sessionId: s,
          sourceId: o.source.id,
          mediaStartMs: c.mediaStartMs,
          mediaEndMs: c.mediaEndMs,
          capturedAt: c.capturedAt,
          receivedAt: c.receivedAt,
          analyzedAt: c.analyzedAt,
          type: c.type,
          description: c.description,
          origin: c.origin,
          interpretation: c.interpretation,
          evidence: c.evidence,
          rawText: c.rawText,
          model: c.model,
          modelConfidence: c.modelConfidence,
          relatedEntities: c.relatedEntities,
          dedupeKey: `${o.source.id}:${action.key}`.slice(0, 300),
        });
        if (created) {
          await emitObservation(ctx.db, ctx.publisher, o.session, observation, "observation.created");
          await o.onObservation?.(observation);
          // Auto clips (opt-in): never allowed to break analysis.
          await maybeAutoClip(ctx, o.session, observation, o.autoClipRunId?.() ?? null).catch((err: unknown) =>
            ctx.log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "auto clip failed"),
          );
        }
        return observation.id;
      }
      const updated = await extendObservation(ctx.db, action.id, { mediaEndMs: action.mediaEndMs, evidence: action.evidence, analyzedAt: new Date().toISOString() });
      if (updated) await emitObservation(ctx.db, ctx.publisher, o.session, updated, "observation.updated");
      return action.id;
    },

    async frameAnalyzed(info) {
      await recordFramesAnalyzed(ctx.db, s, { count: info.analyzers.length > 0 ? 1 : 0, analyzedSpanMs: info.coveredMs, delayMs: info.delayMs, hadResult: info.hadResult });
      await upsertSourceHealth(ctx.db, o.source.id, {
        framesAnalyzedDelta: info.analyzers.length > 0 ? 1 : 0,
        lastAnalyzedAt: new Date(),
        delayMs: info.delayMs,
      });
    },

    async allowVisionCall() {
      const limit = o.settings.maxVisionCallsPerHour;
      if (limit <= 0) return { allowed: false, reason: "vision budget is set to 0 calls per hour" };
      const used = await visionCallsInLastHour(ctx.db, b);
      if (used >= limit) return { allowed: false, reason: `hourly vision budget reached (${used}/${limit})` };
      return { allowed: true, reason: null };
    },

    async visionUsage(result: VisionResult, frames: number) {
      await recordUsage(ctx.db, {
        broadcasterId: b,
        sessionId: s,
        kind: "vision",
        provider: result.model.provider,
        model: result.model.version,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        frames,
        estimatedCostUsd: estimateCostUsd(result.usage, priceIn, priceOut),
      });
    },

    async problem(scope, message) {
      const msg = sanitizeErrorMessage(message);
      const last = reported.get(msg) ?? 0;
      if (Date.now() - last < 60_000) return; // don't spam the same problem
      reported.set(msg, Date.now());
      ctx.log.warn({ scope, session: s }, msg);
      await recordOpsError(ctx.db, b, scope, msg);
    },
  };
}
