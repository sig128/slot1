/** "Twitch not configured: missing A, B" -> "Missing A, B". Keeps the exact variable names. */
export function requirementText(reason: string | null | undefined): string {
  if (!reason) return "";
  const m = /missing (.+)$/i.exec(reason);
  return m ? `Missing ${m[1]}.` : reason.endsWith(".") ? reason : `${reason}.`;
}
