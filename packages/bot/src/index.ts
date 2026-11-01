import {
  EVIDENCE_CLASS_LABEL,
  evidenceClass,
  formatAge,
  PRIVILEGED_COMMANDS,
  type AnalysisStatus,
  type BotCommandName,
  type ChannelSettings,
  type Observation,
} from "@slot1/contracts";

export const NOT_OBSERVED = "I haven't observed that.";

export interface ChatterInfo {
  id: string;
  login: string;
  isBroadcaster: boolean;
  isModerator: boolean;
  isVip: boolean;
  isSubscriber: boolean;
}

export interface BotCommand {
  command: BotCommandName;
  args: string;
  unknown: string | null;
}

export interface BotContext {
  broadcasterId: string;
  settings: ChannelSettings;
  globalKill: boolean;
  globalMessagesPer30s: number;
  chatter: ChatterInfo;
  /** Status of the analysis subsystem for the channel's current session (null = no session). */
  analysis: AnalysisStatus | null;
  broadcastLive: boolean;
  now: number;
}

export interface BotPorts {
  cooldown(key: string, seconds: number): Promise<{ allowed: boolean; retryAfterSec: number }>;
  take(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean }>;
  /** Returns false if the key was already remembered (duplicate). */
  remember(key: string, seconds: number): Promise<boolean>;
  latestObservation(): Promise<Observation | null>;
  recentObservations(windowMs: number): Promise<Observation[]>;
  coverageRatio(windowMs: number): Promise<number | null>;
  search(query: string): Promise<Observation[]>;
  answer(question: string, evidence: Observation[]): Promise<{ answer: string; notObserved: boolean }>;
  requestClip(): Promise<{ ok: true; jobId: string } | { ok: false; reason: string }>;
  setPaused(paused: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** Creator controls. `message` is the chat reply, including how to fix a missing setting. */
  setRecording(on: boolean): Promise<{ ok: boolean; message: string }>;
  setAutoClips(on: boolean): Promise<{ ok: boolean; message: string }>;
  /** Forwarding destinations, without any URL or key. */
  relayStatus(): Promise<{ label: string; status: string }[]>;
  /**
   * Short public link to the moment of an observation (built with `momentLink` from contracts and
   * the public origin), or null when chat viewers couldn't open it (private session, no video time).
   */
  momentLink?(o: Observation): string | null;
}

/** Chat replies are capped at 500 characters; the link always survives, the text is shortened. */
export function withMomentLink(reply: string, link: string | null, max = 500): string {
  if (!link) return reply;
  const room = max - link.length - 1;
  if (room < 20) return reply;
  const text = reply.length > room ? `${reply.slice(0, room - 1).trimEnd()}…` : reply;
  return `${text} ${link}`;
}

export type BotDecisionKind = "answered" | "queued" | "denied" | "rate_limited" | "duplicate" | "disabled" | "killed" | "error";

export interface BotDecision {
  decision: BotDecisionKind;
  reply: string | null;
  reason: string;
}

/** Vision availability as chat should describe it. Derived only from the analysis subsystem. */
export function visionSummary(a: AnalysisStatus | null, now: number): { kind: "none" | "paused" | "waiting" | "stale" | "fresh"; ageMs: number | null } {
  if (!a || a.state === "no_source" || a.state === "replay" || a.state === "error") return { kind: "none", ageMs: null };
  if (a.state === "stopped") return { kind: "paused", ageMs: null };
  const last = a.lastReceivedFrameAt ? new Date(a.lastReceivedFrameAt).getTime() : null;
  const ageMs = last === null ? null : now - last;
  if (a.state === "ready" || a.state === "analyzing_clip") return { kind: "waiting", ageMs };
  if (a.state === "stale") return { kind: "stale", ageMs };
  return { kind: "fresh", ageMs };
}

function visionPhrase(a: AnalysisStatus | null, now: number): string {
  const v = visionSummary(a, now);
  switch (v.kind) {
    case "none":
      return "vision not connected (chat & clips only)";
    case "paused":
      return "vision paused";
    case "waiting":
      return "vision waiting for video";
    case "stale":
      return `vision stale (last frame ${formatAge(v.ageMs)} ago)`;
    case "fresh":
      return `vision live (last frame ${formatAge(v.ageMs)} ago${a?.measuredDelayMs ? `, ~${formatAge(a.measuredDelayMs)} behind` : ""})`;
  }
}

const NO_VISION_NOW = "Gameplay vision isn't connected for this channel, so I can't see the game. I can still make a clip: !slot1 clip";

function permitted(cmd: BotCommandName, ctx: BotContext): boolean {
  const c = ctx.chatter;
  const approvedMod = c.isModerator && ctx.settings.approvedModeratorIds.includes(c.id);
  if (PRIVILEGED_COMMANDS.has(cmd)) return c.isBroadcaster || approvedMod;
  if (cmd === "clip") {
    switch (ctx.settings.clipPermission) {
      case "broadcaster":
        return c.isBroadcaster;
      case "approved_moderators":
        return c.isBroadcaster || approvedMod;
      case "moderators":
        return c.isBroadcaster || c.isModerator;
      case "vips":
        return c.isBroadcaster || c.isModerator || c.isVip;
      case "everyone":
        return true;
    }
  }
  return true;
}

const GAMEPLAY_EXCLUDE = new Set(["media_facts", "session_coverage", "source_gap", "scene_transition"]);

function line(o: Observation, now: number): string {
  const cls = EVIDENCE_CLASS_LABEL[evidenceClass(o)].toLowerCase();
  const age = formatAge(now - new Date(o.receivedAt).getTime());
  return `${age} ago — ${o.description} (${cls})`;
}

/**
 * Handle one chat command. Chat text is untrusted: it only ever becomes a search query or a
 * delimited question; configuration changes happen only through explicit, permission-checked
 * privileged commands.
 */
export async function handleCommand(cmd: BotCommand, ctx: BotContext, ports: BotPorts): Promise<BotDecision> {
  const s = ctx.settings;
  if (ctx.globalKill || s.botKilled) return { decision: "killed", reply: null, reason: "kill switch active" };
  if (!s.botEnabled) return { decision: "disabled", reply: null, reason: "bot disabled for channel" };
  if (!s.allowedCommands.includes(cmd.command)) return { decision: "disabled", reply: null, reason: `command ${cmd.command} not allowed` };
  if (!permitted(cmd.command, ctx)) return { decision: "denied", reply: null, reason: "insufficient permission" };

  const privileged = PRIVILEGED_COMMANDS.has(cmd.command);
  if (!privileged) {
    const user = await ports.cooldown(`u:${ctx.broadcasterId}:${ctx.chatter.id}`, s.userCooldownSec);
    if (!user.allowed) return { decision: "rate_limited", reply: null, reason: `user cooldown ${user.retryAfterSec}s` };
    const chan = await ports.cooldown(`c:${ctx.broadcasterId}:${cmd.command}`, s.channelCooldownSec);
    if (!chan.allowed) return { decision: "rate_limited", reply: null, reason: `channel cooldown ${chan.retryAfterSec}s` };
  }
  const global = await ports.take("bot:global", ctx.globalMessagesPer30s, 30);
  if (!global.allowed) return { decision: "rate_limited", reply: null, reason: "global rate limit" };

  let decision: BotDecisionKind = "answered";
  let reply: string;
  const now = ctx.now;
  const vision = visionSummary(ctx.analysis, now);

  switch (cmd.command) {
    case "help": {
      const prefix = cmd.unknown ? `Unknown command "${cmd.unknown.replace(/[^a-z0-9]/gi, "")}". ` : "";
      reply = `${prefix}SLOT1 commands: !slot1 now · recap · find <thing> · ask <question> · clip · status. Right now: ${visionPhrase(ctx.analysis, now)}.`;
      if (permitted("record", ctx)) reply += " Creator: record on|off · autoclip on|off · relay · pause · mute.";
      break;
    }
    case "status": {
      const commentary = s.commentaryMode === "off" ? "off" : s.commentaryMuted ? "muted" : s.commentaryMode;
      reply = `Broadcast: ${ctx.broadcastLive ? "live" : "not live"} · ${visionPhrase(ctx.analysis, now)} · commentary ${commentary}.`;
      break;
    }
    case "now": {
      if (vision.kind === "none") reply = NO_VISION_NOW;
      else if (vision.kind === "paused") reply = "Analysis is paused by the creator, so I'm not looking right now.";
      else if (vision.kind === "waiting") reply = "Video source connected, but no frames have arrived yet.";
      else if (vision.kind === "stale") reply = `My last look was ${formatAge(vision.ageMs)} ago — the video feed went quiet, so I can't say what's happening now.`;
      else {
        const latest = await ports.latestObservation();
        if (!latest || now - new Date(latest.receivedAt).getTime() > 120_000) reply = "Watching — nothing notable in the last couple of minutes.";
        else reply = `As of ${line(latest, now)}`;
      }
      break;
    }
    case "recap": {
      if (vision.kind === "none") {
        reply = "No gameplay vision on this channel, so there's nothing I've seen to recap.";
        break;
      }
      const windowMs = 10 * 60_000;
      const obs = (await ports.recentObservations(windowMs)).filter((o) => o.origin !== "twitch" && !GAMEPLAY_EXCLUDE.has(o.type));
      const ratio = await ports.coverageRatio(windowMs);
      const cov = ratio === null ? "coverage unknown" : `${Math.round(ratio * 100)}% analyzed`;
      if (obs.length === 0) reply = `Last 10 min (${cov}): nothing notable observed.${vision.kind === "stale" ? " Feed is currently stale." : ""}`;
      else {
        const items = obs.slice(-4).map((o) => line(o, now));
        reply = `Last 10 min (${cov}): ${items.join(" · ")}${vision.kind === "stale" ? " · feed stale now" : ""}`;
      }
      break;
    }
    case "find":
    case "ask": {
      const q = cmd.args.trim();
      if (q.length < 2) {
        reply = `Usage: !slot1 ${cmd.command} <${cmd.command === "find" ? "thing to find" : "question"}>`;
        break;
      }
      if (vision.kind === "none") {
        reply = "I can only answer from what I've seen, and gameplay vision isn't connected here.";
        break;
      }
      const evidence = await ports.search(q);
      if (evidence.length === 0) {
        reply = NOT_OBSERVED;
        break;
      }
      if (cmd.command === "find") {
        reply = `Found: ${evidence
          .slice(0, 2)
          .map((o) => line(o, now))
          .join(" · ")}`;
      } else {
        const a = await ports.answer(q, evidence);
        reply = a.notObserved ? NOT_OBSERVED : a.answer;
      }
      if (vision.kind === "stale" && reply !== NOT_OBSERVED) reply += ` (feed stale — last frame ${formatAge(vision.ageMs)} ago)`;
      // A short link to the best match, so chat can jump to the moment.
      if (reply !== NOT_OBSERVED) reply = withMomentLink(reply, ports.momentLink?.(evidence[0]!) ?? null);
      break;
    }
    case "clip": {
      const r = await ports.requestClip();
      if (r.ok) {
        decision = "queued";
        reply = "Clip requested — I'll post the link once Twitch confirms it exists.";
      } else {
        reply = `Couldn't request a clip: ${r.reason}`;
      }
      break;
    }
    case "pause":
      await ports.setPaused(true);
      reply = "Analysis paused. Nothing new will be analyzed until !slot1 resume.";
      break;
    case "resume":
      await ports.setPaused(false);
      reply = "Analysis resumed.";
      break;
    case "mute":
      await ports.setMuted(true);
      reply = "Automatic commentary muted. Commands still work.";
      break;
    case "unmute":
      await ports.setMuted(false);
      reply = s.commentaryMode === "off" ? "Unmuted — but automatic commentary is turned off in Studio." : "Automatic commentary unmuted.";
      break;
    case "record":
    case "autoclip": {
      const on = onOff(cmd.args);
      if (on === null) {
        reply = `Usage: !slot1 ${cmd.command} on|off`;
        break;
      }
      const r = cmd.command === "record" ? await ports.setRecording(on) : await ports.setAutoClips(on);
      reply = r.message;
      break;
    }
    case "relay": {
      const list = await ports.relayStatus();
      reply = list.length
        ? `Forwarding: ${list.map((d) => `${d.label} ${d.status}`).join(", ")}.`
        : "No forwarding set up. Add Twitch, YouTube or Kick in SLOT1 Studio → Stream setup.";
      break;
    }
  }

  const fresh = await ports.remember(`dup:${ctx.broadcasterId}:${hash(reply)}`, 60);
  if (!fresh && !privileged) return { decision: "duplicate", reply: null, reason: "identical reply sent recently" };
  return { decision, reply, reason: "ok" };
}

function onOff(args: string): boolean | null {
  const a = args.trim().toLowerCase();
  if (a === "on" || a === "start" || a === "yes") return true;
  if (a === "off" || a === "stop" || a === "no") return false;
  return null;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Wording for automatic commentary. Short, hedged, never every frame. */
export function commentaryLine(o: Observation): string | null {
  const cls = evidenceClass(o);
  if (cls === "measured" || cls === "platform") return null;
  const hedge = cls === "inferred" ? "Looks like: " : "";
  return `${hedge}${o.description}`.slice(0, 200);
}
