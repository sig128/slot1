import Link from "next/link";
import type { EvidenceClass } from "@slot1/contracts";
import { EVIDENCE_CLASS_LABEL } from "@slot1/contracts";
import { EvidenceGlyph } from "@/components/watch/EvidenceGlyph";
import { FAQ, FEATURES } from "@/lib/home-content";

const KNOWS: { cls: EvidenceClass; meaning: string }[] = [
  { cls: "visible_text", meaning: "Read from text on screen, like a mission title." },
  { cls: "visible", meaning: "Seen in the frames themselves." },
  { cls: "inferred", meaning: "Worked out from several frames, and labeled as a guess." },
  { cls: "heard", meaning: "From the stream’s audio, when transcription is on." },
  { cls: "measured", meaning: "Measured from the video: cuts, black screens, coverage." },
  { cls: "platform", meaning: "Reported by Twitch, like the title or category." },
];

/** Rockstar Games' scheduled date for GTA VI. The date is shown only while it is still ahead. */
const GTA_VI_SCHEDULED = Date.UTC(2026, 10, 19);
function gtaViStillAhead(): boolean {
  return Date.now() < GTA_VI_SCHEDULED;
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="poster-title scroll-mt-24 text-[length:var(--text-display-md)] font-black leading-[0.92]">
      {children}
    </h2>
  );
}

type Stage = "done" | "active" | "next";
const STAGE_LABEL: Record<Stage, string> = { done: "Supported", active: "In training", next: "Up next" };

function StageMark({ stage }: { stage: Stage }) {
  return (
    <svg viewBox="0 0 28 28" className="mt-0.5 h-7 w-7 shrink-0" aria-hidden>
      <rect x="2" y="2" width="24" height="24" rx="4" fill={stage === "done" ? "#ffc94d" : "#1c0b22"} stroke="#140715" strokeWidth="3" />
      {stage === "done" && <path d="M8 14.5l4 4 8-9" fill="none" stroke="#140715" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />}
      {stage === "active" && <path d="M14 7a7 7 0 0 1 0 14z" fill="#ffc94d" stroke="#140715" strokeWidth="1.6" />}
      {stage === "next" && <circle cx="14" cy="14" r="5.5" fill="none" stroke="#ffc94d" strokeWidth="2.6" strokeDasharray="3 2.6" />}
    </svg>
  );
}

/**
 * The rest of the home page, under the intro and "How it works": the GTA AI SLOT1 is training,
 * what you get, how SLOT1 backs up what it says, and questions. Server-rendered so search engines
 * read it; h2 sections only (the page's h1 is the intro).
 */
