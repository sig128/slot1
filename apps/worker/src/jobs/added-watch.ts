import sharp from "sharp";
import type { ServerContext } from "@slot1/services";
import { watchAddedStreams } from "@slot1/services";
import { loadActiveGtaModel } from "../gta/onnx-model";
import { publishAiView } from "../live/ai-view";

/**
 * Featured channels are not sent into SLOT1. Every 5 seconds, watch each live one's public
 * preview picture and learn from it. The describing model runs only when Admin → AI is configured.
 */
export async function watchAdded(ctx: ServerContext): Promise<void> {
  const gtaModel = await loadActiveGtaModel(ctx, { live: true, streamId: "added-streams" });
  await watchAddedStreams(ctx, {
    gtaModel,
    // "What the AI sees" and the AI overlay, for whoever is watching a featured stream.
    insight: (c, i) => publishAiView(ctx, c, i),
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
