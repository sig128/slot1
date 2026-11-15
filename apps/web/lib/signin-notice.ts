/**
 * What the page says after "Sign in with Twitch" comes back. The API sends the result as
 * ?twitch=connected | denied | error&why=<code> (TwitchSignInWhy in @slot1/contracts) and the bot
 * link as ?bot=..., so a failed sign-in never looks like nothing happened.
 */
export interface SignInNotice {
  tone: "ok" | "warn" | "error";
  title: string;
  body: string | null;
  /** For whoever runs the site: what to change. Shown in smaller type under the body. */
  owner: string | null;
  /** Offer the sign-in button again. */
  retry: boolean;
  /** The reason code from the API (?why=), when there was one. */
  code: string | null;
  /** Which sign-in this is about, so "try again" goes to the same platform. */
  platform: "twitch" | "kick";
}

export const TWITCH_SIGN_IN_PATH = "/api/auth/twitch/start";

export const KICK_SIGN_IN_PATH = "/api/auth/kick/start";

export type SignInPlatform = "twitch" | "kick";

/** Sign in just to chat: identity only, no channel connected. Comes back to `returnTo`. */
export function chatSignInHref(returnTo: string, platform: SignInPlatform = "twitch"): string {
  return `${platform === "kick" ? KICK_SIGN_IN_PATH : TWITCH_SIGN_IN_PATH}?role=viewer&returnTo=${encodeURIComponent(returnTo)}`;
}

