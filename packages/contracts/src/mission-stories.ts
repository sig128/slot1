/**
 * Missions as stories, and what leads to each result.
 *
 * From one stream's entries, in media-time order, SLOT1 rebuilds every mission attempt: from its
 * first objective (or title) to MISSION PASSED or MISSION FAILED, how long it took, the objectives
 * on the way, the last one before it failed, why it failed (as the result screen said), the deaths
 * and busts during it and what else happened in it. Separately, every WASTED, BUSTED, MISSION
 * FAILED and MISSION PASSED is kept with what SLOT1 saw in the minute before it, so the common
 * causes can be counted across streams.
 *
 * Only what was read or seen counts: an attempt without a result read on screen stays "no result
 * seen", and a mission's name is only ever text read on screen.
 */

/** One entry of a stream's log, as the stories need it. */
export interface StoryEntry {
  id: string;
  type: string;
  origin: string;
  mediaStartMs: number;
  rawText: string | null;
  /** Knowledge tags (`act:<activity>`, `place:<Place>`). */
  tags: readonly string[];
}

export type MissionOutcome = "passed" | "failed" | "unknown";
export type StoryEventKind = "wasted" | "busted" | "mission_failed" | "mission_passed";
export const STORY_EVENT_KINDS: readonly StoryEventKind[] = ["wasted", "busted", "mission_failed", "mission_passed"];

export interface MissionAttempt {
  /** Order within the stream, by start. */
  seq: number;
  name: string | null;
  /** Where the name was read: the MISSION PASSED screen, the mission's title, or a retry of it. */
  nameFrom: "result_screen" | "title" | "retry" | null;
  /** What groups attempts of one mission across streams (see `missionKey`). */
  key: string | null;
  outcome: MissionOutcome;
  /** Why it failed, as the result screen said (or "Wasted"/"Busted" right before it). */
  failReason: string | null;
  startedMs: number;
  endedMs: number;
  /** End minus start; null when the start wasn't seen (a result with nothing before it). */
  durationMs: number | null;
  objectives: string[];
  /** The last objective on screen: where a failed attempt failed. */
  lastObjective: string | null;
  deaths: number;
  busts: number;
  /** Activities seen during the attempt, most often first. */
  activities: string[];
  places: string[];
  startEntryId: string | null;
  endEntryId: string | null;
}

export interface StoryEvent {
  kind: StoryEventKind;
  atMs: number;
  entryId: string;
  /** The attempt it happened in, if any (`MissionAttempt.seq`). */
  attemptSeq: number | null;
  /** Activities seen in the minute before it, most recent first. */
  before: string[];
  places: string[];
}

export const STORY_RULES = {
  /** An attempt with no objective, title or result for this long ends as "no result seen". */
  idleGapMs: 10 * 60_000,
  /** One result screen is read by several readers (text, SLOT1's model, the AI): counted once. */
  sameResultMs: 15_000,
  /** Where the mission's name (MISSION PASSED) or why it failed (MISSION FAILED) is read. */
  bannerBeforeMs: 1_500,
  bannerAfterMs: 8_000,
  /** A death or bust this close before MISSION FAILED is why it failed, if nothing else was read. */
  deathBeforeFailMs: 30_000,
  /** A title more than this long after an attempt began starts a new attempt. */
  titleOpensAfterMs: 60_000,
  /** What leads to a result: the minute before it. */
  beforeMs: 60_000,
} as const;

/** Activities that are the story's own structure rather than something that happened in it. */
const STRUCTURE = new Set(["objective", "mission_start", "mission_passed", "mission_failed", "wasted", "busted"]);

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);

function titleCase(v: string): string {
  return v
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/(^|[/-])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase())))
    .join(" ");
}

