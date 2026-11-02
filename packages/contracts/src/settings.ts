import { z } from "zod";

/**
 * Server settings an admin can change in the browser (/admin → Settings). The API can't edit the
 * server's .env: it leaves a request for the server's `slot1 tick` (every minute), which checks
 * each key and value again with the same rules (scripts/server-setup.sh, setting_ok) before
 * writing .env and restarting what reads it. These checks mirror that function exactly, but
 * count UTF-8 bytes where the server counts bytes, so nothing passes here that the server refuses.
 */

const bytes = (v: string) => new TextEncoder().encode(v).length;
/** No control characters and none of the characters the server's .env format would interpret. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const PLAIN = /^[^\u0000-\u001f\u007f"'`$\\#]+$/;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const EMAIL_PART = /^[^\s\u0000-\u001f\u007f@"'`$\\#]+$/;

export const SETTING_KEYS = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "SLOT1_OPERATOR_TWITCH_LOGINS",
  "SLOT1_BOT_TWITCH_LOGIN",
  "ANTHROPIC_API_KEY",
  "VISION_PROVIDER",
  "SLOT1_AUTODEPLOY",
  "SLOT1_GOOGLE_SITE_VERIFICATION",
  "SLOT1_BING_SITE_VERIFICATION",
  "SLOT1_CONTACT_EMAIL",
  "SLOT1_LEGAL_NAME",
  "SLOT1_LEGAL_ADDRESS",
  "SLOT1_GOVERNING_LAW",
  "SLOT1_ADMIN_PASSWORD_HASH",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings the server lets /admin empty. The others can only be replaced. */
export const CLEARABLE_SETTINGS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  "SLOT1_OPERATOR_TWITCH_LOGINS",
  "SLOT1_BOT_TWITCH_LOGIN",
  "ANTHROPIC_API_KEY",
  "SLOT1_GOOGLE_SITE_VERIFICATION",
  "SLOT1_BING_SITE_VERIFICATION",
  "SLOT1_CONTACT_EMAIL",
  "SLOT1_LEGAL_NAME",
  "SLOT1_LEGAL_ADDRESS",
  "SLOT1_GOVERNING_LAW",
]);

/** The server's check for one value (setting_ok in scripts/server-setup.sh). */
export function settingValueOk(key: SettingKey, v: string): boolean {
  switch (key) {
    case "TWITCH_CLIENT_ID":
    case "TWITCH_CLIENT_SECRET":
      return /^[a-z0-9]{20,64}$/.test(v);
    case "SLOT1_OPERATOR_TWITCH_LOGINS":
      return /^[a-z0-9_]{1,25}(,[a-z0-9_]{1,25}){0,9}$/.test(v);
    case "SLOT1_BOT_TWITCH_LOGIN":
      return /^[a-z0-9_]{1,25}$/.test(v);
    case "ANTHROPIC_API_KEY":
      return /^[A-Za-z0-9_-]{20,300}$/.test(v);
    case "VISION_PROVIDER":
      return v === "anthropic" || v === "none";
    case "SLOT1_AUTODEPLOY":
      return v === "true" || v === "false";
    case "SLOT1_GOOGLE_SITE_VERIFICATION":
    case "SLOT1_BING_SITE_VERIFICATION":
      return /^[A-Za-z0-9_-]{1,120}$/.test(v);
    case "SLOT1_CONTACT_EMAIL": {
      const at = v.indexOf("@");
      if (at < 0 || v.indexOf("@", at + 1) >= 0) return false;
      const local = v.slice(0, at);
      const domain = v.slice(at + 1);
      return EMAIL_PART.test(local) && EMAIL_PART.test(domain) && bytes(local) <= 64 && bytes(domain) <= 190;
    }
    case "SLOT1_LEGAL_NAME":
    case "SLOT1_LEGAL_ADDRESS":
    case "SLOT1_GOVERNING_LAW":
      return PLAIN.test(v) && bytes(v) <= 200;
    case "SLOT1_ADMIN_PASSWORD_HASH":
      return /^scrypt\$[A-Za-z0-9+/=.:_$-]{20,400}$/.test(v);
  }
}

