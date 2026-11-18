import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DetectedObject, SourceLabel } from "@slot1/contracts";
import { ocrCandidates, visionCandidates, type FrameRef } from "./candidates";
import { FusionWindow, HighlightScorer, type Candidate, type FusionAction } from "./fusion";
import { GtaPredictionGate, type FrameModel, type FramePrediction } from "./gta/model";
import { weakLabelsFromOcr, type WeakLabel } from "./gta/weak-labels";
import type { OcrEngine, OcrLine } from "./ocr";
import { motionCandidate, type FrameChange, type MotionMeter } from "./motion";
import type { GameProfile } from "./profiles";
import { ProviderError } from "./providers/http";
import type { VisionProvider, VisionResult } from "./providers/vision";
import type { SampledFrame } from "./sources";

export interface PipelineSink {
  /** Persist the frame JPEG as an evidence asset; returns its id. */
  storeFrame(frame: SampledFrame): Promise<{ assetId: string }>;
  /** Persist a fusion action. Returns the observation id for inserts/extends. */
  persist(action: Exclude<FusionAction, { kind: "hold" }>): Promise<string | null>;
  frameAnalyzed(info: { frame: FrameRef; analyzers: string[]; coveredMs: number; delayMs: number; hadResult: boolean }): Promise<void>;
  allowVisionCall(): Promise<{ allowed: boolean; reason: string | null }>;
  visionUsage(result: VisionResult, frames: number): Promise<void>;
  problem(scope: string, message: string): Promise<void>;
  /**
   * Offer an analyzed frame to the GTA training pool. The sink decides (creator consent,
   * sampling caps) whether to keep it. Optional: sinks without a training pool ignore it.
   */
  trainingFrame?(input: { frame: SampledFrame; ref: FrameRef; weakLabels: WeakLabel[]; prediction: FramePrediction | null; objects?: { name: string; items: DetectedObject[] } | null }): Promise<void>;
  /** The GTA model skipped this frame (e.g. the shared inference service was busy). Optional. */
  modelFrameSkipped?(frame: FrameRef, reason: string): Promise<void>;
  /** Keep what was said in one live audio chunk (text only) as transcript evidence. Optional. */
  storeTranscript?(t: StoredTranscript): Promise<{ assetId: string }>;
}

/**
 * SLOT1's object finder: boxes around people, vehicles and animals in a frame (a general detector,
 * not trained on GTA). Part of the analysis on every frame; its boxes go to "What the AI sees", the
 * stream overlay and the training pool as proposals, never to the log.
 */
export interface ObjectFinder {
  readonly name: string;
  find(jpeg: Buffer): Promise<{ objects: DetectedObject[]; durationMs: number }>;
}

export interface StoredTranscript {
  mediaStartMs: number;
  durationMs: number;
  receivedAt: Date;
  language: string | null;
  languageName: string | null;
  text: string;
  segments: { startMs: number; endMs: number; text: string }[];
  sounds: string[];
  provider: string;
  model: string;
}

export interface PipelineOptions {
  ocr: OcrEngine | null;
  ocrVersion: string;
  /**
   * OCR reading kinds that stay out of the log (they still reach "What the AI sees" and the
   * training labels). Featured channels' preview pictures leave out loose "visible_text": menu
   * items, stream overlays and chat boxes read word by word, which the vision model describes better.
   */
  ocrKeepOut?: ReadonlySet<string>;
  vision: VisionProvider | null;
  /** SLOT1's own trained GTA model (active registry version), when one is deployed. */
  gtaModel?: FrameModel | null;
  /** The object finder (people, vehicles, animals), run on every analyzed frame. */
  objects?: ObjectFinder | null;
  profile: GameProfile;
  sourceLabel: SourceLabel;
  visionBatchSize: number;
  /** Interval each analyzed frame stands for when computing coverage. */
  coverageMsPerFrame: number;
  workDir: string;
  sink: PipelineSink;
  /**
   * Called once per analyzed frame with what each analyzer actually did on it ("What the AI
   * sees"). Optional; never allowed to break analysis.
   */
  insight?: (i: FrameInsight) => Promise<void>;
  /** Measures how much each frame changed: sudden action becomes a live log entry. */
  motion?: MotionMeter | null;
  /**
   * Watching every second: OCR and the GTA model read every frame, but the vision model is asked
   * only when something happens (sudden action, a cut, big on-screen text, a new scene from the GTA
   * model; at most one every `minGapMs`, sent at once) plus one frame every `heartbeatMs`.
   * Null sends every frame in batches, as before.
   */
  visionGate?: { heartbeatMs: number; minGapMs: number } | null;
}

