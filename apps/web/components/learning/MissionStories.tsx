import Link from "next/link";
import type { LearningResponse } from "@slot1/contracts";

const n = (v: number) => v.toLocaleString("en-US");
const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * Missions as stories: every mission seen on public streams, from its first objective to MISSION
 * PASSED or MISSION FAILED, with where it fails and why. Then what SLOT1 saw in the minute before
 * every WASTED, BUSTED, MISSION FAILED and MISSION PASSED.
 */
export function MissionStories({ data }: { data: LearningResponse }) {
  const attempts = data.missions.reduce((a, m) => a + m.attempts, 0);
  return (
    <>
      <section id="missions" aria-labelledby="missions-title" className="la-section">
        <div className="la-section-head">
          <h2 id="missions-title" className="la-section-title">
            Missions, start to result
          </h2>
          {data.missions.length > 0 && (
            <p className="la-section-count tnum">
              {n(data.missions.length)} {data.missions.length === 1 ? "mission" : "missions"}, {n(attempts)} {attempts === 1 ? "attempt" : "attempts"}
            </p>
          )}
        </div>
        <p className="la-section-lead">
          Every attempt from its first objective to MISSION PASSED or MISSION FAILED, on every stream: how long passing takes, where people fail, and what the
          result screen said.
        </p>
        {data.missions.length ? (
          <ol className="learn-missions mt-8">
            {data.missions.map((m) => {
              const unknown = m.attempts - m.passed - m.failed;
              return (
                <li key={m.key} className="learn-mission">
                  <div className="learn-mission-head">
                    <h3 className={`learn-mission-name ${m.named ? "" : "is-unnamed"}`}>{m.label}</h3>
                    <p className="tnum text-ivory-2">
                      {n(m.passed)} of {n(m.attempts)} passed
                      {m.streams > 1 ? `, ${n(m.streams)} streams` : ""}
                    </p>
                  </div>
                  <div
                    className="learn-mission-bar"
                    role="img"
                    aria-label={`${m.passed} passed, ${m.failed} failed${unknown ? `, ${unknown} with no result seen` : ""}`}
                  >
                    <span className="is-passed" style={{ flexGrow: m.passed }} />
                    <span className="is-failed" style={{ flexGrow: m.failed }} />
                    <span className="is-unknown" style={{ flexGrow: unknown }} />
                  </div>
                  <dl className="learn-mission-facts">
                    {m.medianPassMs !== null && (
                      <div>
                        <dt>Passing takes</dt>
                        <dd className="tnum">
                          about {minutes(m.medianPassMs)}
                          {m.fastestPassMs !== null && m.fastestPassMs < m.medianPassMs ? `, fastest ${minutes(m.fastestPassMs)}` : ""}
                        </dd>
                      </div>
                    )}
                    {m.failsAt[0] && (
                      <div>
                        <dt>Fails most at</dt>
                        <dd>
                          “{m.failsAt[0].objective}” <span className="tnum text-ivory-3">({m.failsAt[0].count})</span>
                        </dd>
                      </div>
                    )}
                    {m.failReasons[0] && (
                      <div>
                        <dt>Result screen said</dt>
                        <dd>
                          “{m.failReasons[0].reason}” <span className="tnum text-ivory-3">({m.failReasons[0].count})</span>
                        </dd>
                      </div>
                    )}
                    {m.deaths > 0 && (
                      <div>
                        <dt>Deaths during it</dt>
                        <dd className="tnum">{n(m.deaths)}</dd>
                      </div>
                    )}
                  </dl>
                  {m.href && (
                    <Link href={m.href} className="learn-mission-link">
                      Watch the latest result
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="la-empty">
            No missions yet. They come from the objectives at the bottom of the screen and the MISSION PASSED and MISSION FAILED screens SLOT1 reads, so
            they start with the first stream where someone plays a mission.
          </p>
        )}
      </section>

      <section id="causes" aria-labelledby="causes-title" className="la-section">
        <div className="la-section-head">
          <h2 id="causes-title" className="la-section-title">
            What leads to it
          </h2>
        </div>
        <p className="la-section-lead">What SLOT1 saw in the minute before each result, counted across every stream.</p>
        <div className="learn-causes mt-8">
          {data.outcomes.map((o) => (
            <section key={o.kind} aria-labelledby={`cause-${o.kind}`} className="learn-cause">
              <h3 id={`cause-${o.kind}`} className="learn-cause-title">
                <span>{o.label}</span>
                <span className="tnum">{n(o.total)}</span>
              </h3>
              {o.before.length ? (
                <ul className="mt-3 grid gap-2">
                  {o.before.map((b) => (
                    <li key={b.key} className="learn-cause-row">
                      <span className="flex justify-between gap-3">
                        <span>{b.label}</span>
                        <span className="tnum text-ivory-2">{pct(b.count, o.total)}%</span>
                      </span>
                      <span className="learn-cause-bar" aria-hidden>
                        <span style={{ width: `${pct(b.count, o.total)}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-ivory-3">{o.total ? "Nothing named in the minute before yet." : "Not seen yet."}</p>
              )}
              {o.places.length > 0 && <p className="mt-3 text-[0.9rem] text-ivory-3">Where: {o.places.map((p) => p.name).join(", ")}</p>}
              {o.href && (
                <Link href={o.href} className="learn-mission-link mt-3">
                  Watch the latest
                </Link>
              )}
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
