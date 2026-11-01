import { describe, expect, it } from "vitest";
import { handleCommand, NOT_OBSERVED, type BotContext, type BotPorts } from "@slot1/bot";
import type { AnalysisStatus, ChannelSettings, Observation } from "@slot1/contracts";
import { parseChatCommand, readBadges, sanitizeReply } from "@slot1/twitch";

const NOW = Date.parse("2026-11-01T20:00:00Z");

function settings(over: Partial<ChannelSettings> = {}): ChannelSettings {
  return {
    visibility: "public", directoryOptIn: true, publicAnalysis: true, viewerQuestions: "off",
    botEnabled: true, botKilled: false, commentaryMode: "off", commentaryMuted: false,
    allowedCommands: ["help", "status", "now", "recap", "clip", "find", "ask", "pause", "resume", "mute", "unmute"],
    shortAliasesEnabled: false, clipPermission: "moderators", approvedModeratorIds: ["200"],
    userCooldownSec: 20, channelCooldownSec: 5, agentEnabled: true, analysisPaused: false,
    recordingConsent: false, rollingBufferEnabled: false, rollingBufferSeconds: 60, retentionDays: 30,
    sampleIntervalMs: 5000, maxVisionCallsPerHour: 120, gameProfile: "gta5", trainingConsent: false,
    recordingEnabled: false, recordingRetentionDays: 14, autoClips: false, autoClipPreRollMs: 8000, autoClipPostRollMs: 6000,
    chatAnnouncements: false, ...over,
  };
}

const viewer = { id: "100", login: "viewer", isBroadcaster: false, isModerator: false, isVip: false, isSubscriber: false };
const mod = { id: "200", login: "mod", isBroadcaster: false, isModerator: true, isVip: false, isSubscriber: false };
const unapprovedMod = { ...mod, id: "201" };
const owner = { id: "1", login: "owner", isBroadcaster: true, isModerator: false, isVip: false, isSubscriber: false };

function analysis(state: AnalysisStatus["state"], lastFrameAgoMs: number | null = 3000): AnalysisStatus {
  return {
    state, reason: null, sourceLabel: "live",
    lastReceivedFrameAt: lastFrameAgoMs === null ? null : new Date(NOW - lastFrameAgoMs).toISOString(),
    lastAnalyzedFrameAt: null, lastResultAt: null, measuredCadenceMs: 5000, measuredDelayMs: 1500, staleAfterMs: 16_500, visionConfigured: true,
  };
}

function obs(description: string, agoMs = 10_000): Observation {
  return {
    id: crypto.randomUUID(), schemaVersion: 1, broadcasterId: "b", sessionId: "s", sourceId: "src", mediaStartMs: 1000, mediaEndMs: 2000,
    capturedAt: null, receivedAt: new Date(NOW - agoMs).toISOString(), analyzedAt: null, publishedAt: null, type: "mission_title",
    description, origin: "ocr", interpretation: "directly_visible", evidence: [{ assetId: "a1", kind: "frame", mediaPtsMs: 1000 }],
    rawText: description, model: null, modelConfidence: null, reviewStatus: "unreviewed", relatedEntities: [],
  };
}

function ports(over: Partial<BotPorts> = {}) {
  const seen = new Set<string>();
  const cooldowns = new Map<string, number>();
  const calls: string[] = [];
  const p: BotPorts = {
    cooldown: async (key, seconds) => {
      const until = cooldowns.get(key) ?? 0;
      if (until > NOW) return { allowed: false, retryAfterSec: Math.ceil((until - NOW) / 1000) };
      cooldowns.set(key, NOW + seconds * 1000);
      return { allowed: true, retryAfterSec: 0 };
    },
    take: async () => ({ allowed: true }),
    remember: async (key) => (seen.has(key) ? false : (seen.add(key), true)),
    latestObservation: async () => obs("Mission: The Docks"),
    recentObservations: async () => [obs("Mission: The Docks")],
    coverageRatio: async () => 0.8,
    search: async () => [],
    answer: async () => ({ answer: "x", notObserved: true }),
    requestClip: async () => (calls.push("clip"), { ok: true, jobId: "j1" }),
    setPaused: async (v) => void calls.push(`paused:${v}`),
    setMuted: async (v) => void calls.push(`muted:${v}`),
    setRecording: async (v) => (calls.push(`record:${v}`), { ok: true, message: `Recording ${v ? "on" : "off"}.` }),
    setAutoClips: async (v) => (calls.push(`autoclip:${v}`), { ok: true, message: `Auto-clips ${v ? "on" : "off"}.` }),
    relayStatus: async () => [],
    ...over,
  };
  return { p, calls };
}

const ctx = (over: Partial<BotContext> = {}): BotContext => ({
  broadcasterId: "b1", settings: settings(), globalKill: false, globalMessagesPer30s: 20, chatter: viewer,
  analysis: analysis("live_vision"), broadcastLive: true, now: NOW, ...over,
});
const cmd = (command: Parameters<typeof handleCommand>[0]["command"], args = "") => ({ command, args, unknown: null });

