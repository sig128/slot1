import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { z } from "zod";
import {
  decideActivation,
  GTA_BOXES,
  GTA_EVENTS,
  GTA_SCENES,
  GTA_TAXONOMY_VERSION,
  ModelEvaluation,
  ModelUploadMetadata,
  SubmitLabelsInput,
  type TrainingOverview,
} from "@slot1/contracts";
import {
  acceptedFrameCount,
  activateModel,
  addModelEvaluations,
  applyHumanLabels,
  buildDatasetVersion,
  consentingChannelCount,
  deleteTrainingFrames,
  getDatasetVersion,
  getModel,
  getSettings,
  getTrainingFrame,
  insertModel,
  listActiveModels,
  listDatasetFrames,
  listDatasetVersions,
  listModels,
  listTrainingFrameKeys,
  listTrainingQueue,
  trainingCounts,
} from "@slot1/db";
import { MODELS_CHANNEL, randomToken } from "@slot1/platform";
import { datasetClassMap, datasetView, modelStorageKey, modelView, TRAINING_SPLIT_SEED, trainingFrameViews, type ServerContext } from "@slot1/services";
import { ApiProblem, badRequest, conflict, notFound } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";

const IdParam = z.object({ id: z.string().uuid() });
const MAX_MODEL_BYTES = 500 * 1024 * 1024;

/**
 * GTA model training: a creator labels frames from their OWN consented streams; datasets and the
 * model registry are deployment-wide and managed only by SLOT1 operators. Anyone else gets 404.
 */
