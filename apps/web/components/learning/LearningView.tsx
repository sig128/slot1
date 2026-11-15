import Link from "next/link";
import type { LearningResponse, NowResponse } from "@slot1/contracts";
import { KnowledgeMap, PlacesSeen } from "./KnowledgeMap";
import { LearningExperience } from "./LearningExperience";
import { MissionStories } from "./MissionStories";
import { NamedCatalog } from "./NamedCatalog";
import "./learning.css";

const STEPS: [string, string][] = [
  ["Watch", "Every stream sent to SLOT1, live, every second."],
  ["Sort", "Every moment filed by what happened and where."],
  ["Label", "Creators mark what's on screen."],
  ["Train", "A new model wins only if it tests better."],
];

/**
 * The Learning page: ask SLOT1 about the game (its globe is its face), then everything it knows,
 * sorted: missions start to result, what leads to each result, every activity and place, the
 * streams it's watching, and how it learns. One page, every stream.
 */
export function LearningView({ data, now }: { data: LearningResponse | null; now: NowResponse | null }) {
  if (!data) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-10 sm:px-6 lg:px-10">
        <h1 className="poster-title text-[length:var(--text-display-xl)] font-black leading-[0.86]">SLOT1 is learning</h1>
        <p className="mt-16 text-ivory-2">The learning network didn&apos;t load. Reload the page to try again.</p>
      </div>
    );
  }
  return (
    <LearningExperience
      initialLearning={data}
      initialNow={now}
      knowledge={
        <>
          <MissionStories data={data} />
          <KnowledgeMap data={data} />
          <NamedCatalog data={data} />
          <PlacesSeen data={data} />
        </>
      }
      footer={
        <section id="how" aria-labelledby="how-title" className="la-section">
          <div className="la-section-head">
            <h2 id="how-title" className="la-section-title">
              How it learns
            </h2>
          </div>
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
      }
    />
  );
}
