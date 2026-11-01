"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminMessagesResponse, AdminOverview, AdminUsage } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { MessagesInbox } from "./MessagesInbox";
import { ago, compact, duration, Health, num, Ranked, Section, size, Stat } from "./parts";
import { VisitorsChart } from "./VisitorsChart";

const REFRESH_MS = 10_000;

/** Chart roles (validated on the graphite surface, see VisitorsChart). */
const VIZ_VARS = { "--admin-series-1": "#4f8fea", "--admin-series-2": "#d9703a", "--admin-surface": "#101014" } as React.CSSProperties;

const DEVICE_TEXT: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Computer" };
const BROWSER_TEXT: Record<string, string> = { chrome: "Chrome", safari: "Safari", firefox: "Firefox", edge: "Edge", opera: "Opera", samsung: "Samsung Internet", other: "Other" };
const STATE_TEXT: Record<string, string> = {
  no_source: "No video",
  ready: "Ready",
  analyzing_clip: "Analyzing a clip",
  live_vision: "Watching",
  replay: "Replay",
  delayed: "Delayed",
  stale: "Stale",
  stopped: "Paused",
  error: "Error",
};

const SECTIONS = [
  ["now", "Right now"],
  ["visitors", "Visitors"],
  ["platform", "Platform"],
  ["ai", "AI"],
  ["messages", "Messages"],
  ["system", "System"],
] as const;

function usageLine(rows: AdminUsage[], kind: AdminUsage["kind"]) {
  return rows.find((r) => r.kind === kind) ?? null;
}

function costText(rows: AdminUsage[]): string {
  const priced = rows.filter((r) => r.estimatedCostUsd !== null);
  if (rows.length === 0) return "$0";
  if (priced.length === 0) return "not tracked yet";
  const sum = priced.reduce((n, r) => n + (r.estimatedCostUsd ?? 0), 0);
  return `$${sum.toFixed(sum < 10 ? 2 : 0)}${priced.length < rows.length ? " (part)" : ""}`;
}

