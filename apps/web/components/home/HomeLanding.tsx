import Link from "next/link";
import type { EvidenceClass } from "@slot1/contracts";
import { EVIDENCE_CLASS_LABEL } from "@slot1/contracts";
import { EvidenceGlyph } from "@/components/watch/EvidenceGlyph";
import { FAQ, FEATURES, STEPS } from "@/lib/home-content";

const KNOWS: { cls: EvidenceClass; meaning: string }[] = [
  { cls: "visible_text", meaning: "Read from text on screen, like a mission title." },
  { cls: "visible", meaning: "Seen in the frames themselves." },
  { cls: "inferred", meaning: "Concluded from several frames, and labeled as a conclusion." },
  { cls: "heard", meaning: "From the stream’s audio, when transcription is on." },
  { cls: "measured", meaning: "Measured from the video: cuts, black screens, coverage." },
  { cls: "platform", meaning: "Reported by Twitch, like the title or category." },
];

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="poster-title scroll-mt-24 text-[length:var(--text-display-md)] font-black leading-[0.92]">
      {children}
    </h2>
  );
}

/**
 * What SLOT1 is, for anyone arriving from a search or a shared link. Server-rendered so search
 * engines read it; the On Air section above stays the page's main job.
 */
export function HomeLanding() {
  return (
    <div className="border-t hairline">
      <section aria-labelledby="what-is-slot1" className="mx-auto grid max-w-[1600px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-7">
          <h2 id="what-is-slot1" className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">
            A broadcast companion that shows its evidence.
          </h2>
          <p className="mt-6 max-w-[60ch] text-[1.08rem] text-ivory-2">
            SLOT1 sits beside a GTA stream. It samples the gameplay a creator sends it, reads what’s on screen and keeps a running log of what happened.
            Every line links to the frames it came from. When SLOT1 hasn’t seen something, it says “I haven’t observed that” instead of guessing.
          </p>
          <p className="mt-4 max-w-[60ch] text-ivory-2">
            Viewers get the stream with the log beside it, instant replays and the big moments. Creators get one place to stream from, a clipper, and a
            chat bot that knows what just happened.
          </p>
        </div>
        <aside aria-labelledby="how-it-knows" className="lg:col-span-4 lg:col-start-9">
          <h3 id="how-it-knows" className="font-display text-[1.45rem] font-bold leading-tight">
            Every line says how SLOT1 knows
          </h3>
          <dl className="mt-4 divide-y divide-line border-y hairline">
            {KNOWS.map((k) => (
              <div key={k.cls} className="grid grid-cols-[1.25rem_7.5rem_1fr] items-baseline gap-x-3 py-2.5 text-sm">
                <EvidenceGlyph cls={k.cls} className="translate-y-[-1px] text-ivory" />
                <dt className="font-display text-[1.02rem] font-semibold text-ivory">{EVIDENCE_CLASS_LABEL[k.cls]}</dt>
                <dd className="text-ivory-2">{k.meaning}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </section>

      <section aria-labelledby="whats-in-slot1" className="mx-auto max-w-[1600px] px-4 pb-20 sm:px-6 lg:px-10">
        <SectionTitle id="whats-in-slot1">What’s in SLOT1</SectionTitle>
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

      <section aria-labelledby="how-it-works" className="mx-auto max-w-[1600px] px-4 pb-20 sm:px-6 lg:px-10">
        <SectionTitle id="how-it-works">How it works</SectionTitle>
        <ol className="mt-8 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="border-t border-line-strong pt-4">
              <span className="poster-title tnum block text-[3.2rem] leading-none text-apricot" aria-hidden>
                {i + 1}
              </span>
              <h3 className="mt-3 font-display text-[1.45rem] font-bold leading-tight">
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </h3>
              <p className="mt-2 max-w-[38ch] text-[0.95rem] text-ivory-2">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12 grid gap-6 border-y hairline py-8 sm:grid-cols-2">
          <div>
            <p className="font-display text-[1.45rem] font-bold leading-tight">Watching?</p>
            <p className="mt-1 max-w-[46ch] text-sm text-ivory-2">No account needed. Open a public stream and the log runs beside it.</p>
            <Link href="/los-santos" className="btn btn-primary mt-4">
              See who’s live
            </Link>
          </div>
          <div>
            <p className="font-display text-[1.45rem] font-bold leading-tight">Streaming?</p>
            <p className="mt-1 max-w-[46ch] text-sm text-ivory-2">Connect Twitch, send your stream once, and decide what’s public.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/studio" className="btn btn-coral">
                Connect my Twitch
              </Link>
              <Link href="/setup" className="btn btn-ghost">
                How SLOT1 works
              </Link>
            </div>
          </div>
        </div>
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
