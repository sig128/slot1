import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { deleteSession } from "../../apps/worker/src/jobs/maintenance";
import { splitForSession } from "@slot1/contracts";
import { createReplaySession, insertTrainingFrame } from "@slot1/db";
import { storageKeys } from "@slot1/platform";
import { TRAINING_SPLIT_SEED } from "@slot1/services";
import { Browser, multipart, startHarness, type Harness } from "./harness";

const ROOT = path.resolve(__dirname, "../..");
const SAMPLE = path.join(ROOT, "tests/fixtures/generated/sample-replay.mp4");
const hasTorch = spawnSync("python3", ["-c", "import torch, torchvision, onnx, onnxruntime"], { stdio: "ignore" }).status === 0;

/** The synthetic sample's scenes by media time (scripts/make-sample-video.sh). */
const sceneAt = (ms: number) => (ms < 12_000 ? "driving" : ms < 14_000 ? "loading_or_black" : ms < 26_000 ? "on_foot" : "cutscene");

describe("GTA model training engine", () => {
  let h: Harness;
  let creator: Browser;
  let other: Browser;
  let stranger: Browser;
  let operator: Browser;
  let creatorBroadcaster = "";
  let datasetId = "";
  let exportDir = "";
  let firstSession = "";

  async function upload(b: Browser, title: string) {
    const form = await multipart({ title, rightsConfirmed: "true" }, { field: "file", filename: "run.mp4", path: SAMPLE, type: "video/mp4" });
    const r = await b.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(r.status).toBe(200);
    const { sessionId, sourceId } = r.json<{ sessionId: string; sourceId: string }>();
    const job = h.jobs.find((j) => j.name === "analyze-upload" && (j.data as { sessionId: string }).sessionId === sessionId)!;
    await analyzeUpload(h.ctx, job.data as Parameters<typeof analyzeUpload>[1]);
    return { sessionId, sourceId };
  }
  const framesOf = async (sessionId: string) =>
    (await h.ctx.db.query<{ id: string; storage_key: string; media_pts_ms: string }>(`SELECT id, storage_key, media_pts_ms FROM training_frames WHERE session_id = $1 ORDER BY media_pts_ms`, [sessionId])).rows;

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.join(ROOT, "scripts/make-sample-video.sh")], { stdio: "ignore" });
    h = await startHarness();
    creator = new Browser(h);
    other = new Browser(h);
    stranger = new Browser(h);
    operator = new Browser(h);
    await creator.signInLocal("Training Crew");
    await other.signInLocal("No Consent Crew");
    await stranger.signInLocal("Stranger Crew");
    const op = await operator.signInLocal("Ops");
    await h.ctx.db.query(`UPDATE users SET is_operator = true WHERE id = $1`, [(op.user as { id: string }).id]);
    creatorBroadcaster = ((await creator.get("/api/me")).json().broadcaster as { id: string }).id;
  });
  afterAll(async () => {
    // Other suites share this database: leave no model active behind us.
    await h?.ctx.db.query(`UPDATE models SET status = 'retired' WHERE status = 'active'`).catch(() => undefined);
    await h?.close();
  });

  it("collects nothing from creators who haven't opted in", async () => {
    const overview = (await other.get("/api/training")).json();
    expect(overview.consent).toBe(false);
    const { sessionId } = await upload(other, "No consent run");
    expect(await framesOf(sessionId)).toHaveLength(0);
  });

  it("keeps sampled frames with automatic proposals once the creator opts in", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { trainingConsent: true } })).status).toBe(200);
    const { sessionId } = await upload(creator, "Consented run");
    firstSession = sessionId;
    const frames = await framesOf(sessionId);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) expect(f.storage_key.startsWith(`${storageKeys.sessionPrefix(creatorBroadcaster, sessionId)}/training/`)).toBe(true);
    const labels = await h.ctx.db.query<{ kind: string; class: string; source: string; status: string }>(
      `SELECT l.kind, l.class, l.source, l.status FROM training_labels l JOIN training_frames f ON f.id = l.frame_id WHERE f.session_id = $1`,
      [sessionId],
    );
    const found = labels.rows.map((l) => `${l.source}:${l.kind}:${l.class}`);
    expect(found).toContain("auto_ocr:event:mission_passed");
    expect(found).toContain("auto_ocr:box:big_message");
    expect(found).toContain("auto_measure:scene:loading_or_black");
    expect(labels.rows.every((l) => l.status === "proposed")).toBe(true);
  });

  it("shows the queue only to its owner, interesting frames first", async () => {
    const { frames } = (await creator.get("/api/training/queue?limit=50")).json<{ frames: any[] }>();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].labels.some((l: any) => l.status === "proposed")).toBe(true);
    const img = await creator.get(frames[0].imageUrl);
    expect(img.status).toBe(200);
    expect((await stranger.get(`/api/training/frames/${frames[0].id}`)).status).toBe(404);
    expect((await stranger.request("POST", `/api/training/frames/${frames[0].id}/labels`, { json: { scene: "driving" } })).status).toBe(404);
    expect((await stranger.get("/api/training/queue")).json().frames).toHaveLength(0);
    // Datasets and the registry are operator-only.
    expect((await creator.request("POST", "/api/training/datasets")).status).toBe(404);
  });

  it("saves human labels: agreeing proposals accepted, the rest rejected", async () => {
    const { frames } = (await creator.get("/api/training/queue?limit=50")).json<{ frames: any[] }>();
    const withMission = frames.find((f) => f.labels.some((l: any) => l.class === "mission_passed"));
    expect(withMission).toBeTruthy();
    const big = withMission.labels.find((l: any) => l.class === "big_message");
    const r = await creator.request("POST", `/api/training/frames/${withMission.id}/labels`, {
      json: { scene: sceneAt(withMission.mediaPtsMs), events: ["mission_passed"], boxes: big ? [{ class: "big_message", ...big.box }] : [] },
    });
    expect(r.status).toBe(200);
    const saved = r.json();
    expect(saved.status).toBe("labeled");
    expect(saved.labels.find((l: any) => l.source === "auto_ocr" && l.class === "mission_passed").status).toBe("accepted");
    expect(saved.labels.filter((l: any) => l.source === "auto_ocr" && l.kind === "box").every((l: any) => l.status === "rejected")).toBe(true);
    expect(saved.labels.filter((l: any) => l.source === "creator").map((l: any) => l.class).sort()).toEqual(
      [sceneAt(withMission.mediaPtsMs), "mission_passed", ...(big ? ["big_message"] : [])].sort(),
    );
    // Label the rest of this session by its known scenes.
    for (const f of frames.filter((x) => x.id !== withMission.id)) {
      expect((await creator.request("POST", `/api/training/frames/${f.id}/labels`, { json: { scene: sceneAt(f.mediaPtsMs) } })).status).toBe(200);
    }
    const overview = (await creator.get("/api/training")).json();
    expect(overview.counts.unlabeled).toBe(0);
  });

  it("builds a frozen, session-split dataset and exports it", async () => {
    // More sessions so every split has data: copies of real frames, each in its own session.
    const source = await framesOf(firstSession);
    const per = { train: 0, val: 0, test: 0 };
    for (let i = 0; i < 80 && (per.train < 3 || per.val < 2 || per.test < 2); i++) {
      const s = await createReplaySession(h.ctx.db, creatorBroadcaster, `Copy ${i}`, "private");
      const split = splitForSession(TRAINING_SPLIT_SEED, s.id);
      if (per[split] >= 3) continue;
      per[split] += 1;
      for (const f of source) {
        const jpeg = await h.ctx.storage.getStream(f.storage_key);
        const chunks: Buffer[] = [];
        for await (const c of jpeg.stream) chunks.push(c as Buffer);
        const key = `${storageKeys.sessionPrefix(creatorBroadcaster, s.id)}/training/${f.id}.jpg`;
        const { bytes } = await h.ctx.storage.putBuffer(key, Buffer.concat(chunks), "image/jpeg");
        const row = await insertTrainingFrame(h.ctx.db, {
          broadcasterId: creatorBroadcaster, sessionId: s.id, sourceId: null, sourceKind: "upload", sourceLabel: "replay",
          mediaPtsMs: Number(f.media_pts_ms), storageKey: key, width: 1280, height: 720, bytes, priority: 0,
        });
        await creator.request("POST", `/api/training/frames/${row.id}/labels`, { json: { scene: sceneAt(Number(f.media_pts_ms)) } });
      }
    }
    const r = await operator.request("POST", "/api/training/datasets");
    expect(r.status).toBe(200);
    const ds = r.json();
    datasetId = ds.id;
    expect(ds.version).toBe(1);
    expect(ds.counts.splits.test).toBeGreaterThan(0);
    expect(ds.counts.splits.val).toBeGreaterThan(0);
    // Whole sessions per split: no session appears in two splits.
    const rows = await h.ctx.db.query<{ session_id: string; n: number }>(
      `SELECT f.session_id, count(DISTINCT df.split)::int AS n FROM dataset_frames df JOIN training_frames f ON f.id = df.frame_id WHERE df.dataset_version_id = $1 GROUP BY 1`,
      [datasetId],
    );
    expect(rows.rows.every((x) => x.n === 1)).toBe(true);
    // The no-consent creator's frames never enter a dataset (they have none), and neither do unlabeled ones.
    const exp = await operator.get(`/api/training/datasets/${datasetId}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers["content-type"]).toBe("application/zip");
    const dir = mkdtempSync(path.join(tmpdir(), "slot1-ds-"));
    writeFileSync(path.join(dir, "ds.zip"), exp.raw);
    execFileSync("unzip", ["-q", path.join(dir, "ds.zip"), "-d", path.join(dir, "x")]);
    exportDir = path.join(dir, "x");
    const meta = JSON.parse(readFileSync(path.join(exportDir, "dataset.json"), "utf8"));
    expect(meta).toMatchObject({ datasetVersionId: datasetId, version: 1, testSplitHash: ds.testSplitHash });
    const manifest = readFileSync(path.join(exportDir, "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(manifest).toHaveLength(ds.counts.frames);
    expect(readdirSync(path.join(exportDir, "images"))).toHaveLength(ds.counts.frames);
    expect(manifest.find((m) => m.events.includes("mission_passed"))).toBeTruthy();
    const coco = JSON.parse(readFileSync(path.join(exportDir, "coco_train.json"), "utf8"));
    expect(coco.categories[0]).toEqual({ id: 1, name: "minimap" });
    expect(JSON.parse(readFileSync(path.join(exportDir, "classes.json"), "utf8")).scenes).toContain("loading_or_black");
  });

  it.skipIf(!hasTorch)("trains a real model, registers it, enforces the activation rule and runs it on new footage", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "slot1-train-"));
    const train = spawnSync(
      "python3",
      [path.join(ROOT, "ml/train_scene.py"), "--data", exportDir, "--out", out, "--arch", "tiny", "--no-pretrained", "--epochs", "30", "--size", "96", "--batch-size", "16", "--lr", "0.01", "--version", "it-1"],
      { encoding: "utf8", timeout: 600_000 },
    );
    expect(train.status, train.stderr || train.stdout).toBe(0);
    const onnx = path.join(out, "gta-scene-it-1.onnx");
    const metaPath = path.join(out, "gta-scene-it-1.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.metrics[0].testSplitHash).toBe(JSON.parse(readFileSync(path.join(exportDir, "dataset.json"), "utf8")).testSplitHash);

    const uploadModel = async (metadata: object, b = operator) => {
      const form = await multipart({ metadata: JSON.stringify(metadata) }, { field: "model", filename: "model.onnx", path: onnx, type: "application/octet-stream" });
      return b.request("POST", "/api/training/models", { body: form.body, headers: { "content-type": form.contentType } });
    };
    expect((await uploadModel(meta, creator)).status).toBe(404);
    const first = await uploadModel(meta);
    expect(first.status, first.body).toBe(200);
    const m1 = first.json();
    expect(m1.status).toBe("candidate");
    const act = await operator.request("POST", `/api/training/models/${m1.id}/activate`);
    expect(act.status, act.body).toBe(200);
    expect(act.json().model.status).toBe("active");

    // eval.py reproduces the evaluation from the ONNX file alone, on the same frozen test split.
    const evalOut = path.join(out, "eval.json");
    const ev = spawnSync("python3", [path.join(ROOT, "ml/eval.py"), "--model", onnx, "--metadata", metaPath, "--data", exportDir, "--out", evalOut], { encoding: "utf8", timeout: 120_000 });
    expect(ev.status, ev.stderr).toBe(0);
    const evaluation = JSON.parse(readFileSync(evalOut, "utf8"));
    expect(evaluation[0].testSplitHash).toBe(meta.metrics[0].testSplitHash);
    expect(evaluation[0].value).toBeCloseTo(meta.metrics[0].value, 5);

    // A worse candidate on the same test split is refused; an equal one is allowed.
    const worse = { ...meta, version: "it-2", metrics: [{ ...meta.metrics[0], value: Math.max(0, meta.metrics[0].value - 0.2) }] };
    const m2 = (await uploadModel(worse)).json();
    const refused = await operator.request("POST", `/api/training/models/${m2.id}/activate`);
    if (meta.metrics[0].value > 0) {
      expect(refused.status).toBe(409);
      expect(refused.json().decision.allowed).toBe(false);
    }
    const otherSplit = { ...meta, version: "it-3", metrics: [{ ...meta.metrics[0], testSplitHash: "0".repeat(64) }] };
    expect((await uploadModel(otherSplit)).status).toBe(400);

    // New footage now runs through the active model: proposals for review, honest observations.
    const { sessionId } = await upload(creator, "After model");
    const modelLabels = await h.ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM training_labels l JOIN training_frames f ON f.id = l.frame_id WHERE f.session_id = $1 AND l.source = 'model' AND l.model_id = $2`,
      [sessionId, m1.id],
    );
    expect(modelLabels.rows[0]!.n).toBeGreaterThan(0);
    const obs = (await creator.get(`/api/sessions/${sessionId}/observations?limit=500`)).json<{ observations: any[] }>().observations;
    const fromModel = obs.filter((o) => o.model?.provider === "slot1-gta");
    for (const o of fromModel) {
      expect(o.origin).toBe("video");
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.modelConfidence).toBeGreaterThanOrEqual(0.6);
    }
    const session = (await creator.get(`/api/sessions/${sessionId}`)).json();
    expect(session.analysis.reason).toMatch(/GTA model/);
  });

  it("stops collecting when consent is turned off, and deletion removes frames and files", async () => {
    expect((await creator.request("PATCH", "/api/studio/settings", { json: { trainingConsent: false } })).status).toBe(200);
    const { sessionId } = await upload(creator, "After opting out");
    expect(await framesOf(sessionId)).toHaveLength(0);

    const frames = await framesOf(firstSession);
    expect(frames.length).toBeGreaterThan(0);
    expect((await creator.request("DELETE", `/api/sessions/${firstSession}`)).status).toBe(200);
    const job = h.jobs.find((j) => j.name === "delete-session" && (j.data as { sessionId: string }).sessionId === firstSession)!;
    await deleteSession(h.ctx, job.data as { sessionId: string; broadcasterId: string });
    expect(await framesOf(firstSession)).toHaveLength(0);
    for (const f of frames) expect(await h.ctx.storage.size(f.storage_key)).toBeNull();
    // The dataset version loses those frames too (never exported again).
    const left = await h.ctx.db.query(`SELECT 1 FROM dataset_frames WHERE frame_id = ANY($1::uuid[])`, [frames.map((f) => f.id)]);
    expect(left.rowCount).toBe(0);

    const purge = await creator.request("DELETE", "/api/training/frames", { json: { confirm: "DELETE" } });
    expect(purge.status).toBe(200);
    expect((await creator.get("/api/training")).json().counts.frames).toBe(0);
  });
});
