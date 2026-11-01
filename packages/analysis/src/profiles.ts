import type { ObservationType } from "@slot1/contracts";

/**
 * Game profiles describe WHERE to look for readable text and what the vision model should be
 * careful about. They never assert game mechanics. Region coordinates are fractions of the frame.
 */
export interface OcrRegion {
  id: string;
  /** x, y, w, h as fractions of the frame (0..1). */
  box: [number, number, number, number];
  /** Observation type used when text is read here (may be refined by `classify`). */
  type: ObservationType;
  /** tesseract page segmentation mode. 6 = block, 7 = single line, 11 = sparse text. */
  psm: 6 | 7 | 11;
  minLineConfidence: number;
  classify?: (text: string) => ObservationType | null;
  /** When set, lines that do not match are dropped (used for numeric HUD readouts). */
  requirePattern?: RegExp;
}

export interface GameProfile {
  id: "generic" | "gta5";
  name: string;
  /** Validation status is shown in Studio. Unvalidated profiles are labeled as such. */
  validation: "generic" | "unvalidated_draft" | "validated";
  validationNote: string;
  regions: OcrRegion[];
  visionHints: string[];
}

const OBJECTIVE_RE = /^(go|get|lose|follow|take|find|collect|deliver|return|wait|enter|leave|reach|drive|escape|head|meet|pick up|steal|destroy|chase|use)\b/i;
const RESULT_RE = /\b(mission passed|mission failed|wasted|busted|passed|failed|complete|completed|respect\s*\+)\b/i;

export const GENERIC_PROFILE: GameProfile = {
  id: "generic",
  name: "Generic footage",
  validation: "generic",
  validationNote: "Reads any clearly legible on-screen text. Makes no game-specific assumptions.",
  regions: [{ id: "full", box: [0, 0, 1, 1], type: "visible_text", psm: 11, minLineConfidence: 82 }],
  visionHints: [
    "This may be any video game. Do not assume a specific game unless its name or UI is clearly visible.",
  ],
};

/**
 * GTA V layout draft. These regions follow the standard 16:9 HUD layout (subtitles and
 * objectives bottom-centre, area/street names bottom-right, cash top-right). They have NOT been
 * validated against real recorded footage in this build — Studio shows this profile as an
 * unvalidated draft until a creator confirms readings on their own recordings.
 */
export const GTA5_PROFILE: GameProfile = {
  id: "gta5",
  name: "GTA V (validation draft)",
  validation: "unvalidated_draft",
  validationNote:
    "Region layout drafted from the standard GTA V 16:9 HUD. Not yet validated on real footage — verify readings before relying on them.",
  regions: [
    {
      id: "bottom_center",
      box: [0.05, 0.76, 0.9, 0.18],
      type: "subtitle",
      psm: 6,
      minLineConfidence: 78,
      classify: (t) => (OBJECTIVE_RE.test(t) ? "objective_text" : "subtitle"),
    },
    {
      id: "center_banner",
      box: [0.15, 0.32, 0.7, 0.3],
      type: "visible_text",
      psm: 6,
      minLineConfidence: 82,
      classify: (t) => (RESULT_RE.test(t) ? "result_screen" : null),
    },
    { id: "bottom_right_area", box: [0.66, 0.84, 0.33, 0.14], type: "place_name", psm: 6, minLineConfidence: 80 },
    {
      id: "top_right_hud",
      box: [0.72, 0.02, 0.27, 0.16],
      type: "hud_reading",
      psm: 6,
      // Numeric readouts score lower in tesseract; the strict pattern below compensates.
      minLineConfidence: 58,
      requirePattern: /^\$\s?\d{1,3}(,\d{3})*$/,
    },
  ],
  visionHints: [
    "The footage is expected to be GTA V, but only state the game if its UI is visible.",
    "Bottom-centre text is usually subtitles or mission objectives; read it exactly.",
    "Bottom-right text is usually the area or street name; read it exactly.",
    "A 'WASTED' or 'BUSTED' screen is a result screen, not proof of anything else.",
    "Do not infer wanted level, health or ammo unless the HUD element is clearly readable.",
  ],
};

export const PROFILES: Record<GameProfile["id"], GameProfile> = { generic: GENERIC_PROFILE, gta5: GTA5_PROFILE };

export function getProfile(id: string | null | undefined): GameProfile {
  return id === "gta5" ? GTA5_PROFILE : GENERIC_PROFILE;
}
