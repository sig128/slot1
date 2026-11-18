import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_VIEW_OBJECTS_OFF, type AiViewObjects } from "@slot1/contracts";
import { ObjectDetector } from "@slot1/gta-runtime";
import { sanitizeErrorMessage } from "@slot1/platform";
import type { ServerContext } from "@slot1/services";

/**
 * The AI overlay's object finder: YOLOX-Nano (Apache-2.0, trained on COCO), shipped with the worker
 * in apps/worker/models. Loaded once per process, the first time someone watches the overlay. A
 * missing or broken model file turns the boxes off and says why; nothing is ever drawn without it.
 */
const FILE = "yolox-nano.onnx";
export const OBJECT_MODEL_NAME = "YOLOX-Nano (COCO)";

let loading: Promise<ObjectDetector | null> | null = null;
let problem: string | null = null;

function modelFile(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The Docker image runs from /app with models/ beside dist/; development runs from apps/worker.
  const candidates = [path.resolve(process.cwd(), "models", FILE), path.resolve(here, "../models", FILE), path.resolve(here, "../../models", FILE)];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function objectDetector(log: ServerContext["log"]): Promise<ObjectDetector | null> {
  loading ??= (async () => {
    const file = modelFile();
    if (!file) {
      problem = "The object finder isn't installed on this server";
      log.warn({ file: FILE }, "object model file not found: the AI overlay shows no object boxes");
      return null;
    }
    try {
      const det = await ObjectDetector.load(file, OBJECT_MODEL_NAME);
      log.info({ model: OBJECT_MODEL_NAME, input: det.input }, "object finder loaded for the AI overlay");
      return det;
    } catch (err) {
      problem = "The object finder couldn't start on this server";
      log.warn({ err: sanitizeErrorMessage((err as Error).message) }, "object model failed to load: the AI overlay shows no object boxes");
      return null;
    }
  })();
  return loading;
}

/** Box the people, vehicles and animals in one frame for the overlay. Never throws. */
export async function findObjects(log: ServerContext["log"], jpeg: Buffer): Promise<AiViewObjects> {
  const det = await objectDetector(log);
  if (!det) return { ...AI_VIEW_OBJECTS_OFF, note: problem };
  try {
    const r = await det.detect(jpeg);
    return { status: "found", model: det.name, items: r.objects, durationMs: r.durationMs, note: null };
  } catch (err) {
    return { status: "error", model: det.name, items: [], durationMs: null, note: `The object finder failed on this frame: ${sanitizeErrorMessage((err as Error).message).slice(0, 160)}` };
  }
}
