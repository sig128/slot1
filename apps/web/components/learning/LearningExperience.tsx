"use client";

import { useEffect, useState } from "react";
import type { LearningResponse, NowResponse } from "@slot1/contracts";
import { skillLevel } from "@slot1/contracts";
import { GameAsk } from "./GameAsk";
import { knowledgeDots, LearningGlobe } from "./LearningGlobe";
import { LiveEyes } from "./LiveEyes";

const n = (v: number) => v.toLocaleString("en-US");

/**
 * The live half of the Learning page: the network globe, its numbers, and the streams the AI is
 * watching. Polls "Right now" every few seconds and the learning totals every 30 s, while visible.
 */
export function LearningExperience({ initialLearning, initialNow }: { initialLearning: LearningResponse | null; initialNow: NowResponse | null }) {
  const [learning, setLearning] = useState(initialLearning);
  const [now, setNow] = useState(initialNow);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    const poll = async (path: string, set: (v: never) => void) => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(path, { cache: "no-store" });
        if (r.ok && !stop) set((await r.json()) as never);
      } catch {
        // Keep what we have; the next poll tries again.
      }
    };
    const fast = setInterval(() => {
      void poll("/api/now", setNow as (v: never) => void);
      setClock(Date.now());
    }, initialNow?.refreshMs ?? 5000);
    const slow = setInterval(() => void poll("/api/learning", setLearning as (v: never) => void), 30_000);
    return () => {
      stop = true;
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [initialNow?.refreshMs]);

  const skills = learning?.skills ?? [];
  const started = skills.filter((s) => skillLevel(s) > 0).length;
  const live = (now?.streams ?? []).filter((s) => s.kind === "slot1" && s.activity).length;
  const stats: [string, string][] = learning
    ? [
        ["Live streams", n(live)],
        ["Moments caught", n(learning.watched.caught)],
        ["Hours watched", learning.watched.hours.toLocaleString("en-US")],
        ["Frames learned", n(learning.learning.labeledFrames + learning.learning.frames)],
        ["Lines heard", n(learning.heard.lines)],
        ["Activities seen", `${learning.activities.filter((a) => a.seen > 0).length}/${learning.activities.length}`],
      ]
    : [];

  return (
    <>
      <div className="learn-stage relative -mx-4 sm:-mx-6 lg:-mx-10">
        <LearningGlobe data={learning} now={now} />
        <dl className="learn-hud absolute inset-x-0 bottom-0 grid grid-cols-2 gap-x-6 gap-y-3 px-4 pb-5 sm:grid-cols-3 sm:px-6 lg:grid-cols-6 lg:px-10">
          {stats.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dd className="tnum font-display text-[clamp(1.6rem,3vw,2.6rem)] font-bold leading-none text-ivory">{value}</dd>
              <dt className="mt-1 text-[0.8rem] text-ivory-3">{label}</dt>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.85rem] text-ivory-2">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-coral" aria-hidden /> What’s happening
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-signal" aria-hidden /> Where the player is
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-apricot" aria-hidden /> Reading the screen
        </span>
        {learning && learning.heard.languages.length > 0 && (
          <span className="text-ivory-2">
            Heard in {learning.heard.languages.length === 1 ? "1 language" : `${learning.heard.languages.length} languages`}:{" "}
            {learning.heard.languages
              .slice(0, 8)
              .map((l) => `${l.name} (${n(l.lines)})`)
              .join(", ")}
          </span>
        )}
        <span className="text-ivory-3">
          {knowledgeDots(learning) > 0
            ? "Bright dots are what it learned. Hover a skill to see how far it’s come; drag to turn."
            : "Hover a skill to see how far it’s come; drag to turn. It lights up as streams come in."}
        </span>
      </div>

      <GameAsk />

      <section aria-labelledby="eyes-title" className="mt-16">
        <h2 id="eyes-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
          Its eyes right now
        </h2>
        <div className="mt-6">
          <LiveEyes data={now} now={clock} />
        </div>
      </section>
    </>
  );
}
