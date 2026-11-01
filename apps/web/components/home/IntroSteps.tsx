import { STEPS, type Step } from "@/lib/home-content";

/** Body text with the step's key words in the highlight colour, like a game's objective text. */
function Objective({ step }: { step: Step }) {
  const escaped = step.keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = step.body.split(new RegExp(`(${escaped.join("|")})`));
  return (
    <>
      {parts.map((part, i) =>
        step.keys.includes(part) ? (
          <span key={i} className="gx-key">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Pictograms for the three steps: go live, the AI watching (inside SLOT1's evidence brackets), the clips. */
function StepIcon({ index }: { index: number }) {
  const ink = "#140715";
  return (
    <svg viewBox="0 0 48 48" className="gx-step-icon" aria-hidden>
      {index === 0 && (
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          <rect x="5" y="10" width="30" height="21" rx="3" fill="#2a1233" stroke={ink} strokeWidth="3" />
          <rect x="8" y="13" width="24" height="15" rx="1.5" fill="#ff8547" />
          <path d="M14 36h12M20 31v5" stroke={ink} strokeWidth="3" />
          <circle cx="12.5" cy="17.5" r="2.2" fill="#ff4f87" stroke={ink} strokeWidth="1.4" />
          <path d="M38 13a8 8 0 0 1 0 11M42 9a14 14 0 0 1 0 19" stroke="#ffc94d" strokeWidth="3" />
        </g>
      )}
      {index === 1 && (
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path d="M6 14V7h7M35 7h7v7M42 34v7h-7M13 41H6v-7" stroke="#7fb2ff" strokeWidth="3.2" />
          <path d="M8 24c4-7 10-10.5 16-10.5S36 17 40 24c-4 7-10 10.5-16 10.5S12 31 8 24z" fill="#2a1233" stroke={ink} strokeWidth="3" />
          <circle cx="24" cy="24" r="6.5" fill="#ffc94d" stroke={ink} strokeWidth="2.6" />
          <circle cx="24" cy="24" r="2.4" fill={ink} />
        </g>
      )}
      {index === 2 && (
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          <rect x="5" y="12" width="30" height="26" rx="3" fill="#2a1233" stroke={ink} strokeWidth="3" />
          <path d="M5 18h30" stroke={ink} strokeWidth="2.6" />
          <path d="M10 12l4 6M18 12l4 6M26 12l4 6" stroke={ink} strokeWidth="2.2" />
          <path d="M16 23.5v9l8-4.5z" fill="#ff4f87" stroke={ink} strokeWidth="2.2" />
          <path d="M40 6l1.8 4.2L46 12l-4.2 1.8L40 18l-1.8-4.2L34 12l4.2-1.8z" fill="#ffc94d" stroke={ink} strokeWidth="1.8" />
        </g>
      )}
    </svg>
  );
}

/**
 * "How it works" in three steps, right under the home intro: a mission briefing with a route
 * line between the objectives. The steps are a real sequence, so they are numbered.
 */
export function IntroSteps() {
  return (
    <section aria-labelledby="how-it-works" className="gx-steps">
      <div className="mx-auto max-w-[1600px] px-4 py-14 sm:px-6 lg:px-10 lg:py-16">
        <h2 id="how-it-works" className="poster-title text-[length:var(--text-display-md)] font-black leading-[0.92]">
          How it works
        </h2>
        <ol className="gx-steps-list mt-8">
          {STEPS.map((s, i) => (
            <li key={s.title} className="gx-step">
              <div className="flex items-start justify-between gap-4">
                <span className="gx-step-num" aria-hidden>
                  {i + 1}
                </span>
                <StepIcon index={i} />
              </div>
              <h3 className="mt-4 font-display text-[1.6rem] font-bold leading-[1.02] text-ivory">
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </h3>
              <p className="mt-2 text-[1rem] leading-relaxed text-ivory-2">
                <Objective step={s} />
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