/** The "Sign in with Twitch" link. It goes straight to Twitch, then back to `returnTo`. */
export function twitchSignInHref(returnTo = "/studio"): string {
  return returnTo === "/studio" ? `${TWITCH_SIGN_IN_PATH}?returnTo=%2Fstudio` : `${TWITCH_SIGN_IN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The "Sign in with Kick" link: the creator's Kick channel, then back to `returnTo`. */
export function kickSignInHref(returnTo = "/studio"): string {
  return `${KICK_SIGN_IN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function signInHref(platform: SignInPlatform, returnTo = "/studio"): string {
  return platform === "kick" ? kickSignInHref(returnTo) : twitchSignInHref(returnTo);
}

export function signInNotice(search: URLSearchParams, origin: string): SignInNotice | null {
  const k = kickNotice(search, origin);
  if (k) return { ...k, code: search.get("why"), platform: "kick" };
  const n = notice(search, origin);
  return n ? { ...n, code: search.get("why"), platform: "twitch" } : null;
}

/** What the page says after "Sign in with Kick" comes back: ?kick=connected | signed_in | denied | error&why=. */
function kickNotice(search: URLSearchParams, origin: string): Omit<SignInNotice, "code" | "platform"> | null {
  const kick = search.get("kick");
  if (!kick) return null;
  if (kick === "connected") return { tone: "ok", title: "Kick connected.", body: null, owner: null, retry: false };
  if (kick === "signed_in") return { tone: "ok", title: "Signed in with Kick.", body: null, owner: null, retry: false };
  if (kick === "denied") return { tone: "warn", title: "You cancelled on Kick.", body: "Nothing was connected. Sign in again whenever you're ready.", owner: null, retry: true };
  switch (search.get("why")) {
    case "not_configured":
      return {
        tone: "warn",
        title: "Sign in with Kick isn't open yet.",
        body: "It opens as soon as the site's Kick app is connected.",
        owner: "Site owner: save the Kick app's Client ID and Secret in Admin → Settings → Kick app.",
        retry: false,
      };
    case "expired":
      return {
        tone: "warn",
        title: "That sign-in ran out.",
        body: "A sign-in works for 10 minutes, in the browser where you started it. Start again here.",
        owner: null,
        retry: true,
      };
    case "code":
      return {
        tone: "warn",
        title: "Kick didn't accept the sign-in.",
        body: "That happens after going back or clicking twice. Sign in again.",
        owner: `Site owner: if it keeps happening, check that the Kick app's Redirect URL is exactly ${origin}/api/auth/kick/callback.`,
        retry: true,
      };
    case "app":
      return {
        tone: "error",
        title: "Kick didn't accept this site's app.",
        body: "Sign-in can't finish until it's fixed. Nothing is wrong with your Kick account.",
        owner: "Site owner: copy the Client ID and Secret from kick.com → Settings → Developer into Admin → Settings → Kick app.",
        retry: true,
      };
    case "kick_down":
      return { tone: "warn", title: "Kick didn't answer.", body: "Try again in a minute.", owner: null, retry: true };
    case "no_channel":
      return { tone: "warn", title: "Kick didn't name a channel for this account.", body: "Sign in with the Kick account you stream from.", owner: null, retry: true };
    case "server":
      return { tone: "error", title: "SLOT1 couldn't save your sign-in.", body: "Try again. If it keeps happening, the problem is on our side.", owner: null, retry: true };
    default:
      return { tone: "error", title: "Kick sign-in didn't finish.", body: "Try again.", owner: null, retry: true };
  }
}

function notice(search: URLSearchParams, origin: string): Omit<SignInNotice, "code" | "platform"> | null {
  const twitch = search.get("twitch");
  const bot = search.get("bot");
  if (twitch === "connected") return { tone: "ok", title: "Twitch connected.", body: null, owner: null, retry: false };
  // Signed in only to chat: no channel was connected.
  if (twitch === "signed_in") return { tone: "ok", title: "Signed in with Twitch.", body: null, owner: null, retry: false };
  if (twitch === "denied") {
    return { tone: "warn", title: "You cancelled on Twitch.", body: "Nothing was connected. Sign in again whenever you're ready.", owner: null, retry: true };
  }
  if (twitch === "error") {
    switch (search.get("why")) {
      case "expired":
        return {
          tone: "warn",
          title: "That sign-in ran out.",
          body: "A sign-in works for 10 minutes, in the browser where you started it. Start again here.",
          owner: null,
          retry: true,
        };
      case "code":
        return { tone: "warn", title: "Twitch's sign-in code was already used.", body: "That happens after going back or clicking twice. Sign in again.", owner: null, retry: true };
      case "twitch_down":
        return { tone: "warn", title: "Twitch didn't answer.", body: "Try again in a minute.", owner: null, retry: true };
      case "not_configured":
        return {
          tone: "warn",
          title: "Sign in with Twitch isn't open yet.",
          body: "It opens as soon as the site's Twitch app is connected.",
          owner: "Site owner: create the app at dev.twitch.tv/console, then save its Client ID and Secret in Admin → Settings → Twitch app.",
          retry: false,
        };
      case "app_secret":
        return {
          tone: "error",
          title: "Twitch didn't accept this site's app secret.",
          body: "Sign-in can't finish until it's fixed. It's a setting on SLOT1's side; nothing is wrong with your Twitch account.",
          owner: "Site owner: in the Twitch developer console, open the app and click New Secret, then paste it in Admin → Settings → Twitch app.",
          retry: true,
        };
      case "app_client":
        return {
          tone: "error",
          title: "Twitch doesn't recognize this site's app.",
          body: "Sign-in can't finish until it's fixed. Nothing is wrong with your Twitch account.",
          owner: "Site owner: copy the Client ID from the Twitch developer console into Admin → Settings → Twitch app.",
          retry: true,
        };
      case "redirect":
        return {
          tone: "error",
          title: "The Twitch app's redirect URL doesn't match this site.",
          body: "Sign-in can't finish until it's fixed. Nothing is wrong with your Twitch account.",
          owner: `Site owner: in the Twitch developer console, set the app's OAuth Redirect URL to ${origin}/api/auth/twitch/callback exactly.`,
          retry: true,
        };
      case "server":
        return { tone: "error", title: "SLOT1 couldn't save your connection.", body: "Try again. If it keeps happening, the problem is on our side.", owner: null, retry: true };
      default:
        return { tone: "error", title: "Twitch sign-in didn't finish.", body: "Try again.", owner: null, retry: true };
    }
  }
  if (bot === "linked") return { tone: "ok", title: "SLOT1 bot account linked.", body: null, owner: null, retry: false };
  if (bot === "wrong_account") {
    return { tone: "warn", title: "That Twitch account isn't the SLOT1 bot account.", body: "Sign in to Twitch as the bot account, then link it again.", owner: null, retry: false };
  }
  if (bot === "missing_scopes") return { tone: "warn", title: "The bot authorization was missing permissions.", body: "Link it again and approve everything Twitch asks.", owner: null, retry: false };
  if (bot === "not_admin") return { tone: "warn", title: "Only a SLOT1 admin can link the bot account.", body: null, owner: null, retry: false };
  return null;
}
