import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { FrameInsight } from "@slot1/analysis";
import { AI_VIEW_FRAME_WIDTH, aiViewWatched, buildAiViewSnapshot, storeAiView, type AiViewContext, type ServerContext } from "@slot1/services";

/**
 * Publish "What the AI sees" for one analyzed frame: a 640 px copy of exactly that frame plus
 * what OCR, the vision provider and the GTA model did with it. Stored in Redis with a short TTL
 * for the API to serve, and only while someone is watching; never written to the database or
 * object storage.
 */
export async function publishAiView(ctx: Pick<ServerContext, "redis">, c: AiViewContext, i: FrameInsight): Promise<void> {
  // Only while somebody has the AI view open: no Redis memory or CPU spent on unwatched streams.
  if (!(await aiViewWatched(ctx, c.sessionId))) return;
  const img = sharp(i.frame.jpeg);
  const meta = await img.metadata();
  const small = await img.resize({ width: AI_VIEW_FRAME_WIDTH, withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: false }).toBuffer({ resolveWithObject: true });
  const snapshot = buildAiViewSnapshot(randomUUID(), c, i, {
    width: small.info.width,
    height: small.info.height,
    analyzedWidth: i.frame.width ?? meta.width ?? small.info.width,
    analyzedHeight: i.frame.height ?? meta.height ?? small.info.height,
  });
  await storeAiView(ctx, snapshot, small.data);
}
