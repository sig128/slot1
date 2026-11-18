import sharp from "sharp";
import type { ServerContext } from "@slot1/services";
import { trackLiveBoxes, watchAddedStreams } from "@slot1/services";
import { loadActiveGtaModel } from "../gta/onnx-model";
import { publishAiView } from "../live/ai-view";
import { objectFinder } from "../live/objects";

/**
 * Featured channels are not sent into SLOT1. Every 5 seconds, watch each live one's public
 * preview picture and learn from it. The describing model runs only when Admin → AI is configured.
 */
export async function watchAdded(ctx: ServerContext): Promise<void> {
  const gtaModel = await loadActiveGtaModel(ctx, { live: true, streamId: "added-streams" });
  await watchAddedStreams(ctx, {
    gtaModel,
    // People and vehicles in every picture, whether or not anyone is watching.
    objects: await objectFinder(ctx.log),
    // The boxes stay on the watch page, including before anyone opens it.
    insight: (c, i) => publishAiView(ctx, c, i, { always: true }),
    toJpeg: async (buf, contentType) => {
      if (contentType.includes("jpeg")) return buf;
      try {
        return await sharp(buf).jpeg({ quality: 80 }).toBuffer();
      } catch {
        return null;
      }
    },
  });
}

/**
 * Move the people and car boxes on featured streams every couple of seconds. Learning stays on
 * its own schedule; this only updates the boxes drawn on the live player.
 */
export async function trackAdded(ctx: ServerContext): Promise<void> {
  await trackLiveBoxes(ctx, {
    objects: await objectFinder(ctx.log),
    toJpeg: async (buf, contentType) => {
      if (contentType.includes("jpeg")) return buf;
      try {
        return await sharp(buf).jpeg({ quality: 80 }).toBuffer();
      } catch {
        return null;
      }
    },
  });
}
