/**
 * The AI overlay's object finder, in the viewer's browser: YOLOX-Nano on ONNX Runtime Web
 * (WebAssembly), off the main thread so the stream and the page stay smooth. Frames come in as
 * ImageBitmaps and boxes go back out. Nothing leaves the viewer's computer.
 */
import * as ort from "onnxruntime-web/wasm";
import { decodeYolox, DEFAULT_DECODE, YOLOX_PAD, type DetectedObject } from "@slot1/contracts";

export type DetectorIn = { type: "init"; modelUrl: string } | { type: "frame"; id: number; bitmap: ImageBitmap };
export type DetectorOut =
  | { type: "ready" }
  | { type: "objects"; id: number; objects: DetectedObject[]; ms: number }
  | { type: "error"; message: string; fatal: boolean };

const INPUT = 416;
const scope = self as unknown as { postMessage(m: DetectorOut): void; onmessage: ((e: MessageEvent<DetectorIn>) => void) | null };

let session: ort.InferenceSession | null = null;
let canvas: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;
const input = new Float32Array(3 * INPUT * INPUT);

async function init(modelUrl: string) {
  // This site serves the WebAssembly itself (scripts/copy-ort.mjs); its JavaScript glue is in this
  // bundle already. One thread, as pages here aren't cross-origin isolated.
  ort.env.wasm.wasmPaths = { wasm: `/ort/${ort.env.versions.web}/ort-wasm-simd-threaded.wasm` };
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  canvas = new OffscreenCanvas(INPUT, INPUT);
  g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2D canvas in this browser's workers");
}

/** Letterbox the frame at the top left with YOLOX's gray, as BGR planes of 0..255. */
function prepare(bitmap: ImageBitmap): { scale: number; width: number; height: number } {
  const { width, height } = bitmap;
  const scale = Math.min(INPUT / width, INPUT / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  g!.fillStyle = `rgb(${YOLOX_PAD},${YOLOX_PAD},${YOLOX_PAD})`;
  g!.fillRect(0, 0, INPUT, INPUT);
  g!.drawImage(bitmap, 0, 0, w, h);
  const rgba = g!.getImageData(0, 0, INPUT, INPUT).data;
  const plane = INPUT * INPUT;
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    input[p] = rgba[i + 2]!;
    input[plane + p] = rgba[i + 1]!;
    input[2 * plane + p] = rgba[i]!;
  }
  return { scale, width, height };
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    init(msg.modelUrl).then(
      () => scope.postMessage({ type: "ready" }),
      (err: unknown) => scope.postMessage({ type: "error", message: (err as Error).message, fatal: true }),
    );
    return;
  }
  const bitmap = msg.bitmap;
  if (!session || !g) {
    bitmap.close();
    return;
  }
  const t0 = performance.now();
  let frame: ReturnType<typeof prepare>;
  try {
    frame = prepare(bitmap);
  } finally {
    bitmap.close();
  }
  session
    .run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, INPUT, INPUT]) })
    .then((out) => {
      const raw = out[session!.outputNames[0]!]!.data as Float32Array;
      scope.postMessage({ type: "objects", id: msg.id, objects: decodeYolox(raw, INPUT, frame.scale, frame.width, frame.height, DEFAULT_DECODE), ms: performance.now() - t0 });
    })
    .catch((err: unknown) => scope.postMessage({ type: "error", message: (err as Error).message, fatal: false }));
};
