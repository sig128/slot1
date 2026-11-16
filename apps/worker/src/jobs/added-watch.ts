import sharp from "sharp";
import type { ServerContext } from "@slot1/services";
import { watchAddedStreams } from "@slot1/services";
import { loadActiveGtaModel } from "../gta/onnx-model";

/**
 * Featured channels are not sent into SLOT1. Once a minute, watch each live one's public
 * preview picture and learn from it. The describing model runs only when Admin → AI is configured.
 */
export async function watchAdded(ctx: ServerContext): Promise<void> {
  const gtaModel = await loadActiveGtaModel(ctx, { live: true, streamId: "added-streams" });
  await watchAddedStreams(ctx, {
    gtaModel,
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
