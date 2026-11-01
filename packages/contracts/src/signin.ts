import { z } from "zod";

/**
 * Why a "Sign in with Twitch" attempt didn't finish. The callback sends it back to the page as
 * `?twitch=error&why=<code>` (or `twitch=denied` / `twitch=expired`), so the person sees what
 * happened instead of the same sign-in screen again, and /admin and /status show it too.
 */
export const TwitchSignInWhy = z.enum([
  /** Twitch rejected the site's app secret (wrong, old or regenerated secret). */
  "app_secret",
  /** Twitch doesn't know the site's Client ID. */
  "app_client",
  /** The redirect URL Twitch has on file doesn't match this site's. */
  "redirect",
  /** The one-time code from Twitch was already used or too old (back button, double click, slow approval). */
  "code",
  /** The sign-in started in another browser or tab, or took more than 10 minutes. */
  "expired",
  /** The person clicked Cancel on Twitch. */
  "denied",
  /** Twitch didn't answer or answered with an error of its own. */
  "twitch_down",
  /** Sign in with Twitch isn't set up on this site yet. */
  "not_configured",
  /** Something failed on SLOT1 while saving the connection. */
  "server",
]);
export type TwitchSignInWhy = z.infer<typeof TwitchSignInWhy>;

export const TwitchSignInEvent = z.object({
  at: z.string(),
  outcome: z.enum(["connected", "denied", "error"]),
  why: TwitchSignInWhy.nullable(),
  /** Twitch's own error text (sanitized). Admin-only: never on public pages. */
  detail: z.string().max(300).nullable(),
});
export type TwitchSignInEvent = z.infer<typeof TwitchSignInEvent>;
