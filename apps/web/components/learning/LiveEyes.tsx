"use client";

import Link from "next/link";
import type { NowResponse, NowStream } from "@slot1/contracts";
import { relativeAge } from "@/lib/format";

const BAD = new Set(["wasted", "busted", "mission_failed", "crash"]);
const GOOD = new Set(["mission_passed"]);

/** The activity in the game's own register: result screens big, the rest as plain labels. */
function Verdict({ s }: { s: NowStream }) {
  const a = s.activity;
  if (!a || a.key === "live") return <p className="font-display text-xl font-bold text-ivory-2">Watching</p>;
  const tone = BAD.has(a.key) ? "text-coral" : GOOD.has(a.key) ? "text-gold" : "text-ivory";
  return <p className={`poster-title text-[clamp(1.9rem,3.6vw,2.8rem)] leading-[0.9] ${tone}`}>{a.tier === "event" ? a.label.toUpperCase() : a.label}</p>;
}

function Eye({ s, now }: { s: NowStream; now: number }) {
  return (
    <li className="min-w-0 border hairline bg-graphite-900">
      <Link href={s.watchPath} className="group block">
        <div className="relative aspect-video overflow-hidden bg-graphite-800">
          {s.thumbnailUrl ? (
            // The latest frame SLOT1 received: exactly what the AI looked at.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.thumbnailUrl} alt={`What SLOT1 saw on ${s.displayName}'s stream`} className="h-full w-full object-cover" />
          ) : null}
          <div className="ai-scan pointer-events-none absolute inset-0" aria-hidden />
          <span className="chip chip-live absolute left-2.5 top-2.5">Live</span>
          {s.label === "test" && <span className="chip chip-muted absolute right-2.5 top-2.5 bg-graphite/80">Test stream</span>}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-graphite via-graphite/70 to-transparent px-4 pb-3 pt-10">
            <Verdict s={s} />
          </div>
        </div>
        <div className="space-y-1.5 p-4">
          <p className="flex items-baseline justify-between gap-3">
            <span className="truncate font-display text-lg font-bold group-hover:text-apricot">{s.displayName}</span>
            {s.activity?.observedAt && <span className="tnum shrink-0 text-[0.8rem] text-ivory-3">seen {relativeAge(s.activity.observedAt, now)}</span>}
          </p>
          {s.activity?.detail && s.activity.detail.trim().toLowerCase() !== s.activity.label.toLowerCase() && (
            <p className="line-clamp-2 text-sm text-ivory-2">{s.activity.detail}</p>
          )}
        </div>
      </Link>
    </li>
  );
}

/**
 * What the AI is looking at right now on every stream sent to SLOT1, and one feed of everything it
 * caught across them. The page polls the same public snapshot as "Right now" and passes it in.
 */
export function LiveEyes({ data, now }: { data: NowResponse | null; now: number }) {
  const watched = (data?.streams ?? []).filter((s) => s.kind === "slot1" && s.activity);
  const feed = watched
    .flatMap((s) => s.recent.map((e) => ({ ...e, who: s.displayName, path: s.watchPath })))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, 14);

  if (watched.length === 0) {
    return (
      <div className="grid gap-6 border hairline bg-graphite-900 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-end">
        <div className="max-w-[60ch]">
          <p className="font-display text-2xl font-bold">No stream is sending video to SLOT1 right now.</p>
          <p className="mt-2 text-ivory-2">
            The moment someone streams through SLOT1, this shows what the AI is looking at on each stream and everything it catches, live.
          </p>
        </div>
        <Link href="/setup" className="btn btn-primary self-start md:self-end">
          Send your stream to SLOT1
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <ul className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3" aria-label="Streams the AI is watching">
        {watched.map((s) => (
          <Eye key={s.broadcasterId} s={s} now={now} />
        ))}
      </ul>
      <section aria-labelledby="feed-title" className="border hairline bg-graphite-900">
        <h3 id="feed-title" className="border-b hairline px-4 py-3 font-display text-lg font-bold">
          Everything it caught, all streams
        </h3>
        {feed.length === 0 ? (
          <p className="p-4 text-sm text-ivory-2">Nothing named in the last few minutes.</p>
        ) : (
          <ol className="divide-y divide-[var(--color-line)]" aria-live="polite">
            {feed.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <p className="flex justify-between gap-3 text-[0.78rem] text-ivory-3">
                  <Link href={e.path} className="truncate hover:text-ivory">
                    {e.who}
                  </Link>
                  <span className="tnum shrink-0">{relativeAge(e.receivedAt, now)}</span>
                </p>
                <p className="mt-0.5 text-ivory">{e.description}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
