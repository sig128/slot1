import type { AdminHealth } from "@slot1/contracts";

/* Number and size formatting for the dashboard ------------------------------------------- */

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
export const compact = (n: number) => (n >= 10_000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n) : nf.format(n));

export function size(n: number | null | undefined): string {
  if (n === null || n === undefined) return "not measured";
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function duration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/* Components ---------------------------------------------------------------------------- */

export function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className="min-w-0 scroll-mt-24 border-t hairline pt-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h2 id={`${id}-h`} className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">
          {title}
        </h2>
        {aside}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/**
 * Stat tile: label, value in plain sans (proportional figures), optional context line. A value
 * that is a status in words ("not tracked yet") is set smaller and quieter than a number.
 */
export function Stat({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  const words = !/\d/.test(value);
  return (
    <div className="min-w-0 border-l hairline pl-4">
      <p className="text-[0.85rem] text-ivory-2">{label}</p>
      <p className={words ? "mt-2 text-[1.15rem] font-medium leading-snug text-ivory-2" : "mt-1 text-[1.9rem] font-semibold leading-tight tracking-[-0.01em] [overflow-wrap:anywhere]"}>{value}</p>
      {note ? <p className="mt-0.5 text-[0.82rem] text-ivory-3">{note}</p> : null}
    </div>
  );
}

const STATUS = {
  ok: { label: "OK", color: "#0ca30c", icon: "M5 12.5l4.2 4.2L19 7" },
  degraded: { label: "Degraded", color: "#fab219", icon: "M12 7v6m0 3.5v.5" },
  down: { label: "Down", color: "#d03b3b", icon: "M7 7l10 10M17 7L7 17" },
  off: { label: "Off", color: "var(--color-ivory-3)", icon: "M7 12h10" },
} as const;

/** Status always comes as icon + word + detail, never color alone. */
export function Health({ name, health }: { name: string; health: AdminHealth }) {
  const s = STATUS[health.status];
  return (
    <div className="flex min-w-0 items-start gap-3">
      <svg viewBox="0 0 24 24" aria-hidden className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke={s.color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={s.icon} />
      </svg>
      <div className="min-w-0">
        <p className="font-display text-[1.05rem] font-semibold tracking-[0.02em]">
          {name} <span className="font-sans text-[0.85rem] font-normal text-ivory-2">{s.label}</span>
        </p>
        <p className="text-[0.85rem] text-ivory-3 [overflow-wrap:anywhere]">{health.detail}</p>
      </div>
    </div>
  );
}

/**
 * Ranked list with a thin bar per row (one hue: the bars compare magnitude, they carry no
 * identity). Values are printed, so nothing depends on reading bar lengths.
 */
export function Ranked({
  title,
  rows,
  keyLabel,
  empty,
  format = (k: string) => k,
}: {
  title: string;
  rows: { key: string; views: number; visitors: number }[];
  keyLabel: string;
  empty: string;
  format?: (key: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <div className="min-w-0">
      <h3 className="font-display text-[1.3rem] font-bold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-[0.9rem] text-ivory-3">{empty}</p>
      ) : (
        <table className="mt-3 w-full table-fixed border-collapse text-[0.9rem]">
          <thead>
            <tr className="text-left text-[0.78rem] text-ivory-3">
              <th scope="col" className="pb-2 font-normal">
                {keyLabel}
              </th>
              <th scope="col" className="w-[5.5rem] pb-2 text-right font-normal">
                Views
              </th>
              <th scope="col" className="w-[5.5rem] pb-2 text-right font-normal">
                Visitors
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t hairline align-top">
                <td className="py-2 pr-3">
                  <span className="block truncate" title={format(r.key)}>
                    {format(r.key)}
                  </span>
                  <span aria-hidden className="mt-1.5 block h-1 rounded-full bg-graphite-600">
                    <span className="block h-1 rounded-full" style={{ width: `${Math.max(2, (r.views / max) * 100)}%`, background: "var(--admin-series-1)" }} />
                  </span>
                </td>
                <td className="tnum py-2 text-right">{num(r.views)}</td>
                <td className="tnum py-2 text-right text-ivory-2">{num(r.visitors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
