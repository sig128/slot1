import { z } from "zod";
import type { Interpretation, ObservationType } from "./enums";

/**
 * The GTA V label set SLOT1's own model is trained on. Bump GTA_TAXONOMY_VERSION whenever a class
 * is added, removed or renamed: datasets and models record the version they were built with, and
 * a model is only ever compared or activated against data of the same taxonomy.
 */
export const GTA_TAXONOMY_VERSION = 1;

/** What kind of moment the frame shows (exactly one per frame). Order = keyboard shortcut 1–8. */
export const GTA_SCENES = ["driving", "on_foot", "shootout", "cutscene", "menu_or_map", "loading_or_black", "phone", "other"] as const;
export const GtaScene = z.enum(GTA_SCENES);
export type GtaScene = z.infer<typeof GtaScene>;

/** Things that happen (zero or more per frame). */
export const GTA_EVENTS = [
  "mission_passed",
  "mission_failed",
  "wasted",
  "busted",
  "wanted_level_up",
  "wanted_cleared",
  "police_chase",
  "vehicle_crash",
  "money_change",
  "vehicle_enter_exit",
] as const;
export const GtaEvent = z.enum(GTA_EVENTS);
export type GtaEvent = z.infer<typeof GtaEvent>;

/** Regions the detector learns to box. */
export const GTA_BOXES = [
  "minimap",
  "wanted_stars",
  "money_hud",
  "health_armor",
  "mission_text",
  "subtitle",
  "big_message",
  "weapon_hud",
  "phone",
  "vehicle",
  "person",
] as const;
export const GtaBox = z.enum(GTA_BOXES);
export type GtaBox = z.infer<typeof GtaBox>;

export const GTA_SCENE_LABEL: Record<GtaScene, string> = {
  driving: "Driving",
  on_foot: "On foot",
  shootout: "Shootout",
  cutscene: "Cutscene",
  menu_or_map: "Menu or map",
  loading_or_black: "Loading or black",
  phone: "Phone",
  other: "Other",
};

export const GTA_EVENT_LABEL: Record<GtaEvent, string> = {
  mission_passed: "Mission passed",
  mission_failed: "Mission failed",
  wasted: "Wasted",
  busted: "Busted",
  wanted_level_up: "Wanted level up",
  wanted_cleared: "Wanted level cleared",
  police_chase: "Police chase",
  vehicle_crash: "Vehicle crash",
  money_change: "Money changed",
  vehicle_enter_exit: "Gets in or out of a vehicle",
};

export const GTA_BOX_LABEL: Record<GtaBox, string> = {
  minimap: "Minimap",
  wanted_stars: "Wanted stars",
  money_hud: "Money",
  health_armor: "Health and armor",
  mission_text: "Mission text",
  subtitle: "Subtitle",
  big_message: "Big message (MISSION PASSED, WASTED…)",
  weapon_hud: "Weapon",
  phone: "Phone",
  vehicle: "Vehicle",
  person: "Person",
};

/**
 * Events that describe change over time. The model must see them on at least two consecutive
 * frames before SLOT1 publishes them, and they are always labeled "inferred".
 */
export const GTA_TEMPORAL_EVENTS: ReadonlySet<GtaEvent> = new Set(["wanted_level_up", "wanted_cleared", "police_chase", "vehicle_crash", "money_change", "vehicle_enter_exit"]);

/** How a model output becomes an observation. `null` = never published (training signal only). */
export const GTA_EVENT_OBSERVATION: Record<GtaEvent, { type: ObservationType; interpretation: Interpretation }> = {
  mission_passed: { type: "result_screen", interpretation: "directly_visible" },
  mission_failed: { type: "result_screen", interpretation: "directly_visible" },
  wasted: { type: "result_screen", interpretation: "directly_visible" },
  busted: { type: "result_screen", interpretation: "directly_visible" },
  wanted_level_up: { type: "hud_reading", interpretation: "inferred" },
  wanted_cleared: { type: "hud_reading", interpretation: "inferred" },
  police_chase: { type: "movement", interpretation: "inferred" },
  vehicle_crash: { type: "possible_collision", interpretation: "inferred" },
  money_change: { type: "hud_reading", interpretation: "inferred" },
  vehicle_enter_exit: { type: "vehicle_enter_exit", interpretation: "inferred" },
};

export const GTA_BOX_OBSERVATION: Record<GtaBox, ObservationType | null> = {
  minimap: null,
  wanted_stars: "hud_reading",
  money_hud: null,
  health_armor: null,
  mission_text: null,
  subtitle: null,
  big_message: null,
  weapon_hud: null,
  phone: "environment",
  vehicle: "vehicle",
  person: null,
};

export const GtaTaxonomy = z.object({
  version: z.number().int(),
  scenes: z.array(z.string()),
  events: z.array(z.string()),
  boxes: z.array(z.string()),
});
export type GtaTaxonomy = z.infer<typeof GtaTaxonomy>;

export function gtaTaxonomy(): GtaTaxonomy {
  return { version: GTA_TAXONOMY_VERSION, scenes: [...GTA_SCENES], events: [...GTA_EVENTS], boxes: [...GTA_BOXES] };
}
