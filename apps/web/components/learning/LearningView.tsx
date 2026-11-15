import Link from "next/link";
import { skillLevel, LEARNING_EXAMPLES_GOAL, type LearningResponse, type LearningSkill, type NowResponse } from "@slot1/contracts";
import { LiveEyes } from "./LiveEyes";
import "./learning.css";

const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Five stars, filled by the active models' test score: the skill level, in GTA's own currency. */
function Stars({ level }: { level: number }) {
  const filled = Math.round(level * 5);
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} viewBox="0 0 24 24" className={`learn-star h-7 w-7 ${i < filled ? "is-on" : ""}`}>
          <path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" />
        </svg>
      ))}
    </span>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 py-2">
      <dt className="shrink-0 text-ivory-2">{label}</dt>
      <span className="learn-leader min-w-6 flex-1" aria-hidden />
      <dd className="tnum shrink-0 font-display text-xl font-bold text-ivory">{value}</dd>
    </div>
  );
}

function SkillRow({ s }: { s: LearningSkill }) {
  const level = skillLevel(s);
  const status =
    s.score !== null
      ? `${pct(s.score)} right`
      : s.examples >= LEARNING_EXAMPLES_GOAL
        ? `${n(s.examples)} examples, ready to train`
        : s.examples > 0
          ? `${n(s.examples)} of ${LEARNING_EXAMPLES_GOAL} examples`
          : "Not learned yet";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)_minmax(8.5rem,auto)]">
      <span className="truncate text-ivory">{s.label}</span>
      <span className="order-3 col-span-2 sm:order-none sm:col-span-1">
        <span
          className={`learn-bar ${s.score !== null ? "is-tested" : "is-learning"}`}
          role="meter"
          aria-label={`${s.label}: ${status}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          style={{ ["--fill" as string]: `${Math.max(level, 0) * 100}%` }}
        />
      </span>
      <span className="text-right text-[0.85rem] leading-tight">
        <span className={s.score !== null ? "text-gold" : s.examples > 0 ? "text-apricot" : "text-ivory-3"}>{status}</span>
        {s.seen !== null && s.seen > 0 && <span className="block text-ivory-3">caught {n(s.seen)}× live</span>}
      </span>
    </li>
  );
}

const GROUPS: { group: LearningSkill["group"]; title: string; blurb: string }[] = [
  { group: "event", title: "What's happening", blurb: "Results, wanted levels, chases and crashes." },
  { group: "scene", title: "Where the player is", blurb: "One scene per frame." },
  { group: "box", title: "Reading the screen", blurb: "Finding each part of the HUD and what's in the frame." },
];

/**
 * The Learning page: what SLOT1's AI is looking at right now, what it has watched and caught across
 * every stream, and how far each GTA skill has come. One page for all streams combined.
 */
export function LearningView({ data, now }: { data: LearningResponse | null; now: NowResponse | null }) {
  const scene = data?.models.find((m) => m.task === "scene") ?? null;
  const detector = data?.models.find((m) => m.task === "detector") ?? null;
  const scored = (data?.models ?? []).filter((m) => m.score !== null);
  const level = scored.length ? scored.reduce((a, m) => a + (m.score ?? 0), 0) / scored.length : 0;
  const modelText = (m: typeof scene, metric: string) =>
    m ? `${m.version}${m.score !== null ? ` · ${pct(m.score)} ${metric}` : ""}` : "Not trained yet";

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-10 sm:px-6 lg:px-10">
      <header className="max-w-[62rem]">
        <h1 className="poster-title text-[length:var(--text-display-xl)] font-black leading-[0.86]">What SLOT1 learned</h1>
        <p className="mt-5 max-w-[60ch] text-lg text-ivory-2">
          Everything SLOT1’s AI has watched, caught and learned, from every stream sent to it, combined in one place. Every number here is counted, not
          estimated, and it grows with each stream.
        </p>
      </header>

      <section aria-labelledby="eyes-title" className="mt-14">
        <h2 id="eyes-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
          Its eyes right now
        </h2>
        <p className="mb-6 mt-2 text-ivory-2">The frame the AI is looking at on each stream, and what it makes of it.</p>
        <LiveEyes initial={now} />
      </section>

      {!data ? (
        <p className="mt-16 text-ivory-2">The learning numbers didn’t load. Reload the page to try again.</p>
      ) : (
        <>
          <section aria-labelledby="stats-title" className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
            <div>
              <h2 id="stats-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
                Stats
              </h2>
              <div className="mt-6 flex items-center gap-4 border-y hairline py-4">
                <Stars level={level} />
                <p className="text-sm leading-snug text-ivory-2">
                  {scored.length
                    ? `Skill level from the active models’ own test scores (${scored.map((m) => pct(m.score!)).join(", ")}).`
                    : "No trained model yet. The stars fill as SLOT1’s own GTA model is trained and tested."}
                </p>
              </div>
              <dl className="mt-2">
                <StatRow label="Streams watched" value={n(data.watched.streams)} />
                <StatRow label="Gameplay watched" value={`${data.watched.hours.toLocaleString("en-US")} h`} />
                <StatRow label="Channels watched" value={n(data.watched.channels)} />
                <StatRow label="Moments caught" value={n(data.watched.caught)} />
                <StatRow label="Channels teaching SLOT1" value={n(data.learning.channels)} />
                <StatRow label="Frames kept to learn from" value={n(data.learning.frames)} />
                <StatRow label="Frames labeled by people" value={n(data.learning.labeledFrames)} />
                <StatRow label="Scene model" value={modelText(scene, "F1")} />
                <StatRow label="Screen reader model" value={modelText(detector, "mAP")} />
              </dl>
              <p className="mt-4 text-[0.82rem] text-ivory-3">
                Watched and caught count public streams only. Learning counts only channels that switched on training in Studio.
              </p>
            </div>

            <div>
              <h2 className="font-display text-[length:var(--text-display-md)] font-bold leading-none">Skills</h2>
              <p className="mt-2 max-w-[62ch] text-ivory-2">
                A bar fills halfway with labeled examples (up to {LEARNING_EXAMPLES_GOAL}), and the rest of the way only when a trained model proves it
                on frames it never saw.
              </p>
              <div className="mt-6 space-y-10">
                {GROUPS.map((g) => (
                  <div key={g.group}>
                    <h3 className="font-display text-xl font-bold">{g.title}</h3>
                    <p className="text-sm text-ivory-3">{g.blurb}</p>
                    <ul className="mt-2 divide-y divide-[var(--color-line)]">
                      {data.skills
                        .filter((s) => s.group === g.group)
                        .map((s) => (
                          <SkillRow key={`${s.group}:${s.key}`} s={s} />
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section aria-labelledby="how-title" className="mt-20 border-t hairline pt-12">
            <h2 id="how-title" className="font-display text-[length:var(--text-display-md)] font-bold leading-none">
              How it learns
            </h2>
            <ol className="mt-8 grid gap-8 md:grid-cols-2 xl:grid-cols-4">
              {[
                ["Watch", "Every stream sent to SLOT1 is read live: a frame every 5 seconds by default, up to one a second, plus on-screen text."],
                [
                  "Keep",
                  "On channels that switched on training, SLOT1 keeps a frame every 10 seconds, at scene cuts and at big moments, up to 2,000 per stream.",
                ],
                ["Label", "Creators mark what’s on each frame in Studio → GTA model, with SLOT1’s own suggestions to accept or fix."],
                [
                  "Train and test",
                  "Frames from every channel are combined into one dataset. A new model replaces the old one only if it scores better on the same test frames.",
                ],
              ].map(([title, body], i) => (
                <li key={title} className="border-t-2 border-apricot pt-4">
                  <p className="tnum font-display text-sm font-bold text-apricot">Step {i + 1}</p>
                  <p className="mt-1 font-display text-2xl font-bold">{title}</p>
                  <p className="mt-2 text-ivory-2">{body}</p>
                </li>
              ))}
            </ol>
            <div className="mt-12 flex flex-wrap items-center gap-4">
              <Link href="/setup" className="btn btn-primary">
                Send your stream to SLOT1
              </Link>
              <Link href="/studio?tab=gta" className="btn btn-ghost">
                Teach SLOT1 in Studio
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
