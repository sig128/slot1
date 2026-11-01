"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AdminDay } from "@slot1/contracts";
import { dayLabel, num } from "./parts";

/*
 * Visitors and page views per UTC day: two series on one shared count axis (same unit), 2px
 * lines, end dots with a surface ring, a legend plus selective end labels, a crosshair tooltip
 * on hover and keyboard focus, and a table twin. Colors validated with the dataviz validator on
 * the graphite surface (#15151a): #4f8fea / #d9703a pass band, chroma, CVD and contrast.
 */
const SERIES = [
  { key: "visitors" as const, name: "Visitors", color: "var(--admin-series-1)" },
  { key: "views" as const, name: "Page views", color: "var(--admin-series-2)" },
];
const H = 220;
const AXIS = 28;
const M = { top: 14, right: 92, left: 46 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

export function VisitorsChart({ days }: { days: AdminDay[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const id = useId();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width < 520;
  const right = narrow ? 16 : M.right;
  const plotW = Math.max(10, width - M.left - right);
  const max = useMemo(() => niceMax(Math.max(0, ...days.map((d) => d.views))), [days]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const x = (i: number) => M.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => M.top + H - (v / max) * H;
  const pathFor = (k: "visitors" | "views") => days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
  const step = days.length > 10 ? Math.ceil(days.length / (narrow ? 4 : 6)) : 1;
  const last = days[days.length - 1];
  const allZero = days.every((d) => d.views === 0);

  // End labels only when they don't collide; the legend and tooltip carry identity otherwise.
  const endY = last ? { visitors: y(last.visitors), views: y(last.views) } : null;
  const showEndLabels = !narrow && !!endY && Math.abs(endY.visitors - endY.views) >= 16;

  function pick(clientX: number) {
    const el = wrap.current;
    if (!el || days.length === 0) return;
    const r = el.getBoundingClientRect();
    const px = clientX - r.left;
    const i = days.length <= 1 ? 0 : Math.round(((px - M.left) / plotW) * (days.length - 1));
    setActive(Math.max(0, Math.min(days.length - 1, i)));
  }

  function onKey(e: React.KeyboardEvent) {
    if (days.length === 0) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(days.length - 1, (a ?? days.length - 1) + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(days.length - 1);
    else if (e.key === "Escape") setActive(null);
  }

  const a = active !== null ? days[active] : null;
  const total = days.reduce((n, d) => n + d.views, 0);
  const summary = `Visitors and page views per day, ${days.length} days. ${num(total)} page views in total. Use the arrow keys to read each day.`;

  return (
    <div className="admin-viz">
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-[0.85rem] text-ivory-2" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <svg width="18" height="8" aria-hidden>
              <line x1="1" x2="17" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <div
        ref={wrap}
        className="relative mt-3 outline-none focus-visible:outline-2 focus-visible:outline-apricot"
        tabIndex={0}
        role="img"
        aria-label={summary}
        aria-describedby={`${id}-readout`}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((v) => v ?? days.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        {/* Drawn at the measured width (1 unit = 1 px); the viewBox only matters before the first measure. */}
        <svg viewBox={`0 0 ${width} ${M.top + H + AXIS}`} className="block h-auto w-full" aria-hidden>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" />
              <text x={M.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="tnum" fontSize="12" fill="var(--color-ivory-3)">
                {num(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            i % step === 0 || i === days.length - 1 ? (
              <text key={d.day} x={x(i)} y={M.top + H + 19} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize="12" fill="var(--color-ivory-3)">
                {dayLabel(d.day)}
              </text>
            ) : null,
          )}
          {a && <line x1={x(active!)} x2={x(active!)} y1={M.top} y2={M.top + H} stroke="var(--color-line-strong)" strokeWidth="1" />}
          {SERIES.map((s) => (
            <path key={s.key} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {last &&
            SERIES.map((s) => (
              <circle key={s.key} cx={x(days.length - 1)} cy={y(last[s.key])} r="4" fill={s.color} stroke="var(--admin-surface)" strokeWidth="2" />
            ))}
          {a &&
            SERIES.map((s) => <circle key={`a-${s.key}`} cx={x(active!)} cy={y(a[s.key])} r="4.5" fill={s.color} stroke="var(--admin-surface)" strokeWidth="2" />)}
          {showEndLabels &&
            last &&
            SERIES.map((s) => (
              <text key={`l-${s.key}`} x={x(days.length - 1) + 10} y={endY![s.key]} dy="0.32em" fontSize="12" fill="var(--color-ivory-2)">
                <tspan className="tnum" fill="var(--color-ivory)" fontWeight="600">
                  {num(last[s.key])}
                </tspan>{" "}
                {s.name.toLowerCase()}
              </text>
            ))}
          {allZero && (
            <text x={M.left + plotW / 2} y={M.top + H / 2} textAnchor="middle" fontSize="14" fill="var(--color-ivory-3)">
              Nothing counted in this period yet
            </text>
          )}
        </svg>
        {a && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[9.5rem] border hairline bg-graphite-900/95 px-3 py-2 text-[0.85rem] shadow-[0_6px_24px_rgb(0_0_0/0.45)]"
            style={x(active!) > width - 180 ? { right: width - x(active!) + 12 } : { left: x(active!) + 12 }}
          >
            <p className="text-ivory-3">{dayLabel(a.day)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="mt-1 flex items-center gap-2">
                <svg width="12" height="6" aria-hidden>
                  <line x1="1" x2="11" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="tnum font-semibold text-ivory">{num(a[s.key])}</span>
                <span className="text-ivory-2">{s.name.toLowerCase()}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <p id={`${id}-readout`} className="sr-only" aria-live="polite">
        {a ? `${dayLabel(a.day)}: ${num(a.visitors)} visitors, ${num(a.views)} page views` : ""}
      </p>
      <details className="mt-3 text-[0.9rem]">
        <summary className="cursor-pointer text-ivory-2 hover:text-ivory">Show as a table</summary>
        <div className="mt-2 max-h-72 overflow-y-auto">
          <table className="w-full max-w-[28rem] border-collapse">
            <thead>
              <tr className="text-left text-[0.78rem] text-ivory-3">
                <th scope="col" className="pb-1 font-normal">
                  Day (UTC)
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Visitors
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Page views
                </th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-t hairline">
                  <td className="py-1">{dayLabel(d.day)}</td>
                  <td className="tnum py-1 text-right">{num(d.visitors)}</td>
                  <td className="tnum py-1 text-right">{num(d.views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