describe("bot command handling", () => {
  it("kill switch and disabled bot answer nothing", async () => {
    expect((await handleCommand(cmd("status"), ctx({ globalKill: true }), ports().p)).decision).toBe("killed");
    expect((await handleCommand(cmd("status"), ctx({ settings: settings({ botKilled: true }) }), ports().p)).decision).toBe("killed");
    expect((await handleCommand(cmd("status"), ctx({ settings: settings({ botEnabled: false }) }), ports().p)).decision).toBe("disabled");
    expect((await handleCommand(cmd("find", "car"), ctx({ settings: settings({ allowedCommands: ["help"] }) }), ports().p)).decision).toBe("disabled");
  });

  it("only the broadcaster and approved moderators may pause, resume or mute", async () => {
    const { p, calls } = ports();
    expect((await handleCommand(cmd("pause"), ctx({ chatter: viewer }), p)).decision).toBe("denied");
    expect((await handleCommand(cmd("pause"), ctx({ chatter: unapprovedMod }), p)).decision).toBe("denied");
    expect((await handleCommand(cmd("pause"), ctx({ chatter: mod }), p)).decision).toBe("answered");
    expect((await handleCommand(cmd("mute"), ctx({ chatter: owner }), p)).decision).toBe("answered");
    expect(calls).toEqual(["paused:true", "muted:true"]);
  });

  it("clip permission follows the channel setting", async () => {
    const { p, calls } = ports();
    expect((await handleCommand(cmd("clip"), ctx({ chatter: viewer }), p)).decision).toBe("denied");
    expect((await handleCommand(cmd("clip"), ctx({ chatter: unapprovedMod }), p)).decision).toBe("queued");
    expect((await handleCommand(cmd("clip"), ctx({ chatter: unapprovedMod, settings: settings({ clipPermission: "approved_moderators" }) }), ports().p)).decision).toBe("denied");
    expect((await handleCommand(cmd("clip"), ctx({ chatter: viewer, settings: settings({ clipPermission: "everyone" }) }), ports().p)).decision).toBe("queued");
    expect(calls).toEqual(["clip"]);
  });

  it("applies user and channel cooldowns, but not to privileged commands", async () => {
    const { p } = ports();
    expect((await handleCommand(cmd("status"), ctx(), p)).decision).toBe("answered");
    const second = await handleCommand(cmd("now"), ctx(), p);
    expect(second.decision).toBe("rate_limited");
    expect(second.reason).toMatch(/user cooldown/);
    const otherViewer = await handleCommand(cmd("status"), ctx({ chatter: { ...viewer, id: "101" } }), p);
    expect(otherViewer.decision).toBe("rate_limited");
    expect(otherViewer.reason).toMatch(/channel cooldown/);
    expect((await handleCommand(cmd("pause"), ctx({ chatter: owner }), p)).decision).toBe("answered");
    expect((await handleCommand(cmd("resume"), ctx({ chatter: owner }), p)).decision).toBe("answered");
  });

  it("respects the global rate limit", async () => {
    const { p } = ports({ take: async () => ({ allowed: false }) });
    expect((await handleCommand(cmd("status"), ctx(), p)).decision).toBe("rate_limited");
  });

  it("suppresses an identical reply within a minute", async () => {
    const { p } = ports({ cooldown: async () => ({ allowed: true, retryAfterSec: 0 }) });
    expect((await handleCommand(cmd("status"), ctx(), p)).decision).toBe("answered");
    expect((await handleCommand(cmd("status"), ctx({ chatter: { ...viewer, id: "102" } }), p)).decision).toBe("duplicate");
  });

  it("never claims to see gameplay without vision, and says so when stale", async () => {
    const none = await handleCommand(cmd("now"), ctx({ analysis: analysis("no_source", null) }), ports().p);
    expect(none.reply).toMatch(/isn't connected/);
    const stale = await handleCommand(cmd("now"), ctx({ analysis: analysis("stale", 90_000) }), ports().p);
    expect(stale.reply).toMatch(/went quiet/);
    const fresh = await handleCommand(cmd("now"), ctx(), ports().p);
    expect(fresh.reply).toMatch(/Mission: The Docks/);
  });

  it("answers find/ask only from evidence", async () => {
    const empty = await handleCommand(cmd("ask", "did they crash?"), ctx(), ports().p);
    expect(empty.reply).toBe(NOT_OBSERVED);
    const found = await handleCommand(cmd("find", "docks"), ctx(), ports({ search: async () => [obs("Mission: The Docks")] }).p);
    expect(found.reply).toMatch(/^Found: /);
    const noVision = await handleCommand(cmd("find", "docks"), ctx({ analysis: null }), ports().p);
    expect(noVision.reply).toMatch(/only answer from what I've seen/);
  });
});

describe("creator chat controls (record, autoclip, relay)", () => {
  const controls = settings({ allowedCommands: [...settings().allowedCommands, "record", "autoclip", "relay"] });
  const c = (over: Partial<BotContext> = {}) => ctx({ settings: controls, ...over });

  it("only the broadcaster and approved moderators may use them", async () => {
    for (const command of ["record", "autoclip", "relay"] as const) {
      const { p, calls } = ports();
      expect((await handleCommand(cmd(command, "on"), c({ chatter: viewer }), p)).decision).toBe("denied");
      expect((await handleCommand(cmd(command, "on"), c({ chatter: unapprovedMod }), p)).decision).toBe("denied");
      expect(calls).toEqual([]);
      expect((await handleCommand(cmd(command, "on"), c({ chatter: mod }), p)).decision).toBe("answered");
      expect((await handleCommand(cmd(command, "off"), c({ chatter: owner }), p)).decision).toBe("answered");
    }
  });

  it("switches recording and auto-clips with on/off and explains usage otherwise", async () => {
    const { p, calls } = ports();
    expect((await handleCommand(cmd("record", "on"), c({ chatter: owner }), p)).reply).toBe("Recording on.");
    expect((await handleCommand(cmd("autoclip", "OFF"), c({ chatter: owner }), p)).reply).toBe("Auto-clips off.");
    expect((await handleCommand(cmd("record", "maybe"), c({ chatter: owner }), p)).reply).toBe("Usage: !slot1 record on|off");
    expect((await handleCommand(cmd("autoclip"), c({ chatter: owner }), p)).reply).toBe("Usage: !slot1 autoclip on|off");
    expect(calls).toEqual(["record:true", "autoclip:false"]);
  });

  it("passes on the consent explanation instead of pretending recording started", async () => {
    const message = "Recording needs your OK first: SLOT1 Studio → Library → Recording. Then type !slot1 record on again.";
    const { p } = ports({ setRecording: async () => ({ ok: false, message }) });
    expect((await handleCommand(cmd("record", "on"), c({ chatter: owner }), p)).reply).toBe(message);
  });

  it("repeats a privileged answer instead of swallowing it as a duplicate", async () => {
    const { p } = ports();
    expect((await handleCommand(cmd("record", "on"), c({ chatter: owner }), p)).decision).toBe("answered");
    expect((await handleCommand(cmd("record", "on"), c({ chatter: owner }), p)).decision).toBe("answered");
  });

  it("reports forwarding by name and status only", async () => {
    const { p } = ports({ relayStatus: async () => [{ label: "Twitch", status: "live" }, { label: "YouTube", status: "retrying" }] });
    const r = await handleCommand(cmd("relay"), c({ chatter: owner }), p);
    expect(r.reply).toBe("Forwarding: Twitch live, YouTube retrying.");
    expect(r.reply).not.toMatch(/rtmp|key|:\/\//i);
    expect((await handleCommand(cmd("relay"), c({ chatter: owner }), ports().p)).reply).toMatch(/^No forwarding set up\. Add Twitch, YouTube or Kick in SLOT1 Studio/);
  });

  it("lists the creator controls in help only for people allowed to use them", async () => {
    expect((await handleCommand(cmd("help"), c({ chatter: owner }), ports().p)).reply).toMatch(/Creator: record on\|off · autoclip on\|off · relay/);
    expect((await handleCommand(cmd("help"), c({ chatter: viewer }), ports().p)).reply).not.toMatch(/Creator:/);
  });

  it("parses the new subcommands", () => {
    expect(parseChatCommand("!slot1 record on", { aliasesEnabled: false })).toMatchObject({ command: "record", args: "on" });
    expect(parseChatCommand("!slot1 autoclip off", { aliasesEnabled: false })).toMatchObject({ command: "autoclip", args: "off" });
    expect(parseChatCommand("!slot1 relay", { aliasesEnabled: false })).toMatchObject({ command: "relay", args: "" });
  });
});

describe("chat parsing", () => {
  it("parses !slot1 subcommands and opt-in aliases", () => {
    expect(parseChatCommand("!slot1 find  red car ", { aliasesEnabled: false })).toEqual({ command: "find", args: "red car", unknown: null, viaAlias: false });
    expect(parseChatCommand("!SLOT1", { aliasesEnabled: false })).toMatchObject({ command: "help" });
    expect(parseChatCommand("!slot1 dance", { aliasesEnabled: false })).toMatchObject({ command: "help", unknown: "dance" });
    expect(parseChatCommand("!clip", { aliasesEnabled: false })).toBeNull();
    expect(parseChatCommand("!clip", { aliasesEnabled: true })).toMatchObject({ command: "clip", viaAlias: true });
    expect(parseChatCommand("hello !slot1", { aliasesEnabled: true })).toBeNull();
  });

  it("sanitizes replies so they cannot run chat commands", () => {
    expect(sanitizeReply("/ban someone")).toBe("ban someone");
    expect(sanitizeReply(".timeout x\nsecond line")).toBe("timeout x second line");
    expect(sanitizeReply("a".repeat(600))).toHaveLength(498);
  });

  it("reads roles from badges, broadcaster by id", () => {
    expect(readBadges([{ set_id: "moderator" }], "5", "1")).toMatchObject({ isModerator: true, isBroadcaster: false });
    expect(readBadges([], "1", "1").isBroadcaster).toBe(true);
  });
});
