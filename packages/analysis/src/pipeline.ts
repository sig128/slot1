import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceLabel } from "@slot1/contracts";
import { ocrCandidates, visionCandidates, type FrameRef } from "./candidates";
import { FusionWindow, HighlightScorer, type Candidate, type FusionAction } from "./fusion";
import { GtaPredictionGate, type FrameModel, type FramePrediction } from "./gta/model";
import { weakLabelsFromOcr, type WeakLabel } from "./gta/weak-labels";
import type { OcrEngine, OcrLine } from "./ocr";
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
  trainingFrame?(input: { frame: SampledFrame; ref: FrameRef; weakLabels: WeakLabel[]; prediction: FramePrediction | null }): Promise<void>;
  /** The GTA model skipped this frame (e.g. the shared inference service was busy). Optional. */
  modelFrameSkipped?(frame: FrameRef, reason: string): Promise<void>;
}

export interface PipelineOptions {
  ocr: OcrEngine | null;
  ocrVersion: string;
  vision: VisionProvider | null;
  /** SLOT1's own trained GTA model (active registry version), when one is deployed. */
  gtaModel?: FrameModel | null;
  profile: GameProfile;
  sourceLabel: SourceLabel;
  visionBatchSize: number;
  /** Interval each analyzed frame stands for when computing coverage. */
  coverageMsPerFrame: number;
  workDir: string;
  sink: PipelineSink;
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
  readonly stats = { frames: 0, analyzedFrames: 0, visionFrames: 0, visionCalls: 0, observations: 0, visionErrors: 0, ocrLines: 0, modelFrames: 0, modelSkipped: 0 };
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

  async handleFrame(frame: SampledFrame): Promise<void> {
    const { assetId } = await this.o.sink.storeFrame(frame);
    const ref: FrameRef = { ptsMs: frame.ptsMs, assetId, receivedAt: frame.receivedAt, capturedAt: frame.capturedAt };
    this.frameRefs.push(ref);
    this.stats.frames += 1;
    let hadResult = false;
    const nowIso = () => new Date().toISOString();
    let ocrLines: OcrLine[] = [];

    if (this.o.ocr) {
      const dir = path.join(this.o.workDir, "ocr");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${frame.ptsMs}.jpg`);
      await writeFile(file, frame.jpeg);
      try {
        const lines = await this.o.ocr.readFrame(file, this.o.profile, dir);
        ocrLines = lines;
        this.stats.ocrLines += lines.length;
        for (const c of ocrCandidates(lines, ref, this.o.ocrVersion, nowIso())) hadResult = (await this.fuse(c)) || hadResult;
      } catch (err) {
        await this.o.sink.problem("ocr", `OCR failed on a frame: ${(err as Error).message}`);
      } finally {
        await rm(file, { force: true });
      }
    }

    let prediction: FramePrediction | null = null;
    if (this.o.gtaModel && this.gtaGate) {
      try {
        prediction = await this.o.gtaModel.predict(frame.jpeg);
        if (prediction) {
          this.stats.modelFrames += 1;
          for (const c of this.gtaGate.candidates(prediction, ref, nowIso())) hadResult = (await this.fuse(c)) || hadResult;
        } else {
          // Skipped, not failed: nothing is published for this frame and the skip is counted.
          this.stats.modelSkipped += 1;
          const why = this.o.gtaModel.skipReason ?? "skipped";
          await this.o.sink.modelFrameSkipped?.(ref, why);
          await this.o.sink.problem("gta-model", `GTA model skipped frames: ${why}`);
        }
      } catch (err) {
        await this.o.sink.problem("gta-model", `GTA model failed on a frame: ${(err as Error).message}`);
      }
    }

    if (this.o.vision) {
      this.batch.push(ref);
      this.batchJpegs.push(frame.jpeg);
      if (this.batch.length >= this.o.visionBatchSize) hadResult = (await this.runVision()) || hadResult;
    }

    if (this.o.sink.trainingFrame) {
      try {
        await this.o.sink.trainingFrame({ frame, ref, weakLabels: weakLabelsFromOcr(ocrLines), prediction });
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
  }

  /** Process any frames still waiting for a vision batch. */
  async flush(): Promise<void> {
    if (this.o.vision && this.batch.length > 0) await this.runVision();
  }

  /** Persist a measured/deterministic candidate through the same fusion path. */
  async addCandidate(c: Candidate): Promise<void> {
    await this.fuse(c);
  }

  private async runVision(): Promise<boolean> {
    const frames = this.batch;
    const jpegs = this.batchJpegs;
    this.batch = [];
    this.batchJpegs = [];
    if (!this.o.vision || frames.length === 0) return false;
    const gate = await this.o.sink.allowVisionCall();
    if (!gate.allowed) {
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
      await this.o.sink.visionUsage(result, frames.length);
      this.lastSummary = result.analysis.scene.summary || null;
      let any = false;
      for (const c of visionCandidates(result, frames, new Date().toISOString())) any = (await this.fuse(c)) || any;
      return any;
    } catch (err) {
      this.stats.visionErrors += 1;
      const msg = err instanceof ProviderError ? err.message : `Vision analysis failed: ${(err as Error).message}`;
      await this.o.sink.problem("vision", msg);
      return false;
    }
  }

  private async fuse(c: Candidate): Promise<boolean> {
    const action = this.fusion.push(c);
    if (action.kind === "hold") return false;
    const id = await this.o.sink.persist(action);
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
