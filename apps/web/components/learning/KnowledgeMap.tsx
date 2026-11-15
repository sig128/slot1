import type { LearningResponse } from "@slot1/contracts";

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Everything SLOT1 saw, sorted: every activity of the game under its category, with how often it
 * was seen on public streams, and the places on the map it saw them. Unseen activities stay listed,
 * dimmed, so the gaps are as visible as the progress.
 */
export function KnowledgeMap({ data }: { data: LearningResponse }) {
  const categories: { key: string; label: string; items: LearningResponse["activities"] }[] = [];
  for (const a of data.activities) {
    let c = categories.find((x) => x.key === a.category);
    if (!c) categories.push((c = { key: a.category, label: a.categoryLabel, items: [] }));
    c.items.push(a);
  }
  const seen = data.activities.filter((a) => a.seen > 0).length;

  return (
    <section id="sorted" aria-labelledby="sorted-title" className="la-section">
      <div className="la-section-head">
        <h2 id="sorted-title" className="la-section-title">
          Everything it has seen, sorted
        </h2>
        <p className="la-section-count tnum">
          {n(seen)} of {n(data.activities.length)} activities seen
        </p>
      </div>
      <p className="la-section-lead">
        Every entry of every stream lands in one of these, with where it happened. The list grows with the game, and GTA 6 joins it once it&apos;s out.
      </p>
      <div className="learn-cats mt-8">
        {categories.map((c) => {
          const got = c.items.filter((i) => i.seen > 0).length;
          return (
            <section key={c.key} aria-labelledby={`cat-${c.key}`} className="learn-cat">
              <h3 id={`cat-${c.key}`} className="learn-cat-title">
                <span>{c.label}</span>
                <span className="tnum text-ivory-3">
                  {got}/{c.items.length}
                </span>
              </h3>
              <ul>
                {c.items.map((a) => (
                  <li key={a.key} className={`learn-act ${a.seen > 0 ? "is-seen" : ""}`}>
                    <span>{a.label}</span>
                    <span className="learn-leader" aria-hidden />
                    <span className="tnum">{a.seen > 0 ? n(a.seen) : "not yet"}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

/** The places on the map SLOT1 saw most, across every stream. */
export function PlacesSeen({ data }: { data: LearningResponse }) {
  return (
    <section id="places" aria-labelledby="places-title" className="la-section">
      <div className="la-section-head">
        <h2 id="places-title" className="la-section-title">
          Places on the map
        </h2>
        {data.places.length > 0 && <p className="la-section-count tnum">{n(data.places.length)} places</p>}
      </div>
      {data.places.length ? (
        <ol className="learn-places mt-8">
          {data.places.map((p) => (
            <li key={p.name}>
              <span className="learn-place-name">{p.name}</span>
              <span className="tnum text-ivory-3">
                {n(p.seen)} {p.seen === 1 ? "time" : "times"}, {n(p.streams)} {p.streams === 1 ? "stream" : "streams"}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="la-empty">
          No places yet. They come from the place names GTA shows on screen, signs SLOT1 reads, and what the AI recognizes in the picture.
        </p>
      )}
    </section>
  );
}
