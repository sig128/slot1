import { z } from "zod";
import { GTA_BOX_LABEL, GTA_EVENT_LABEL, GTA_SCENE_LABEL, GTA_BOXES, GTA_EVENTS, GTA_SCENES } from "./gta-taxonomy";

/**
 * The Learning page: everything SLOT1's AI has watched, caught and learned, combined across every
 * stream sent to SLOT1. Only public streams count as "watched", and only channels that switched on
 * training count as "learned from". Every number comes from the database; nothing is estimated.
 */

/** Labeled examples at which a skill's bar fills up while no model has been tested on it. */
export const LEARNING_EXAMPLES_GOAL = 200;

export const LearningSkill = z.object({
  group: z.enum(["event", "scene", "box"]),
  key: z.string(),
  label: z.string(),
  /** Frames people labeled with it, from channels that let SLOT1 learn from their streams. */
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
    /** Channels that let SLOT1 learn from their streams right now. */
    channels: z.number().int().nonnegative(),
    /** Frames kept to learn from, from those channels. */
    frames: z.number().int().nonnegative(),
    /** Of those, frames people labeled. */
    labeledFrames: z.number().int().nonnegative(),
  }),
  skills: z.array(LearningSkill),
  /** What SLOT1 heard said on public streams (speech transcripts), in any language. */
  heard: z.object({
    lines: z.number().int().nonnegative(),
    /** Languages detected, most lines first. */
    languages: z.array(z.object({ name: z.string(), lines: z.number().int().nonnegative() })),
  }),
  /** Models SLOT1 runs right now. */
  models: z.array(LearningModel),
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
