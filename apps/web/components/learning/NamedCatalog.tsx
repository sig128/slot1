"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { LearningResponse } from "@slot1/contracts";

type Named = LearningResponse["named"][number];

const n = (v: number) => v.toLocaleString("en-US");

/** The filters, in order; each lists the kinds it shows. */
const GROUPS: { key: string; label: string; kinds: Named["kind"][] }[] = [
  { key: "vehicles", label: "Vehicles", kinds: ["vehicle"] },
  { key: "weapons", label: "Weapons and items", kinds: ["weapon", "item"] },
  { key: "people", label: "People", kinds: ["person"] },
  { key: "places", label: "Places", kinds: ["place"] },
  { key: "objectives", label: "Objectives", kinds: ["objective"] },
  { key: "text", label: "Signs and text", kinds: ["text"] },
  { key: "other", label: "Other", kinds: ["other"] },
];

/**
 * Everything SLOT1 named, on every stream: every vehicle, weapon, person, place, objective and sign,
 * counted. There's no fixed list: a new name joins the first time it's seen.
 */
export function NamedCatalog({ data }: { data: LearningResponse }) {
  const [group, setGroup] = useState<string>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const g of GROUPS) c.set(g.key, data.named.filter((x) => g.kinds.includes(x.kind)).length);
    return c;
  }, [data.named]);
  const shown = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    const needle = q.trim().toLowerCase();
    return data.named.filter((x) => (!g || g.kinds.includes(x.kind)) && (!needle || x.label.toLowerCase().includes(needle))).slice(0, 400);
  }, [data.named, group, q]);

  return (
    <section id="named" aria-labelledby="named-title" className="la-section">
      <div className="la-section-head">
        <h2 id="named-title" className="la-section-title">
          Everything it named
        </h2>
        {data.namedTotal > 0 && <p className="la-section-count tnum">{n(data.namedTotal)} names</p>}
      </div>
      <p className="la-section-lead">
        Every vehicle, weapon, person, place, objective and sign SLOT1 named on any stream, counted. There&apos;s no fixed list: a new name joins the
        first time it&apos;s seen.
      </p>
      {data.named.length ? (
        <>
          <div className="la-named-tools">
            <div className="la-chips" role="group" aria-label="Show">
              <button type="button" className="la-chip" aria-pressed={group === "all"} onClick={() => setGroup("all")}>
                All <span className="tnum">{n(data.named.length)}</span>
              </button>
              {GROUPS.filter((g) => (counts.get(g.key) ?? 0) > 0).map((g) => (
                <button key={g.key} type="button" className="la-chip" aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
                  {g.label} <span className="tnum">{n(counts.get(g.key) ?? 0)}</span>
                </button>
              ))}
            </div>
            <label className="la-find">
              <span className="sr-only">Find a name</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a name" autoComplete="off" />
            </label>
          </div>
          {shown.length ? (
            <ul className="la-named">
              {shown.map((x) => (
                <li key={`${x.kind}:${x.label}`}>
                  {x.href ? (
                    <Link href={x.href} className="la-named-row">
                      <span className="la-named-label">{x.label}</span>
                      <span className="tnum text-ivory-3">{n(x.seen)}</span>
                    </Link>
                  ) : (
                    <span className="la-named-row">
                      <span className="la-named-label">{x.label}</span>
                      <span className="tnum text-ivory-3">{n(x.seen)}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="la-empty">Nothing named matches “{q}” yet.</p>
          )}
        </>
      ) : (
        <p className="la-empty">
          Nothing named yet. Names come from what the AI names in the picture and the text SLOT1 reads on screen: car names when someone gets in,
          weapons on the weapon wheel, objectives, signs. It starts with the first stream.
        </p>
      )}
    </section>
  );
}
