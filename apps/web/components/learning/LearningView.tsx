import Link from "next/link";
import type { LearningResponse, NowResponse } from "@slot1/contracts";
import { LearningExperience } from "./LearningExperience";
import "./learning.css";

const STEPS: [string, string][] = [
  ["Watch", "Every stream sent to SLOT1, live."],
  ["Keep", "Frames from channels that opt in."],
  ["Label", "Creators mark what’s on screen."],
  ["Train", "A new model wins only if it tests better."],
];

/**
 * The Learning page: SLOT1's learning network as a globe that grows with everything it learns,
 * the streams it's watching with what it catches, and how it learns. One page, every stream.
 */
export function LearningView({ data, now }: { data: LearningResponse | null; now: NowResponse | null }) {
  return (
    <div className="mx-auto max-w-[1600px] overflow-x-clip px-4 pb-24 pt-10 sm:px-6 lg:px-10">
      <header className="relative z-10 max-w-[56rem]">
        <h1 className="poster-title text-[length:var(--text-display-xl)] font-black leading-[0.86]">SLOT1 is learning</h1>
        <p className="mt-4 max-w-[46ch] text-lg text-ivory-2">Every stream sent to SLOT1 grows this network. Live catches fly into the skill they teach.</p>
      </header>

      {data ? (
        <LearningExperience initialLearning={data} initialNow={now} />
      ) : (
        <p className="mt-16 text-ivory-2">The learning network didn’t load. Reload the page to try again.</p>
      )}

      <section aria-labelledby="how-title" className="mt-20 border-t hairline pt-10">
        <h2 id="how-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
          How it learns
        </h2>
        <ol className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex items-baseline gap-4 border-t-2 border-apricot pt-3">
              <span className="tnum font-display text-3xl font-bold text-apricot">{i + 1}</span>
              <span>
                <span className="block font-display text-2xl font-bold">{title}</span>
                <span className="text-ivory-2">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link href="/setup" className="btn btn-primary">
            Send your stream to SLOT1
          </Link>
          <Link href="/studio?tab=gta" className="btn btn-ghost">
            Teach SLOT1 in Studio
          </Link>
        </div>
      </section>
    </div>
  );
}
