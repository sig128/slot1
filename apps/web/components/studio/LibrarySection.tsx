"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EXPORT_PRESETS, formatMediaTime, type ExportFormat, type ExportPresetId, type LibraryItemView, type LibraryResponse, type LibraryVisibility } from "@slot1/contracts";
import { ShareFilePanel } from "@/components/clipper/ShareClip";
import { Toggle } from "@/components/ui/Toggle";
import { api, ApiError } from "@/lib/api";
import { itemKindLabel, ownerOpenPath, VISIBILITY_TEXT } from "@/lib/clipper";
import { bytes, relativeAge } from "@/lib/format";
import { canShareAsFile } from "@/lib/share";
import type { StudioCtx } from "./StudioApp";

type Filter = "all" | "recordings" | "clips" | "renders" | "screenshots";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["recordings", "Recordings"],
  ["clips", "Clips"],
  ["renders", "Renders"],
  ["screenshots", "Screenshots"],
];
const RETENTION_DAYS = [1, 3, 7, 14, 30, 60, 90, 180, 365];

function matches(i: LibraryItemView, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "recordings") return i.kind === "recording";
  if (f === "screenshots") return i.kind === "screenshot" || i.kind === "thumbnail";
  // Clips: Twitch clips, rendered clip exports and SLOT1's own auto clips.
  if (f === "clips") return i.kind === "twitch_clip" || i.kind === "clip_export" || (i.kind === "render" && i.auto);
  return i.kind === "render" && !i.auto;
}

interface ProjectRow {
  id: string;
  title: string;
  origin: "manual" | "auto";
  updatedAt: string;
  segments: number;
}

