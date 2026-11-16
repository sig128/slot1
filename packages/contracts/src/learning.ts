import { z } from "zod";
import { GTA_BOX_LABEL, GTA_EVENT_LABEL, GTA_SCENE_LABEL, GTA_BOXES, GTA_EVENTS, GTA_SCENES } from "./gta-taxonomy";

/**
 * The Learning page: everything SLOT1's AI has watched, caught and learned, combined across every
 * stream sent to SLOT1. Only public streams count as "watched". Every channel is learned from
 * unless the creator turns that off. Every number comes from the database; nothing is estimated.
 */

/** Labeled examples at which a skill's bar fills up while no model has been tested on it. */
export const LEARNING_EXAMPLES_GOAL = 200;

export const LearningSkill = z.object({
  group: z.enum(["event", "scene", "box"]),
  key: z.string(),
  label: z.string(),
  /** Frames people labeled with it, from channels that still have learning on. */
  examples: z.number().int().nonnegative(),
  /** The active model's F1 for it on its own test set; null when no tested model covers it. */
  score: z.number().min(0).max(1).nullable(),
  /** Times SLOT1 caught it on public streams; null for what SLOT1 doesn't log as its own entry. */
  seen: z.number().int().nonnegative().nullable(),
});
export type LearningSkill = z.infer<typeof LearningSkill>;

export const LearningModel = z.object({
  task: z.enum(["scene", "detector"]),
  version: z.string(),
  activatedAt: z.string().nullable(),
  metric: z.enum(["macro_f1", "map50"]).nullable(),
  score: z.number().min(0).max(1).nullable(),
  testFrames: z.number().int().nullable(),
});
export type LearningModel = z.infer<typeof LearningModel>;

export const LearningResponse = z.object({
  generatedAt: z.string(),
  watched: z.object({
    /** Public streams SLOT1 analyzed. */
    streams: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    /** Hours of video SLOT1 analyzed on them. */
    hours: z.number().nonnegative(),
    /** Entries SLOT1 named (results, chases, crashes, scenes, missions) on them. */
    caught: z.number().int().nonnegative(),
  }),
  learning: z.object({
    /** Channels that still have learning on. */
    channels: z.number().int().nonnegative(),
    /** Frames kept to learn from, from those channels. */
    frames: z.number().int().nonnegative(),
    /** Of those, frames people labeled. */
    labeledFrames: z.number().int().nonnegative(),
  }),
  skills: z.array(LearningSkill),
  /**
   * Everything SLOT1 saw, sorted: every activity of the game (contracts/game-knowledge.ts) with how
   * often it was seen on public streams, in category order.
   */
  activities: z.array(
    z.object({
      key: z.string(),
      category: z.string(),
      categoryLabel: z.string(),
      label: z.string(),
      seen: z.number().int().nonnegative(),
      streams: z.number().int().nonnegative(),
      lastSeenAt: z.string().nullable(),
    }),
  ),
  /** Places on the map SLOT1 saw (read on screen, recognized or named), most often first. */
  places: z.array(z.object({ name: z.string(), seen: z.number().int().nonnegative(), streams: z.number().int().nonnegative() })),
  /**
   * Missions as stories (contracts/mission-stories.ts): every mission seen on public streams, its
   * attempts from start to result, most attempted first.
   */
  missions: z.array(
    z.object({
      key: z.string(),
      /** As read on screen, or "The mission that starts with …" when no name was read. */
      label: z.string(),
      named: z.boolean(),
      attempts: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      streams: z.number().int().nonnegative(),
      medianPassMs: z.number().int().nullable(),
      fastestPassMs: z.number().int().nullable(),
      deaths: z.number().int().nonnegative(),
      failsAt: z.array(z.object({ objective: z.string(), count: z.number().int() })),
      failReasons: z.array(z.object({ reason: z.string(), count: z.number().int() })),
      /** The newest result screen of it, to watch. */
      href: z.string().nullable(),
    }),
  ),
  /** What SLOT1 saw in the minute before every WASTED, BUSTED, MISSION FAILED and MISSION PASSED. */
  outcomes: z.array(
    z.object({
      kind: z.enum(["wasted", "busted", "mission_failed", "mission_passed"]),
      label: z.string(),
      total: z.number().int().nonnegative(),
      before: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
      places: z.array(z.object({ name: z.string(), count: z.number().int() })),
      href: z.string().nullable(),
    }),
  ),
  /**
   * Everything SLOT1 named on public streams, most seen first: what the AI named in the picture
   * (vehicles, people, items, places, signs), objectives read on screen, and car and weapon names
   * the game showed (contracts/gta-names.ts). There's no fixed list.
   */
  named: z.array(
    z.object({
      kind: z.enum(["vehicle", "weapon", "person", "place", "item", "text", "objective", "other"]),
      label: z.string(),
      seen: z.number().int().nonnegative(),
      streams: z.number().int().nonnegative(),
      /** The newest moment with it. */
      href: z.string().nullable(),
    }),
  ),
  /** How many different names in all (the list above shows the most seen). */
  namedTotal: z.number().int().nonnegative(),
  /** What SLOT1 heard said on public streams (speech transcripts), in any language. */
  heard: z.object({
    lines: z.number().int().nonnegative(),
    /** Languages detected, most lines first. */
    languages: z.array(z.object({ name: z.string(), lines: z.number().int().nonnegative() })),
  }),
  /** Models SLOT1 runs right now. */
  models: z.array(LearningModel),
  /** "Ask SLOT1 about the game" opens to everyone at `opensAtHours` hours watched. */
  ask: z.object({ open: z.boolean(), opensAtHours: z.number().nonnegative() }),
});
export type LearningResponse = z.infer<typeof LearningResponse>;

