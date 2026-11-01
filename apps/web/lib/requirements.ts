/**
 * A capability's reason as one sentence. Visitors and creators already get a friendly line from
 * the API ("Streaming to SLOT1 isn't open yet"). Operators get the technical one ("Twitch not
 * configured: missing A, B"); it's shown here without its list of settings, because <SetupFix>
 * next to it spells those out together with the command that fixes them.
 */
export function requirementText(reason: string | null | undefined): string {
  if (!reason) return "";
  const s = reason.replace(/:\s*missing .+$/i, "").trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