/* What /admin sends ---------------------------------------------------------------------- */

const trimmed = z.string().max(1000).transform((v) => v.trim());
/** Twitch usernames as people type them: any case, with @ or spaces; several comma-separated. */
const logins = z
  .string()
  .max(400)
  .transform((v) =>
    v
      .toLowerCase()
      .replace(/[@\s]/g, "")
      .split(",")
      .filter(Boolean)
      .join(","),
  );
/** The value of content="..." when the whole meta tag is pasted, as `slot1 seo` accepts. */
const verification = trimmed.transform((v) => /content="([^"]*)"/.exec(v)?.[1]?.trim() ?? v);

/**
 * A partial change. A field left out stays as it is; an empty string empties a setting the server
 * lets /admin empty. Secrets are write-only: the page never gets them back.
 */
export const SettingsPatch = z
  .object({
    twitchClientId: trimmed.optional(),
    twitchClientSecret: trimmed.optional(),
    adminTwitchLogins: logins.optional(),
    botTwitchLogin: logins.optional(),
    anthropicApiKey: trimmed.optional(),
    aiEnabled: z.boolean().optional(),
    autodeploy: z.boolean().optional(),
    googleVerification: verification.optional(),
    bingVerification: verification.optional(),
    contactEmail: trimmed.optional(),
    legalName: trimmed.optional(),
    legalAddress: trimmed.optional(),
    governingLaw: trimmed.optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;
export type SettingsPatchInput = z.input<typeof SettingsPatch>;
export type SettingsField = keyof SettingsPatch;

/** Which .env key each field writes. */
export const FIELD_KEYS: Record<SettingsField, SettingKey> = {
  twitchClientId: "TWITCH_CLIENT_ID",
  twitchClientSecret: "TWITCH_CLIENT_SECRET",
  adminTwitchLogins: "SLOT1_OPERATOR_TWITCH_LOGINS",
  botTwitchLogin: "SLOT1_BOT_TWITCH_LOGIN",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  aiEnabled: "VISION_PROVIDER",
  autodeploy: "SLOT1_AUTODEPLOY",
  googleVerification: "SLOT1_GOOGLE_SITE_VERIFICATION",
  bingVerification: "SLOT1_BING_SITE_VERIFICATION",
  contactEmail: "SLOT1_CONTACT_EMAIL",
  legalName: "SLOT1_LEGAL_NAME",
  legalAddress: "SLOT1_LEGAL_ADDRESS",
  governingLaw: "SLOT1_GOVERNING_LAW",
};

/** What each field must look like, in the words the form shows under it. */
export const FIELD_RULES: Record<SettingsField, string> = {
  twitchClientId: "20 to 64 lowercase letters and digits, as the Twitch developer console shows it.",
  twitchClientSecret: "20 to 64 lowercase letters and digits, as the Twitch developer console shows it.",
  adminTwitchLogins: "Twitch usernames (letters, digits, underscores), up to 10, separated by commas.",
  botTwitchLogin: "One Twitch username (letters, digits, underscores).",
  anthropicApiKey: "The key from console.anthropic.com (letters, digits, - and _).",
  aiEnabled: "On or off.",
  autodeploy: "On or off.",
  googleVerification: "The content=\"...\" value of Google's meta tag (letters, digits, - and _).",
  bingVerification: "The content=\"...\" value of Bing's meta tag (letters, digits, - and _).",
  contactEmail: "An email address without spaces or the characters \" ' ` $ \\ #.",
  legalName: "Up to 200 characters, without the characters \" ' ` $ \\ #.",
  legalAddress: "One line, up to 200 characters, without the characters \" ' ` $ \\ #.",
  governingLaw: "Up to 200 characters, without the characters \" ' ` $ \\ #.",
};

export interface SettingEntry {
  key: SettingKey;
  /** null empties the setting. */
  value: string | null;
}

export type SettingsCheck = { ok: true; entries: SettingEntry[] } | { ok: false; errors: Partial<Record<SettingsField, string>> };

/** Turns a patch into the server's settings, or says which fields the server would refuse. */
export function settingsEntries(patch: SettingsPatch): SettingsCheck {
  const entries: SettingEntry[] = [];
  const errors: Partial<Record<SettingsField, string>> = {};
  for (const [field, raw] of Object.entries(patch) as [SettingsField, string | boolean | undefined][]) {
    if (raw === undefined) continue;
    const key = FIELD_KEYS[field];
    if (field === "aiEnabled") {
      entries.push({ key, value: raw ? "anthropic" : "none" });
      continue;
    }
    if (field === "autodeploy") {
      entries.push({ key, value: raw ? "true" : "false" });
      continue;
    }
    const value = String(raw);
    if (value === "") {
      if (CLEARABLE_SETTINGS.has(key)) entries.push({ key, value: null });
      else errors[field] = "This one can't be emptied, only replaced.";
      continue;
    }
    if (!settingValueOk(key, value)) {
      errors[field] = FIELD_RULES[field];
      continue;
    }
    entries.push({ key, value });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, entries };
}

export const AdminPasswordChange = z
  .object({
    /** The password in use now. Not needed when none is set yet. */
    current: z.string().max(4096).optional(),
    next: z.string().max(4096),
  })
  .strict();
export type AdminPasswordChange = z.infer<typeof AdminPasswordChange>;

/* What /admin shows ---------------------------------------------------------------------- */

export const DeployStatus = z.object({
  state: z.enum(["building", "live", "failed"]),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  at: z.string(),
});
export type DeployStatus = z.infer<typeof DeployStatus>;

export interface SettingsRequestResult {
  id: string;
  status: "pending" | "applied" | "refused" | "unknown";
  /** The server's words: "restart: apps" or "not accepted: KEY". */
  detail: string | null;
  at: string | null;
}

export interface AdminSettingsView {
  /** False when this server can't take settings from the browser (no shared state folder). */
  available: boolean;
  unavailableReason: string | null;
  values: {
    twitchClientId: string | null;
    twitchClientSecretSet: boolean;
    adminTwitchLogins: string;
    botTwitchLogin: string | null;
    anthropicApiKeySet: boolean;
    aiProvider: "none" | "anthropic" | "openai";
    autodeploy: boolean;
    googleVerification: string | null;
    bingVerification: string | null;
    contactEmail: string | null;
    legalName: string | null;
    legalAddress: string | null;
    governingLaw: string | null;
    adminPasswordSet: boolean;
  };
  /** Whether each part works right now (from the settings the API started with). */
  working: { twitch: boolean; twitchReason: string | null; ai: boolean; aiReason: string | null };
  /** The OAuth Redirect URL the Twitch app must list, exactly. */
  twitchRedirectUrl: string;
  version: string | null;
  /** When this API process started: after a save that restarts SLOT1, the page waits for a newer one. */
  apiStartedAt: string;
  deploy: DeployStatus | null;
  /** Newest first. */
  requests: SettingsRequestResult[];
}

/* Public status (/status) ---------------------------------------------------------------- */

export interface PublicStatus {
  generatedAt: string;
  version: string | null;
  deploy: { state: DeployStatus["state"]; commit: string; at: string } | null;
  services: {
    website: "ok";
    database: "ok" | "down";
    redis: "ok" | "down";
  };
  twitchSignIn: {
    configured: boolean;
    last: { outcome: "connected" | "denied" | "error"; why: string | null; at: string } | null;
  };
  ai: { configured: boolean };
  streaming: { available: boolean };
}