export function AdminApp({ initial, initialMessages }: { initial: AdminOverview; initialMessages: AdminMessagesResponse | null }) {
  const [data, setData] = useState<AdminOverview>(initial);
  const [range, setRange] = useState<7 | 30>(initial.visitors.range.days);
  const [stale, setStale] = useState<string | null>(null);
  const [ranging, setRanging] = useState(false);
  const [now, setNow] = useState(() => new Date(initial.generatedAt).getTime());
  const [signingOut, setSigningOut] = useState(false);
  const rangeRef = useRef(range);
  const router = useRouter();

  const refresh = useCallback(async (r: 7 | 30) => {
    try {
      const next = await api<AdminOverview>(`/api/admin/overview?range=${r}`);
      if (r !== rangeRef.current) return;
      setData(next);
      setStale(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        window.location.reload();
        return;
      }
      setStale("Couldn't refresh. Showing the last update.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (document.visibilityState !== "hidden") await refresh(rangeRef.current);
      if (alive) t = setTimeout(() => void loop(), REFRESH_MS);
    };
    t = setTimeout(() => void loop(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(rangeRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      if (t) clearTimeout(t);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  async function chooseRange(r: 7 | 30) {
    if (r === range) return;
    rangeRef.current = r;
    setRange(r);
    setRanging(true);
    await refresh(r);
    setRanging(false);
  }

  async function signOut() {
    setSigningOut(true);
    await api("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/");
  }

  const v = data.visitors;
  const p = data.platform;
  const s = data.system;
  const days = v.days.slice(-range);
  const updated = Math.max(0, Math.round((now - new Date(data.generatedAt).getTime()) / 1000));

  return (
    <div style={VIZ_VARS} className="mx-auto max-w-[1600px] px-4 pb-24 pt-10 sm:px-6 lg:px-10">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <h1 className="poster-title text-[length:var(--text-display-lg)] leading-[0.9]">Control room</h1>
          <p className="mt-3 text-[0.95rem] text-ivory-2">
            Everything on this page is counted, not estimated.{" "}
            {data.access === "admin_link" ? "Signed in with a one-time admin link." : "Signed in as an operator."}
          </p>
        </div>
        <div className="flex items-center gap-4 text-[0.85rem] text-ivory-3">
          <p aria-live="polite">{stale ?? (updated < 3 ? "Updated just now" : `Updated ${updated} s ago`)}</p>
          {data.access === "admin_link" && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={signingOut} onClick={() => void signOut()}>
              Sign out
            </button>
          )}
        </div>
      </header>

      <nav aria-label="Dashboard sections" className="mt-8 flex flex-wrap gap-1 border-y hairline py-2">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="btn btn-quiet btn-sm">
            {label}
            {id === "messages" && data.messages.open > 0 ? <span className="tnum ml-1 rounded-sm bg-coral px-1.5 text-graphite">{data.messages.open}</span> : null}
          </a>
        ))}
      </nav>

      {!data.analyticsEnabled && (
        <p className="mt-6 border-l-2 border-apricot pl-3 text-[0.95rem]">Visitor counting is off on this server (SLOT1_ANALYTICS=false). Visitor numbers stay at what was counted before.</p>
      )}

      <div className="mt-10 grid gap-14">
        {/* RIGHT NOW --------------------------------------------------------------------- */}
        <Section id="now" title="Right now">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <div className="flex items-center gap-3 text-coral">
                <span className={`live-dot ${data.now.online > 0 ? "live-dot-pulse" : ""}`} aria-hidden />
                <span className="font-display text-[0.95rem] font-semibold tracking-[0.06em]">ON THE SITE</span>
              </div>
              <p className="mt-2 text-[clamp(3.5rem,8vw,5.5rem)] font-semibold leading-none tracking-[-0.02em]">{num(data.now.online)}</p>
              <p className="mt-2 text-[0.9rem] text-ivory-2">
                {data.now.online === 1 ? "person" : "people"} with a page open in the last {data.now.windowSec} s
              </p>
              {data.now.byPath.length > 0 ? (
                <ul className="mt-6 grid gap-2 text-[0.9rem]" aria-label="Pages open now">
                  {data.now.byPath.slice(0, 8).map((r) => (
                    <li key={r.path} className="flex items-baseline justify-between gap-4 border-t hairline pt-2">
                      <span className="truncate">{r.path}</span>
                      <span className="tnum shrink-0 text-ivory-2">{num(r.visitors)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-6 text-[0.9rem] text-ivory-3">Nobody has a page open right now. Visitors with Do Not Track or Global Privacy Control turned on are never counted.</p>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-[1.3rem] font-bold">
                Live now <span className="tnum text-ivory-2">{data.now.live.length}</span>
              </h3>
              {data.now.live.length === 0 ? (
                <p className="mt-3 text-[0.9rem] text-ivory-3">No stream is live on SLOT1 right now.</p>
              ) : (
                <ul className="mt-3 grid gap-0">
                  {data.now.live.map((l) => (
                    <li key={l.sessionId} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 border-t hairline py-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <Link href={`/watch/${l.login}`} className="truncate font-semibold hover:underline">
                            {l.displayName}
                          </Link>
                          {l.label === "test" ? <span className="chip chip-replay">TEST</span> : <span className="chip chip-live">LIVE</span>}
                          {l.visibility === "private" ? <span className="chip chip-muted">PRIVATE</span> : null}
                        </p>
                        <p className="mt-1 truncate text-[0.85rem] text-ivory-3">
                          {l.source === "ingest" ? "Video reaches SLOT1" : "Twitch only"}, {STATE_TEXT[l.analysisState] ?? l.analysisState}, live for {duration(Math.round((now - new Date(l.startedAt).getTime()) / 1000))}
                          {l.title ? `, “${l.title}”` : ""}
                        </p>
                      </div>
                      <p className="text-right">
                        <span className="tnum block text-[1.4rem] font-semibold leading-none">{num(l.viewers)}</span>
                        <span className="text-[0.78rem] text-ivory-3">{l.viewers === 1 ? "viewer" : "viewers"}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-8 grid gap-5 sm:grid-cols-2">
                <Health name="Worker" health={s.worker} />
                <Health name="Ingest gateway" health={s.gateway} />
                <Health name="GTA model service" health={s.inference} />
                <Health
                  name="Job queues"
                  health={{
                    status: s.queues.some((q) => q.failed > 0) ? "degraded" : s.queues.length ? "ok" : "down",
                    detail: s.queues.length
                      ? `${num(s.queues.reduce((n, q) => n + q.waiting + q.delayed, 0))} waiting, ${num(s.queues.reduce((n, q) => n + q.active, 0))} running, ${num(s.queues.reduce((n, q) => n + q.failed, 0))} failed (kept 7 days)`
                      : "Couldn't read the queues",
                  }}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* VISITORS ---------------------------------------------------------------------- */}
        <Section id="visitors" title="Visitors">
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
            <Stat label="Visitors today" value={compact(v.today.visitors)} note={`${num(v.today.views)} page views`} />
            <Stat label="Last 7 days" value={compact(v.last7.visitors)} note={`visitors, ${num(v.last7.views)} page views`} />
            <Stat label="Last 30 days" value={compact(v.last30.visitors)} note={`visitors, ${num(v.last30.views)} page views`} />
            <Stat label="Page views, all time" value={compact(v.allTimeViews)} note={v.since ? `since ${new Date(`${v.since}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : "nothing counted yet"} />
          </div>
          <p className="mt-4 max-w-[80ch] text-[0.82rem] text-ivory-3">
            Visitors are counted per day without cookies: someone who comes back on three days counts three times in the 7- and 30-day totals. Days are UTC.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3" role="group" aria-label="Period for the chart and the lists below">
            {([7, 30] as const).map((r) => (
              <button key={r} type="button" aria-pressed={range === r} className={`btn btn-sm ${range === r ? "select-bar" : "btn-ghost"}`} onClick={() => void chooseRange(r)}>
                Last {r} days
              </button>
            ))}
          </div>
          <div className={`mt-6 grid gap-12 transition-opacity ${ranging ? "opacity-60" : ""}`}>
            <VisitorsChart days={days} />
            <div className="grid gap-x-12 gap-y-10 lg:grid-cols-2">
              <Ranked title="Top pages" keyLabel="Page" rows={v.range.pages} empty="No page views in this period." />
              <Ranked title="Where visitors came from" keyLabel="Website" rows={v.range.referrers} empty="No visits from other websites in this period. Direct visits and visits from apps don't send one." />
              <Ranked title="Devices" keyLabel="Device" rows={v.range.devices} empty="No page views in this period." format={(k) => DEVICE_TEXT[k] ?? k} />
              <Ranked title="Browsers" keyLabel="Browser" rows={v.range.browsers} empty="No page views in this period." format={(k) => BROWSER_TEXT[k] ?? k} />
            </div>
          </div>
        </Section>

        {/* PLATFORM ---------------------------------------------------------------------- */}
        <Section id="platform" title="Platform">
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-3 xl:grid-cols-4">
            <Stat label="Accounts" value={compact(p.users.total)} note={`${num(p.users.new7)} new this week, ${num(p.users.operators)} operator${p.users.operators === 1 ? "" : "s"}`} />
            <Stat label="Creators" value={compact(p.creators.total)} note={`${num(p.creators.connected)} with Twitch connected`} />
            <Stat label="Chat bot" value={`${num(p.botChannels)} channel${p.botChannels === 1 ? "" : "s"}`} note={p.botLinked ? "Bot account linked" : "Bot account not linked yet"} />
            <Stat label="Video sources" value={compact(p.liveSources.total)} note={`${num(p.liveSources.publishing)} sending video now`} />
            <Stat label="Sessions" value={compact(p.sessions.total)} note={`${num(p.sessions.today)} started today, ${num(p.sessions.liveNow)} live`} />
            <Stat label="Observations, 24 h" value={compact(p.observations24h)} note="Things SLOT1 saw or read" />
            <Stat label="Library" value={compact(p.library.total)} note={`${num(p.library.recordings)} recordings, ${num(p.library.renders)} edits, ${num(p.library.screenshots)} screenshots, ${num(p.clips)} Twitch clips`} />
            <Stat label="Stored files" value={size(p.storage.trackedBytes)} note={`${num(p.storage.files)} files tracked`} />
            <Stat label="Forwarding" value={`${num(p.relay.live)} live`} note={`${num(p.relay.enabled)} of ${num(p.relay.total)} destinations switched on`} />
          </div>
        </Section>

        {/* AI ----------------------------------------------------------------------------- */}
        <Section id="ai" title="AI">
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Health
              name="Vision model"
              health={data.ai.vision.available ? { status: "ok", detail: `${data.ai.vision.provider ?? "provider"}, ${data.ai.vision.model ?? "model"}` } : { status: "off", detail: data.ai.vision.reason ?? "Not configured" }}
            />
            <Health name="Screen text (OCR)" health={data.ai.ocr.available ? { status: "ok", detail: "Local tesseract" } : { status: "off", detail: data.ai.ocr.reason ?? "Not available" }} />
            <Health name="Speech to text" health={data.ai.transcription.available ? { status: "ok", detail: "Configured" } : { status: "off", detail: data.ai.transcription.reason ?? "Not configured" }} />
            <Health
              name="GTA model"
              health={
                data.ai.models.length
                  ? { status: "ok", detail: data.ai.models.map((m) => `${m.task}: ${m.name} ${m.version}`).join("; ") }
                  : { status: "off", detail: `No trained model active yet${data.ai.candidateModels ? `, ${data.ai.candidateModels} candidate${data.ai.candidateModels === 1 ? "" : "s"} uploaded` : ""}` }
              }
            />
          </div>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full border-collapse text-[0.9rem]">
              <caption className="pb-3 text-left font-display text-[1.3rem] font-bold">Provider calls</caption>
              <thead>
                <tr className="text-left text-[0.78rem] text-ivory-3">
                  <th scope="col" className="pb-2 font-normal">
                    Kind
                  </th>
                  <th scope="col" className="pb-2 text-right font-normal">
                    Calls, 24 h
                  </th>
                  <th scope="col" className="pb-2 text-right font-normal">
                    Calls, 30 days
                  </th>
                  <th scope="col" className="hidden pb-2 text-right font-normal sm:table-cell">
                    Frames, 30 days
                  </th>
                  <th scope="col" className="hidden pb-2 text-right font-normal sm:table-cell">
                    Tokens in / out, 30 days
                  </th>
                </tr>
              </thead>
              <tbody>
                {(["vision", "qa", "transcription", "clip_ai"] as const).map((k) => {
                  const d = usageLine(data.ai.usage24h, k);
                  const m = usageLine(data.ai.usage30d, k);
                  return (
                    <tr key={k} className="border-t hairline">
                      <th scope="row" className="py-2 text-left font-normal">
                        {k === "vision" ? "Vision (frames)" : k === "qa" ? "Answers (Ask SLOT1)" : k === "clip_ai" ? "AI clip tools" : "Speech to text"}
                      </th>
                      <td className="tnum py-2 text-right">{num(d?.calls ?? 0)}</td>
                      <td className="tnum py-2 text-right">{num(m?.calls ?? 0)}</td>
                      <td className="tnum hidden py-2 text-right sm:table-cell">{num(m?.frames ?? 0)}</td>
                      <td className="tnum hidden py-2 text-right text-ivory-2 sm:table-cell">
                        {compact(m?.inputTokens ?? 0)} / {compact(m?.outputTokens ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-[0.85rem] text-ivory-2">
              Estimated cost, 30 days: <span className="text-ivory">{costText(data.ai.usage30d)}</span>
              <span className="text-ivory-3"> (from the prices set in VISION_PRICE_INPUT_PER_MTOK and VISION_PRICE_OUTPUT_PER_MTOK)</span>
            </p>
          </div>
        </Section>

        {/* MESSAGES ---------------------------------------------------------------------- */}
        <Section id="messages" title="Messages" aside={<Link href="/contact" className="text-[0.9rem] text-ivory-2 underline hover:text-ivory">Open the contact page</Link>}>
          <MessagesInbox initial={initialMessages} openCount={data.messages.open} now={now} />
        </Section>

        {/* SYSTEM ------------------------------------------------------------------------ */}
        <Section id="system" title="System">
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Version" value={s.version ?? "not tracked yet"} note={`Node ${s.node.replace(/^v/, "")}`} />
            <Stat label="API up for" value={duration(s.apiUptimeSec)} />
            <Stat label="Database" value={s.database.ok ? size(s.database.sizeBytes) : "unavailable"} note={s.database.version ? `Postgres ${s.database.version}` : undefined} />
            <Stat label="Redis memory" value={s.redis.ok ? size(s.redis.usedMemoryBytes) : "unavailable"} />
            <Stat
              label="Free disk"
              value={s.disk.freeBytes === null ? "not measured" : size(s.disk.freeBytes)}
              note={s.disk.totalBytes ? `of ${size(s.disk.totalBytes)} where media is stored` : s.disk.driver === "s3" ? "Media is in object storage" : undefined}
            />
            <Stat label="Failures, 24 h" value={num(s.failedJobs24h)} note="Failed jobs and reported errors" />
          </div>
          {s.disk.freeBytes !== null && s.disk.totalBytes ? (
            <div className="mt-6 max-w-[34rem]">
              <p className="text-[0.85rem] text-ivory-2">Disk used where media is stored</p>
              <div
                className="mt-2 h-2 rounded-full bg-[#1d3557]"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(100 - (s.disk.freeBytes / s.disk.totalBytes) * 100)}
                aria-label="Disk used"
              >
                <div
                  className="h-2 rounded-full"
                  style={{
                    width: `${Math.max(1, 100 - (s.disk.freeBytes / s.disk.totalBytes) * 100)}%`,
                    background: s.disk.freeBytes / s.disk.totalBytes < 0.1 ? "#d03b3b" : s.disk.freeBytes / s.disk.totalBytes < 0.2 ? "#fab219" : "var(--admin-series-1)",
                  }}
                />
              </div>
              <p className="tnum mt-1 text-[0.82rem] text-ivory-3">{Math.round(100 - (s.disk.freeBytes / s.disk.totalBytes) * 100)}% used</p>
            </div>
          ) : null}
          <div className="mt-10 grid gap-12 lg:grid-cols-2">
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full min-w-[19rem] border-collapse text-[0.9rem]">
                <caption className="pb-3 text-left font-display text-[1.3rem] font-bold">Job queues</caption>
                <thead>
                  <tr className="text-left text-[0.78rem] text-ivory-3">
                    <th scope="col" className="pb-2 font-normal">
                      Queue
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Waiting
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Running
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Failed
                    </th>
                    <th scope="col" className="pb-2 text-right font-normal">
                      Workers
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.queues.map((q) => (
                    <tr key={q.name} className="border-t hairline">
                      <th scope="row" className="py-2 text-left font-normal">
                        {q.name}
                      </th>
                      <td className="tnum py-2 text-right">{num(q.waiting + q.delayed)}</td>
                      <td className="tnum py-2 text-right">{num(q.active)}</td>
                      <td className={`tnum py-2 text-right ${q.failed ? "text-coral" : ""}`}>{num(q.failed)}</td>
                      <td className="tnum py-2 text-right text-ivory-2">{num(q.workers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-[1.3rem] font-bold">Recent failures</h3>
              {s.recentFailures.length === 0 ? (
                <p className="mt-3 text-[0.9rem] text-ivory-3">Nothing failed in the last 24 hours.</p>
              ) : (
                <ul className="mt-3 grid gap-0 text-[0.9rem]">
                  {s.recentFailures.map((f, i) => (
                    <li key={`${f.at}-${i}`} className="border-t hairline py-2">
                      <p className="flex flex-wrap justify-between gap-x-4">
                        <span className="text-ivory">{f.where}</span>
                        <time dateTime={f.at} className="text-ivory-3">
                          {ago(f.at, now)}
                        </time>
                      </p>
                      <p className="mt-0.5 text-ivory-2 [overflow-wrap:anywhere]">{f.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
