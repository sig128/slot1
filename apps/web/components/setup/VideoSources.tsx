import "./video-sources.css";
import { VIDEO_CHOICES } from "./content";

/** /setup → Video sources: three routes, by what you play on, and what the AI gets to watch on each. */
export function VideoSources() {
  return (
    <>
      <p className="su-intro">The AI can only analyze video that reaches SLOT1 itself. How it gets there depends on what you play on.</p>
      <div className="su-grid su-vchoices">
        {VIDEO_CHOICES.map((c) => (
          <section key={c.id} className="su-panel su-vchoice" aria-labelledby={`video-${c.id}`} data-choice={c.id}>
            <h3 id={`video-${c.id}`} className="su-panel-title flex flex-wrap items-center gap-2">
              {c.title} {c.tag && <span className="su-tag su-signal">{c.tag}</span>}
            </h3>
            {c.lines.map((l) => (
              <p key={l} className="mt-2">
                {l}
              </p>
            ))}
            {c.options && (
              <ul className="su-vopts">
                {c.options.map((o) => (
                  <li key={o.name} className="su-vopt">
                    <p className="su-vopt-head">
                      <b>{o.name}</b> <span className="su-tag su-gold">{o.tag}</span>
                    </p>
                    <p>{o.text}</p>
                  </li>
                ))}
              </ul>
            )}
            {c.limit && <p className="su-vlimit">{c.limit}</p>}
          </section>
        ))}
      </div>
      <p className="su-note">Each source has its own stream key, which you can revoke at any time.</p>
      <p className="su-note">
        No live video at all? Upload recordings as replays, or let SLOT1 analyze your clips. Looped or test recordings sent over the live ingest stay labeled TEST /
        REPLAY.
      </p>
    </>
  );
}