/** Everything the pipeline did with one frame, exactly as it happened. */
export interface FrameInsight {
  frame: SampledFrame;
  ref: FrameRef;
  profile: GameProfile;
  ocr: { enabled: boolean; engine: string | null; lines: OcrLine[]; durationMs: number | null; error: string | null };
  model: { enabled: boolean; label: string | null; prediction: FramePrediction | null; skipped: string | null; error: string | null };
  /** What the object finder boxed in this frame. */
  objects?: { enabled: boolean; name: string | null; items: DetectedObject[]; durationMs: number | null; error: string | null };
  vision: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    /** analyzed: this frame's batch went to the provider now; batching: waiting for more frames. */
    state: "analyzed" | "batching" | "skipped" | "error" | "off";
    result: VisionResult | null;
    note: string | null;
    batch: { have: number; need: number };
  };
  produced: { id: string; type: string; description: string; action: "new" | "extended" }[];
  analyzedAt: Date;
}

/**
 * Whether the vision model looks at a frame: "now" (something happened), "batch" (queue it as
 * before) or "skip" (nothing changed and the last look was recent). Without a gate or a motion
 * reading every frame is batched.
 */
export function visionDecision(
  gate: { heartbeatMs: number; minGapMs: number } | null,
  f: { change: FrameChange | null; bigText: boolean; sceneChanged: boolean; sinceLastMs: number },
): "now" | "batch" | "skip" {
  if (!gate || !f.change) return "batch";
  const happened = f.change.spike || f.change.cut || f.bigText || f.sceneChanged;
  if (happened && f.sinceLastMs >= gate.minGapMs) return "now";
  if (f.sinceLastMs >= gate.heartbeatMs) return "batch";
  return "skip";
}

/**
 * The single observation pipeline used for replays, Twitch clips and live ingest:
 *   frame → evidence asset → local OCR (deterministic) → batched vision → fusion → persist.
 * Nothing is produced without a real frame; providers that are not configured are skipped and
 * reported, never substituted.
 */
export class ObservationPipeline {
  private readonly fusion = new FusionWindow(20_000);
  private readonly highlights = new HighlightScorer();
  private batch: FrameRef[] = [];
  private batchJpegs: Buffer[] = [];
  private lastSummary: string | null = null;
  private visionBlockedReason: string | null = null;
  private gtaGate: GtaPredictionGate | null = null;
  /** Observations created or extended while the current frame is being handled. */
  private produced: FrameInsight["produced"] | null = null;
  private lastVision: { state: "analyzed" | "skipped" | "error"; result: VisionResult | null; note: string | null } | null = null;
  readonly stats = { frames: 0, analyzedFrames: 0, visionFrames: 0, visionCalls: 0, observations: 0, visionErrors: 0, ocrLines: 0, modelFrames: 0, modelSkipped: 0, visionSkipped: 0, motionSpikes: 0 };
  private lastVisionPushAt = -Infinity;
  private lastScene: string | null = null;
  private lastMotionAt = -Infinity;
  readonly frameRefs: FrameRef[] = [];

  constructor(private readonly o: PipelineOptions) {
    if (o.gtaModel) this.gtaGate = new GtaPredictionGate(o.gtaModel.thresholds);
  }

  get analyzers(): string[] {
    const list: string[] = [];
    if (this.o.ocr) list.push("OCR");
    if (this.o.gtaModel) list.push(this.o.gtaModel.label);
    if (this.o.vision) list.push(`vision (${this.o.vision.provider})`);
    return list;
  }

  private get analyzing(): boolean {
    return Boolean(this.o.ocr || this.o.vision || this.o.gtaModel);
  }

  /** Frames and outside events (speech) are handled one at a time, in arrival order. */
  private serial: Promise<void> = Promise.resolve();

  handleFrame(frame: SampledFrame): Promise<void> {
    const run = this.serial.then(() => this.analyzeFrame(frame));
    this.serial = run.catch(() => undefined);
    return run;
  }