/** Text compared without case, accents or punctuation. */
export function textKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** An objective as read at the bottom of the screen, cleaned up. */
export function cleanObjective(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/[“”"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!,;:]+$/, "");
  if (v.length < 4 || v.length > 120 || !/\p{L}{3}/u.test(v)) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

const RESULT_WORDS = /\b(?:mission\s+(?:passed|failed)|passed|failed|wasted|busted)\b/i;
const NOT_A_NAME_START = /^\W*(?:gold|silver|bronze|medal|completion|accuracy|headshots?|time taken|special ability|checkpoint|retry|skip|quit|continue|press|hold|loading|paused)\b/i;

/** A mission's name as read on screen (MISSION PASSED screen or title), or null if it isn't one. */
export function cleanMissionName(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/[^\p{L}\p{N}'&.,!?/: -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-:,.]+|[\s\-:,]+$/g, "");
  if (v.length < 3 || v.length > 48 || !/\p{L}{3}/u.test(v)) return null;
  // Stats under the result ("Time Taken 05:32", "Accuracy 63%"), the result itself, buttons.
  if (/\d/.test(v) && /[:%$+]/.test(v)) return null;
  if (RESULT_WORDS.test(v) || NOT_A_NAME_START.test(v)) return null;
  if (v.split(" ").length > 7) return null;
  return v === v.toUpperCase() ? titleCase(v) : v;
}

/** Why a mission failed, as read under MISSION FAILED ("Lamar died."), or null. */
export function cleanFailReason(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw
    .replace(/[“”"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!]+$/, "");
  if (v.length < 5 || v.length > 90 || !/\p{L}{3}/u.test(v) || !/\s/.test(v)) return null;
  if (/\bmission\s+(?:passed|failed)\b|\b(?:wasted|busted)\b/i.test(v) || NOT_A_NAME_START.test(v)) return null;
  return `${v.charAt(0).toUpperCase()}${v.slice(1)}.`;
}

/** What groups attempts of one mission: its name, else its first objective. */
export function missionKey(a: { name: string | null; objectives: readonly string[] }): string | null {
  if (a.name) return `name:${textKey(a.name)}`;
  if (a.objectives[0]) return `objective:${textKey(a.objectives[0])}`;
  return null;
}

function resultOf(e: StoryEntry): StoryEventKind | null {
  if (e.type !== "result_screen") return null;
  const t = new Set(e.tags);
  if (t.has("act:mission_failed")) return "mission_failed";
  if (t.has("act:mission_passed")) return "mission_passed";
  if (t.has("act:wasted")) return "wasted";
  if (t.has("act:busted")) return "busted";
  // "PASSED" or "FAILED" read alone in the result banner.
  const raw = e.rawText ?? "";
  if (/\bfailed\b/i.test(raw)) return "mission_failed";
  if (/\bpassed\b/i.test(raw)) return "mission_passed";
  return null;
}

interface Draft {
  startedMs: number;
  startSeen: boolean;
  lastMs: number;
  title: string | null;
  name: string | null;
  nameFrom: MissionAttempt["nameFrom"];
  objectives: string[];
  objectiveKeys: Set<string>;
  lastObjective: string | null;
  deaths: number;
  busts: number;
  lastSetback: { kind: "wasted" | "busted"; atMs: number } | null;
  outcome: MissionOutcome;
  failReason: string | null;
  endedMs: number;
  startEntryId: string | null;
  endEntryId: string | null;
}

/** First index whose time is at or after `ms` (entries sorted by time). */
function lowerBound(list: readonly StoryEntry[], ms: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.mediaStartMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tags of entries in [fromMs, toMs], counted. */
function countTags(list: readonly StoryEntry[], fromMs: number, toMs: number, exclude: ReadonlySet<string>) {
  const acts = new Map<string, number>();
  const places = new Map<string, number>();
  for (let i = lowerBound(list, fromMs); i < list.length && list[i]!.mediaStartMs <= toMs; i++) {
    for (const t of list[i]!.tags) {
      if (t.startsWith("act:")) {
        const k = t.slice(4);
        if (!exclude.has(k)) acts.set(k, (acts.get(k) ?? 0) + 1);
      } else if (t.startsWith("place:")) places.set(t.slice(6), (places.get(t.slice(6)) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([k]) => k);
  return { activities: top(acts, 12), places: top(places, 6) };
}

/** Distinct tags of entries in [fromMs, toMs), most recent first. */
function recentTags(list: readonly StoryEntry[], fromMs: number, toMs: number, exclude: ReadonlySet<string>) {
  const acts: string[] = [];
  const places: string[] = [];
  const start = lowerBound(list, fromMs);
  for (let i = lowerBound(list, toMs) - 1; i >= start; i--) {
    for (const t of list[i]!.tags) {
      if (t.startsWith("act:")) {
        const k = t.slice(4);
        if (!exclude.has(k) && !acts.includes(k)) acts.push(k);
      } else if (t.startsWith("place:") && !places.includes(t.slice(6))) places.push(t.slice(6));
    }
  }
  return { before: acts.slice(0, 12), places: places.slice(0, 4) };
}

/**
 * Every mission attempt and every result of one stream, from its entries (any order). Pure: the
 * same entries always give the same stories, so a stream can be rebuilt at any time.
 */
export function buildStories(input: readonly StoryEntry[]): { attempts: MissionAttempt[]; events: StoryEvent[] } {
  const entries = input.filter((e) => Number.isFinite(e.mediaStartMs)).sort((a, b) => a.mediaStartMs - b.mediaStartMs || a.id.localeCompare(b.id));
  const drafts: Draft[] = [];
  const results: { kind: StoryEventKind; atMs: number; entryId: string; draft: Draft | null }[] = [];
  const lastResultAt = new Map<StoryEventKind, number>();
  let cur: Draft | null = null;

  const open = (atMs: number, entryId: string | null, startSeen = true): Draft => {
    const d: Draft = {
      startedMs: atMs,
      startSeen,
      lastMs: atMs,
      title: null,
      name: null,
      nameFrom: null,
      objectives: [],
      objectiveKeys: new Set(),
      lastObjective: null,
      deaths: 0,
      busts: 0,
      lastSetback: null,
      outcome: "unknown",
      failReason: null,
      endedMs: atMs,
      startEntryId: entryId,
      endEntryId: null,
    };
    drafts.push(d);
    return d;
  };
  const close = (d: Draft, outcome: MissionOutcome, atMs: number, entryId: string | null) => {
    d.outcome = outcome;
    d.endedMs = atMs;
    d.endEntryId = entryId;
  };

  for (const e of entries) {
    const at = e.mediaStartMs;
    if (cur && at - cur.lastMs > STORY_RULES.idleGapMs) {
      close(cur, "unknown", cur.lastMs, null);
      cur = null;
    }
    const kind = resultOf(e);
    if (kind) {
      const prev = lastResultAt.get(kind);
      if (prev !== undefined && at - prev < STORY_RULES.sameResultMs) continue;
      lastResultAt.set(kind, at);
      if (kind === "wasted" || kind === "busted") {
        // A death or bust during a mission is part of it; the mission ends on its own result.
        if (cur) {
          if (kind === "wasted") cur.deaths += 1;
          else cur.busts += 1;
          cur.lastSetback = { kind, atMs: at };
          cur.lastMs = at;
        }
        results.push({ kind, atMs: at, entryId: e.id, draft: cur });
        continue;
      }
      const d = cur ?? open(at, null, false);
      close(d, kind === "mission_passed" ? "passed" : "failed", at, e.id);
      d.lastMs = at;
      results.push({ kind, atMs: at, entryId: e.id, draft: d });
      cur = null;
      continue;
    }
    if (e.type === "objective_text") {
      const o = cleanObjective(e.rawText);
      if (!o) continue;
      cur ??= open(at, e.id);
      const k = textKey(o);
      if (!cur.objectiveKeys.has(k)) {
        cur.objectiveKeys.add(k);
        if (cur.objectives.length < 40) cur.objectives.push(o);
      }
      cur.lastObjective = o;
      cur.lastMs = at;
      continue;
    }
    if (e.type === "mission_title") {
      const t = cleanMissionName(e.rawText);
      if (!t) continue;
      // A title shows when a mission starts: a different one, or one well into an attempt, opens a new attempt.
      if (cur && ((cur.title && textKey(cur.title) !== textKey(t)) || (!cur.title && at - cur.startedMs > STORY_RULES.titleOpensAfterMs))) {
        close(cur, "unknown", cur.lastMs, null);
        cur = null;
      }
      cur ??= open(at, e.id);
      cur.title ??= t;
      cur.lastMs = at;
    }
  }
  if (cur) close(cur, "unknown", cur.lastMs, null);

  // The result screens' own words: the mission's name under MISSION PASSED, why under MISSION FAILED.
  const banner = entries.filter((e) => (e.type === "visible_text" && e.origin === "ocr") || e.type === "mission_title");
  for (const r of results) {
    const d = r.draft;
    if (!d || (r.kind !== "mission_passed" && r.kind !== "mission_failed")) continue;
    const near = banner.filter((b) => b.mediaStartMs >= r.atMs - STORY_RULES.bannerBeforeMs && b.mediaStartMs <= r.atMs + STORY_RULES.bannerAfterMs);
    if (r.kind === "mission_passed") {
      for (const b of near) {
        const n = cleanMissionName(b.rawText);
        if (n) {
          d.name = n;
          d.nameFrom = "result_screen";
          break;
        }
      }
    } else {
      for (const b of near) {
        const why = cleanFailReason(b.rawText);
        if (why) {
          d.failReason = why;
          break;
        }
      }
      if (!d.failReason && d.lastSetback && r.atMs - d.lastSetback.atMs <= STORY_RULES.deathBeforeFailMs) d.failReason = d.lastSetback.kind === "wasted" ? "Wasted." : "Busted.";
    }
  }
  for (const d of drafts) {
    if (!d.name && d.title) {
      d.name = d.title;
      d.nameFrom = "title";
    }
  }
  // A retry is the same mission: a failed attempt and the next one sharing an objective, or any
  // two attempts sharing two objectives, carry the name one of them was read with.
  const shared = (a: Draft, b: Draft) => [...a.objectiveKeys].filter((k) => b.objectiveKeys.has(k)).length;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (d.name) continue;
      let best: Draft | null = null;
      let bestGap = Infinity;
      for (let j = 0; j < drafts.length; j++) {
        const o = drafts[j]!;
        if (j === i || !o.name) continue;
        const n = shared(d, o);
        const adjacentRetry = Math.abs(i - j) === 1 && n >= 1 && (i < j ? d.outcome !== "passed" : o.outcome !== "passed");
        if ((adjacentRetry || n >= 2) && Math.abs(i - j) < bestGap) {
          best = o;
          bestGap = Math.abs(i - j);
        }
      }
      if (best) {
        d.name = best.name;
        d.nameFrom = "retry";
      }
    }
  }

  const attempts: MissionAttempt[] = drafts.map((d, seq) => {
    const { activities, places } = countTags(entries, d.startedMs, d.endedMs, STRUCTURE);
    const objectives = d.objectives;
    return {
      seq,
      name: d.name,
      nameFrom: d.nameFrom,
      key: missionKey({ name: d.name, objectives }),
      outcome: d.outcome,
      failReason: d.outcome === "failed" ? d.failReason : null,
      startedMs: d.startedMs,
      endedMs: d.endedMs,
      durationMs: d.startSeen ? d.endedMs - d.startedMs : null,
      objectives,
      lastObjective: d.lastObjective,
      deaths: d.deaths,
      busts: d.busts,
      activities,
      places,
      startEntryId: d.startEntryId,
      endEntryId: d.endEntryId,
    };
  });
  const seqOf = new Map(drafts.map((d, i) => [d, i]));
  // What led to a failed mission includes the death or bust before it; for the others they're the result itself.
  const failExclude = new Set([...STRUCTURE].filter((k) => k !== "wasted" && k !== "busted"));
  const events: StoryEvent[] = results.map((r) => {
    const { before, places } = recentTags(entries, r.atMs - STORY_RULES.beforeMs, r.atMs, r.kind === "mission_failed" ? failExclude : STRUCTURE);
    return { kind: r.kind, atMs: r.atMs, entryId: r.entryId, attemptSeq: r.draft ? (seqOf.get(r.draft) ?? null) : null, before, places };
  });
  return { attempts, events };
}

/* Across streams ---------------------------------------------------------------------------- */

/** One stored attempt, as the summaries need it. */
export interface AttemptRecord {
  sessionId: string;
  broadcasterId: string;
  name: string | null;
  key: string | null;
  outcome: MissionOutcome;
  failReason: string | null;
  durationMs: number | null;
  objectives: readonly string[];
  lastObjective: string | null;
  deaths: number;
  busts: number;
  activities: readonly string[];
  endObservationId: string | null;
  endedAt: string | null;
}

export interface MissionSummary {
  key: string;
  name: string | null;
  firstObjective: string | null;
  attempts: number;
  passed: number;
  failed: number;
  unknown: number;
  streams: number;
  channels: number;
  /** Median time from start to MISSION PASSED, over passes whose start was seen. */
  medianPassMs: number | null;
  fastestPassMs: number | null;
  deaths: number;
  busts: number;
  /** The last objective on screen before MISSION FAILED, most often first. */
  failsAt: { objective: string; count: number }[];
  failReasons: { reason: string; count: number }[];
  /** Activities seen in passed and in failed attempts (in how many of them). */
  inPassed: { activity: string; count: number }[];
  inFailed: { activity: string; count: number }[];
  /** Result screens to watch, newest first. */
  proof: string[];
  lastAt: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

function tally(values: Iterable<string>, n: number): { value: string; count: number }[] {
  const m = new Map<string, { value: string; count: number }>();
  for (const v of values) {
    const k = textKey(v);
    if (!k) continue;
    const cur = m.get(k);
    if (cur) cur.count += 1;
    else m.set(k, { value: v, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, n);
}

/**
 * Attempts of every stream grouped by mission. Attempts known only by their first objective join
 * the named mission that starts with the same objective.
 */
export function summarizeMissions(records: readonly AttemptRecord[]): MissionSummary[] {
  const nameByFirstObjective = new Map<string, string>();
  for (const r of records) {
    if (r.key?.startsWith("name:") && r.objectives[0]) nameByFirstObjective.set(textKey(r.objectives[0]), r.key);
  }
  const groups = new Map<string, AttemptRecord[]>();
  for (const r of records) {
    if (!r.key) continue;
    const key = r.key.startsWith("objective:") ? (nameByFirstObjective.get(r.key.slice(10)) ?? r.key) : r.key;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: MissionSummary[] = [];
  for (const [key, list] of groups) {
    const names = tally(list.map((r) => r.name).filter((n): n is string => Boolean(n)), 1);
    const passed = list.filter((r) => r.outcome === "passed");
    const failed = list.filter((r) => r.outcome === "failed");
    const passTimes = passed.map((r) => r.durationMs).filter((d): d is number => d !== null && d > 0);
    const firstObjectives = tally(list.map((r) => r.objectives[0]).filter((o): o is string => Boolean(o)), 1);
    const activityCounts = (rs: AttemptRecord[]) =>
      tally(
        rs.flatMap((r) => [...new Set(r.activities)]),
        4,
      ).map((t) => ({ activity: t.value, count: t.count }));
    const newest = [...list].sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    out.push({
      key,
      name: names[0]?.value ?? null,
      firstObjective: firstObjectives[0]?.value ?? null,
      attempts: list.length,
      passed: passed.length,
      failed: failed.length,
      unknown: list.length - passed.length - failed.length,
      streams: new Set(list.map((r) => r.sessionId)).size,
      channels: new Set(list.map((r) => r.broadcasterId)).size,
      medianPassMs: median(passTimes),
      fastestPassMs: passTimes.length ? Math.min(...passTimes) : null,
      deaths: list.reduce((a, r) => a + r.deaths, 0),
      busts: list.reduce((a, r) => a + r.busts, 0),
      failsAt: tally(failed.map((r) => r.lastObjective).filter((o): o is string => Boolean(o)), 3).map((t) => ({ objective: t.value, count: t.count })),
      failReasons: tally(failed.map((r) => r.failReason).filter((o): o is string => Boolean(o)), 3).map((t) => ({ reason: t.value, count: t.count })),
      inPassed: activityCounts(passed),
      inFailed: activityCounts(failed),
      proof: newest.map((r) => r.endObservationId).filter((id): id is string => Boolean(id)).slice(0, 4),
      lastAt: newest[0]?.endedAt ?? null,
    });
  }
  return out.sort((a, b) => b.attempts - a.attempts || (a.name ?? a.firstObjective ?? "").localeCompare(b.name ?? b.firstObjective ?? ""));
}

/** How a mission is named when no name was read: by how it starts. */
export function missionLabel(m: Pick<MissionSummary, "name" | "firstObjective">): string {
  if (m.name) return m.name;
  return m.firstObjective ? `The mission that starts with “${m.firstObjective}”` : "A mission";
}

/** The missions a question names (by their names as read on screen), best match first. */
export function questionMissions(question: string, missions: readonly Pick<MissionSummary, "key" | "name">[]): string[] {
  const q = ` ${textKey(question)} `;
  const scored: { key: string; score: number }[] = [];
  for (const m of missions) {
    if (!m.name) continue;
    const name = textKey(m.name);
    if (name.length < 3) continue;
    if (q.includes(` ${name} `)) {
      scored.push({ key: m.key, score: 100 + name.length });
      continue;
    }
    // Most of the name's words, for names typed a little differently ("the paleto score heist").
    const words = name.split(" ").filter((w) => w.length > 2 && !SMALL_WORDS.has(w));
    if (words.length >= 2) {
      const hit = words.filter((w) => q.includes(` ${w} `)).length;
      if (hit / words.length >= 0.75) scored.push({ key: m.key, score: hit });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.key);
}
