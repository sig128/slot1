import { z } from "zod";
import { bigMoment } from "./clipper";
import { SourceLabel } from "./enums";
import type { Observation } from "./observation";

/* ------------------------------------------------------------------------------------------ */
/* "Los Santos right now": what is happening on each live stream                              */
/* ------------------------------------------------------------------------------------------ */

/** Only observations SLOT1 received this recently describe what is happening "now". */
export const ACTIVITY_WINDOW_MS = 60_000;

export const ActivityKey = z.enum([
  "mission_passed",
  "mission_failed",
  "wasted",
  "busted",
  "police_chase",
  "shootout",
  "crash",
  "driving",
  "on_foot",
  "cutscene",
  "menu",
  "phone",
  "loading",
  "mission",
  "live",
]);
export type ActivityKey = z.infer<typeof ActivityKey>;

/**
 * Tiers, in priority order:
 * 1. events: result screens SLOT1 read (MISSION PASSED, WASTED, BUSTED…), and the GTA model's or
 *    AI vision's chase, crash and shootout observations;
 * 2. scene: the GTA model's scene class (driving, on foot, cutscene, menu…);
 * 3. mission: mission or objective text read on screen;
 * 4. none: nothing recent, shown as plain "Live".
 */
export const ActivityTier = z.enum(["event", "scene", "mission", "none"]);
export type ActivityTier = z.infer<typeof ActivityTier>;

export const NowActivity = z.object({
  key: ActivityKey,
  label: z.string(),
  /** What exactly was seen (the observation's own words), or why there is nothing to show. */
  detail: z.string().nullable(),
  tier: ActivityTier,
  /** When SLOT1 received the evidence. Null for "Live" with nothing recent. */
  observedAt: z.string().nullable(),
  observationId: z.string().nullable(),
});
export type NowActivity = z.infer<typeof NowActivity>;

type ActivityInput = Pick<Observation, "id" | "type" | "description" | "rawText" | "origin" | "receivedAt" | "reviewStatus">;

const SCENES: Record<string, { key: ActivityKey; label: string }> = {
  driving: { key: "driving", label: "Driving" },
  "on foot": { key: "on_foot", label: "On foot" },
  shootout: { key: "shootout", label: "Shootout" },
  cutscene: { key: "cutscene", label: "Cutscene" },
  "menu or map": { key: "menu", label: "In the menu or map" },
  phone: { key: "phone", label: "On the phone" },
  "loading or black": { key: "loading", label: "Loading" },
};

const RESULT: Record<string, { key: ActivityKey; label: string }> = {
  "MISSION PASSED": { key: "mission_passed", label: "Mission passed" },
  "MISSION COMPLETE": { key: "mission_passed", label: "Mission passed" },
  "MISSION FAILED": { key: "mission_failed", label: "Mission failed" },
  WASTED: { key: "wasted", label: "Wasted" },
  BUSTED: { key: "busted", label: "Busted" },
};

function classify(o: ActivityInput): { tier: Exclude<ActivityTier, "none">; key: ActivityKey; label: string; detail: string } | null {
  const big = bigMoment(o);
  if (big && RESULT[big.text]) return { tier: "event", ...RESULT[big.text]!, detail: o.rawText ?? o.description };
  if (o.type === "movement" && /chase/i.test(o.description)) return { tier: "event", key: "police_chase", label: "Police chase", detail: o.description };
  if (o.type === "possible_collision") return { tier: "event", key: "crash", label: "Crash", detail: o.description };
  if (o.type === "combat") return { tier: "event", key: "shootout", label: "Shootout", detail: o.description };
  if (o.type === "environment") {
    const m = o.description.match(/^Scene: (.+)$/i);
    const scene = m ? SCENES[m[1]!.trim().toLowerCase()] : undefined;
    if (scene) return { tier: "scene", ...scene, detail: o.description };
  }
  if ((o.type === "mission_title" || o.type === "objective_text") && (o.rawText ?? "").trim().length >= 3) {
    return { tier: "mission", key: "mission", label: o.type === "mission_title" ? "Mission" : "On a mission", detail: o.rawText!.trim().slice(0, 80) };
  }
  return null;
}

const RANK: Record<Exclude<ActivityTier, "none">, number> = { event: 0, scene: 1, mission: 2 };

/**
 * What is happening on a stream right now, from what SLOT1 actually observed in the last minute.
 * Higher tiers win; within a tier, the most recent observation wins. Nothing recent means
 * "Live" with an honest reason, never a guess.
 */
export function deriveActivity(observations: readonly ActivityInput[], nowMs: number, quietReason: string | null = null): NowActivity {
  let best: { o: ActivityInput; c: NonNullable<ReturnType<typeof classify>>; at: number } | null = null;
  for (const o of observations) {
    if (o.origin === "twitch" || o.reviewStatus === "rejected") continue;
    const at = Date.parse(o.receivedAt);
    if (!Number.isFinite(at) || nowMs - at > ACTIVITY_WINDOW_MS || at - nowMs > 5000) continue;
    const c = classify(o);
    if (!c) continue;
    if (!best || RANK[c.tier] < RANK[best.c.tier] || (RANK[c.tier] === RANK[best.c.tier] && at > best.at)) best = { o, c, at };
  }
  if (!best) return { key: "live", label: "Live", detail: quietReason, tier: "none", observedAt: null, observationId: null };
  return {
    key: best.c.key,
    label: best.c.label,
    detail: best.c.detail,
    tier: best.c.tier,
    observedAt: new Date(best.at).toISOString(),
    observationId: best.o.id,
  };
}

export const NowRecentEntry = z.object({
  id: z.string(),
  description: z.string(),
  receivedAt: z.string(),
  type: z.string(),
});
export type NowRecentEntry = z.infer<typeof NowRecentEntry>;

export const NowStream = z.object({
  broadcasterId: z.string(),
  login: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** "slot1": the creator sends video to SLOT1. "twitch": live on Twitch only, watch-only here. */
  kind: z.enum(["slot1", "twitch"]),
  /** TEST sources stay labeled TEST: a test stream is never presented as live gameplay. */
  label: SourceLabel.nullable(),
  sessionId: z.string().nullable(),
  title: z.string().nullable(),
  category: z.string().nullable(),
  viewerCount: z.number().nullable(),
  /** Latest frame SLOT1 received (public sessions only), as a short-lived signed URL. */
  thumbnailUrl: z.string().nullable(),
  /** Null when the creator keeps analysis private, or for watch-only Twitch channels. */
  activity: NowActivity.nullable(),
  /** Analysis subsystem state, so stale feeds are labeled as such. */
  analysisState: z.string().nullable(),
  recent: z.array(NowRecentEntry),
  twitchUrl: z.string().nullable(),
  watchPath: z.string(),
});
export type NowStream = z.infer<typeof NowStream>;

export const NowResponse = z.object({
  streams: z.array(NowStream),
  /** Why the list is empty, in plain words. Null when there are streams. */
  emptyReason: z.string().nullable(),
  generatedAt: z.string(),
  /** Clients poll; the server caches for this long. */
  refreshMs: z.number().int(),
});
export type NowResponse = z.infer<typeof NowResponse>;