export function HomeLanding() {
  const stillAhead = gtaViStillAhead();
  return (
    <div className="border-t hairline">
      <section aria-labelledby="gta-ai" id="gta-ai-section" className="mx-auto grid max-w-[1600px] scroll-mt-20 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-6">
          <span id="gta-ai" className="block scroll-mt-24" />
          <h2 id="gta-ai-title" className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">
            The GTA AI we’re building together
          </h2>
          <p className="mt-6 max-w-[56ch] text-[1.1rem] text-ivory-2">
            SLOT1 is training its own GTA AI. When creators opt in, frames from their streams teach it the missions, places, vehicles and moments of the
            game.
          </p>
          <ul className="mt-6 max-w-[56ch] space-y-3 text-ivory-2">
            <li>
              <strong className="font-display text-[1.12rem] font-semibold text-ivory">Opt-in only.</strong> Nothing is used without the creator’s OK. Turn
              it on in Studio, under GTA model.
            </li>
            <li>
              <strong className="font-display text-[1.12rem] font-semibold text-ivory">Change your mind any time.</strong> Switching it off stops
              collection and removes your frames from future training sets. Copies already used in a training run can’t be recalled.
            </li>
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/studio" className="btn btn-coral">
              Open Studio
            </Link>
            <Link href="/setup#ai" className="btn btn-ghost">
              How the AI works
            </Link>
          </div>
        </div>

        <div className="lg:col-span-5 lg:col-start-8">
          <div className="gx-objectives">
            <h3 className="font-display text-[1.45rem] font-bold leading-tight text-ivory">Where it stands</h3>
            <ol className="mt-4 space-y-5">
              <li className="flex gap-3.5">
                <StageMark stage="done" />
                <div>
                  <p className="font-display text-[1.3rem] font-bold leading-tight text-ivory">
                    GTA V and GTA Online <span className="ml-1 align-middle text-[0.85rem] font-semibold text-gold">{STAGE_LABEL.done}</span>
                  </p>
                  <p className="mt-1 text-[0.95rem] text-ivory-2">Supported today. The log reads on-screen text, plus an AI vision model when this site has one switched on.</p>
                </div>
              </li>
              <li className="flex gap-3.5">
                <StageMark stage="active" />
                <div>
                  <p className="font-display text-[1.3rem] font-bold leading-tight text-ivory">
                    SLOT1’s own GTA model <span className="ml-1 align-middle text-[0.85rem] font-semibold text-gold">{STAGE_LABEL.active}</span>
                  </p>
                  <p className="mt-1 text-[0.95rem] text-ivory-2">Learning from opted-in gameplay. It isn’t used for the log yet.</p>
                </div>
              </li>
              <li className="flex gap-3.5">
                <StageMark stage="next" />
                <div>
                  <p className="leading-tight">
                    <span className="gx-vi text-[1.45rem]">GTA VI</span>{" "}
                    <span className="ml-1 align-middle font-display text-[0.85rem] font-semibold text-gold">{STAGE_LABEL.next}</span>
                  </p>
                  <p className="mt-1.5 text-[0.95rem] text-ivory-2">
                    {stillAhead && "Rockstar Games has scheduled it for 19 November 2026 on PS5 and Xbox Series X|S. "}
                    SLOT1 is getting ready to learn its world as soon as players stream it.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section aria-labelledby="what-you-get" className="mx-auto max-w-[1600px] px-4 pb-20 sm:px-6 lg:px-10">
        <SectionTitle id="what-you-get">What you get</SectionTitle>
        {/* Pause-menu list: the row under the pointer or keyboard focus takes the ivory selection bar. */}
        <ul className="mt-8 grid border-t hairline lg:grid-cols-2 lg:gap-x-10">
          {FEATURES.map((f) => (
            <li key={f.name} className="group relative border-b hairline">
              <div className="flex h-full flex-col gap-2 px-3 py-5 transition-colors group-focus-within:bg-ivory group-hover:bg-ivory sm:flex-row sm:items-baseline sm:gap-6">
                <h3 className="shrink-0 font-display text-[1.55rem] font-bold leading-none group-focus-within:text-graphite group-hover:text-graphite sm:w-[13rem]">
                  <Link href={f.href} className="after:absolute after:inset-0">
                    {f.name}
                  </Link>
                </h3>
                <p className="min-w-0 flex-1 text-[0.95rem] text-ivory-2 group-focus-within:text-graphite group-hover:text-graphite">{f.body}</p>
                <span aria-hidden className="shrink-0 font-display text-[0.95rem] font-semibold text-apricot group-focus-within:text-graphite group-hover:text-graphite">
                  {f.cta}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="proof" className="mx-auto grid max-w-[1600px] gap-10 px-4 pb-20 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-5">
          <SectionTitle id="proof">Proof, not guesses</SectionTitle>
          <p className="mt-5 max-w-[48ch] text-[1.05rem] text-ivory-2">
            Everything SLOT1 tells you points to the exact frames it came from, and says how it knows. When it hasn’t seen something, it says so.
          </p>
        </div>
        <dl className="grid content-start gap-x-10 border-t hairline sm:grid-cols-2 lg:col-span-7">
          {KNOWS.map((k) => (
            <div key={k.cls} className="grid grid-cols-[1.25rem_1fr] items-baseline gap-x-3 border-b hairline py-3 text-sm">
              <EvidenceGlyph cls={k.cls} className="translate-y-[-1px] text-ivory" />
              <div>
                <dt className="font-display text-[1.06rem] font-semibold text-ivory">{EVIDENCE_CLASS_LABEL[k.cls]}</dt>
                <dd className="text-ivory-2">{k.meaning}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="questions" className="mx-auto grid max-w-[1600px] gap-10 px-4 pb-24 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-4">
          <SectionTitle id="questions">Questions</SectionTitle>
          <p className="mt-4 max-w-[36ch] text-sm text-ivory-2">
            Anything else?{" "}
            <Link href="/contact" className="underline hover:text-ivory">
              Contact SLOT1
            </Link>
            .
          </p>
        </div>
        <div className="lg:col-span-8">
          <div className="border-t hairline">
            {FAQ.map((f) => (
              <details key={f.q} className="group border-b hairline">
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-4 hover:text-apricot [&::-webkit-details-marker]:hidden">
                  <h3 className="font-display text-[1.3rem] font-bold leading-tight">{f.q}</h3>
                  <span aria-hidden className="shrink-0 font-display text-[1.6rem] leading-none text-ivory-3 transition-transform duration-150 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="max-w-[70ch] pb-5 text-ivory-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
