import { describe, expect, it } from "vitest";
import { handleCommand, NOT_OBSERVED, withMomentLink, type BotContext, type BotPorts } from "@slot1/bot";
import { formatTimeParam, jumpTarget, momentLink, parseTimeParam, type ChannelSettings, type Observation } from "@slot1/contracts";
import type { RecordingRun } from "@slot1/db";
import { bufferSegments, planWindow, runForMoment } from "@slot1/services";
import { momentHref, readJumpParams, replayHref } from "../../apps/web/lib/moments";

describe("?t= parsing", () => {
  it("accepts seconds, unit form and clock form", () => {
    expect(parseTimeParam("83")).toBe(83_000);
    expect(parseTimeParam("83.5")).toBe(83_500);
    expect(parseTimeParam("83s")).toBe(83_000);
    expect(parseTimeParam("1m23s")).toBe(83_000);
    expect(parseTimeParam("1M23S")).toBe(83_000);
    expect(parseTimeParam("2m")).toBe(120_000);
    expect(parseTimeParam("1h2m3s")).toBe(3_723_000);
    expect(parseTimeParam("01:23")).toBe(83_000);
    expect(parseTimeParam("1:02:03")).toBe(3_723_000);
    expect(parseTimeParam(" 0:05 ")).toBe(5000);
    expect(parseTimeParam("0")).toBe(0);
  });

  it("rejects anything else instead of guessing", () => {
    for (const bad of [null, undefined, "", " ", "abc", "1:75", "1:2:3:4", "-5", "1m-2s", "5ms", "1.2.3", "m", "1h1h", "25:00:00", "999999", "0x10", "1e3"]) {
      expect(parseTimeParam(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it("formats compactly and round-trips to the second", () => {
    expect(formatTimeParam(83_000)).toBe("1m23s");
    expect(formatTimeParam(4000)).toBe("4s");
    expect(formatTimeParam(0)).toBe("0s");
    expect(formatTimeParam(3_600_000)).toBe("1h");
    expect(formatTimeParam(3_723_400)).toBe("1h2m3s");
    for (const ms of [0, 999, 59_000, 61_500, 3_599_000, 7_384_000]) expect(parseTimeParam(formatTimeParam(ms))).toBe(Math.floor(ms / 1000) * 1000);
  });

  it("lands three seconds before the moment, never before the start", () => {
    expect(jumpTarget(83_000)).toBe(80_000);
    expect(jumpTarget(2000)).toBe(0);
  });
});

describe("moment links", () => {
  it("are built from the public origin with one helper", () => {
    expect(momentLink("https://slot1.example", "0f8e1c2a-0000-4000-8000-000000000001")).toBe("https://slot1.example/m/0f8e1c2a-0000-4000-8000-000000000001");
    expect(momentLink("https://slot1.example/", "x")).toBe("https://slot1.example/m/x");
  });

  it("web links carry the moment time and the observation", () => {
    expect(replayHref("s1", 83_000, "o1")).toBe("/replay/s1?t=1m23s&moment=o1");
    expect(replayHref("s1", null)).toBe("/replay/s1");
    expect(momentHref({ observationId: "o1", sessionId: "s1", sessionKind: "ingest", channelLogin: "crew", mediaStartMs: 5000 })).toBe("/m/o1");
    expect(momentHref({ observationId: null, sessionId: "s1", sessionKind: "replay", channelLogin: "crew", mediaStartMs: 5000 })).toBe("/replay/s1?t=5s");
    expect(momentHref({ observationId: null, sessionId: "s1", sessionKind: "ingest", channelLogin: "crew", mediaStartMs: 5000 })).toBe("/watch/crew");
    expect(readJumpParams({ t: "01:23", moment: "0F8E1C2A-0000-4000-8000-000000000001" })).toEqual({ tMs: 83_000, momentId: "0f8e1c2a-0000-4000-8000-000000000001" });
    expect(readJumpParams({ t: "soon", moment: "../etc" })).toEqual({ tMs: null, momentId: null });
  });
});

describe("chat replies link to the moment", () => {
  const NOW = Date.parse("2026-11-01T20:00:00Z");
  const settings = {
    visibility: "public", directoryOptIn: true, publicAnalysis: true, viewerQuestions: "off", botEnabled: true, botKilled: false, commentaryMode: "off",
    commentaryMuted: false, allowedCommands: ["find", "ask"], shortAliasesEnabled: false, clipPermission: "moderators", approvedModeratorIds: [],
    userCooldownSec: 0, channelCooldownSec: 0, agentEnabled: true, analysisPaused: false, recordingConsent: false, rollingBufferEnabled: false,
    rollingBufferSeconds: 60, retentionDays: 30, sampleIntervalMs: 5000, maxVisionCallsPerHour: 120, gameProfile: "gta5", trainingConsent: false,
    recordingEnabled: false, recordingRetentionDays: 14, autoClips: false, autoClipPreRollMs: 8000, autoClipPostRollMs: 6000, chatAnnouncements: false,
  } as unknown as ChannelSettings;
  const o: Observation = {
    id: "0f8e1c2a-0000-4000-8000-000000000001", schemaVersion: 1, broadcasterId: "b", sessionId: "s", sourceId: "src", mediaStartMs: 4000, mediaEndMs: 5000,
    capturedAt: null, receivedAt: new Date(NOW - 20_000).toISOString(), analyzedAt: null, publishedAt: null, type: "result_screen",
    description: "MISSION PASSED screen", origin: "ocr", interpretation: "directly_visible", evidence: [], rawText: "MISSION PASSED", model: null,
    modelConfidence: null, reviewStatus: "unreviewed", relatedEntities: [],
  };
  const ctx: BotContext = {
    broadcasterId: "b", settings, globalKill: false, globalMessagesPer30s: 20, now: NOW, broadcastLive: true,
    chatter: { id: "9", login: "v", isBroadcaster: false, isModerator: false, isVip: false, isSubscriber: false },
    analysis: { state: "live_vision", reason: null, sourceLabel: "live", lastReceivedFrameAt: new Date(NOW - 2000).toISOString(), lastAnalyzedFrameAt: null, lastResultAt: null, measuredCadenceMs: 5000, measuredDelayMs: 1000, staleAfterMs: 16_000, visionConfigured: true },
  };
  const ports = (over: Partial<BotPorts>): BotPorts => ({
    cooldown: async () => ({ allowed: true, retryAfterSec: 0 }), take: async () => ({ allowed: true }), remember: async () => true,
    latestObservation: async () => o, recentObservations: async () => [o], coverageRatio: async () => 1, search: async () => [o],
    answer: async () => ({ answer: "Yes, MISSION PASSED was on screen.", notObserved: false }), requestClip: async () => ({ ok: false, reason: "x" }),
    setPaused: async () => undefined, setMuted: async () => undefined, setRecording: async () => ({ ok: true, message: "" }), setAutoClips: async () => ({ ok: true, message: "" }),
    relayStatus: async () => [], ...over,
  });
  const link = momentLink("https://slot1.example", o.id);

  it("find and ask end with the short link", async () => {
    const find = await handleCommand({ command: "find", args: "mission", unknown: null }, ctx, ports({ momentLink: () => link }));
    expect(find.reply).toMatch(/^Found: /);
    expect(find.reply!.endsWith(` ${link}`)).toBe(true);
    const ask = await handleCommand({ command: "ask", args: "did it pass?", unknown: null }, ctx, ports({ momentLink: () => link }));
    expect(ask.reply).toBe(`Yes, MISSION PASSED was on screen. ${link}`);
  });

  it("keeps the link whole within Twitch's 500 characters", async () => {
    const long = "A".repeat(600);
    const ask = await handleCommand({ command: "ask", args: "what happened?", unknown: null }, ctx, ports({ momentLink: () => link, answer: async () => ({ answer: long, notObserved: false }) }));
    expect(ask.reply!.length).toBeLessThanOrEqual(500);
    expect(ask.reply!.endsWith(` ${link}`)).toBe(true);
    expect(withMomentLink("short", null)).toBe("short");
  });

  it("adds no link when nothing was observed or viewers couldn't open it", async () => {
    const none = await handleCommand({ command: "ask", args: "did they crash?", unknown: null }, ctx, ports({ momentLink: () => link, answer: async () => ({ answer: "", notObserved: true }) }));
    expect(none.reply).toBe(NOT_OBSERVED);
    const priv = await handleCommand({ command: "find", args: "mission", unknown: null }, ctx, ports({ momentLink: () => null }));
    expect(priv.reply).not.toMatch(/https?:/);
  });
});

describe("instant replay windows", () => {
  const segs = (starts: number[], len = 6000) => starts.map((s) => ({ startMs: s, endMs: s + len }));

  it("cuts 8 s before and 4 s after the moment from contiguous segments", () => {
    const plan = planWindow(segs([0, 6000, 12_000, 18_000, 24_000]), { mediaMs: 20_000, secondsAgo: null }, 8000, 4000, true);
    expect(plan).toEqual({ kind: "ok", fromMs: 12_000, toMs: 24_000, momentOffsetMs: 8000, parts: [2, 3] });
  });

  it("starts at the first saved second when the moment is near the start", () => {
    const plan = planWindow(segs([0, 6000]), { mediaMs: 3000, secondsAgo: null }, 8000, 4000, true);
    expect(plan).toMatchObject({ kind: "ok", fromMs: 0, toMs: 7000, momentOffsetMs: 3000, parts: [0, 1] });
  });

  it("waits while the end of the moment is still being saved, then cuts short rather than stall", () => {
    const waiting = planWindow(segs([0, 6000]), { mediaMs: 11_500, secondsAgo: null }, 8000, 4000, true);
    expect(waiting).toMatchObject({ kind: "pending", reason: "Saving the last seconds of the moment" });
    expect((waiting as { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(1500);
    const notYet = planWindow(segs([0, 6000]), { mediaMs: 13_000, secondsAgo: null }, 8000, 4000, true);
    expect(notYet).toMatchObject({ kind: "pending", reason: "Saving the moment" });
    expect(planWindow(segs([0, 6000]), { mediaMs: 10_500, secondsAgo: null }, 8000, 4000, true)).toMatchObject({ kind: "pending" });
    expect(planWindow(segs([0, 6000]), { mediaMs: 9500, secondsAgo: null }, 8000, 4000, true)).toMatchObject({ kind: "ok", fromMs: 1500, toMs: 12_000, momentOffsetMs: 8000 });
  });

  it("is honest when the media no longer covers the moment", () => {
    expect(planWindow(segs([30_000, 36_000]), { mediaMs: 10_000, secondsAgo: null }, 8000, 4000, true, "gone")).toEqual({ kind: "unavailable", reason: "gone" });
    expect(planWindow(segs([0, 6000]), { mediaMs: 20_000, secondsAgo: null }, 8000, 4000, false, "gone")).toEqual({ kind: "unavailable", reason: "gone" });
    expect(planWindow([], { mediaMs: 1, secondsAgo: null }, 8000, 4000, false, "gone")).toEqual({ kind: "unavailable", reason: "gone" });
    expect(planWindow([], { mediaMs: 1, secondsAgo: null }, 8000, 4000, true)).toMatchObject({ kind: "pending" });
  });

  it("refuses to join across a hole in the saved video", () => {
    expect(planWindow([{ startMs: 0, endMs: 6000 }, { startMs: 9000, endMs: 15_000 }], { mediaMs: 10_000, secondsAgo: null }, 8000, 4000, false)).toEqual({
      kind: "unavailable",
      reason: "Part of that moment wasn't saved",
    });
  });

  it("replays the last seconds of a live media time", () => {
    expect(planWindow(segs([0, 6000, 12_000]), { mediaMs: null, secondsAgo: 10 }, 8000, 4000, true)).toEqual({ kind: "ok", fromMs: 8000, toMs: 18_000, momentOffsetMs: null, parts: [1, 2] });
  });

  it("matches a moment to the recording run it was received in", () => {
    const run = (id: string, start: string, end: string | null): RecordingRun => ({ runId: id, wallStart: start, wallEnd: end, segments: [] });
    const runs = [run("r2", "2026-11-01T20:10:00Z", null), run("r1", "2026-11-01T20:00:00Z", "2026-11-01T20:05:00Z")];
    const at = (iso: string) => Date.parse(iso);
    expect(runForMoment(runs, at("2026-11-01T20:02:00Z"), at("2026-11-01T20:12:00Z"))?.runId).toBe("r1");
    expect(runForMoment(runs, at("2026-11-01T20:05:10Z"), at("2026-11-01T20:12:00Z"))?.runId).toBe("r1");
    expect(runForMoment(runs, at("2026-11-01T20:11:00Z"), at("2026-11-01T20:12:00Z"))?.runId).toBe("r2");
    expect(runForMoment(runs, at("2026-11-01T20:07:00Z"), at("2026-11-01T20:12:00Z"))).toBeNull();
  });

  it("reads the rolling buffer's ring without the file being rewritten", () => {
    // Ring of 4 files, second lap: seg0002 is being rewritten, its old entry is no longer valid.
    const csv = ["seg0000.ts,0.0,6.0", "seg0001.ts,6.0,12.0", "seg0002.ts,12.0,18.0", "seg0003.ts,18.0,24.0", "seg0000.ts,24.0,30.0", "seg0001.ts,30.0,36.0"].join("\n");
    expect(bufferSegments(csv, 4)).toEqual([
      { name: "seg0003.ts", startMs: 18_000, endMs: 24_000 },
      { name: "seg0000.ts", startMs: 24_000, endMs: 30_000 },
      { name: "seg0001.ts", startMs: 30_000, endMs: 36_000 },
    ]);
    // A first lap that hasn't wrapped keeps everything; junk lines are ignored.
    expect(bufferSegments("seg0000.ts,0.0,6.0\nnot,a,segment\nseg0001.ts,6.0,12.0\n", 10).map((s) => s.name)).toEqual(["seg0000.ts", "seg0001.ts"]);
    expect(bufferSegments("", 10)).toEqual([]);
  });
});
