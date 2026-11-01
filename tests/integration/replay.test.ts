import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderOwnedClip } from "../../apps/worker/src/jobs/clips";
import { deleteSession } from "../../apps/worker/src/jobs/maintenance";
import { analyzeUpload } from "../../apps/worker/src/jobs/upload";
import { Browser, multipart, ORIGIN, readSse, startHarness, type Harness } from "./harness";

const SAMPLE = path.resolve(__dirname, "../fixtures/generated/sample-replay.mp4");

/**
 * Upload → analysis → evidence, on real Postgres, Redis, ffmpeg and tesseract. No AI provider is
 * configured, so the run also proves the honest no-AI path (OCR + measurements only).
 */
describe("replay upload pipeline", () => {
  let h: Harness;
  const owner = () => new Browser(h);
  let creator: Browser;
  let stranger: Browser;
  let anonymous: Browser;
  let sessionId = "";
  let sourceId = "";

  beforeAll(async () => {
    if (!existsSync(SAMPLE)) execFileSync("bash", [path.resolve(__dirname, "../../scripts/make-sample-video.sh")], { stdio: "ignore" });
    h = await startHarness();
    creator = owner();
    stranger = owner();
    anonymous = owner();
    await creator.signInLocal("Docks Crew");
    await stranger.signInLocal("Other Creator");
    await anonymous.refreshCsrf();
  });
  afterAll(async () => h?.close());

  it("requires a signed-in creator, CSRF and a rights confirmation", async () => {
    const form = await multipart({ title: "Docks run" }, { field: "file", filename: "docks.mp4", path: SAMPLE, type: "video/mp4" });
    const anon = await anonymous.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(anon.status).toBe(401);
    const noCsrf = await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType }, csrf: false });
    expect(noCsrf.status).toBe(403);
    const noRights = await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(noRights.status).toBe(400);
    expect(noRights.json().error.message).toMatch(/rights/);
  });

  it("rejects a file that is not video", async () => {
    const fake = path.resolve(__dirname, "../../package.json");
    const form = await multipart({ title: "Not a video", rightsConfirmed: "true" }, { field: "file", filename: "fake.mp4", path: fake, type: "video/mp4" });
    const r = await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(r.status).toBe(400);
  });

  it("accepts an owned recording, labels it REPLAY and queues analysis", async () => {
    const form = await multipart({ title: "Docks run, synthetic", rightsConfirmed: "true" }, { field: "file", filename: "docks.mp4", path: SAMPLE, type: "video/mp4" });
    const r = await creator.request("POST", "/api/uploads", { body: form.body, headers: { "content-type": form.contentType } });
    expect(r.status).toBe(200);
    const body = r.json<{ sessionId: string; sourceId: string; label: string; visibility: string }>();
    expect(body).toMatchObject({ label: "replay", visibility: "private" });
    sessionId = body.sessionId;
    sourceId = body.sourceId;
    const job = h.jobs.find((j) => j.name === "analyze-upload");
    expect(job?.data).toMatchObject({ sessionId, sourceId });
    // Nothing has been analyzed yet, so nothing is claimed.
    const obs = (await creator.get(`/api/sessions/${sessionId}/observations`)).json<{ observations: unknown[] }>();
    expect(obs.observations).toHaveLength(0);
  });

  it("analyzes frames into evidence-backed observations without any AI provider", async () => {
    const job = h.jobs.find((j) => j.name === "analyze-upload")!;
    await analyzeUpload(h.ctx, job.data as Parameters<typeof analyzeUpload>[1]);

    const session = (await creator.get(`/api/sessions/${sessionId}`)).json();
    expect(session.kind).toBe("replay");
    expect(session.label).toBe("replay");
    expect(session.analysis.state).toBe("replay");
    expect(session.analysis.visionConfigured).toBe(false);
    expect(session.analysis.reason).toMatch(/AI vision is not configured/);

    const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=200`)).json<{ observations: any[]; sources: any[] }>();
    const items = page.observations;
    expect(page.sources.map((x) => x.label)).toEqual(["replay"]);
    const texts = items.map((o) => `${o.type}|${o.rawText ?? ""}|${o.description}`).join("\n");
    expect(texts).toMatch(/MISSION PASSED/);
    expect(texts).toMatch(/12,450/);
    expect(texts).toMatch(/Vespucci Beach/);
    expect(items.some((o) => o.type === "black_screen")).toBe(true);
    for (const o of items) {
      // No AI model ran: the only engine named anywhere is the local OCR (tesseract).
      if (o.origin === "ocr") expect(o.model?.provider).toBe("tesseract");
      else expect(o.model).toBeNull();
      if (o.origin !== "ocr") expect(o.modelConfidence).toBeNull();
      if (o.origin !== "twitch") expect(o.evidence.length).toBeGreaterThan(0);
      expect(["ocr", "video", "audio"]).toContain(o.origin);
    }
    // The synthetic black segment is 12–14 s: the measurement must sit there.
    const black = items.find((o) => o.type === "black_screen");
    expect(black.mediaStartMs).toBeGreaterThanOrEqual(11_000);
    expect(black.mediaEndMs).toBeLessThanOrEqual(15_500);
  });

  it("serves evidence frames only through short-lived signed URLs", async () => {
    const page = (await creator.get(`/api/sessions/${sessionId}/observations?limit=200`)).json<{ observations: any[] }>();
    const withFrame = page.observations.find((o) => o.evidence.some((e: any) => e.kind === "frame"));
    const detail = (await creator.get(`/api/observations/${withFrame.id}`)).json();
    expect(detail.sessionLabel).toBe("replay");
    const url: string = detail.evidence[0].url;
    expect(url).toMatch(/^\/api\/media\/f\//);
    const ok = await anonymous.get(url);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/image\/jpeg/);
    const tampered = await anonymous.get(url.slice(0, -3) + (url.endsWith("AAA") ? "BBB" : "AAA"));
    expect(tampered.status).toBe(403);
  });

  it("keeps a private session invisible to other creators and to anonymous viewers", async () => {
    for (const b of [stranger, anonymous]) {
      expect((await b.get(`/api/sessions/${sessionId}`)).status).toBe(404);
      expect((await b.get(`/api/sessions/${sessionId}/observations`)).status).toBe(404);
      expect((await b.get(`/api/sessions/${sessionId}/events/poll`)).status).toBe(404);
      expect((await b.request("POST", `/api/sessions/${sessionId}/ask`, { json: { question: "what happened?" } })).status).toBe(404);
    }
    const anyObs = (await creator.get(`/api/sessions/${sessionId}/observations?limit=1`)).json<{ observations: any[] }>().observations[0];
    expect((await stranger.get(`/api/observations/${anyObs.id}`)).status).toBe(404);
    // Another creator can't change or delete it either.
    expect((await stranger.request("PATCH", `/api/sessions/${sessionId}`, { json: { visibility: "public" } })).status).toBe(404);
    expect((await stranger.request("DELETE", `/api/sessions/${sessionId}`)).status).toBe(404);
    expect((await stranger.request("POST", `/api/observations/${anyObs.id}/corrections`, { json: { reviewStatus: "rejected" } })).status).toBe(404);
    expect((await stranger.get(`/api/sessions/${sessionId}/clips`)).status).toBe(404);
    // Another creator's Studio lists only their own sessions and sources.
    const theirStudio = (await stranger.get("/api/studio")).json();
    expect(JSON.stringify(theirStudio)).not.toContain(sessionId);
    // Moments search never leaks another creator's sessions.
    const saved = await creator.request("POST", "/api/moments", { json: { sessionId, observationId: anyObs.id, title: "Private moment" } });
    expect(saved.status).toBe(200);
    expect((await creator.get(`/api/moments?q=private`)).json<{ moments: unknown[] }>().moments.length).toBeGreaterThan(0);
    expect((await stranger.get(`/api/moments?q=private`)).json<{ moments: unknown[] }>().moments).toHaveLength(0);
    expect((await anonymous.get(`/api/moments`)).json<{ moments: unknown[] }>().moments).toHaveLength(0);
  });

  it("answers questions only from evidence and says when something wasn't observed", async () => {
    const yes = (await creator.request("POST", `/api/sessions/${sessionId}/ask`, { json: { question: "When did the mission pass?" } })).json();
    expect(yes.mode).toBe("retrieval");
    expect(yes.notObserved).toBe(false);
    expect(yes.citations.length).toBeGreaterThan(0);
    const no = (await creator.request("POST", `/api/sessions/${sessionId}/ask`, { json: { question: "Did a helicopter explode?" } })).json();
    expect(no.notObserved).toBe(true);
    expect(no.citations).toHaveLength(0);
  });

  it("records a creator correction with an audit trail", async () => {
    const o = (await creator.get(`/api/sessions/${sessionId}/observations?limit=1`)).json<{ observations: any[] }>().observations[0];
    const r = await creator.request("POST", `/api/observations/${o.id}/corrections`, { json: { reviewStatus: "corrected", description: "Mission objective: reach the docks", reason: "typo" } });
    expect(r.status).toBe(200);
    const detail = (await creator.get(`/api/observations/${o.id}`)).json();
    expect(detail.observation.reviewStatus).toBe("corrected");
    expect(detail.observation.description).toBe("Mission objective: reach the docks");
    expect(detail.corrections[0]).toMatchObject({ reviewStatus: "corrected", reason: "typo" });
  });

  it("streams events with Last-Event-ID backfill, without duplicates or other sessions", async () => {
    const all = (await creator.get(`/api/sessions/${sessionId}/events/poll`)).json<{ events: { id: string; sessionId: string }[] }>().events;
    expect(all.length).toBeGreaterThan(5);
    const ids = all.map((e) => BigInt(e.id));
    expect(new Set(ids.map(String)).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!, `event ids out of order: ${all.map((e) => e.id).join(",")}`).toBe(true);

    // A second session for the same creator produces events that must never appear here.
    const other = await multipart({ title: "Second run", rightsConfirmed: "true" }, { field: "file", filename: "b.mp4", path: SAMPLE, type: "video/mp4" });
    const second = (await creator.request("POST", "/api/uploads", { body: other.body, headers: { "content-type": other.contentType } })).json<{ sessionId: string }>();
    expect(second.sessionId).not.toBe(sessionId);

    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as AddressInfo).port;
    const middle = all[Math.floor(all.length / 2)]!.id;
    const expected = all.filter((e) => BigInt(e.id) > BigInt(middle)).map((e) => e.id);
    const got = await readSse(`http://127.0.0.1:${port}/api/sessions/${sessionId}/events`, { cookie: creator.cookie, origin: ORIGIN, "last-event-id": middle }, expected.length, 6000);
    expect(got.map((e) => e.id)).toEqual(expected);
    expect(got.every((e) => e.data.sessionId === sessionId)).toBe(true);
  });

  it("renders landscape and vertical clips from media SLOT1 actually holds", async () => {
    const r = await creator.request("POST", "/api/clips", {
      json: { sessionId, kind: "owned_render", centerMs: 27_000, preRollMs: 3000, postRollMs: 3000, vertical: true, caption: "Mission passed", idempotencyKey: "it-render-0001" },
    });
    expect(r.status).toBe(200);
    const job = h.jobs.find((j) => j.name === "render-clip");
    expect(job).toBeTruthy();
    await renderOwnedClip(h.ctx, job!.data as { clipJobId: string });
    const clips = (await creator.get(`/api/sessions/${sessionId}/clips`)).json<{ clips: any[] }>().clips;
    const clip = clips.find((c) => c.kind === "owned_render");
    expect(clip.state).toBe("ready");
    expect(clip.durationMs).toBeGreaterThanOrEqual(5500);
    const kinds = clip.exports.map((x: any) => `${x.kind}:${x.width}x${x.height}`);
    expect(kinds).toEqual(expect.arrayContaining(["landscape:1280x720", "vertical:1080x1920"]));
    const file = await anonymous.get(clip.exports[0].url);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/video\/mp4/);
    // Same idempotency key: no second render.
    const again = await creator.request("POST", "/api/clips", { json: { sessionId, kind: "owned_render", centerMs: 27_000, idempotencyKey: "it-render-0001" } });
    expect(again.status).toBe(200);
    expect(h.jobs.filter((j) => j.name === "render-clip")).toHaveLength(1);
  });

  it("deletes a session with its media, observations and events", async () => {
    const assets = await h.ctx.db.query<{ storage_key: string }>(`SELECT storage_key FROM evidence_assets WHERE session_id = $1`, [sessionId]);
    expect(assets.rowCount).toBeGreaterThan(0);
    expect((await creator.request("DELETE", `/api/sessions/${sessionId}`)).status).toBe(200);
    // Hidden immediately, removed by the worker job.
    expect((await creator.get(`/api/sessions/${sessionId}`)).status).toBe(404);
    const job = h.jobs.find((j) => j.name === "delete-session" && (j.data as { sessionId: string }).sessionId === sessionId);
    await deleteSession(h.ctx, job!.data as { sessionId: string; broadcasterId: string });
    for (const table of ["observations", "evidence_assets", "session_events", "saved_moments", "clip_jobs"]) {
      const left = await h.ctx.db.query(`SELECT 1 FROM ${table} WHERE session_id = $1`, [sessionId]);
      expect(left.rowCount, table).toBe(0);
    }
    for (const a of assets.rows) expect(await h.ctx.storage.size(a.storage_key)).toBeNull();
  });
});
