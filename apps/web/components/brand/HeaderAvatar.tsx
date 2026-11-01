import type { MeResponse } from "@slot1/contracts";

/**
 * The signed-in creator's Twitch avatar, or their initial when Twitch has none. Decorative: the
 * link around it carries the name.
 */
export function HeaderAvatar({ broadcaster, className }: { broadcaster: NonNullable<MeResponse["broadcaster"]>; className: string }) {
  return broadcaster.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={broadcaster.avatarUrl} alt="" className={`shrink-0 rounded-full object-cover ${className}`} />
  ) : (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-full bg-graphite-600 font-display font-bold text-ivory ${className}`}>
      {broadcaster.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}
