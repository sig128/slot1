import { describe, expect, it } from "vitest";
import { DroppedError, FairBatcher, type BatcherOptions } from "../../apps/inference/src/batcher";
import { hwaccelInputArgs, LiveIngestAdapter } from "@slot1/analysis";
import { parseExecutionProviders } from "@slot1/gta-runtime";

const opts = (o: Partial<BatcherOptions> = {}): BatcherOptions => ({ maxBatch: 4, maxWaitMs: 20, maxQueue: 100, maxPerStream: 100, concurrency: 1, ...o });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A run function that records batches and can be held open to build a backlog. */
function recorder() {
  const batches: string[][] = [];
  let release: (() => void) | null = null;
  let hold = false;
  return {
    batches,
    holdNext() {
      hold = true;
    },
    release() {
      hold = false;
      release?.();
      release = null;
    },
    run: async (inputs: string[]) => {
      batches.push(inputs);
      if (hold) await new Promise<void>((r) => (release = r));
      return inputs.map((x) => `out:${x}`);
    },
  };
}

describe("dynamic batching for many streams", () => {
  it("runs as soon as a batch is full, without waiting for the timer", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 3, maxWaitMs: 5000 }), r.run);
    const t0 = Date.now();
    const out = await Promise.all(["a", "b", "c"].map((x, i) => b.submit(`s${i}`, x)));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.batches).toEqual([["a", "b", "c"]]);
    expect(out.map((o) => o.output)).toEqual(["out:a", "out:b", "out:c"]);
    expect(out.every((o) => o.batchSize === 3)).toBe(true);
  });

  it("runs a partial batch when the wait window ends", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 10, maxWaitMs: 25 }), r.run);
    const p = Promise.all([b.submit("s1", "a"), b.submit("s2", "b")]);
    await sleep(5);
    expect(r.batches).toHaveLength(0);
    const out = await p;
    expect(r.batches).toEqual([["a", "b"]]);
    expect(out[0]!.queueMs).toBeGreaterThanOrEqual(15);
  });

  it("gives every request its own result, in order", async () => {
    const b = new FairBatcher(opts({ maxBatch: 8, maxWaitMs: 5 }), async (xs: number[]) => xs.map((x) => x * 10));
    const out = await Promise.all([1, 2, 3, 4, 5].map((x) => b.submit("one-stream", x)));
    expect(out.map((o) => o.output)).toEqual([10, 20, 30, 40, 50]);
  });

  it("refuses new frames at once when the whole queue is full", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 1, maxWaitMs: 0, maxQueue: 2 }), r.run);
    r.holdNext();
    const first = b.submit("s0", "running");
    await sleep(5); // first batch is now running and held
    const waiting = [b.submit("s1", "w1"), b.submit("s2", "w2")];
    const t0 = Date.now();
    await expect(b.submit("s3", "w3")).rejects.toMatchObject({ reason: "queue_full" });
    expect(Date.now() - t0).toBeLessThan(50);
    expect(b.counters.dropped.queue_full).toBe(1);
    r.release();
    await Promise.all([first, ...waiting]);
  });

  it("keeps a fast stream's newest frames and drops its oldest", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 10, maxWaitMs: 0, maxPerStream: 2 }), r.run);
    r.holdNext();
    const first = b.submit("busy", "f0");
    await sleep(5);
    const f1 = b.submit("busy", "f1");
    const f2 = b.submit("busy", "f2");
    const f3 = b.submit("busy", "f3");
    await expect(f1).rejects.toBeInstanceOf(DroppedError);
    await expect(f1).rejects.toMatchObject({ reason: "replaced_by_newer_frame" });
    r.release();
    await Promise.all([first, f2, f3]);
    expect(r.batches[1]).toEqual(["f2", "f3"]);
  });

  it("fills batches round-robin so one busy stream can't starve the others", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 4, maxWaitMs: 0 }), r.run);
    r.holdNext();
    const all = [b.submit("warmup", "w")];
    await sleep(5);
    for (let i = 0; i < 8; i++) all.push(b.submit("busy", `busy${i}`));
    all.push(b.submit("quiet-a", "a0"), b.submit("quiet-b", "b0"));
    r.release();
    await Promise.all(all);
    // The first batch after the backlog serves every waiting stream before more of "busy".
    expect(r.batches[1]).toEqual(["busy0", "a0", "b0", "busy1"]);
  });

  it("rejects waiting frames on shutdown and lets running batches finish", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 1, maxWaitMs: 0 }), r.run);
    r.holdNext();
    const running = b.submit("s", "run");
    await sleep(5);
    const waiting = b.submit("s", "wait");
    const closing = b.close();
    await expect(waiting).rejects.toMatchObject({ reason: "shutting_down" });
    r.release();
    await expect(running).resolves.toMatchObject({ output: "out:run" });
    await closing;
    await expect(b.submit("s", "late")).rejects.toMatchObject({ reason: "shutting_down" });
  });

  it("never runs a frame whose caller's deadline passed while it waited", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 1, maxWaitMs: 0 }), r.run);
    r.holdNext();
    const running = b.submit("s0", "run");
    await sleep(5);
    const late = b.submit("s1", "late", { deadline: performance.now() + 10 });
    const fresh = b.submit("s2", "fresh");
    await sleep(30);
    r.release();
    await expect(late).rejects.toMatchObject({ reason: "expired" });
    await Promise.all([running, fresh]);
    expect(r.batches).toEqual([["run"], ["fresh"]]);
    expect(b.counters.dropped.expired).toBe(1);
  });

  it("refuses at once when the waiting work wouldn't finish within half the caller's deadline", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 1, maxWaitMs: 0 }), r.run);
    // One slow batch (~40 ms) teaches the batcher how long a batch takes.
    r.holdNext();
    const warm = b.submit("s0", "warm");
    await sleep(40);
    r.release();
    await warm;
    r.holdNext();
    const running = b.submit("s0", "run"); // idle service: always admitted
    await sleep(5);
    const roomy = b.submit("s1", "roomy", { deadline: performance.now() + 1000 }); // ~2 batches ahead ≈ 80 ms < 500 ms
    const t0 = performance.now();
    await expect(b.submit("s2", "tight", { deadline: performance.now() + 100 })).rejects.toMatchObject({ reason: "busy" }); // ≈ 120 ms > 50 ms
    expect(performance.now() - t0).toBeLessThan(20);
    expect(b.counters.dropped.busy).toBe(1);
    r.release();
    await Promise.all([running, roomy]);
    expect(r.batches.flat()).not.toContain("tight");
  });

  it("drops a frame whose caller went away, and refuses one that was already cancelled", async () => {
    const r = recorder();
    const b = new FairBatcher(opts({ maxBatch: 1, maxWaitMs: 0 }), r.run);
    r.holdNext();
    const running = b.submit("s0", "run");
    await sleep(5);
    const ac = new AbortController();
    const gone = b.submit("s1", "gone", { signal: ac.signal });
    ac.abort();
    r.release();
    await expect(gone).rejects.toMatchObject({ reason: "cancelled" });
    await running;
    expect(r.batches).toEqual([["run"]]);
    await expect(b.submit("s1", "again", { signal: ac.signal })).rejects.toMatchObject({ reason: "cancelled" });
    expect(b.counters.dropped.cancelled).toBe(2);
  });
});