export function LibrarySection({ ctx }: { ctx: StudioCtx }) {
  const s = ctx.overview.settings;
  const login = ctx.overview.broadcaster.login;
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [vis, setVis] = useState<LibraryVisibility | "any">("any");

  const load = useCallback(async () => {
    try {
      const [lib, p] = await Promise.all([api<LibraryResponse>("/api/library"), api<{ projects: ProjectRow[] }>("/api/projects")]);
      setData(lib);
      setProjects(p.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your library");
    }
  }, []);

  useEffect(() => {
    // Initial load of this tab's data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Renders and screenshots finish in the background: refresh while any is still processing.
  const processing = data?.items.some((i) => i.status === "processing") ?? false;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [processing, load]);

  const items = useMemo(() => (data?.items ?? []).filter((i) => matches(i, filter) && (vis === "any" || i.visibility === vis)), [data, filter, vis]);

  const patch = async (id: string, body: Partial<Pick<LibraryItemView, "title" | "visibility" | "featured">>) => {
    try {
      const row = await api<LibraryItemView>(`/api/library/${id}`, { method: "PATCH", json: body });
      setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === id ? row : x)) } : d));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that item");
    }
  };
  const remove = async (i: LibraryItemView) => {
    const what = i.kind === "recording" ? "this recording's video (the session and its AI log stay)" : `“${i.title}”`;
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    try {
      await api(`/api/library/${i.id}`, { method: "DELETE" });
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== i.id) } : d));
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete that item");
    }
  };

  const usage = data?.usage;
  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">Library</h2>
        <p className="mt-2 max-w-[68ch] text-ivory-2">
          Everything you record, capture and cut. Items start private; choose what appears on{" "}
          <Link href={`/c/${login}`} className="underline hover:text-ivory">
            your public profile
          </Link>
          .
        </p>
        {s.visibility !== "public" && (
          <p className="mt-3 max-w-[68ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
            Your channel is private, so nothing here is visible to anyone else yet, even items set to Public or Unlisted. Make the channel public under Privacy
            and data when you&apos;re ready to share.
          </p>
        )}
      </div>

      <section className="st-block border-t hairline py-6" aria-labelledby="lib-rec">
        <h3 id="lib-rec" className="mb-2 font-display text-xl font-bold">
          Recording
        </h3>
        {!s.recordingConsent && (
          <Toggle
            label="I consent to SLOT1 recording my ingest stream"
            description="Required before any of your live stream is stored beyond the analyzed frames. Same setting as under Privacy and data."
            checked={false}
            onChange={(v) => void ctx.save({ recordingConsent: v })}
          />
        )}
        <Toggle
          label="Record my SLOT1 streams"
          description="Saves each live session sent to your SLOT1 ingest URL as an MP4, copied without re-encoding, so you can replay it with the AI log, take screenshots and cut clips. Twitch-only broadcasts can't be recorded."
          checked={s.recordingEnabled && s.recordingConsent}
          disabled={!s.recordingConsent}
          onChange={(v) => void ctx.save({ recordingEnabled: v })}
        />
        <div className="mt-2 grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-end">
          <div>
            <label className="label" htmlFor="rec-days">
              Keep recordings for
            </label>
            <select id="rec-days" className="field tnum" value={s.recordingRetentionDays} onChange={(e) => void ctx.save({ recordingRetentionDays: Number(e.target.value) })}>
              {[...new Set([...RETENTION_DAYS, s.recordingRetentionDays])]
                .sort((a, b) => a - b)
                .map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "1 day" : `${d} days`}
                  </option>
                ))}
            </select>
          </div>
          <p className="text-[0.82rem] text-ivory-3">Expired recordings are deleted. Clips, renders and screenshots you made from them stay in your library.</p>
        </div>
        {usage && <StorageBar usage={usage} />}
      </section>

      <section className="st-block border-t hairline py-6" aria-labelledby="lib-auto">
        <h3 id="lib-auto" className="mb-2 font-display text-xl font-bold">
          Auto clips
        </h3>
        <Toggle
          label="Cut a clip around every big moment"
          description="When SLOT1 reads MISSION PASSED, MISSION FAILED, WASTED or BUSTED on screen, it cuts a vertical 1080×1920 clip draft you can edit or share. Replays are clipped right away; live streams need Recording on."
          checked={s.autoClips}
          onChange={(v) => void ctx.save({ autoClips: v })}
        />
        <div className="mt-2 grid max-w-md grid-cols-2 gap-4">
          <SecondsField id="pre-roll" label="Seconds before the moment" value={s.autoClipPreRollMs} min={0} max={60} onSave={(ms) => void ctx.save({ autoClipPreRollMs: ms })} />
          <SecondsField id="post-roll" label="Seconds after" value={s.autoClipPostRollMs} min={1} max={60} onSave={(ms) => void ctx.save({ autoClipPostRollMs: ms })} />
        </div>
      </section>

      <section className="st-block border-t hairline py-6" aria-labelledby="lib-items">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h3 id="lib-items" className="font-display text-xl font-bold">
            Your library
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Show" className="flex flex-wrap border hairline">
              {FILTERS.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={filter === v}
                  onClick={() => setFilter(v)}
                  className={`h-9 px-3 font-display text-[0.95rem] font-semibold ${filter === v ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="sr-only" htmlFor="lib-vis">
              Visibility
            </label>
            <select id="lib-vis" className="field h-9 w-auto" value={vis} onChange={(e) => setVis(e.target.value as LibraryVisibility | "any")}>
              <option value="any">Any visibility</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-coral">
            {error}
          </p>
        )}
        {!data ? (
          <p className="mt-4 text-sm text-ivory-3">Loading your library</p>
        ) : items.length === 0 ? (
          <p className="mt-4 max-w-[68ch] text-sm text-ivory-3">
            {data.items.length === 0
              ? "Nothing here yet. Open a replay to take screenshots or cut a clip, turn on Recording for live streams, or let auto clips catch your big moments."
              : "Nothing matches these filters."}
          </p>
        ) : (
          <ul className="mt-5 grid gap-x-5 gap-y-8 sm:grid-cols-2 2xl:grid-cols-3" aria-label="Library items">
            {items.map((i) => (
              <LibraryCard key={i.id} item={i} login={login} onPatch={(b) => patch(i.id, b)} onDelete={() => remove(i)} />
            ))}
          </ul>
        )}
      </section>

      <section className="st-block border-t hairline py-6" aria-labelledby="lib-edits">
        <h3 id="lib-edits" className="mb-2 font-display text-xl font-bold">
          Edits
        </h3>
        {projects.length === 0 ? (
          <p className="text-sm text-ivory-3">No edits yet. Use “Edit clip” on a replay to start one.</p>
        ) : (
          <ul className="divide-y divide-line">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <Link href={`/studio/edit/${p.id}`} className="min-w-0 flex-1 truncate text-ivory hover:text-apricot">
                  {p.title}
                </Link>
                <span className={`chip ${p.origin === "auto" ? "chip-replay" : "chip-muted"}`}>{p.origin === "auto" ? "Auto clip" : "Edit"}</span>
                <BatchExport projectId={p.id} title={p.title} onStarted={() => void load()} />
                <span className="tnum text-[0.8rem] text-ivory-3" suppressHydrationWarning>
                  {p.segments} segment{p.segments === 1 ? "" : "s"}, {relativeAge(p.updatedAt)}
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm text-coral"
                  onClick={async () => {
                    if (!window.confirm(`Delete the edit “${p.title}”? Renders you made from it stay.`)) return;
                    await api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => undefined);
                    void load();
                  }}
                >
                  Delete<span className="sr-only"> edit {p.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const BATCH: ExportPresetId[] = ["tiktok", "shorts", "reels", "x", "youtube"];

/** Export one edit for several platforms at once (one library item per platform). */
function BatchExport({ projectId, title, onStarted }: { projectId: string; title: string; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ExportPresetId[]>(["tiktok", "shorts", "reels"]);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="w-full sm:w-auto">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Export for…<span className="sr-only"> {title}</span>
      </button>
      {open && (
        <div className="mt-2 border hairline p-3">
          <fieldset>
            <legend className="label">Platforms</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {BATCH.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-[#ffad72]" checked={chosen.includes(p)} onChange={(e) => setChosen((l) => (e.target.checked ? [...l, p] : l.filter((x) => x !== p)))} />
                  {EXPORT_PRESETS[p].label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`bf-${projectId}`} className="label">
                File type
              </label>
              <select id={`bf-${projectId}`} className="field h-8 w-auto py-0 text-[0.85rem]" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                <option value="mp4">Video (MP4)</option>
                <option value="gif">GIF</option>
                <option value="audio">Audio only</option>
              </select>
            </div>
            <button
              type="button"
              className="btn btn-coral btn-sm"
              disabled={busy || chosen.length === 0}
              onClick={async () => {
                setBusy(true);
                setMsg(null);
                try {
                  const r = await api<{ items: LibraryItemView[] }>(`/api/projects/${projectId}/exports`, { method: "POST", json: { presets: chosen, format } });
                  setMsg({ text: `${r.items.length} export${r.items.length === 1 ? "" : "s"} started; they appear in your library.`, error: false });
                  onStarted();
                } catch (err) {
                  setMsg({ text: err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}` : ""}` : "Couldn't start the exports", error: true });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting" : `Export ${chosen.length}`}
            </button>
          </div>
          {msg && (
            <p role={msg.error ? "alert" : "status"} className={`mt-2 text-[0.8rem] ${msg.error ? "text-coral" : "text-ivory-2"}`}>
              {msg.text}
            </p>
          )}
          <p className="mt-1 text-[0.72rem] text-ivory-3">Platform length limits are their published ones as of 2025 and can change.</p>
        </div>
      )}
    </div>
  );
}

function SecondsField({ id, label, value, min, max, onSave }: { id: string; label: string; value: number; min: number; max: number; onSave: (ms: number) => void }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className="field tnum"
        defaultValue={Math.round(value / 1000)}
        onBlur={(e) => {
          const v = Math.min(max, Math.max(min, Math.round(Number(e.target.value))));
          if (Number.isFinite(v) && v * 1000 !== value) onSave(v * 1000);
        }}
      />
    </div>
  );
}

const USAGE_PARTS = [
  ["recordings", "Recordings", "bg-coral"],
  ["library", "Clips and screenshots", "bg-apricot"],
  ["uploads", "Uploads", "bg-signal"],
  ["analysis", "Analysis frames", "bg-ivory-3"],
] as const;

function StorageBar({ usage }: { usage: LibraryResponse["usage"] }) {
  const total = Math.max(1, usage.total);
  return (
    <div className="mt-6">
      <p className="text-sm text-ivory-2">
        Storage used: <span className="tnum font-display text-lg font-bold text-ivory">{usage.total ? bytes(usage.total) : "0 B"}</span>
      </p>
      <div className="mt-2 flex h-2 w-full max-w-xl overflow-hidden bg-graphite-700" aria-hidden>
        {USAGE_PARTS.map(([k, , cls]) => (usage[k] > 0 ? <span key={k} className={cls} style={{ width: `${(usage[k] / total) * 100}%` }} /> : null))}
      </div>
      <dl className="tnum mt-2 grid max-w-3xl grid-cols-1 gap-x-6 gap-y-1 text-[0.82rem] min-[420px]:grid-cols-2 lg:grid-cols-4">
        {USAGE_PARTS.map(([k, label, cls]) => (
          <div key={k} className="flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 shrink-0 ${cls}`} />
            <dt className="text-ivory-3">{label}</dt>
            <dd className="ml-auto whitespace-nowrap">{usage[k] ? bytes(usage[k]) : "0 B"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LibraryCard({
  item: i,
  login,
  onPatch,
  onDelete,
}: {
  item: LibraryItemView;
  login: string;
  onPatch: (b: Partial<Pick<LibraryItemView, "title" | "visibility" | "featured">>) => Promise<void>;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(i.title);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const ready = i.status === "ready";
  const isVideo = i.kind !== "screenshot" && i.kind !== "twitch_clip" && i.kind !== "thumbnail" && i.format === "mp4";
  const ext = i.kind === "screenshot" ? "jpg" : i.format === "png" ? "png" : i.format === "gif" ? "gif" : i.format === "audio" ? "m4a" : "mp4";
  const fileName = `${i.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "slot1"}.${ext}`;
  const openHref = i.kind === "twitch_clip" ? (i.externalUrl ?? i.viewPath) : ownerOpenPath(i);
  const external = i.kind === "twitch_clip" && Boolean(i.externalUrl);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${i.viewPath}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable: the link is still shown on the item page */
    }
  };
  return (
    <li className="min-w-0">
      <div className="relative aspect-video overflow-hidden bg-graphite-900">
        {i.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={i.posterUrl} alt="" loading="lazy" className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center text-sm text-ivory-3">{i.kind === "twitch_clip" ? "Clip on Twitch" : ready ? "No preview" : ""}</div>
        )}
        <span className="chip absolute left-2 top-2 bg-graphite-900/85">
          {itemKindLabel(i)}
          {i.preset && i.preset !== "original" ? ` · ${EXPORT_PRESETS[i.preset].label}` : ""}
          {i.format === "gif" ? " · GIF" : i.format === "audio" ? " · Audio" : ""}
        </span>
        {i.durationMs ? <span className="tnum absolute bottom-2 right-2 bg-graphite-900/85 px-1.5 text-[0.78rem]">{formatMediaTime(i.durationMs)}</span> : null}
        {i.status === "processing" && (
          <div className="absolute inset-x-0 bottom-0 bg-graphite-900/85 px-3 py-2">
            <p className="text-[0.8rem] text-ivory-2">{i.kind === "render" ? "Rendering" : "Processing"}</p>
            <div
              role="progressbar"
              aria-label={`${i.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={i.progress === null ? undefined : Math.round(i.progress * 100)}
              className="mt-1 h-1 bg-graphite-600"
            >
              <span className="block h-full bg-apricot transition-[width]" style={{ width: `${Math.round((i.progress ?? 0.04) * 100)}%` }} />
            </div>
          </div>
        )}
        {i.status === "failed" && <p className="absolute inset-x-0 bottom-0 bg-graphite-900/90 px-3 py-2 text-[0.8rem] text-coral">{i.error ?? "Failed"}</p>}
      </div>

      {renaming ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (title.trim()) await onPatch({ title: title.trim() });
            setRenaming(false);
          }}
        >
          <label className="sr-only" htmlFor={`t-${i.id}`}>
            Title
          </label>
          <input id={`t-${i.id}`} className="field h-9" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <button className="btn btn-primary btn-sm h-9">Save</button>
        </form>
      ) : (
        <p className="mt-3 truncate font-display text-[1.25rem] font-bold leading-tight" title={i.title}>
          {i.title}
        </p>
      )}
      <p className="tnum mt-0.5 text-[0.8rem] text-ivory-3" suppressHydrationWarning>
        {relativeAge(i.createdAt)}
        {i.width && i.height ? `, ${i.width}×${i.height}` : ""}
        {i.bytes ? `, ${bytes(i.bytes)}` : ""}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`v-${i.id}`}>
          Who can see {i.title}
        </label>
        <select
          id={`v-${i.id}`}
          className="field h-8 w-auto py-0 text-[0.85rem]"
          value={i.visibility}
          disabled={!ready}
          onChange={(e) => void onPatch({ visibility: e.target.value as LibraryVisibility })}
        >
          {(Object.keys(VISIBILITY_TEXT) as LibraryVisibility[]).map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_TEXT[v].label}: {VISIBILITY_TEXT[v].detail}
            </option>
          ))}
        </select>
        {i.visibility === "public" && (
          <button type="button" className={`btn btn-sm ${i.featured ? "btn-primary" : "btn-ghost"}`} aria-pressed={i.featured} onClick={() => void onPatch({ featured: !i.featured })}>
            {i.featured ? "Featured" : "Feature"}
            <span className="sr-only"> {i.title} on your profile</span>
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        {ready &&
          (external ? (
            <a href={openHref} target="_blank" rel="noreferrer noopener" className="btn btn-quiet btn-sm">
              Open<span className="sr-only"> {i.title}</span> on Twitch
            </a>
          ) : (
            <Link href={openHref} className="btn btn-quiet btn-sm">
              Open<span className="sr-only"> {i.title}</span>
            </Link>
          ))}
        {i.projectId && (
          <Link href={`/studio/edit/${i.projectId}`} className="btn btn-quiet btn-sm">
            Edit<span className="sr-only"> {i.title}</span>
          </Link>
        )}
        {ready && i.url && (
          <a href={i.url} download={fileName} className="btn btn-quiet btn-sm">
            Download<span className="sr-only"> {i.title}</span>
          </a>
        )}
        {canShareAsFile(i) && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={sharing} onClick={() => setSharing((v) => !v)}>
            Share<span className="sr-only"> {i.title}</span>
          </button>
        )}
        {ready && i.visibility !== "private" && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => void copyLink()}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        )}
        {!renaming && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setTitle(i.title), setRenaming(true))}>
            Rename<span className="sr-only"> {i.title}</span>
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-sm text-coral" onClick={onDelete}>
          Delete<span className="sr-only"> {i.title}</span>
        </button>
      </div>
      {sharing && canShareAsFile(i) && <ShareFilePanel item={i} onClose={() => setSharing(false)} />}
      {isVideo && i.kind === "recording" && ready && (
        <p className="mt-1 text-[0.78rem] text-ivory-3">Open it to screenshot any frame or cut a clip at the playhead.</p>
      )}
      {i.visibility === "public" && ready && (
        <p className="mt-1 text-[0.78rem] text-ivory-3">
          Listed on{" "}
          <Link href={`/c/${login}`} className="underline hover:text-ivory">
            /c/{login}
          </Link>
        </p>
      )}
    </li>
  );
}