  /**
   * A measured or outside candidate (what was said on stream, media facts): fused like any other
   * reading, between frames, never in the middle of one.
   */
  addCandidate(c: Candidate): Promise<boolean> {
    const run = this.serial.then(() => this.fuse(c));
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async analyzeFrame(frame: SampledFrame): Promise<void> {
    const { assetId } = await this.o.sink.storeFrame(frame);
    const ref: FrameRef = { ptsMs: frame.ptsMs, assetId, receivedAt: frame.receivedAt, capturedAt: frame.capturedAt };
    this.frameRefs.push(ref);
    this.stats.frames += 1;
    let hadResult = false;
    const nowIso = () => new Date().toISOString();
    let ocrLines: OcrLine[] = [];
    this.produced = this.o.insight ? [] : null;
    const ocrInfo: FrameInsight["ocr"] = { enabled: Boolean(this.o.ocr), engine: this.o.ocr?.name ?? null, lines: [], durationMs: null, error: null };
    const modelInfo: FrameInsight["model"] = { enabled: Boolean(this.o.gtaModel), label: this.o.gtaModel?.label ?? null, prediction: null, skipped: null, error: null };

    if (this.o.ocr) {
      const dir = path.join(this.o.workDir, "ocr");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${frame.ptsMs}.jpg`);
      await writeFile(file, frame.jpeg);
      const t0 = Date.now();
      try {
        const lines = await this.o.ocr.readFrame(file, this.o.profile, dir);
        ocrLines = lines;
        ocrInfo.lines = lines;
        ocrInfo.durationMs = Date.now() - t0;
        this.stats.ocrLines += lines.length;
        const logged = this.o.ocrKeepOut ? lines.filter((l) => !this.o.ocrKeepOut!.has(l.type)) : lines;
        for (const c of ocrCandidates(logged, ref, this.o.ocrVersion, nowIso())) hadResult = (await this.fuse(c)) || hadResult;
      } catch (err) {
        ocrInfo.error = (err as Error).message;
        await this.o.sink.problem("ocr", `OCR failed on a frame: ${(err as Error).message}`);
      } finally {
        await rm(file, { force: true });
      }
    }

    let prediction: FramePrediction | null = null;
    if (this.o.gtaModel && this.gtaGate) {
      try {
        prediction = await this.o.gtaModel.predict(frame.jpeg);
        modelInfo.prediction = prediction;
        if (prediction) {
          this.stats.modelFrames += 1;
          for (const c of this.gtaGate.candidates(prediction, ref, nowIso())) hadResult = (await this.fuse(c)) || hadResult;
        } else {
          // Skipped, not failed: nothing is published for this frame and the skip is counted.
          this.stats.modelSkipped += 1;
          const why = this.o.gtaModel.skipReason ?? "skipped";
          modelInfo.skipped = why;
          await this.o.sink.modelFrameSkipped?.(ref, why);
          await this.o.sink.problem("gta-model", `GTA model skipped frames: ${why}`);
        }
      } catch (err) {
        modelInfo.error = (err as Error).message;
        await this.o.sink.problem("gta-model", `GTA model failed on a frame: ${(err as Error).message}`);
      }
    }

    // People, vehicles and animals: for the overlay, "What the AI sees" and training proposals.
    const objectsInfo: NonNullable<FrameInsight["objects"]> = { enabled: Boolean(this.o.objects), name: this.o.objects?.name ?? null, items: [], durationMs: null, error: null };
    if (this.o.objects) {
      try {
        const found = await this.o.objects.find(frame.jpeg);
        objectsInfo.items = found.objects;
        objectsInfo.durationMs = found.durationMs;
      } catch (err) {
        objectsInfo.error = (err as Error).message;
        await this.o.sink.problem("objects", `The object finder failed on a frame: ${(err as Error).message}`);
      }
    }

    // How much the picture changed: sudden action is logged, and it decides whether vision looks.
    let change: FrameChange | null = null;
    if (this.o.motion) {
      try {
        change = await this.o.motion.measure(frame.jpeg);
      } catch {
        change = null;
      }
      const t = frame.receivedAt.getTime();
      if (change?.spike && t - this.lastMotionAt >= 5000) {
        this.lastMotionAt = t;
        this.stats.motionSpikes += 1;
        hadResult = (await this.fuse(motionCandidate(change, ref, nowIso()))) || hadResult;
      }
    }

    let visionRan = false;
    let gatedOut = false;
    if (this.o.vision) {
      const g = this.o.visionGate;
      const scene = prediction?.scene?.class ?? null;
      const sceneChanged = scene !== null && scene !== this.lastScene;
      if (scene !== null) this.lastScene = scene;
      const bigText = ocrLines.some((l) => l.type === "result_screen" || l.type === "mission_title" || l.type === "objective_text");
      const t = frame.receivedAt.getTime();
      const decision = visionDecision(g ?? null, { change, bigText, sceneChanged, sinceLastMs: t - this.lastVisionPushAt });
      if (decision !== "skip") {
        this.lastVisionPushAt = t;
        this.batch.push(ref);
        this.batchJpegs.push(frame.jpeg);
        // Something happened: ask now instead of waiting for a full batch.
        if (decision === "now" || this.batch.length >= this.o.visionBatchSize) {
          visionRan = true;
          hadResult = (await this.runVision()) || hadResult;
        }
      } else {
        gatedOut = true;
        this.stats.visionSkipped += 1;
      }
    }

    if (this.o.sink.trainingFrame) {
      try {
        await this.o.sink.trainingFrame({
          frame,
          ref,
          weakLabels: weakLabelsFromOcr(ocrLines),
          prediction,
          objects: this.o.objects && !objectsInfo.error ? { name: this.o.objects.name, items: objectsInfo.items } : null,
        });
      } catch (err) {
        await this.o.sink.problem("training", `Couldn't add a frame to the training pool: ${(err as Error).message}`);
      }
    }

    if (this.analyzing) this.stats.analyzedFrames += 1;
    await this.o.sink.frameAnalyzed({
      frame: ref,
      analyzers: this.analyzers,
      coveredMs: this.analyzing ? this.o.coverageMsPerFrame : 0,
      delayMs: Date.now() - frame.receivedAt.getTime(),
      hadResult,
    });

    const produced = this.produced ?? [];
    this.produced = null;
    if (this.o.insight) {
      const v = this.o.vision;
      const last = visionRan ? this.lastVision : null;
      try {
        await this.o.insight({
          frame,
          ref,
          profile: this.o.profile,
          ocr: ocrInfo,
          model: modelInfo,
          objects: objectsInfo,
          vision: {
            enabled: Boolean(v),
            provider: v?.provider ?? null,
            model: v?.model ?? null,
            state: !v ? "off" : gatedOut ? "skipped" : last ? last.state : "batching",
            result: gatedOut ? null : (last?.result ?? null),
            note: gatedOut ? "Nothing changed on screen, so the vision model wasn't asked about this frame." : (last?.note ?? null),
            batch: { have: v ? this.batch.length : 0, need: v ? this.o.visionBatchSize : 0 },
          },
          produced,
          analyzedAt: new Date(),
        });
      } catch {
        // Showing what the AI saw must never interrupt the analysis itself.
      }
    }
  }

