import { tmpdir } from "node:os";
import path from "node:path";
import { loadRuntime, releaseUnused, type GtaRuntime } from "@slot1/gta-runtime";
import { listActiveModels, recordOpsError, type Queryable } from "@slot1/db";
import { sanitizeErrorMessage, type Logger, type StorageDriver } from "@slot1/platform";

/** What the server needs from a model holder (registry-backed, or fixed for load tests). */
export interface ModelSource {
  readonly hasModel: boolean;
  readonly swaps: { at: string; from: string | null; to: string | null }[];
  status(): ModelStatus;
  withRuntime<T>(fn: (rt: GtaRuntime | null) => Promise<T>): Promise<T>;
}

/** One fixed model (load tests, benchmarks). No registry, no swapping. */
export class StaticModelSource implements ModelSource {
  readonly swaps: { at: string; from: string | null; to: string | null }[] = [];
  private readonly loadedAt = new Date().toISOString();
  constructor(private readonly runtime: GtaRuntime) {}
  get hasModel() {
    return true;
  }
  status(): ModelStatus {
    const rt = this.runtime;
    return { active: true, label: rt.label, version: rt.version, fingerprint: rt.fingerprint, thresholds: rt.thresholds, inputSize: rt.inputSize, providers: rt.providers, notes: rt.notes, loadedAt: this.loadedAt, lastCheckAt: null, lastError: null };
  }
  withRuntime<T>(fn: (rt: GtaRuntime | null) => Promise<T>): Promise<T> {
    return fn(this.runtime);
  }
}

interface Holder {
  runtime: GtaRuntime;
  inUse: number;
}

export interface ModelStatus {
  active: boolean;
  label: string | null;
  version: string | null;
  fingerprint: string | null;
  thresholds: GtaRuntime["thresholds"] | null;
  inputSize: { width: number; height: number } | null;
  providers: string[];
  notes: string[];
  loadedAt: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
}

/**
 * Holds the registry's active GTA model(s) for the whole service and swaps them without dropping
 * work: a batch keeps the runtime it started with; the previous model's sessions are released
 * only once no batch uses them.
 */
export class ModelManager implements ModelSource {
  private current: Holder | null = null;
  /** Previous models still used by a running batch. */
  private readonly retired = new Set<Holder>();
  private loading: Promise<void> | null = null;
  private loadedAt: Date | null = null;
  private lastCheckAt: Date | null = null;
  private lastError: string | null = null;
  /** Registry state whose model files didn't (all) load: not retried on every poll. */
  private failedFingerprint: string | null = null;
  readonly swaps: { at: string; from: string | null; to: string | null }[] = [];

  constructor(
    private readonly deps: { db: Queryable; storage: StorageDriver; log: Logger; providers: string[]; cacheDir?: string },
  ) {}

  get hasModel(): boolean {
    return this.current !== null;
  }

  status(): ModelStatus {
    const rt = this.current?.runtime ?? null;
    return {
      active: Boolean(rt),
      label: rt?.label ?? null,
      version: rt?.version ?? null,
      fingerprint: rt?.fingerprint ?? null,
      thresholds: rt?.thresholds ?? null,
      inputSize: rt?.inputSize ?? null,
      providers: rt?.providers ?? this.deps.providers,
      notes: rt?.notes ?? [],
      loadedAt: this.loadedAt?.toISOString() ?? null,
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  /** Run with the runtime current at call time; it stays alive until the call finishes. */
  async withRuntime<T>(fn: (rt: GtaRuntime | null) => Promise<T>): Promise<T> {
    const holder = this.current;
    if (holder) holder.inUse += 1;
    try {
      return await fn(holder?.runtime ?? null);
    } finally {
      if (holder) {
        holder.inUse -= 1;
        void this.releaseIfRetired(holder);
      }
    }
  }

  /** Re-read the registry; load and swap only when the active model files changed. */
  reload(reason: string): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.doReload(reason).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doReload(reason: string) {
    this.lastCheckAt = new Date();
    try {
      const rows = await listActiveModels(this.deps.db);
      const fingerprint = rows.map((r) => r.onnx_sha256).sort().join("+") || null;
      if (fingerprint === (this.current?.runtime.fingerprint ?? null)) return;
      // Each attempt downloads the files and records an operator error, so a model that didn't load
      // is retried when the registry changes or a model is activated, not every poll.
      if (reason === "poll" && fingerprint === this.failedFingerprint) return;
      this.lastError = null;
      const runtime = rows.length
        ? await loadRuntime(rows, {
            cacheDir: this.deps.cacheDir ?? path.join(tmpdir(), "slot1-inference-models"),
            providers: this.deps.providers,
            fetchToFile: (row, dest) => this.deps.storage.downloadToFile(row.onnx_storage_key, dest),
            onSkip: async (row, why) => {
              const msg = `Inference service skipped model ${row.name}@${row.version}: ${sanitizeErrorMessage(why)}`;
              this.lastError = msg;
              this.deps.log.warn(msg);
              await recordOpsError(this.deps.db, null, "gta-model", msg).catch(() => undefined);
            },
          })
        : null;
      this.failedFingerprint = (runtime?.parts.length ?? 0) < rows.length ? fingerprint : null;
      const old = this.current;
      this.current = runtime ? { runtime, inUse: 0 } : null;
      this.loadedAt = new Date();
      this.swaps.push({ at: this.loadedAt.toISOString(), from: old?.runtime.version ?? null, to: runtime?.version ?? null });
      if (this.swaps.length > 20) this.swaps.shift();
      this.deps.log.info({ reason, from: old?.runtime.version ?? null, to: runtime?.version ?? null, providers: runtime?.providers ?? [] }, "GTA model swapped");
      for (const note of runtime?.notes ?? []) this.deps.log.warn(note);
      if (old) {
        this.retired.add(old);
        await this.releaseIfRetired(old);
      }
    } catch (err) {
      this.lastError = sanitizeErrorMessage((err as Error).message);
      this.deps.log.error({ err: this.lastError }, "model reload failed; keeping the current model");
    }
  }

  private async releaseIfRetired(holder: Holder) {
    if (holder === this.current || holder.inUse > 0) return;
    this.retired.delete(holder);
    // Keep the current model and any older one a batch is still running on.
    const keep = new Set<string>();
    for (const h of [this.current, ...this.retired]) for (const p of h?.runtime.parts ?? []) keep.add(p.row.onnx_sha256);
    await releaseUnused(keep);
  }
}
