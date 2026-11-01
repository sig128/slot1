"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatMediaTime, OBSERVATION_TYPE_LABEL, SOURCE_LABEL_TEXT, type MomentView } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { relativeAge } from "@/lib/format";
import { momentHref } from "@/lib/moments";

const STATE_TEXT: Record<MomentView["processingState"], string> = {
  queued: "Clip queued",
  processing: "Clip processing",
  ready: "Clip ready",
  failed: "Clip failed",
  expired: "Clip expired",
  evidence_only: "Evidence only",
};

export function MomentsApp() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState("");
  const [moments, setMoments] = useState<MomentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (type) p.set("type", type);
    if (from) p.set("from", new Date(from).toISOString());
    if (to) p.set("to", new Date(`${to}T23:59:59`).toISOString());
    try {
      const r = await api<{ moments: MomentView[] }>(`/api/moments?${p.toString()}`);
      setMoments(r.moments);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load moments");
    }
  }, [q, type, from, to]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const channels = [...new Map((moments ?? []).map((m) => [m.broadcasterId, m.channelDisplayName])).entries()];
  const shown = (moments ?? []).filter((m) => !channel || m.broadcasterId === channel);

  return (
    <section className="mx-auto max-w-[1600px] px-4 pb-20 pt-10 sm:px-6 lg:px-10">
      <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">Moments</h1>
      <p className="mt-3 max-w-[64ch] text-ivory-2">Saved moments and clips with the evidence behind them. Search covers descriptions, on-screen text and transcripts you’re allowed to see.</p>

      <form className="mt-8 grid gap-3 border-y hairline py-4 md:grid-cols-[2fr_1fr_1fr_1fr_1fr]" onSubmit={(e) => (e.preventDefault(), void load())} role="search">
        <div>
          <label className="label" htmlFor="m-q">
            Search
          </label>
          <input id="m-q" className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="docks, mission passed, police" />
        </div>
        <div>
          <label className="label" htmlFor="m-ch">
            Channel
          </label>
          <select id="m-ch" className="field" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All</option>
            {channels.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="m-type">
            Observation type
          </label>
          <select id="m-type" className="field" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any</option>
            {Object.entries(OBSERVATION_TYPE_LABEL)
              .filter(([k]) => !["media_facts", "session_coverage"].includes(k))
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="m-from">
            From
          </label>
          <input id="m-from" className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="m-to">
            To
          </label>
          <input id="m-to" className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </form>

      {error && <p className="mt-8 text-coral">{error}</p>}
      {moments === null && !error && <p className="mt-8 text-ivory-3">Loading</p>}
      {moments && shown.length === 0 && (
        <div className="mt-16 max-w-[60ch]">
          <p className="font-display text-3xl font-bold">{q || type || from || to ? "Nothing matches those filters." : "No saved moments yet."}</p>
          <p className="mt-2 text-ivory-2">
            {q || type || from || to
              ? "Try fewer words or a wider date range."
              : "Open a replay or your watch page, select an observation in the log and choose Save moment."}
          </p>
          {!(q || type || from || to) && (
            <Link href="/studio#sources" className="btn btn-ghost mt-5">
              Upload a replay
            </Link>
          )}
        </div>
      )}
      <ul className="mt-6 divide-y divide-line">
        {shown.map((m) => (
          <li key={m.id} className="grid gap-4 py-5 sm:grid-cols-[14rem_1fr_auto]">
            <Link
              href={momentHref(m)}
              className="relative block aspect-video overflow-hidden bg-graphite-800"
              aria-label={`Open ${m.title}${m.mediaStartMs !== null ? ` at ${formatMediaTime(m.mediaStartMs)}` : ""}`}
            >
              {m.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full place-items-center text-[0.8rem] text-ivory-3">No frame stored</span>
              )}
              {m.mediaStartMs !== null && (
                <span className="tnum absolute bottom-1.5 right-1.5 bg-graphite/85 px-1.5 text-[0.75rem]">{formatMediaTime(m.mediaStartMs)}</span>
              )}
            </Link>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-display text-[1.6rem] font-bold leading-tight">{m.title}</h2>
                {m.sessionLabel && <span className="font-display text-[0.8rem] font-semibold tracking-wider text-apricot">{SOURCE_LABEL_TEXT[m.sessionLabel]}</span>}
              </div>
              {m.note && <p className="mt-1 max-w-[70ch] text-sm text-ivory-2">{m.note}</p>}
              <p className="tnum mt-2 text-[0.8rem] text-ivory-3">
                {m.channelDisplayName}, saved {relativeAge(m.createdAt)}
                {m.observationType ? `, ${OBSERVATION_TYPE_LABEL[m.observationType as keyof typeof OBSERVATION_TYPE_LABEL] ?? m.observationType}` : ""}
                {m.clip?.durationMs ? `, clip ${formatMediaTime(m.clip.durationMs)}` : ""}
                {m.clip?.sourceResolution ? `, source ${m.clip.sourceResolution}` : ""}
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <span className={`text-[0.8rem] ${m.processingState === "failed" ? "text-coral" : m.processingState === "ready" ? "text-ivory" : "text-ivory-3"}`}>
                {STATE_TEXT[m.processingState]}
              </span>
              <div className="flex flex-wrap gap-2">
                <Link href={momentHref(m)} className="btn btn-ghost btn-sm">
                  {m.mediaStartMs !== null ? `Jump to ${formatMediaTime(m.mediaStartMs)}` : "Evidence"}
                </Link>
                {m.clip?.clipUrl && (
                  <a href={m.clip.clipUrl} target="_blank" rel="noreferrer noopener" className="btn btn-ghost btn-sm">
                    Twitch clip
                  </a>
                )}
                {m.canExport &&
                  m.clip?.exports.map((x) => (
                    <a key={x.kind} href={x.url} download className="btn btn-primary btn-sm">
                      Export {x.kind}
                    </a>
                  ))}
                {m.twitchUrl && !m.clip?.clipUrl && (
                  <a href={m.twitchUrl} target="_blank" rel="noreferrer noopener" className="btn btn-quiet btn-sm">
                    Twitch
                  </a>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
