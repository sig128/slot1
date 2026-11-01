
/** Date shown on both legal pages. Change it whenever either document changes. */
export const LEGAL_LAST_UPDATED = "1 November 2026";
export const LEGAL_LAST_UPDATED_ISO = "2026-11-01";

export interface LegalConfig {
  /** Who runs SLOT1: the registered business name once there is one. */
  name: string;
  /** True while no business name has been set, so the pages can say "the operator of SLOT1". */
  nameIsDefault: boolean;
  address: string | null;
  email: string | null;
  governingLaw: string | null;
}

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

function clean(v: string | undefined, max: number): string | null {
  const t = v?.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/**
 * The operator's identity for the Privacy Policy and Terms, from the server's environment at
 * request time (set with `slot1 legal`). Everything is optional; the pages read well without it.
 */
export function legalConfig(env: Record<string, string | undefined> = process.env): LegalConfig {
  const name = clean(env.SLOT1_LEGAL_NAME, 120);
  const email = clean(env.SLOT1_CONTACT_EMAIL, 254);
  return {
    name: name ?? "SLOT1",
    nameIsDefault: !name,
    address: clean(env.SLOT1_LEGAL_ADDRESS, 300),
    email: email && EMAIL.test(email) ? email.toLowerCase() : null,
    governingLaw: clean(env.SLOT1_GOVERNING_LAW, 80),
  };
}

export interface AiProcessor {
  name: string;
  purpose: string;
}

/**
 * AI services this deployment actually sends data to, from the same settings the worker uses
 * (VISION_PROVIDER + key, TRANSCRIPTION_PROVIDER + model). Shown live on the Privacy Policy.
 */
export function aiProcessors(env: Record<string, string | undefined> = process.env): AiProcessor[] {
  const out: AiProcessor[] = [];
  const set = (v: string | undefined) => Boolean(v && v.trim());
  if (env.VISION_PROVIDER === "anthropic" && set(env.ANTHROPIC_API_KEY) && set(env.ANTHROPIC_VISION_MODEL))
    out.push({ name: "Anthropic", purpose: "describes sampled video frames (AI vision) and phrases answers to questions from the stored evidence" });
  if (env.VISION_PROVIDER === "openai" && set(env.OPENAI_API_KEY) && set(env.OPENAI_VISION_MODEL))
    out.push({ name: "OpenAI", purpose: "describes sampled video frames (AI vision) and phrases answers to questions from the stored evidence" });
  if (env.TRANSCRIPTION_PROVIDER === "openai_compatible" && set(env.TRANSCRIPTION_MODEL)) {
    let host = "api.openai.com";
    try {
      host = new URL(env.TRANSCRIPTION_BASE_URL || "https://api.openai.com/v1").host;
    } catch {
      /* keep the default */
    }
    out.push({ name: host === "api.openai.com" ? "OpenAI" : `the speech-to-text service at ${host}`, purpose: "turns stream audio into text (transcription)" });
  }
  return out;
}
