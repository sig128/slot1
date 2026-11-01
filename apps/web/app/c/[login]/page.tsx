import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { LibraryItemView, ProfileResponse } from "@slot1/contracts";
import { MediaTile } from "@/components/clipper/PublicMedia";
import { ServiceDown } from "@/components/ui/ServiceDown";
import { publicOrigin } from "@/lib/origin";
import { serverApi } from "@/lib/server";
import { ShareLinkButton } from "@/components/clipper/ShareClip";

export const dynamic = "force-dynamic";

const LOGIN_RE = /^[A-Za-z0-9_]{2,40}$/;

async function load(login: string) {
  if (!LOGIN_RE.test(login)) return null;
  return serverApi<ProfileResponse>(`/api/profiles/${encodeURIComponent(login)}`);
}

function coverOf(p: ProfileResponse): LibraryItemView | undefined {
  return [...p.featured, ...p.clips, ...p.screenshots, ...p.recordings].find((i) => i.posterUrl);
}

export async function generateMetadata({ params }: { params: Promise<{ login: string }> }): Promise<Metadata> {
  const { login } = await params;
  const r = await load(login);
  if (!r?.ok) return { title: "Creator", robots: { index: false } };
  const p = r.data;
  const origin = await publicOrigin();
  const url = `${origin}/c/${p.channel.login}`;
  const count = p.clips.length + p.recordings.length + p.screenshots.length;
  const description =
    count > 0
      ? `${p.channel.displayName}'s GTA clips, recordings and screenshots, with the moments SLOT1 saw happen.`
      : `${p.channel.displayName} on SLOT1: GTA streams with an evidence-backed live log.`;
  const cover = coverOf(p);
  // Stable poster URLs (not expiring media links) so share cards keep working.
  const images = cover ? [{ url: `${origin}/api/library/${cover.id}/poster`, alt: cover.title }] : [];
  const title = `${p.channel.displayName} clips`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "profile", title: `${title} on SLOT1`, description, url, siteName: "SLOT1", images, username: p.channel.login },
    twitter: { card: images.length ? "summary_large_image" : "summary", title: `${title} on SLOT1`, description, images: images.map((i) => i.url) },
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const r = await load(login);
  if (!r) notFound();
  if (!r.ok) {
    if (r.status === 404 || r.status === 400) notFound();
    return <ServiceDown message={r.message} requirement={r.requirement} />;
  }
  const p = r.data;
  const empty = p.clips.length + p.recordings.length + p.screenshots.length === 0;
  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-10 sm:px-6 lg:px-10">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b hairline pb-8">
        <div className="flex min-w-0 items-end gap-5">
          {p.channel.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.channel.avatarUrl} alt="" className="h-20 w-20 shrink-0 rounded-full sm:h-24 sm:w-24" />
          ) : (
            <span aria-hidden className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-graphite-600 font-display text-4xl font-black sm:h-24 sm:w-24">
              {p.channel.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-apricot">Creator</p>
            <h1 className="poster-title break-words text-[length:var(--text-display-lg)] font-black leading-[0.88]">{p.channel.displayName}</h1>
            <p className="tnum mt-2 text-sm text-ivory-2">
              {p.clips.length} clip{p.clips.length === 1 ? "" : "s"} · {p.recordings.length} recording{p.recordings.length === 1 ? "" : "s"} · {p.screenshots.length} screenshot
              {p.screenshots.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.live && (
            <Link href={p.live.watchPath} className="btn btn-coral">
              <span className="live-dot live-dot-pulse" aria-hidden />
              Live now{p.live.title ? <span className="sr-only">: {p.live.title}</span> : null}
            </Link>
          )}
          {p.channel.twitchUrl && (
            <a href={p.channel.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost">
              Twitch
            </a>
          )}
          {p.viewer.channelPublic && <ShareLinkButton path={`/c/${p.channel.login}`} title={`${p.channel.displayName} on SLOT1`} className="btn btn-ghost" />}
        </div>
      </header>

      {p.viewer.isOwner && (
        <p className="mt-6 max-w-[80ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
          {p.viewer.channelPublic
            ? "This is your public profile. Only items you set to Public are listed here."
            : "Only you can see this page: your channel is private. Make it public under Studio, Privacy and data, to share your profile."}{" "}
          <Link href="/studio#library" className="underline hover:text-ivory">
            Manage your library
          </Link>
        </p>
      )}

      {p.live && (
        <Link href={p.live.watchPath} className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 border-l-2 border-coral pl-4 hover:text-apricot">
          <span className="chip chip-live">Live</span>
          <span className="font-display text-xl font-bold">{p.live.title ?? "On air now"}</span>
          <span className="text-sm text-ivory-2">Watch with SLOT1&apos;s live log</span>
        </Link>
      )}

      {empty && (
        <p className="mt-12 max-w-[60ch] text-ivory-2">
          Nothing shared yet. When {p.channel.displayName} makes clips, recordings or screenshots public, they appear here.
        </p>
      )}

      {p.featured.length > 0 && (
        <section className="mt-12" aria-labelledby="featured">
          <h2 id="featured" className="poster-title text-[length:var(--text-display-md)] font-black">
            Featured
          </h2>
          <ul className="mt-5 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {p.featured.slice(0, 6).map((i) => (
              <li key={i.id} className="min-w-0">
                <MediaTile item={i} size="lg" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.clips.length > 0 && (
        <section className="mt-14" aria-labelledby="clips">
          <h2 id="clips" className="poster-title text-[length:var(--text-display-md)] font-black">
            Clips
          </h2>
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {p.clips.map((i) => (
              <li key={i.id} className="min-w-0">
                <MediaTile item={i} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.recordings.length > 0 && (
        <section className="mt-14" aria-labelledby="recordings">
          <h2 id="recordings" className="poster-title text-[length:var(--text-display-md)] font-black">
            Recordings
          </h2>
          <ul className="mt-5 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {p.recordings.map((i) => (
              <li key={i.id} className="min-w-0">
                <MediaTile item={i} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.screenshots.length > 0 && (
        <section className="mt-14" aria-labelledby="screenshots">
          <h2 id="screenshots" className="poster-title text-[length:var(--text-display-md)] font-black">
            Screenshots
          </h2>
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {p.screenshots.map((i) => (
              <li key={i.id} className="min-w-0">
                <MediaTile item={i} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
