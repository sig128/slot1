import "./legal.css";
import { PrintButton } from "./PrintButton";

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

/**
 * Long-form legal page in the SLOT1 system: one column of readable prose, a contents list that
 * stays in view on wide screens, numbered sections (legal documents are cited by number), and a
 * plain black-on-white print layout.
 */
export function LegalDocument({ title, updated, updatedIso, intro, sections }: { title: string; updated: string; updatedIso: string; intro: React.ReactNode; sections: LegalSection[] }) {
  return (
    <article className="legal mx-auto max-w-[1600px] px-4 pb-24 pt-12 sm:px-6 lg:px-10">
      <header className="max-w-[72ch]">
        <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">{title}</h1>
        <p className="mt-4 text-sm text-ivory-3">
          Last updated: <time dateTime={updatedIso}>{updated}</time>
        </p>
        <div className="legal-prose mt-6 text-[1.05rem]">{intro}</div>
      </header>

      <div className="mt-12 grid gap-12 lg:grid-cols-12">
        <nav aria-labelledby="legal-contents" className="legal-toc self-start lg:sticky lg:top-24 lg:col-span-3">
          <h2 id="legal-contents" className="font-display text-lg font-bold">
            Contents
          </h2>
          <ol className="mt-3 space-y-1.5 border-l hairline pl-4 text-sm text-ivory-2">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="hover:text-ivory">
                  <span className="tnum text-ivory-3">{i + 1}.</span> {s.title}
                </a>
              </li>
            ))}
          </ol>
          <PrintButton />
        </nav>

        <div className="min-w-0 space-y-14 lg:col-span-8 lg:col-start-5">
          {sections.map((s, i) => (
            <section key={s.id} aria-labelledby={s.id} className="legal-section">
              <h2 id={s.id} className="scroll-mt-24 font-display text-[clamp(1.6rem,2.4vw,2.1rem)] font-black leading-[1.02]">
                <span className="tnum text-apricot">{i + 1}.</span> {s.title}
              </h2>
              <div className="legal-prose mt-4">{s.body}</div>
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}

/** One kind of information: what it is, why, and how long it's kept (or another closing note). */
export function DataItem({ title, what, why, kept, keptLabel = "Kept" }: { title: string; what: React.ReactNode; why: React.ReactNode; kept: React.ReactNode; keptLabel?: string }) {
  return (
    <div className="legal-item">
      <h4>{title}</h4>
      <dl>
        <div>
          <dt>What</dt>
          <dd>{what}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{why}</dd>
        </div>
        <div>
          <dt>{keptLabel}</dt>
          <dd>{kept}</dd>
        </div>
      </dl>
    </div>
  );
}
