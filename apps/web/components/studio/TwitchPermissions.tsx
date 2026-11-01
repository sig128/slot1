import type { StudioCtx } from "./StudioApp";

/** What each creator permission is for, in the words a streamer would use (docs/TWITCH_SCOPES.md). */
const SCOPE_USE: Record<string, string> = {
  "channel:bot": "the SLOT1 bot in your chat",
  "clips:edit": "making clips",
  "channel:manage:clips": "downloading clips for analysis",
  "channel:read:stream_key": "sending your stream on to Twitch",
};

/** Re-connecting asks Twitch for every permission at once, so one approval fills in what's missing. */
export function grantPermissionsUrl(returnTo = "/studio?tab=stream"): string {
  return `/api/auth/twitch/start?returnTo=${encodeURIComponent(returnTo)}`;
}

function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * For creators who connected before "Connect my Twitch" asked for everything in one approval:
 * what their connection still lacks, and the one click that adds it.
 */
export function TwitchPermissionsNotice({ ctx, returnTo }: { ctx: StudioCtx; returnTo?: string }) {
  const missing = ctx.overview.twitch.missingScopes ?? [];
  if (!ctx.caps.twitch.available || missing.length === 0) return null;
  return (
    <div className="mb-5 max-w-[70ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2" data-testid="twitch-permissions">
      <p>
        Your Twitch connection doesn’t cover {list(missing.map((s) => SCOPE_USE[s] ?? s))} yet. One approval on Twitch adds {missing.length === 1 ? "it" : "them all"}, and
        you come straight back here.
      </p>
      <a href={grantPermissionsUrl(returnTo)} className="btn btn-primary btn-sm mt-2">
        Grant the missing permissions
      </a>
    </div>
  );
}