describe("hardware decoding options", () => {
  it("maps FFMPEG_HWACCEL to input options", () => {
    expect(hwaccelInputArgs("none")).toEqual([]);
    expect(hwaccelInputArgs(undefined)).toEqual([]);
    expect(hwaccelInputArgs("cuda")).toEqual(["-hwaccel", "cuda"]);
    expect(hwaccelInputArgs("cuda", "1")).toEqual(["-hwaccel", "cuda", "-hwaccel_device", "1"]);
    expect(hwaccelInputArgs("vaapi")).toEqual(["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128"]);
    expect(hwaccelInputArgs("videotoolbox")).toEqual(["-hwaccel", "videotoolbox"]);
    expect(() => hwaccelInputArgs("quantum" as never)).toThrow(/Unknown FFMPEG_HWACCEL/);
  });

  it("puts decoder options before the input and keeps frame dropping ahead of the downscale", () => {
    const make = (hwaccel?: "cuda" | "none") =>
      new LiveIngestAdapter(
        { sourceId: "s", broadcasterId: "b", sessionId: "x", kind: "live_ingest", label: "test" },
        { ffmpeg: "ffmpeg", ffprobe: "ffprobe", timeoutMs: 1000 },
        { readUrl: "rtmp://127.0.0.1/live/x", intervalMs: 1000, maxEdge: 1280, queueSize: 4, rollingBuffer: null, ioTimeoutSec: 5, hwaccel },
      ).buildArgs();
    const cuda = make("cuda");
    expect(cuda.indexOf("-hwaccel")).toBeGreaterThan(-1);
    expect(cuda.indexOf("-hwaccel")).toBeLessThan(cuda.indexOf("-i"));
    const vf = cuda[cuda.indexOf("-vf") + 1]!;
    expect(vf.indexOf("fps=")).toBeLessThan(vf.indexOf("scale="));
    expect(make("none")).not.toContain("-hwaccel");
  });
});

describe("execution providers", () => {
  it("keeps known providers in order and always ends with a CPU fallback", () => {
    expect(parseExecutionProviders("cuda,cpu")).toEqual(["cuda", "cpu"]);
    expect(parseExecutionProviders("CUDA")).toEqual(["cuda", "cpu"]);
    expect(parseExecutionProviders("tensorrt, cuda ,cuda")).toEqual(["tensorrt", "cuda", "cpu"]);
    expect(parseExecutionProviders("bogus")).toEqual(["cpu"]);
    expect(parseExecutionProviders(undefined)).toEqual(["cpu"]);
  });
});