  /** Process any frames still waiting for a vision batch (after the frames already queued). */
  flush(): Promise<void> {
    const run = this.serial.then(async () => {
      if (this.o.vision && this.batch.length > 0) await this.runVision();
    });
    this.serial = run.catch(() => undefined);
    return run;
  }

  private async runVision(): Promise<boolean> {
    const frames = this.batch;
    const jpegs = this.batchJpegs;
    this.batch = [];
    this.batchJpegs = [];
    if (!this.o.vision || frames.length === 0) return false;
    const gate = await this.o.sink.allowVisionCall();
    if (!gate.allowed) {
      this.lastVision = { state: "skipped", result: null, note: `Vision skipped: ${gate.reason ?? "budget reached"}` };
      if (this.visionBlockedReason !== gate.reason) {
        this.visionBlockedReason = gate.reason;
        await this.o.sink.problem("vision", `Vision skipped: ${gate.reason ?? "budget reached"}`);
      }
      return false;
    }
    this.visionBlockedReason = null;
    try {
      const result = await this.o.vision.analyze(
        frames.map((f, i) => ({ index: i, ptsMs: f.ptsMs, jpeg: jpegs[i]! })),
        { profile: this.o.profile, sourceLabel: this.o.sourceLabel, previousSummary: this.lastSummary },
      );
      this.stats.visionCalls += 1;
      this.stats.visionFrames += frames.length;
      this.lastVision = { state: "analyzed", result, note: null };
      await this.o.sink.visionUsage(result, frames.length);
      this.lastSummary = result.analysis.scene.summary || null;
      let any = false;
      for (const c of visionCandidates(result, frames, new Date().toISOString())) any = (await this.fuse(c)) || any;
      return any;
    } catch (err) {
      this.stats.visionErrors += 1;
      const msg = err instanceof ProviderError ? err.message : `Vision analysis failed: ${(err as Error).message}`;
      this.lastVision = { state: "error", result: null, note: msg };
      await this.o.sink.problem("vision", msg);
      return false;
    }
  }

  private async fuse(c: Candidate): Promise<boolean> {
    const action = this.fusion.push(c);
    if (action.kind === "hold") return false;
    const id = await this.o.sink.persist(action);
    if (id && this.produced && !this.produced.some((p) => p.id === id)) {
      this.produced.push({ id, type: c.type, description: c.description, action: action.kind === "insert" ? "new" : "extended" });
    }
    if (action.kind === "insert" && id) {
      this.fusion.markInserted(action.key, id);
      this.stats.observations += 1;
      const hl = this.highlights.add({ id, type: c.type, mediaStartMs: c.mediaStartMs, evidence: c.evidence, description: c.description });
      if (hl && c.type !== "highlight_candidate") {
        const evidence = hl.events.flatMap((e) => e.evidence).slice(0, 6);
        const types = [...new Set(hl.events.map((e) => e.type.replace(/_/g, " ")))].join(" + ");
        await this.fuse({
          ...c,
          type: "highlight_candidate",
          description: `Highlight candidate: ${types}`.slice(0, 280),
          interpretation: "inferred",
          mediaStartMs: Math.min(...hl.events.map((e) => e.mediaStartMs)),
          mediaEndMs: c.mediaEndMs,
          evidence,
          rawText: null,
          modelConfidence: null,
          model: null,
          relatedEntities: [],
          minReadings: 1,
        });
      }
    }
    return true;
  }
}
