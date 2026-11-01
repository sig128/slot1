import type { Capabilities, CapabilityStatus } from "@slot1/contracts";

/*
 * Visitors and creators never see server settings. The capability reasons built in config.ts
 * name exact environment variables (that's what operators need), so every response that carries
 * one goes through here: operators get the technical reason plus the `slot1` server command that
 * fixes it; everyone else gets a short, honest line that says what isn't available, not why.
 */

export const CAPABILITY_KEYS = ["twitch", "bot", "eventsub", "vision", "transcription", "ocr", "storage", "ingest", "liveVideo", "relay"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** What a visitor or creator reads when a feature isn't available. Honest, no internals. */
export const PUBLIC_REASON: Record<CapabilityKey, string> = {
  twitch: "Twitch sign-in isn't open on SLOT1 yet",
  bot: "The SLOT1 chat bot isn't switched on yet",
  eventsub: "Live updates from Twitch aren't switched on yet",
  vision: "The AI that describes gameplay isn't switched on yet, so SLOT1 reports on-screen text and video measurements only",
  transcription: "Speech-to-text isn't switched on yet",
  ocr: "On-screen text reading isn't available right now",
  storage: "Saving media isn't available right now",
  ingest: "Streaming to SLOT1 isn't open yet",
  liveVideo: "SLOT1's own live video isn't switched on yet",
  relay: "Forwarding isn't switched on yet",
};

/** The server command (scripts/server-setup.sh) that fixes each one, shown to operators. */
export const SETUP_COMMAND: Record<CapabilityKey, string | null> = {
  twitch: "slot1 twitch",
  bot: "slot1 twitch",
  eventsub: "slot1 twitch",
  vision: "slot1 ai",
  transcription: null,
  ocr: "slot1 update",
  storage: null,
  ingest: "slot1 update",
  liveVideo: "SLOT1_GATEWAY=mediamtx slot1 update",
  relay: "slot1 update",
};

/** Said when a text names server settings but isn't one of the known capability reasons. */
export const PUBLIC_FALLBACK = "This isn't switched on yet on SLOT1";

/** Environment-variable-like names: TWITCH_CLIENT_ID, INGEST_GATEWAY=mediamtx, … */
const SETTING = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:=[A-Za-z0-9.-]+)?\b/g;

export function namesServerSettings(text: string): boolean {
  SETTING.lastIndex = 0;
  return SETTING.test(text);
}

/** Server commands ("slot1 logs demo") and server-side wording only operators act on. */
const SERVER_COMMAND = /\bslot1 (?:twitch|ai|update|logs|status|domain|demo|admin|env)\b/;
const SERVER_WORDING = /\b(?:on the server|this deployment)\b/i;

/** True when a text tells someone to change the server: a setting name, a command, "on the server". */
export function revealsServerSetup(text: string): boolean {
  return namesServerSettings(text) || SERVER_COMMAND.test(text) || SERVER_WORDING.test(text);
}

function missingSettings(reason: string | null): string[] {
  return reason ? [...new Set(reason.match(SETTING) ?? [])] : [];
}

/** The capability whose technical reason this exact text is, if any. */
export function capabilityForReason(caps: Capabilities, text: string): CapabilityKey | null {
  for (const k of CAPABILITY_KEYS) if (caps[k].reason && caps[k].reason === text) return k;
  return null;
}

/**
 * Text that's safe to show anyone. A known capability reason becomes its friendly line. Other
 * text loses the brackets and sentences that tell someone to change the server ("(TWITCH_X)",
 * "On the server, run: slot1 logs demo"); when nothing honest is left, it becomes `fallback`.
 * Everything else passes through unchanged.
 */
export function publicText(caps: Capabilities, text: string, fallback?: string): string;
export function publicText(caps: Capabilities, text: string | null | undefined, fallback?: string): string | null;
export function publicText(caps: Capabilities, text: string | null | undefined, fallback: string = PUBLIC_FALLBACK): string | null {
  if (!text) return text ?? null;
  const key = capabilityForReason(caps, text);
  if (key) return PUBLIC_REASON[key];
  if (!revealsServerSetup(text)) return text;
  const kept = text
    .replace(/\s*\([^()]*\)/g, (m) => (revealsServerSetup(m) ? "" : m))
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !revealsServerSetup(s))
    .join(" ")
    .trim();
  return kept && !revealsServerSetup(kept) ? kept : fallback;
}

/** One capability for this viewer: technical plus the fix for operators, friendly for everyone else. */
export function capabilityFor<T extends CapabilityStatus>(key: CapabilityKey, c: T, operator: boolean): T {
  if (c.available) return { ...c, setup: null };
  if (operator) return { ...c, setup: { missing: missingSettings(c.reason), command: SETUP_COMMAND[key] } };
  return { ...c, reason: PUBLIC_REASON[key], setup: null };
}

/** The whole capabilities document for this viewer. */
export function capabilitiesFor(caps: Capabilities, operator: boolean): Capabilities {
  const out = { ...caps } as Capabilities;
  for (const k of CAPABILITY_KEYS) (out as Record<CapabilityKey, CapabilityStatus>)[k] = capabilityFor(k, caps[k], operator);
  return out;
}

/** A capability's reason for this viewer (null when it's available). */
export function reasonFor(caps: Capabilities, key: CapabilityKey, operator: boolean): string | null {
  return capabilityFor(key, caps[key], operator).reason;
}
