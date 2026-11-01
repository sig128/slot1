/** Rolling, in-memory service metrics. Measurements only; nothing is estimated. */

class Reservoir {
  private readonly values: number[] = [];
  private next = 0;
  constructor(private readonly size: number) {}
  add(v: number) {
    if (this.values.length < this.size) this.values.push(v);
    else {
      this.values[this.next] = v;
      this.next = (this.next + 1) % this.size;
    }
  }
  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[idx]! * 10) / 10;
  }
  get count() {
    return this.values.length;
  }
}

export class Metrics {
  private readonly latency = new Reservoir(4000);
  private readonly queueWait = new Reservoir(4000);
  private readonly batchRun = new Reservoir(2000);
  private readonly batchSizes = new Map<number, number>();
  /** Completion timestamps for throughput over a sliding window. */
  private readonly completions: number[] = [];
  readonly startedAt = Date.now();

  frame(totalMs: number, queueMs: number) {
    this.latency.add(totalMs);
    this.queueWait.add(queueMs);
    const now = Date.now();
    this.completions.push(now);
    while (this.completions.length && now - this.completions[0]! > 60_000) this.completions.shift();
  }

  batch(size: number, runMs: number) {
    this.batchSizes.set(size, (this.batchSizes.get(size) ?? 0) + 1);
    this.batchRun.add(runMs);
  }

  throughput(windowMs: number): number {
    const now = Date.now();
    const n = this.completions.filter((t) => now - t <= windowMs).length;
    return Math.round((n / (windowMs / 1000)) * 10) / 10;
  }

  snapshot() {
    const sizes = [...this.batchSizes.entries()].sort((a, b) => a[0] - b[0]);
    const batches = sizes.reduce((n, [, c]) => n + c, 0);
    const frames = sizes.reduce((n, [s, c]) => n + s * c, 0);
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      latencyMs: { p50: this.latency.percentile(50), p95: this.latency.percentile(95), p99: this.latency.percentile(99), samples: this.latency.count },
      queueWaitMs: { p50: this.queueWait.percentile(50), p95: this.queueWait.percentile(95), p99: this.queueWait.percentile(99) },
      batchRunMs: { p50: this.batchRun.percentile(50), p95: this.batchRun.percentile(95) },
      batchSize: { mean: batches ? Math.round((frames / batches) * 100) / 100 : null, histogram: Object.fromEntries(sizes) },
      throughputFps: { last10s: this.throughput(10_000), last60s: this.throughput(60_000) },
    };
  }
}
