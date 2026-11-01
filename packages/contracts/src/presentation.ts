import type { AnalysisState, BroadcastState, ObservationType, SourceLabel } from "./enums";
import type { Observation } from "./observation";

/**
 * How the UI classifies an observation. These classes are shown to viewers so they can tell
 * a reading of on-screen text apart from an inference or a Twitch platform fact.
 */
export type EvidenceClass = "visible_text" | "visible" | "inferred" | "heard" | "measured" | "platform" | "correction";

const MEASURED: ReadonlySet<ObservationType> = new Set([
  "session_coverage",
  "media_facts",
  "source_gap",
  "scene_transition",
  "black_screen",
  "audio_silence",
]);

export function evidenceClass(o: Pick<Observation, "origin" | "interpretation" | "type" | "rawText">): EvidenceClass {
  if (o.origin === "twitch") return "platform";
  if (o.origin === "user_correction") return "correction";
  if (o.origin === "audio") return "heard";
  if (MEASURED.has(o.type)) return "measured";
  if (o.origin === "ocr") return "visible_text";
  if (o.interpretation === "inferred" || o.interpretation === "unknown") return "inferred";
  if (o.rawText) return "visible_text";
  return "visible";
}

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  visible_text: "Visible text",
  visible: "Visible",
  inferred: "Inferred",
  heard: "Heard",
  measured: "Measured",
  platform: "Twitch fact",
  correction: "Creator correction",
};

/** Plain-language wording for an uncalibrated model score. Never presented as accuracy. */
export function confidenceWords(score: number | null): string {
  if (score === null) return "No model score";
  if (score >= 0.85) return "Model reports high certainty";
  if (score >= 0.6) return "Model reports moderate certainty";
  if (score >= 0.35) return "Model reports low certainty";
  return "Model reports very low certainty";
}

export const ANALYSIS_STATE_LABEL: Record<AnalysisState, string> = {
  no_source: "No video source",
  ready: "Ready — waiting for video",
  analyzing_clip: "Analyzing clip",
  live_vision: "Live vision",
  replay: "Replay",
  delayed: "Delayed",
  stale: "Stale",
  stopped: "Stopped",
  error: "Error",
};

export const BROADCAST_STATE_LABEL: Record<BroadcastState, string> = {
  unknown: "Broadcast unknown",
  live: "Live on Twitch",
  offline: "Offline",
  error: "Twitch unavailable",
};

export const SOURCE_LABEL_TEXT: Record<SourceLabel, string> = {
  replay: "REPLAY",
  test: "TEST / REPLAY",
  live: "LIVE INGEST",
  clip: "CLIP",
};

export const OBSERVATION_TYPE_LABEL: Record<ObservationType, string> = {
  session_coverage: "Coverage",
  media_facts: "Media",
  source_gap: "Gap",
  scene_transition: "Scene change",
  black_screen: "Black screen",
  audio_silence: "Silence",
  visible_text: "On-screen text",
  objective_text: "Objective",
  mission_title: "Mission title",
  subtitle: "Subtitle",
  result_screen: "Result screen",
  hud_reading: "HUD",
  place_name: "Place name",
  vehicle: "Vehicle",
  vehicle_enter_exit: "Vehicle entry/exit",
  possible_collision: "Possible collision",
  movement: "Movement",
  combat: "Combat",
  landmark: "Landmark",
  environment: "Environment",
  dialogue: "Dialogue",
  siren: "Siren",
  reaction: "Reaction",
  highlight_candidate: "Highlight candidate",
  stream_online: "Went live",
  stream_offline: "Went offline",
  channel_update: "Channel update",
};

/** Format a media offset as m:ss or h:mm:ss with tabular-friendly zero padding. */
export function formatMediaTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--:--";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** Human age like "12s", "4m 03s", "2h 10m". */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
