# Scaling the GTA model to many live streams

By default every worker loads the registry's active GTA model and runs it on its own CPU, one
frame at a time. That is simple and fine for a handful of streams. For many streams, one shared
**inference service** runs the model for all of them: it batches frames from every stream into
one model call, keeps streams fair, refuses work it can't finish in time, and swaps models without
dropping requests. Workers keep ingesting and analyzing exactly as before; only the GTA model call
moves.

```
streamer ─RTMP/SRT/WHIP─▶ gateway ─▶ worker: ffmpeg → a frame every N s → pipeline ─▶ observations, proposals
                                                         │  POST /v1/frames (JPEG at model size, ~9 KB)
                                                         ▼
                                      inference service: batches across streams, one ONNX session per model
```

Everything below about speed comes from the measurements in [Measured in this sandbox](#measured-in-this-sandbox-cpu-only).
Nothing in this document was run on a GPU.

## Turning it on

| Where | Variable | Default | Meaning |
| --- | --- | --- | --- |
| worker | `INFERENCE_URL` | empty | e.g. `http://inference:4100`. Empty = run the model in the worker, as before. |
| both | `INFERENCE_SHARED_SECRET` | empty | Required on every request (16+ characters). Production refuses to start a worker with a URL but no secret. |
| worker | `INFERENCE_TIMEOUT_MS` | 1500 | How long a live frame waits for the service; also sent as the frame's deadline. |
| service | `INFERENCE_HOST` / `INFERENCE_PORT` | 127.0.0.1 / 4100 | Bind address. Compose binds 0.0.0.0 inside its network and publishes no port. |
| service | `INFERENCE_MAX_BATCH` | 16 | Most frames per model call. |
| service | `INFERENCE_MAX_WAIT_MS` | 8 | How long the first waiting frame waits for company before a partial batch runs. |
| service | `INFERENCE_MAX_QUEUE` | 512 | Hard cap on waiting frames. |
| service | `INFERENCE_MAX_PER_STREAM` | 4 | Waiting frames per stream; a faster stream replaces its own oldest frame. |
| service | `INFERENCE_CONCURRENCY` | 1 | Batches running at once (keep 1 per GPU unless measurements say otherwise). |
| service | `INFERENCE_EXECUTION_PROVIDERS` | `cpu` | ONNX Runtime providers in order, e.g. `cuda,cpu`. CPU is always kept as the last fallback. |
| service | `INFERENCE_MODEL_POLL_MS` | 15000 | Registry check interval, in addition to the Redis notification. |
| worker | `FFMPEG_HWACCEL` / `FFMPEG_HWACCEL_DEVICE` | `none` / empty | Hardware video decoding for live ingest, see below. |

Run it locally with `pnpm --filter @slot1/inference dev` (it reads `.env` like the API), or with
Docker Compose: the `inference` service is in the `app` profile.

## The service (`apps/inference`)

Internal network only. Every request, including `/healthz` and `/metrics`, needs
`authorization: Bearer $INFERENCE_SHARED_SECRET` (compared in constant time); anything else gets 401.

| Endpoint | Answer |
| --- | --- |
| `POST /v1/frames` | Body: the JPEG (`content-type: image/jpeg`). Metadata travels in headers: `x-slot1-stream` (required, the fairness key; workers send `live:<sourceId>` or `file:<sourceId>`) and `x-slot1-deadline-ms` (optional, how long the caller will wait). |
| `GET /v1/model` | What is loaded: label, version, fingerprint, thresholds, input size, the providers actually in use, and notes (e.g. why CUDA fell back to CPU). |
| `GET /healthz` | `{ ok, model }`. |
| `GET /metrics` | JSON: latency and queue-wait percentiles (p50/p95/p99), batch run time (p50/p95), batch-size histogram, throughput over 10 s and 60 s, queue depth and expected wait, accepted/completed/failed/dropped counters by reason, the model status, recent swaps, and the batching settings. |

`POST /v1/frames` answers:

- `200 { status: "ok", prediction, model: { label, version, thresholds, inputSize }, timings: { queueMs, runMs, batchSize, totalMs } }`.
  `prediction` has exactly the shape the in-process model returns (an integration test checks that
  both give identical predictions for the same bytes).
- `429 { status: "dropped", reason }`, immediately, never after a wait (reasons below).
- `503 { status: "no_model" }` when no model is active; `400` for a missing stream header or a body that isn't a JPEG; `500` if the model run fails.

### Batching, fairness and backpressure

Frames from all streams go into one queue (`apps/inference/src/batcher.ts`). A batch runs as soon
as `INFERENCE_MAX_BATCH` frames are waiting, or `INFERENCE_MAX_WAIT_MS` after the first one arrived.
Batches are filled round-robin, one frame per stream per round, so a stream that sends many frames
can't starve the others. Refusals are always immediate:

| Reason | When |
| --- | --- |
| `replaced_by_newer_frame` | The stream already had `INFERENCE_MAX_PER_STREAM` frames waiting: its oldest one is answered with this and the new one queues. Live analysis wants the newest frame. |
| `queue_full` | `INFERENCE_MAX_QUEUE` frames are already waiting. |
| `busy` | The caller sent a deadline and the work already waiting wouldn't finish within half of it (estimated from recent batch run times). An idle service always accepts, which also re-measures after a slow spell. |
| `expired` | The deadline passed while the frame waited. It is never run. |
| `cancelled` | The caller disconnected while the frame waited. It is never run. |
| `shutting_down` | The service is stopping; running batches still finish. |

Why the deadline matters: without it, an overloaded service keeps a queue longer than any caller
waits, spends its time on frames nobody is waiting for any more, and almost every answer arrives
too late. The measurements below show this collapse and how the deadline fixes it.

Model calls: scene models exported by `ml/train_scene.py` have a dynamic batch axis, so a batch is
one ONNX run on an `[N,3,H,W]` tensor. A scene model exported with a fixed batch size is detected
on its first failed batch and from then on runs frame by frame. Detector models (torchvision
exports take one image) run frame by frame inside the batch, so they share the batching window but
not the speed-up. The JPEG is resized to the model's input size inside the service as well, so
callers that send full frames still work.

### Model hot-swap

Activating a model through the API publishes `slot1:models:changed` on Redis. The service reloads
on that message and also checks the registry every `INFERENCE_MODEL_POLL_MS` in case a message was
missed. The new model is downloaded, its sha256 and taxonomy are checked and its sessions are
created first; then it becomes current. Batches already running finish on the model they started
with, and the old sessions are released once nothing uses them. The integration test sends 60
concurrent requests across a swap: all answer 200, and later answers report the new version.

If the registry can't be read, the current model keeps serving. If the active model's files don't
load (checksum, taxonomy or session errors), the failure is reported to the operator errors and the
service answers `no_model`, as a worker would: the registry stays the source of truth and no other
model is substituted. Such a model is retried when the registry changes or a model is activated,
not on every poll (also covered by the integration tests).

## Worker side

With `INFERENCE_URL` set, the worker's GTA adapter (`apps/worker/src/gta/onnx-model.ts`) asks
`GET /v1/model` when a pipeline starts. No active model means no GTA model, the same as in-process.
An unreachable service is recorded as an operator error and the adapter keeps trying frame by frame.

- **Frames are reduced to the model's input size before they travel**, with the same stretch the
  model uses, so the service's own resize does nothing. On the sample replay a 224×224 frame is
  8,665 bytes on average against 43,424 bytes at 1280 px.
- **Live sources never wait**: one attempt, `INFERENCE_TIMEOUT_MS`, and the same value as the deadline.
  On a timeout, a refusal, a 401, 503 or 5xx answer, or a network error the frame gets no GTA prediction: the
  pipeline counts it (`modelSkipped`), adds one to the source's `frames_dropped` in source health,
  and reports a throttled problem with the reason (for example "the inference service is at
  capacity (busy)"). The rest of the frame's analysis carries on.
- **Uploads and replays** may wait: a timeout of at least 10 s, and up to 4 attempts with backoff
  when the service answers 429.
- Answers go through the same prediction gate, observations and proposals as in-process
  predictions. Thresholds and the label update from each answer, so a hot-swapped model's
  thresholds apply at once.

## Hardware video decoding (`FFMPEG_HWACCEL`)

`none` (default), `cuda`, `vaapi` or `videotoolbox` adds `-hwaccel …` before the live input
(`vaapi` also gets `-hwaccel_device`, `/dev/dri/renderD128` unless `FFMPEG_HWACCEL_DEVICE` says
otherwise; `cuda` passes the device only when set). There is deliberately no
`-hwaccel_output_format`: decoded frames come back to system memory, so the existing filter chain
is unchanged, and its frame dropping (`fps=`) still runs before the downscale (`scale=`), so only
the frames that will be analyzed get scaled. Unit tests check the mapping and the argument order.

Checked here, without any GPU (ffmpeg 6.1.1): when the requested decoder can't start, ffmpeg exits
("Device creation failed", "Hardware device setup failed for decoder") instead of falling back to
software decoding. A wrong setting therefore shows up in source health as `Ingest reader exited (…)`
with that message; set it back to `none`.

## CUDA with onnxruntime-node

What onnxruntime-node 1.31.1 offers (from its package and install script, read in this repo):

- The CPU execution provider on every platform; the CUDA and TensorRT providers **only on Linux x64,
  for CUDA 12** (with cuDNN 9; CUDA 11 is not supported since 1.22). The package README lists
  DirectML for Windows, CoreML for macOS and an experimental WebGPU provider; this repository only
  sets up CUDA.
- The CUDA/TensorRT provider libraries are not in the npm package. Its `postinstall` script
  downloads them from NuGet (`Microsoft.ML.OnnxRuntime.Gpu.Linux`). **pnpm skips that script here**
  (onnxruntime-node isn't in `onlyBuiltDependencies`), so a normal `pnpm install` has no CUDA
  provider. To fetch it: `ONNXRUNTIME_NODE_INSTALL=cuda12 node node_modules/onnxruntime-node/script/install.js`
  in a package that depends on it (`packages/gta-runtime` or `apps/inference`).
- The provider also needs the CUDA 12 runtime libraries and cuDNN 9 on the library path at run time.

Checked here: asking for `cuda,cpu` in this sandbox fails to load
`libonnxruntime_providers_shared.so`; the service then runs on CPU and says so in `/v1/model`
(`providers: ["cpu"]`, notes: "cuda,cpu unavailable (…Failed to load shared library); running on
CPU"). The load test prints the same. So a GPU box that silently runs on CPU is visible.

The `inference-gpu` image target (`infra/docker/app.Dockerfile`) starts from
`nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04` (override with the `CUDA_RUNTIME_IMAGE` build arg),
fetches the provider libraries at build time and sets `INFERENCE_EXECUTION_PROVIDERS=cuda,cpu`. To
use it with Compose, set the `inference` service's target to `inference-gpu` and uncomment its
NVIDIA device reservation (the host needs an NVIDIA driver and the NVIDIA Container Toolkit).
TensorRT also needs the TensorRT libraries, which that base image doesn't include. **Neither image
was built here (no Docker in this sandbox) and nothing ran on a GPU.**

## Measured in this sandbox (CPU only)

These numbers come from **this development sandbox**, not from production hardware:

- 2 vCPUs (Intel Xeon @ 2.10 GHz), 8 GB RAM, **no GPU**, Linux 6.18, Node 22.23.4,
  onnxruntime-node 1.31.1 with the CPU provider.
- The load generator and the service were separate processes **on the same 2 vCPUs**, so they
  competed for CPU. The development stack (API, worker, web, Postgres, Redis, nginx-rtmp) was
  running idle on the same machine.
- Model: an **untrained** MobileNetV3-Small scene model at 224×224, the same architecture
  `ml/train_scene.py` trains (`scripts/loadtest/export_bench_model.py`). Speed depends on the
  architecture, not the weights. Never upload this model to the registry.
- Frames: 10 real frames from the generated sample replay, reduced to 224×224 before sending like
  the worker does (8,665 bytes on average).
- Each stream sends 1 frame/s, which is the fastest live setting (the default is one frame every
  5 s). 20 s per level, client timeout 1,500 ms, service defaults (batch 16, wait 8 ms, queue 512,
  4 per stream, concurrency 1).
- Latency is measured by the client over answered frames only. Command:
  `pnpm exec tsx scripts/load-test.ts --model bench --streams 10,50,100,200,250 --fps 1 --seconds 20`
  (and `--streams 300,400,600`).

**Current build** (requests carry their deadline, as the worker's do):

| Streams | Offered/s | Answered/s | p50 ms | p95 ms | p99 ms | Server queue p95 ms | Batch mean (max) | Refused at once | Timed out |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 10 | 17.6 | 26.5 | 47.5 | 8.4 | 1 (1) | 0 | 0 |
| 50 | 50 | 50 | 16.7 | 25.5 | 35.2 | 11.9 | 1.11 (2) | 0 | 0 |
| 100 | 100 | 100 | 20.4 | 33.3 | 56.2 | 16.5 | 2.04 (6) | 0 | 0 |
| 200 | 200 | 198.9 | 95 | 289.6 | 353.6 | 184.5 | 12.98 (16) | 0 | 0 |
| 250 | 250 | 198.1 | 686 | 841.7 | 889.7 | 717.2 | 15.96 (16) | 900 busy | 0 |
| 300 | 300 | 188 | 725 | 854.6 | 1167.8 | 710.6 | 15.94 (16) | 2,079 busy | 0 |
| 400 | 400 | 182.4 | 726.2 | 887.2 | 950 | 742.2 | 15.96 (16) | 4,188 busy | 0 |
| 600 | 600 | 184.3 | 742.3 | 902.1 | 963 | 749.1 | 15.98 (16) | 8,166 busy | 0 |

**Before deadlines** (an earlier build the same day, same machine and settings):

| Streams | Offered/s | Answered/s | p50 ms | p95 ms | p99 ms | Server queue p95 ms | Batch mean (max) | Refused at once | Timed out |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 10 | 17.7 | 23.7 | 32.9 | 8.4 | 1 (1) | 0 | 0 |
| 50 | 50 | 50 | 16.2 | 22.9 | 31.9 | 9.9 | 1.02 (2) | 0 | 0 |
| 100 | 100 | 100 | 17.6 | 27.7 | 51.3 | 13.7 | 1.95 (7) | 0 | 0 |
| 200 | 200 | 199.4 | 87.9 | 147.7 | 168.4 | 67.4 | 12.54 (16) | 0 | 0 |
| 300 | 300 | 36.7 | 554.6 | 1469.6 | 1497.6 | 1349.2 | 15.8 (16) | 1,585 queue_full | 3,619 |
| 400 | 400 | 28.9 | 999.7 | 1493.5 | 1499.9 | 1386.3 | 15.93 (16) | 3,318 queue_full | 4,037 |
| 600 | 600 | 13.5 | 849 | 1440.7 | 1453 | 1314.7 | 16 (16) | 7,799 queue_full | 3,872 |

The current build with `--no-deadline` at 300 streams answered 80.2/s with 4,265 timeouts (p95
1,476.8 ms): dropping frames whose caller disconnected helps, but without a deadline the queue
still holds more work than fits in the timeout.

What these runs show, on this machine:

- The service saturates at about 200 frames/s. Below that, p50 is 16–20 ms, of which about 8 ms is
  the batching window (a lone frame waits `INFERENCE_MAX_WAIT_MS` for company).
- Batches grow with load on their own (mean 1 at 10 streams, 13–16 near saturation).
- Above saturation, with deadlines, the service keeps answering 182–198 frames/s with no timeouts,
  answered frames come back with p50 0.69–0.74 s and p95 0.84–0.90 s (by design, within about half
  the 1.5 s deadline; the worst p99 was 1.17 s), and the excess is refused at once. Without deadlines, answered frames fell to 13.5–36.7/s.
- Answered/s dropping from about 198 to 182–188 at 300–600 streams is probably the load generator
  itself (it sends up to 600 requests/s on the same 2 vCPUs); that wasn't isolated.
- Near the knee results vary between runs: 200 streams gave p95 147.7 ms in one run and 289.6 ms in
  another on this shared 2-vCPU machine.

Arithmetic, **not measured**: at the default sampling of one frame every 5 s, 200 frames/s is the
model load of about 1,000 streams. That leaves out everything else a stream costs (ffmpeg
decoding, OCR and AI vision in the workers), which this test didn't include.

**Ingest mode**, also measured here: 2 looping test streams through nginx-rtmp into the real dev
worker for 40 s (`--mode ingest --streams 2 --seconds 40`; OCR on, AI vision not configured, no
active GTA model, default sampling of one frame every 5 s). Each source received 8 frames,
analyzed 5–6, dropped 0; frame lag (received → analyzed) p50 1,270 ms, p95 2,865 ms over both
sources. This measures ingest and the pipeline on this box, not model inference.

## Running the load test on a rented GPU box

Record GPU results under their own heading here, with the GPU model and driver; don't mix them into
the sandbox tables above. The JSON report (`--json file`) includes CPU, memory, `nvidia-smi`'s GPU
list, the providers in use and any fallback notes.

**A. The repository on the box** (quickest; serves the benchmark model, no database needed):

```bash
# Linux x64 with an NVIDIA driver for CUDA 12, plus the CUDA 12 runtime and cuDNN 9 libraries
# (or run inside an nvidia/cuda:12.x-cudnn-runtime container). Node 22, pnpm, ffmpeg, python3.
pnpm install
(cd packages/gta-runtime && ONNXRUNTIME_NODE_INSTALL=cuda12 node node_modules/onnxruntime-node/script/install.js)
pip install torch torchvision onnx        # only to export the untrained --model bench
pnpm exec tsx scripts/load-test.ts --model bench --providers cuda,cpu \
  --streams 200,500,1000,2000 --fps 1 --seconds 30 --max-batch 32 --json .data/load-test/gpu.json
```

Check the printed `providers`: it must include `cuda`. If it says `["cpu"]`, read `providerNotes`
for the reason. To test a trained model instead, pass `--model path/to/model.onnx --meta
path/to/model.json` as written by `ml/train_scene.py`.

**B. The real service with your registry's model**: build and run the `inference-gpu` target (see
above) with the stack's `.env`, publish its port on localhost only for the test (for example
`docker run --gpus all -p 127.0.0.1:4100:4100 --env-file .env -e INFERENCE_HOST=0.0.0.0 …`), and
point the load test at it:

```bash
pnpm exec tsx scripts/load-test.ts --url http://127.0.0.1:4100 --secret "$INFERENCE_SHARED_SECRET" \
  --streams 200,500,1000 --fps 1 --seconds 30 --json .data/load-test/gpu-service.json
```

With `--url`, the report's hardware block describes the machine running the load generator; run
it on the GPU box itself or note where the service ran.

Tuning starting points (not measured on a GPU): raise `INFERENCE_MAX_BATCH` to 32–64, keep
`INFERENCE_MAX_WAIT_MS` small (it adds directly to latency at low load), keep one batch running per
GPU, then compare runs. On a running service, watch `/metrics`: steady `busy` refusals mean the
service is short of capacity for the offered rate; add capacity or sample frames less often (the
per-channel sampling interval). Several service replicas behind a load balancer should work (each
has its own queue and all reload on the same Redis channel), but fairness is then per replica;
that setup wasn't tested.

## Not verified here

- Anything on a GPU: the CUDA and TensorRT providers, the `inference-gpu` image, and hardware
  decoding with `cuda`, `vaapi` or `videotoolbox` (only the arguments and the no-device failure
  were checked).
- Docker: no image was built; the Compose file was only checked as YAML.
- Ingest through MediaMTX (the ingest-mode run used nginx-rtmp).
- Model quality: the benchmark model is untrained on purpose and says nothing about accuracy.