/** Which live entry (see `ActivityKey` in now.ts) counts as SLOT1 catching each skill. */
const SEEN_AS: Record<string, string> = {
  "event:mission_passed": "mission_passed",
  "event:mission_failed": "mission_failed",
  "event:wasted": "wasted",
  "event:busted": "busted",
  "event:police_chase": "police_chase",
  "event:vehicle_crash": "crash",
  "scene:driving": "driving",
  "scene:on_foot": "on_foot",
  "scene:shootout": "shootout",
  "scene:cutscene": "cutscene",
  "scene:menu_or_map": "menu",
  "scene:phone": "phone",
  "scene:loading_or_black": "loading",
};

/** Every class of the GTA taxonomy as a skill, with what was counted for it. */
export function learningSkills(input: {
  examples: Map<string, number>;
  seen: Map<string, number>;
  scores: Map<string, number>;
}): LearningSkill[] {
  const make = (group: LearningSkill["group"], key: string, label: string): LearningSkill => {
    const id = `${group}:${key}`;
    const seenKey = SEEN_AS[id];
    return { group, key, label, examples: input.examples.get(id) ?? 0, score: input.scores.get(id) ?? null, seen: seenKey ? (input.seen.get(seenKey) ?? 0) : null };
  };
  return [
    ...GTA_EVENTS.map((k) => make("event", k, GTA_EVENT_LABEL[k])),
    ...GTA_SCENES.map((k) => make("scene", k, GTA_SCENE_LABEL[k])),
    ...GTA_BOXES.map((k) => make("box", k, GTA_BOX_LABEL[k])),
  ];
}

/** How full a skill's bar is: the tested score when there is one, else progress toward the goal. */
export function skillLevel(s: Pick<LearningSkill, "examples" | "score">): number {
  if (s.score !== null) return s.score;
  return Math.min(1, s.examples / LEARNING_EXAMPLES_GOAL) * 0.5;
}

/* Ask SLOT1 about the game ------------------------------------------------------------------- */

export const LearningAskInput = z.object({ question: z.string().trim().min(3).max(300) }).strict();

/** Whether this visitor can ask now: everyone once SLOT1 has watched enough, admins always. */
export const LearningAskAccess = z.object({
  open: z.boolean(),
  /** True when it's open only because this visitor is an admin. */
  adminOnly: z.boolean(),
  hours: z.number().nonnegative(),
  opensAtHours: z.number().nonnegative(),
});
export type LearningAskAccess = z.infer<typeof LearningAskAccess>;
export type LearningAskInput = z.infer<typeof LearningAskInput>;

/** One entry SLOT1 saw that the answer stands on, with where to watch it. */
export const LearningSource = z.object({
  observationId: z.string(),
  description: z.string(),
  channel: z.string(),
  channelLogin: z.string(),
  at: z.string(),
  /** /m/<id>: the moment on its channel or replay. */
  href: z.string(),
});
export type LearningSource = z.infer<typeof LearningSource>;

export const LearningAnswer = z.object({
  question: z.string(),
  /** What SLOT1 saw on streams, from its own records; null when it hasn't seen anything about it. */
  seen: z.object({ answer: z.string(), sources: z.array(LearningSource) }).nullable(),
  /** General game knowledge (never presented as seen on stream); null without a text model. */
  general: z.string().nullable(),
  /** The activities, places, missions and named things (vehicles, weapons…) the question was matched to. */
  about: z.object({ activities: z.array(z.string()), places: z.array(z.string()), missions: z.array(z.string()), named: z.array(z.string()) }),
  mode: z.enum(["model", "retrieval"]),
});
export type LearningAnswer = z.infer<typeof LearningAnswer>;

/** What the text model returns for a game question (validated, ids checked against the evidence). */
export const GameAnswer = z.object({
  seen: z.string().max(700),
  general: z.string().max(700),
  citedObservationIds: z.array(z.string()).max(8),
});
export type GameAnswer = z.infer<typeof GameAnswer>;
