/**
 * Dynamic batching across many live streams.
 *
 * - A batch runs as soon as `maxBatch` frames are waiting, or `maxWaitMs` after the first one
 *   arrived, whichever comes first; at most `concurrency` batches run at once.
 * - Bounded: each stream may have `maxPerStream` frames waiting. When a stream sends faster than
 *   it can be served, its OLDEST waiting frame is dropped (live analysis wants the newest frame).
 *   When the whole queue holds `maxQueue` frames, new frames are refused immediately.
 * - Fair: batches are filled round-robin across streams, one frame per stream per round, so a
 *   busy stream can't starve the others.
 * - Deadline-aware: a caller may say how long it will wait. A frame is refused at once ("busy") when
 *   the work already waiting wouldn't finish within half of that time, and a frame whose caller has
 *   given up (deadline passed or request cancelled) is dropped before it reaches the model. Overload
 *   then shows up as fast refusals while the frames that are accepted still come back in time,
 *   instead of a long queue whose answers all arrive after their callers stopped waiting.
 * Nothing ever blocks the caller beyond the batching window and the inference itself.
 */

export interface BatcherOptions {
  maxBatch: number;
  maxWaitMs: number;
  maxQueue: number;
  maxPerStream: number;
  concurrency: number;
}

export type DropReason = "queue_full" | "busy" | "replaced_by_newer_frame" | "expired" | "cancelled" | "shutting_down";

export interface SubmitOptions {
  /** performance.now() time after which the caller no longer wants the answer. */
  deadline?: number;
  /** Aborts when the caller goes away (e.g. the HTTP client disconnected). */
  signal?: AbortSignal;
}

export class DroppedError extends Error {
  constructor(readonly reason: DropReason) {
    super(`frame dropped: ${reason}`);
  }
}

export interface BatchInfo {
  size: number;
  /** Time the oldest frame in the batch waited before the batch started. */
  maxQueueMs: number;
  runMs: number;
}

interface Item<I, O> {
  input: I;
  stream: string;
  enqueuedAt: number;
  deadline: number;
  cancelled: boolean;
  resolve(v: { output: O; queueMs: number; runMs: number; batchSize: number }): void;
  reject(err: Error): void;
}

export class FairBatcher<I, O> {
  private readonly queues = new Map<string, Item<I, O>[]>();
  /** Round-robin order of streams that have waiting frames. */
  private readonly order: string[] = [];
  private waiting = 0;
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  readonly counters = { accepted: 0, completed: 0, failed: 0, dropped: { queue_full: 0, busy: 0, replaced_by_newer_frame: 0, expired: 0, cancelled: 0, shutting_down: 0 } as Record<DropReason, number> };
  /** Moving average of recent batch run times. */
  private runEstimateMs = 0;

  constructor(
    private readonly opts: BatcherOptions,
    private readonly run: (inputs: I[]) => Promise<O[]>,
    private readonly onBatch?: (info: BatchInfo) => void,
  ) {}

  get depth(): number {
    return this.waiting;
  }

  get inFlight(): number {
    return this.running;
  }

  get streams(): number {
    return this.queues.size;
  }

  /** Rough time until a frame submitted now would have its answer, from recent batch run times. */
  get expectedWaitMs(): number {
    const batchesAhead = Math.ceil((this.waiting + 1) / this.opts.maxBatch) + (this.running >= this.opts.concurrency ? 1 : 0);
    return Math.ceil(batchesAhead / this.opts.concurrency) * this.runEstimateMs;
  }

