import "@/components/setup/setup.css";
import "./clip-guides.css";
import Link from "next/link";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { JsonLd } from "@/components/seo/JsonLd";
import type { ClipGuide, GuidePanel } from "@/lib/clip-guides";
import { breadcrumbList, faqPage, graph, organization, webApplication, webPage, website } from "@/lib/jsonld";
import { legalConfig } from "@/lib/legal";
import { publicOrigin } from "@/lib/origin";
import { twitchSignInHref } from "@/lib/signin-notice";
import { SITE } from "@/lib/site";

function Panels({ items }: { items: GuidePanel[] }) {
  return (
    <div className={items.length === 3 ? "cg-panels cg-three" : "cg-panels"}>
      {items.map((p) => (
        <div key={p.title} className="su-panel cg-panel">
          <h3 className="su-panel-title cg-panel-title">
            {p.title}
            {p.tag && <span className="su-tag su-gold">{p.tag}</span>}
          </h3>
          <p className="cg-panel-body">{p.body}</p>
          {p.link && (
            <Link href={p.link.path} className="cg-panel-link">
              {p.link.label}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A clipping guide (lib/clip-guides.ts) in the same paused-game look as /setup: the city behind a
 * pause menu, the steps as numbered objectives, questions that open in place, and structured data
 * (the page, its breadcrumb and its questions) for search engines.
 */
export async function ClipGuidePage({ guide: g }: { guide: ClipGuide }) {
  const origin = await publicOrigin();
  const structured = graph(
    organization(origin, legalConfig().name),
    website(origin, SITE.description),
    webApplication(origin, SITE.description),
    webPage(origin, { path: g.path, name: g.h1, description: g.description, breadcrumb: true }),
    breadcrumbList(origin, g.path, g.trail),
    faqPage(origin, g.faq, g.path),
  );
  const crumbs = [{ name: "Home", path: "/" }, ...g.trail];

  return (
    <article className="su-page cg" data-guide={g.slug}>
      <header className="su-top">
        <div className="su-art">
          <SkylineArt idPrefix={`cg-${g.slug}`} className="h-full w-full" />
        </div>
        <div className="su-head">
          <div>
            <nav aria-label="Breadcrumb" className="cg-crumbs">
              <ol>
                {crumbs.map((c, i) => (
                  <li key={c.path}>
                    {i === crumbs.length - 1 ? (
                      <span aria-current="page">{c.name}</span>
                    ) : (
                      <Link href={c.path}>{c.name}</Link>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
            <h1 className="su-title cg-title">{g.h1}</h1>
            <p className="su-lede">{g.lede}</p>
          </div>
          <div className="su-head-cta">
            <a href={twitchSignInHref()} className="btn btn-coral">
              Sign in with Twitch
            </a>
            <Link href="/setup" className="btn btn-ghost">
              How SLOT1 works
            </Link>
          </div>
        </div>
      </header>

      <div className="su-body">
        {g.routes && (
          <section id="routes" className="su-section" aria-labelledby="routes-h">
            <h2 id="routes-h" className="su-h2">
              The short answer
            </h2>
            <p className="su-intro">Three ways to get your clips into SLOT1. Pick the one that fits your setup.</p>
            <Panels items={g.routes} />
          </section>
        )}

        {g.sections.map((s) => (
          <section key={s.id} id={s.id} className="su-section" aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`} className="su-h2">
              {s.heading}
            </h2>
            {s.intro && <p className="su-intro cg-intro">{s.intro}</p>}
            {s.steps && (
              <ol className="su-objectives cg-steps">
                {s.steps.map((step) => (
                  <li key={step.title} className="su-objective">
                    <b>{step.title}</b>
                    <span>{step.body}</span>
                  </li>
                ))}
              </ol>
            )}
            {s.panels && <Panels items={s.panels} />}
            {s.note && <p className="su-note">{s.note}</p>}
          </section>
        ))}

        <section id="faq" className="su-section" aria-labelledby="faq-h">
          <h2 id="faq-h" className="su-h2">
            Questions
          </h2>
          <div className="cg-faq">
            {g.faq.map((f) => (
              <details key={f.q} className="cg-q">
                <summary>
                  <h3>{f.q}</h3>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section id="more" className="su-section" aria-labelledby="more-h">
          <h2 id="more-h" className="su-h2">
            More guides
          </h2>
          <ul className="cg-related">
            {g.related.map((r) => (
              <li key={r.path}>
                <Link href={r.path}>
                  <b>{r.label}</b>
                  <span>{r.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <div className="su-end">
          <p className="cg-end-line">Free, no watermark, in your browser.</p>
          <div className="flex flex-wrap gap-2">
            <a href={twitchSignInHref()} className="btn btn-coral">
              Sign in with Twitch
            </a>
            <Link href="/studio" className="btn btn-ghost">
              Open Studio
            </Link>
          </div>
        </div>
      </div>
      <JsonLd data={structured} />
    </article>
  );
}
