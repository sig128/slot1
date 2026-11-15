"use client";

/**
 * Kick's own embedded player (player.kick.com), unmodified: nothing of ours covers its controls or
 * video. Starts muted so it can autoplay; viewers unmute in the player.
 */
export function KickPlayer({ slug, displayName }: { slug: string; displayName: string }) {
  return (
    <div className="w-full">
      <iframe
        title={`${displayName} live on Kick`}
        src={`https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true&muted=true`}
        className="block aspect-video w-full bg-black"
        allowFullScreen
        allow="autoplay; fullscreen; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
