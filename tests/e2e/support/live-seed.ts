import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, type APIRequestContext } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

/**
 * E2E seeding: a creator who really streams to the dev stack. A TEST source is created through
 * the API, the looping sample is published to the ingest gateway (like OBS), and the dev worker
 * reads it, records it if asked, and analyzes it with OCR. Nothing is faked: the pages under
 * test see exactly what a real public stream produces.
 */
export interface LiveCreator {
  req: APIRequestContext;
  login: string;
  displayName: string;
  broadcasterId: string;
  sourceId: string;
  sessionId: string;
  publisher: ChildProcess | null;
  call(method: "post" | "patch" | "delete", url: string, data?: unknown): Promise<unknown>;
  stopPublishing(): void;
  dispose(): Promise<void>;
}

export async function ingestAvailable(baseURL: string): Promise<{ ok: boolean; reason: string | null }> {
  const req = await request.newContext({ baseURL });
  const caps = (await (await req.get("/api/capabilities")).json()) as { ingest: { available: boolean; reason: string | null } };
  await req.dispose();
  if (!caps.ingest.available) return { ok: false, reason: caps.ingest.reason };
  const status = execFileSync("bash", [path.join(ROOT, "scripts/ingest-gateway.sh"), "status"], { encoding: "utf8" }).trim();
  if (status !== "running") execFileSync("bash", [path.join(ROOT, "scripts/ingest-gateway.sh"), "start"], { stdio: "ignore" });
  return { ok: true, reason: null };
}

export async function startLiveCreator(baseURL: string, displayName: string, opts: { recording?: boolean } = {}): Promise<LiveCreator> {
  const origin = new URL(baseURL).origin;
  const req = await request.newContext({ baseURL });
  const token = async () => ((await (await req.get("/api/me")).json()) as { csrfToken: string }).csrfToken;
  const call = async (method: "post" | "patch" | "delete", url: string, data?: unknown) => {
    const res = await req[method](url, { data, headers: { origin, "x-slot1-csrf": await token() } });
    expect(res.ok(), `${method.toUpperCase()} ${url}: ${res.status()} ${await res.text()}`).toBe(true);
    return res.status() === 204 ? null : res.json();
  };
  await call("post", "/api/auth/local", { displayName });
  const me = (await (await req.get("/api/me")).json()) as { broadcaster: { id: string; login: string; displayName: string } };
  await call("patch", "/api/studio/settings", {
    visibility: "public",
    publicAnalysis: true,
    ...(opts.recording ? { recordingConsent: true, recordingEnabled: true } : {}),
  });
  const created = (await call("post", "/api/studio/sources", { name: "Capture card", label: "test" })) as { source: { id: string }; publishUrl: string };
  const publisher = spawn("bash", [path.join(ROOT, "scripts/publish-test-stream.sh"), created.publishUrl], { stdio: "ignore" });
  let sessionId = "";
  await expect(async () => {
    const studio = (await (await req.get("/api/studio")).json()) as { sources: { id: string; sessionId: string | null }[] };
    sessionId = studio.sources.find((s) => s.id === created.source.id)?.sessionId ?? "";
    expect(sessionId).toBeTruthy();
  }).toPass({ timeout: 45_000, intervals: [1000] });
  // Analysis can only be switched on once real frames arrive.
  await expect(async () => {
    const res = await req.post("/api/studio/agent", { data: { enabled: true }, headers: { origin, "x-slot1-csrf": await token() } });
    expect(res.status()).toBe(200);
  }).toPass({ timeout: 45_000, intervals: [2000] });
  await call("patch", `/api/sessions/${sessionId}`, { visibility: "public" });
  const c: LiveCreator = {
    req,
    login: me.broadcaster.login,
    displayName: me.broadcaster.displayName,
    broadcasterId: me.broadcaster.id,
    sourceId: created.source.id,
    sessionId,
    publisher,
    call,
    stopPublishing() {
      c.publisher?.kill("SIGINT");
      c.publisher = null;
    },
    async dispose() {
      c.stopPublishing();
      await req.delete(`/api/studio/sources/${created.source.id}`, { headers: { origin, "x-slot1-csrf": await token() } }).catch(() => undefined);
      await req.dispose();
    },
  };
  return c;
}

export interface SeenObservation {
  id: string;
  description: string;
  origin: string;
  mediaStartMs: number | null;
  receivedAt: string;
  rawText: string | null;
}

/** Wait for an analyzed entry with at least `leadMs` of video before it and a few seconds after. */
export async function waitForReplayableMoment(c: LiveCreator, leadMs = 10_000, settleMs = 9000): Promise<SeenObservation> {
  let found: SeenObservation | null = null;
  await expect(async () => {
    const page = (await (await c.req.get(`/api/sessions/${c.sessionId}/observations?limit=1000`)).json()) as { observations: SeenObservation[] };
    found =
      page.observations.find((o) => o.origin === "ocr" && o.mediaStartMs !== null && o.mediaStartMs >= leadMs && Date.now() - Date.parse(o.receivedAt) >= settleMs) ?? null;
    expect(found).toBeTruthy();
  }).toPass({ timeout: 120_000, intervals: [2000] });
  return found!;
}