  submit(stream: string, input: I, opts: SubmitOptions = {}): Promise<{ output: O; queueMs: number; runMs: number; batchSize: number }> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new DroppedError("shutting_down"));
      if (opts.signal?.aborted) {
        this.counters.dropped.cancelled += 1;
        return reject(new DroppedError("cancelled"));
      }
      const now = performance.now();
      // An idle service always admits, which also re-measures the batch time after a slow spell.
      if (opts.deadline !== undefined && (this.waiting > 0 || this.running > 0) && this.expectedWaitMs > (opts.deadline - now) / 2) {
        this.counters.dropped.busy += 1;
        return reject(new DroppedError("busy"));
      }
      let q = this.queues.get(stream);
      // A stream with waiting frames is already in the round-robin order.
      const alreadyQueued = q !== undefined && q.length > 0;
      if (q && q.length >= this.opts.maxPerStream) {
        // Keep the newest frames of a fast stream; tell the replaced frame's caller at once.
        const old = q.shift()!;
        this.waiting -= 1;
        this.counters.dropped.replaced_by_newer_frame += 1;
        old.reject(new DroppedError("replaced_by_newer_frame"));
      } else if (this.waiting >= this.opts.maxQueue) {
        this.counters.dropped.queue_full += 1;
        return reject(new DroppedError("queue_full"));
      }
      if (!q) {
        q = [];
        this.queues.set(stream, q);
      }
      if (!alreadyQueued) this.order.push(stream);
      const item: Item<I, O> = { input, stream, enqueuedAt: now, deadline: opts.deadline ?? Infinity, cancelled: false, resolve, reject };
      q.push(item);
      this.waiting += 1;
      this.counters.accepted += 1;
      // A cancelled frame stays in the queue but is skipped (and answered) when its turn comes.
      opts.signal?.addEventListener("abort", () => (item.cancelled = true), { once: true });
      this.schedule();
    });
  }

  private schedule() {
    if (this.waiting === 0 || this.running >= this.opts.concurrency) return;
    if (this.waiting >= this.opts.maxBatch || this.opts.maxWaitMs <= 0) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.opts.maxWaitMs);
    }
  }

  /** Take up to maxBatch frames, one per stream per round, oldest first within a stream. */
  private take(): Item<I, O>[] {
    const batch: Item<I, O>[] = [];
    const now = performance.now();
    while (batch.length < this.opts.maxBatch && this.order.length > 0) {
      const rounds = this.order.length;
      for (let i = 0; i < rounds && batch.length < this.opts.maxBatch; i++) {
        const stream = this.order.shift()!;
        const q = this.queues.get(stream)!;
        const item = q.shift()!;
        this.waiting -= 1;
        if (item.cancelled || item.deadline <= now) {
          const reason: DropReason = item.cancelled ? "cancelled" : "expired";
          this.counters.dropped[reason] += 1;
          item.reject(new DroppedError(reason));
        } else batch.push(item);
        if (q.length > 0) this.order.push(stream);
        else this.queues.delete(stream);
      }
    }
    return batch;
  }

  private flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.waiting > 0 && this.running < this.opts.concurrency) {
      const batch = this.take();
      if (batch.length === 0) break;
      void this.execute(batch);
    }
  }

  private async execute(batch: Item<I, O>[]) {
    this.running += 1;
    const started = performance.now();
    const maxQueueMs = Math.max(...batch.map((b) => started - b.enqueuedAt));
    try {
      const outputs = await this.run(batch.map((b) => b.input));
      const runMs = performance.now() - started;
      this.runEstimateMs = this.runEstimateMs === 0 ? runMs : 0.8 * this.runEstimateMs + 0.2 * runMs;
      this.onBatch?.({ size: batch.length, maxQueueMs, runMs });
      batch.forEach((b, i) => {
        const output = outputs[i];
        if (output === undefined) {
          this.counters.failed += 1;
          b.reject(new Error("inference returned fewer results than inputs"));
        } else {
          this.counters.completed += 1;
          b.resolve({ output, queueMs: started - b.enqueuedAt, runMs, batchSize: batch.length });
        }
      });
    } catch (err) {
      this.counters.failed += batch.length;
      for (const b of batch) b.reject(err as Error);
    } finally {
      this.running -= 1;
      this.schedule();
    }
  }

  /** Refuse new frames, reject waiting ones, and wait for running batches to finish. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const q of this.queues.values()) {
      for (const item of q) {
        this.counters.dropped.shutting_down += 1;
        item.reject(new DroppedError("shutting_down"));
      }
    }
    this.queues.clear();
    this.order.length = 0;
    this.waiting = 0;
    while (this.running > 0) await new Promise((r) => setTimeout(r, 10));
  }
}