export const trainingRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const operator = (req: FastifyRequest) => {
      if (!req.auth.user?.is_operator) throw notFound();
      return req.auth.user;
    };
    const ownFrame = async (req: FastifyRequest, id: string) => {
      const b = requireBroadcaster(req);
      const f = await getTrainingFrame(ctx.db, id);
      if (!f || f.broadcaster_id !== b.id) throw notFound("No such training frame");
      return f;
    };

    app.get("/api/training", async (req): Promise<TrainingOverview> => {
      const b = requireBroadcaster(req);
      const settings = await getSettings(ctx.db, b.id);
      const counts = await trainingCounts(ctx.db, b.id);
      const activeModels = (await listActiveModels(ctx.db)).map(modelView);
      const op = req.auth.user?.is_operator
        ? {
            datasets: (await listDatasetVersions(ctx.db)).map(datasetView),
            models: (await listModels(ctx.db)).map(modelView),
            consentingChannels: await consentingChannelCount(ctx.db),
            acceptedFrames: await acceptedFrameCount(ctx.db),
          }
        : null;
      return { consent: settings.trainingConsent, counts, activeModels, operator: op };
    });

    app.get("/api/training/queue", async (req) => {
      const b = requireBroadcaster(req);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }).parse(req.query);
      return { frames: await trainingFrameViews(ctx, await listTrainingQueue(ctx.db, b.id, limit)) };
    });

    app.get("/api/training/frames/:id", async (req) => {
      const { id } = IdParam.parse(req.params);
      const f = await ownFrame(req, id);
      return (await trainingFrameViews(ctx, [f]))[0];
    });

    app.post("/api/training/frames/:id/labels", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req) => {
      const { id } = IdParam.parse(req.params);
      const f = await ownFrame(req, id);
      const input = SubmitLabelsInput.parse(req.body ?? {});
      await applyHumanLabels(ctx.db, f.id, req.auth.user!.id, input);
      return (await trainingFrameViews(ctx, [(await getTrainingFrame(ctx.db, f.id))!]))[0];
    });

    /** Delete every training frame and label this channel contributed (files included). */
    app.delete("/api/training/frames", async (req) => {
      const b = requireBroadcaster(req);
      z.object({ confirm: z.literal("DELETE") }).parse(req.body ?? {});
      const keys = await listTrainingFrameKeys(ctx.db, b.id);
      for (const k of keys) await ctx.storage.delete(k).catch(() => undefined);
      return { deleted: await deleteTrainingFrames(ctx.db, b.id) };
    });

    /* ----------------------------------- operator: datasets ----------------------------------- */

    app.post("/api/training/datasets", async (req) => {
      const user = operator(req);
      const ds = await buildDatasetVersion(ctx.db, { seed: TRAINING_SPLIT_SEED, taxonomyVersion: GTA_TAXONOMY_VERSION, createdBy: user.id });
      if (!ds) throw conflict("No labeled frames from consenting channels yet", "Label frames in Studio → GTA model first");
      return datasetView(ds);
    });

    /** Zip: images/, manifest.jsonl, coco_{train,val,test}.json, classes.json, dataset.json. */
    app.get("/api/training/datasets/:id/export", async (req, reply) => {
      operator(req);
      const { id } = IdParam.parse(req.params);
      const ds = await getDatasetVersion(ctx.db, id);
      if (!ds) throw notFound("No such dataset version");
      const frames = await listDatasetFrames(ctx.db, ds.id);

      // Built into a temporary file first, then streamed with normal backpressure.
      const tmpDir = path.resolve(ctx.config.env.UPLOAD_TMP_DIR);
      await mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `dataset-${randomToken(12)}.zip`);
      const file = createWriteStream(tmp, { flags: "wx", mode: 0o600 });
      const done = new Promise<void>((resolve, reject) => {
        file.on("finish", () => resolve());
        file.on("error", reject);
      });
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          file.destroy(err);
          return;
        }
        file.write(Buffer.from(chunk));
        if (final) file.end();
      });
      const addText = (name: string, text: string) => {
        const f = new ZipDeflate(name, { level: 6 });
        zip.add(f);
        f.push(strToU8(text), true);
      };
      const drain = () => (file.writableNeedDrain ? new Promise<void>((r) => file.once("drain", () => r())) : Promise.resolve());
      addText(
        "dataset.json",
        JSON.stringify(
          {
            datasetVersionId: ds.id,
            version: ds.version,
            taxonomyVersion: ds.taxonomy_version,
            splitSeed: ds.split_seed,
            testSplitHash: ds.test_split_hash,
            counts: ds.counts,
            framesNow: frames.length,
            createdAt: ds.created_at.toISOString(),
          },
          null,
          2,
        ),
      );
      addText("classes.json", JSON.stringify(datasetClassMap(), null, 2));
      addText(
        "README.txt",
        [
          `SLOT1 GTA dataset v${ds.version}`,
          "Frames come only from creators who opted in to training. Splits are by session (frozen seed).",
          "Only human-accepted labels are included. Frames deleted after this version was built are absent.",
          "Train with ml/train_scene.py and ml/train_detector.py; evaluate with ml/eval.py.",
        ].join("\n"),
      );
      addText(
        "manifest.jsonl",
        frames
          .map((f) =>
            JSON.stringify({
              id: f.frame.id,
              file: `images/${f.frame.id}.jpg`,
              split: f.split,
              width: f.frame.width,
              height: f.frame.height,
              scene: f.scene,
              events: f.events,
              boxes: f.boxes,
              sourceLabel: f.frame.source_label,
              sessionId: f.frame.session_id,
            }),
          )
          .join("\n") + (frames.length ? "\n" : ""),
      );
      for (const split of ["train", "val", "test"] as const) {
        const subset = frames.filter((f) => f.split === split);
        let ann = 0;
        const coco = {
          info: { description: `SLOT1 GTA dataset v${ds.version} (${split})`, version: String(ds.version) },
          categories: GTA_BOXES.map((name, i) => ({ id: i + 1, name })),
          images: subset.map((f, i) => ({ id: i + 1, file_name: `images/${f.frame.id}.jpg`, width: f.frame.width, height: f.frame.height, frame_id: f.frame.id })),
          annotations: subset.flatMap((f, i) =>
            f.boxes.map((b) => {
              const bw = b.w * f.frame.width;
              const bh = b.h * f.frame.height;
              return { id: ++ann, image_id: i + 1, category_id: GTA_BOXES.indexOf(b.class as (typeof GTA_BOXES)[number]) + 1, bbox: [b.x * f.frame.width, b.y * f.frame.height, bw, bh], area: bw * bh, iscrowd: 0 };
            }),
          ),
        };
        addText(`coco_${split}.json`, JSON.stringify(coco));
      }
      for (const f of frames) {
        const entry = new ZipPassThrough(`images/${f.frame.id}.jpg`);
        zip.add(entry);
        try {
          const obj = await ctx.storage.getStream(f.frame.storage_key);
          for await (const chunk of obj.stream) entry.push(chunk as Uint8Array);
        } catch {
          // A file removed between listing and export: the manifest still names it, so flag it.
        }
        entry.push(new Uint8Array(0), true);
        await drain();
      }
      zip.end();
      await done;
      const stream = createReadStream(tmp);
      stream.on("close", () => void rm(tmp, { force: true }));
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="slot1-gta-dataset-v${ds.version}.zip"`)
        .header("cache-control", "no-store")
        .send(stream);
    });

    /* ------------------------------------ operator: models ------------------------------------ */

    app.post("/api/training/models", async (req) => {
      const user = operator(req);
      const tmpDir = path.resolve(ctx.config.env.UPLOAD_TMP_DIR);
      await mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `model-${randomToken(12)}.onnx`);
      let metaRaw: string | null = null;
      let gotFile = false;
      try {
        for await (const part of req.parts({ limits: { fieldSize: 512 * 1024, fileSize: MAX_MODEL_BYTES, files: 1, fields: 2 } })) {
          if (part.type === "field") {
            if (part.fieldname === "metadata" && typeof part.value === "string") metaRaw = part.value;
            continue;
          }
          if (gotFile) throw badRequest("Upload one .onnx file");
          if (path.extname(part.filename ?? "").toLowerCase() !== ".onnx") throw badRequest("The model must be an .onnx file");
          await pipeline(part.file, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) throw new ApiProblem(413, "too_large", "Model file is larger than 500 MB");
          gotFile = true;
        }
        if (!gotFile) throw badRequest("Attach the .onnx file");
        if (!metaRaw) throw badRequest("Attach the metadata JSON the training script wrote next to the model");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(metaRaw);
        } catch {
          throw badRequest("Metadata isn't valid JSON");
        }
        const meta = ModelUploadMetadata.parse(parsedJson);
        if (meta.taxonomyVersion !== GTA_TAXONOMY_VERSION) throw badRequest(`Model uses taxonomy v${meta.taxonomyVersion}; this deployment expects v${GTA_TAXONOMY_VERSION}`);
        const known = { scenes: GTA_SCENES as readonly string[], events: GTA_EVENTS as readonly string[], boxes: GTA_BOXES as readonly string[] };
        for (const k of ["scenes", "events", "boxes"] as const) {
          const unknown = (meta.classes[k] ?? []).filter((c) => !known[k].includes(c));
          if (unknown.length) throw badRequest(`Unknown ${k} classes: ${unknown.join(", ")}`);
        }
        if (meta.task === "scene" && !meta.classes.scenes?.length) throw badRequest("A scene model must list its scene classes");
        if (meta.task === "detector" && !meta.classes.boxes?.length) throw badRequest("A detector must list its box classes");
        // Every evaluation must point at a real dataset version and its exact test split.
        for (const e of meta.metrics) {
          const ds = await getDatasetVersion(ctx.db, e.datasetVersionId);
          if (!ds) throw badRequest(`Evaluation refers to an unknown dataset version (${e.datasetVersionId})`);
          if (ds.test_split_hash !== e.testSplitHash) throw badRequest(`Evaluation's test split doesn't match dataset v${ds.version}`);
        }
        if (meta.datasetVersionId && !(await getDatasetVersion(ctx.db, meta.datasetVersionId))) throw badRequest("Unknown training dataset version");

        const bytes = (await stat(tmp)).size;
        const sha256 = createHash("sha256").update(await readFile(tmp)).digest("hex");
        const key = modelStorageKey(meta.name, meta.version);
        if ((await listModels(ctx.db)).some((m) => m.name === meta.name && m.version === meta.version)) throw conflict(`${meta.name} ${meta.version} is already registered`);
        await ctx.storage.putFile(key, tmp, "application/octet-stream");
        const row = await insertModel(ctx.db, {
          name: meta.name,
          version: meta.version,
          task: meta.task,
          taxonomy_version: meta.taxonomyVersion,
          classes: meta.classes,
          input_spec: { ...meta.input, outputs: meta.outputs, ...(meta.thresholds ? { thresholds: meta.thresholds } : {}) } as never,
          metrics: meta.metrics,
          dataset_version_id: meta.datasetVersionId,
          onnx_storage_key: key,
          onnx_sha256: sha256,
          bytes,
          uploaded_by: user.id,
        });
        return modelView(row);
      } finally {
        await rm(tmp, { force: true });
      }
    });

    app.post("/api/training/models/:id/evaluations", async (req) => {
      operator(req);
      const { id } = IdParam.parse(req.params);
      const evaluations = z.array(ModelEvaluation).min(1).max(20).parse(req.body);
      const m = await getModel(ctx.db, id);
      if (!m) throw notFound("No such model");
      for (const e of evaluations) {
        const ds = await getDatasetVersion(ctx.db, e.datasetVersionId);
        if (!ds || ds.test_split_hash !== e.testSplitHash) throw badRequest("Evaluation doesn't match a dataset version's test split");
      }
      return modelView((await addModelEvaluations(ctx.db, id, evaluations))!);
    });

    /** Activate only if it's at least as good as the active model on the same frozen test split. */
    app.post("/api/training/models/:id/activate", async (req, reply) => {
      operator(req);
      const { id } = IdParam.parse(req.params);
      const m = await getModel(ctx.db, id);
      if (!m) throw notFound("No such model");
      if (m.status === "active") return { decision: { allowed: true, reason: "Already active", comparedOn: null, candidateValue: null, activeValue: null }, model: modelView(m) };
      if (m.taxonomy_version !== GTA_TAXONOMY_VERSION) throw conflict("This model was trained on an older label set");
      const active = (await listActiveModels(ctx.db)).find((a) => a.task === m.task) ?? null;
      const decision = decideActivation(m.metrics, active?.metrics ?? null);
      if (!decision.allowed) return reply.status(409).send({ error: { code: "conflict", message: decision.reason, requirement: null }, decision });
      const updated = await activateModel(ctx.db, id);
      // Inference services swap to the new model right away (they also poll as a safety net).
      await ctx.redis.publish(MODELS_CHANNEL, JSON.stringify({ id, at: new Date().toISOString() })).catch(() => undefined);
      return { decision, model: modelView(updated!) };
    });
  };
