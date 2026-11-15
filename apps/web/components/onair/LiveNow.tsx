import Link from "next/link";
import type { ChannelCard, ClipView, ObservationPage, WatchChannelResponse } from "@slot1/contracts";
import { WatchClient } from "@/components/watch/WatchClient";
import { embedParents, serverApi } from "@/lib/server";

/**
 * The home page's "Live now": the first live channel with the same player, panels (live log, Ask
 * SLOT1, session) and Twitch chat as its watch page. A preview channel (Admin → Preview channels,
 * shown to admins only) says so.
 */
export async function LiveNow({ channel }: { channel: ChannelCard }) {
  const watch = await serverApi<WatchChannelResponse>(`/api/channels/${encodeURIComponent(channel.login)}/watch`);
  if (!watch.ok) return null;
  let page: ObservationPage | null = null;
  let clips: ClipView[] = [];
  if (watch.data.session) {
    const id = watch.data.session.id;
    const [p, c] = await Promise.all([serverApi<ObservationPage>(`/api/sessions/${id}/observations`), serverApi<{ clips: ClipView[] }>(`/api/sessions/${id}/clips`)]);
    if (p.ok) page = p.data;
    if (c.ok) clips = c.data.clips;
  }
  return (
    <section id="live-now" aria-labelledby="live-now-title" className="scroll-mt-20 border-t hairline">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-x-6 gap-y-2 px-4 pt-10 sm:px-6 lg:px-10">
        <h2 id="live-now-title" className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">
          Live now
        </h2>
        <Link href={`/watch/${channel.login}`} className="text-[0.95rem] text-ivory-2 underline underline-offset-4 hover:text-ivory">
          Open {channel.displayName}’s page
        </Link>
      </div>
      {channel.preview && (
        <p className="mx-auto mt-3 flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 text-sm text-ivory-2 sm:px-6 lg:px-10" data-testid="preview-note">
          <span className="chip chip-muted">Preview</span>
          Only you see this. {channel.displayName} is in Admin → Preview channels and hasn’t connected SLOT1.
        </p>
      )}
      <WatchClient watch={watch.data} page={page} clips={clips} embedParents={embedParents()} clipSlug={null} nameAs="h2" />
    </section>
  );
}
