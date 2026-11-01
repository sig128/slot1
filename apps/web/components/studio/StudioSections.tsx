"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BotCommandName, formatAge, formatMediaTime, SOURCE_LABEL_TEXT, type CreateIngestSourceResponse } from "@slot1/contracts";
import { AnalysisChip, BroadcastChip, SourceLabelChip } from "@/components/ui/StatusChips";
import { Toggle } from "@/components/ui/Toggle";
import { api, ApiError, getMe } from "@/lib/api";
import { bytes, clockTimeSeconds, pct, relativeAge } from "@/lib/format";
import { requirementText } from "@/lib/requirements";
import type { StudioCtx } from "./StudioApp";

function SectionTitle({ children, lede }: { children: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">{children}</h2>
      {lede && <p className="mt-2 max-w-[68ch] text-ivory-2">{lede}</p>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="st-block border-t hairline py-6">
      <h3 className="mb-2 font-display text-xl font-bold">{title}</h3>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */

export function OverviewSection({ ctx }: { ctx: StudioCtx }) {
  const { overview } = ctx;
  const s = overview.currentSession;
  const lf = overview.lastFrame;
  const [now] = useState(() => Date.now());
  return (
    <div>
      <SectionTitle lede="What SLOT1 is receiving right now and the sessions it holds for your channel.">Overview</SectionTitle>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <p className="label">Last received frame</p>
          {lf ? (
            <figure>
              <div className="st-monitor">
                {/* The actual most recent frame from your source, unmodified. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={lf.url} alt="Most recent frame received from your video source" className="block aspect-video w-full bg-black object-contain" />
                <span className="st-monitor-tag" data-live={s && !s.endedAt ? "" : undefined}>
                  {s && !s.endedAt ? "Receiving" : "Last frame"}
                </span>
              </div>
              <figcaption className="tnum mt-2 text-[0.8rem] text-ivory-3">
                Received {clockTimeSeconds(lf.receivedAt)} ({relativeAge(lf.receivedAt, now)}), source time {formatMediaTime(lf.mediaPtsMs)}
              </figcaption>
            </figure>
          ) : (
            <div className="st-monitor">
              <p className="st-monitor-empty">No frame received from a continuous source yet. Uploaded replays don’t appear here.</p>
              <span className="st-monitor-tag">No signal</span>
            </div>
          )}
        </div>
        <div>
          <p className="label">Current session</p>
          {s ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {s.kind !== "replay" && <BroadcastChip state={s.broadcastState} />}
                <AnalysisChip status={s.analysis} />
                <SourceLabelChip label={s.label} />
              </div>
              <p className="text-sm text-ivory-2">{s.analysis.reason}</p>
              <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.84rem]">
                <dt className="text-ivory-3">Coverage</dt>
                <dd>{pct(s.coverage.ratio)}</dd>
                <dt className="text-ivory-3">Frames analyzed</dt>
                <dd>{s.coverage.framesAnalyzed}</dd>
                <dt className="text-ivory-3">Processing delay</dt>
                <dd>{s.analysis.measuredDelayMs ? formatAge(s.analysis.measuredDelayMs) : "—"}</dd>
              </dl>
              {overview.broadcaster.kind === "twitch" && (
                <Link href={`/watch/${overview.broadcaster.login}`} className="btn btn-ghost btn-sm">
                  Open my watch page
                </Link>
              )}
            </div>
          ) : (
            <p className="text-sm text-ivory-3">No live or ingest session yet.</p>
          )}
        </div>
      </div>
      <Group title="Sessions">
        <SessionList ctx={ctx} />
      </Group>
    </div>
  );
}

function SessionList({ ctx }: { ctx: StudioCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  const sessions = ctx.overview.sessions;
  if (sessions.length === 0) return <p className="text-sm text-ivory-3">No sessions yet. Upload a recording under Video sources to create a replay.</p>;
  return (
    <ul className="st-ledger divide-y divide-line">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <Link href={s.kind === "replay" ? `/replay/${s.id}` : `/watch/${ctx.overview.broadcaster.login}`} className="block truncate text-ivory hover:text-apricot">
              {s.title ?? (s.kind === "twitch_broadcast" ? "Twitch broadcast" : "Untitled session")}
            </Link>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem] text-ivory-3">
              <span suppressHydrationWarning>
                {new Date(s.startedAt).toLocaleString()}, {s.visibility}
              </span>
              {s.label && <span className={`chip ${s.label === "live" ? "chip-live" : "chip-replay"}`}>{SOURCE_LABEL_TEXT[s.label]}</span>}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            disabled={busy === s.id || (ctx.overview.settings.visibility === "private" && s.visibility === "private")}
            title={ctx.overview.settings.visibility === "private" ? "Make the channel public first" : undefined}
            onClick={async () => {
              setBusy(s.id);
              await api(`/api/sessions/${s.id}`, { method: "PATCH", json: { visibility: s.visibility === "public" ? "private" : "public" } }).catch(() => undefined);
              await ctx.reload();
              setBusy(null);
            }}
          >
            Make {s.visibility === "public" ? "private" : "public"}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm text-coral"
            disabled={busy === s.id}
            onClick={async () => {
              if (!window.confirm("Delete this session with its media, transcripts and analysis? This can't be undone.")) return;
              setBusy(s.id);
              await api(`/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => undefined);
              await ctx.reload();
              setBusy(null);
            }}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------ */

export function SourcesSection({ ctx }: { ctx: StudioCtx }) {
  return (
    <div>
      <SectionTitle lede="Give SLOT1 real video to analyze. A stock PS5 broadcasting to Twitch does not send a copy here, so continuous analysis needs a relay you set up yourself.">
        Video sources
      </SectionTitle>
      <Group title="Upload a recording">
        <UploadForm ctx={ctx} />
      </Group>
      <Group title="Continuous ingest">
        <IngestSources ctx={ctx} />
      </Group>
    </div>
  );
}

function UploadForm({ ctx }: { ctx: StudioCtx }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [rights, setRights] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelPublic = ctx.overview.settings.visibility === "public";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f) return setError("Choose a video file");
    setError(null);
    const me = await getMe();
    const form = new FormData();
    form.append("title", title || f.name.replace(/\.[^.]+$/, ""));
    form.append("visibility", visibility);
    form.append("rightsConfirmed", rights ? "true" : "false");
    form.append("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("x-slot1-csrf", me.csrfToken ?? "");
    xhr.upload.onprogress = (ev) => ev.lengthComputable && setProgress(ev.loaded / ev.total);
    xhr.onload = () => {
      setProgress(null);
      try {
        const body = JSON.parse(xhr.responseText) as { sessionId?: string; error?: { message: string } };
        if (xhr.status >= 200 && xhr.status < 300 && body.sessionId) router.push(`/replay/${body.sessionId}`);
        else setError(body.error?.message ?? `Upload failed (${xhr.status})`);
      } catch {
        setError(`Upload failed (${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setError("Upload failed. Check your connection.");
    };
    setProgress(0);
    xhr.send(form);
  };

  return (
    <form onSubmit={submit} className="grid max-w-3xl gap-4 sm:grid-cols-2">
      <p className="text-sm text-ivory-2 sm:col-span-2">
        Upload a recording you own. It becomes a <span className="font-display font-semibold tracking-wider">REPLAY</span>, never a live broadcast.
        MP4, MOV, MKV, WebM, TS, FLV or AVI.
      </p>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="up-file">
          Video file
        </label>
        <input id="up-file" ref={file} type="file" accept="video/*,.mkv,.ts,.flv" className="field py-2" required />
      </div>
      <div>
        <label className="label" htmlFor="up-title">
          Title
        </label>
        <input id="up-title" className="field" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Docks heist, attempt 3" />
      </div>
      <div>
        <label className="label" htmlFor="up-vis">
          Visibility
        </label>
        <select id="up-vis" className="field" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "public")}>
          <option value="private">Private, only you</option>
          <option value="public" disabled={!channelPublic}>
            Public{channelPublic ? "" : " (make the channel public first)"}
          </option>
        </select>
      </div>
      <label className="flex items-start gap-3 text-sm text-ivory-2 sm:col-span-2">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-1 accent-[#ffad72]" required />I own this
        recording or have the rights to have it analyzed and stored by SLOT1.
      </label>
      {progress !== null && (
        <div className="sm:col-span-2" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
          <div className="h-1 bg-graphite-600">
            <div className="h-1 bg-apricot transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="tnum mt-1 text-[0.8rem] text-ivory-3">Uploading {Math.round(progress * 100)}%</p>
        </div>
      )}
      {error && <p className="text-sm text-coral sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button className="btn btn-primary" disabled={progress !== null || !rights}>
          Upload and analyze
        </button>
      </div>
    </form>
  );
}

function IngestSources({ ctx }: { ctx: StudioCtx }) {
  const { overview, caps } = ctx;
  const [name, setName] = useState("Capture PC");
  const [label, setLabel] = useState<"live" | "test">("live");
  const [created, setCreated] = useState<Pick<CreateIngestSourceResponse, "publishUrl" | "streamKey" | "whip" | "srt"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = overview.sources.filter((s) => s.kind === "live_ingest" && s.status !== "revoked");

  if (!caps.ingest.available)
    return (
      <div className="max-w-[68ch] text-sm text-ivory-2">
        <p>Continuous ingest isn’t configured on this deployment.</p>
        <p className="mt-1 text-ivory-3">{requirementText(caps.ingest.reason)}</p>
        <Link href="/setup#sources" className="mt-2 inline-block underline hover:text-ivory">
          How continuous ingest works
        </Link>
      </div>
    );

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api<CreateIngestSourceResponse>("/api/studio/sources", { method: "POST", json: { name, label } }));
      await ctx.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the source");
    }
  };

  return (
    <div className="space-y-6">
      <p className="max-w-[70ch] text-sm text-ivory-2">
        Publish from a capture setup you control (for example OBS with a capture card) to SLOT1’s authenticated ingest. Each source gets its own stream key,
        shown once. Declare looped recordings as <strong className="font-display tracking-wider">TEST</strong>; they stay labeled TEST / REPLAY everywhere.
      </p>
      {created && (
        <div className="border border-apricot/60 bg-graphite-800 p-4 text-sm">
          <p className="font-display text-lg font-bold">Copy this now, it won’t be shown again.</p>
          <dl className="mt-3 grid gap-2">
            <dt className="text-ivory-3">Full publish URL (ffmpeg)</dt>
            <dd className="break-all text-ivory">
              <code>{created.publishUrl}</code>
            </dd>
            <dt className="text-ivory-3">Stream key (OBS, with the server URL below)</dt>
            <dd className="break-all text-ivory">
              <code>{created.streamKey}</code>
            </dd>
            {created.whip && (
              <>
                <dt className="text-ivory-3">Lowest delay: OBS 30+, Service WHIP, Server</dt>
                <dd className="break-all text-ivory">
                  <code>{created.whip.url}</code>
                </dd>
                <dt className="text-ivory-3">WHIP Bearer Token</dt>
                <dd className="break-all text-ivory">
                  <code>{created.whip.bearerToken}</code>
                </dd>
              </>
            )}
            {created.srt && (
              <>
                <dt className="text-ivory-3">SRT URL (includes the key)</dt>
                <dd className="break-all text-ivory">
                  <code>{created.srt.url}</code>
                </dd>
              </>
            )}
          </dl>
          <button type="button" className="btn btn-quiet btn-sm mt-3" onClick={() => setCreated(null)}>
            I’ve copied it
          </button>
        </div>
      )}
      {sources.length > 0 && (
        <ul className="divide-y divide-line border-y hairline">
          {sources.map((s) => (
            <li key={s.id} className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-display text-lg font-bold">{s.name}</span>
                  <SourceLabelChip label={s.label} />
                  <span className={`text-[0.8rem] ${s.status === "publishing" ? "text-signal" : "text-ivory-3"}`}>
                    {s.status === "publishing" ? "Publishing" : s.status === "awaiting_publisher" ? "Waiting for publisher" : "Idle"}
                  </span>
                </div>
                {s.publish && (
                  <p className="tnum mt-1 text-[0.8rem] text-ivory-3">
                    Server {s.publish.serverUrl}, path {s.publish.streamPath}, key ends in {s.publish.keyHint}
                  </p>
                )}
                {s.publish?.whipUrl && (
                  <p className="mt-1 break-all text-[0.8rem] text-ivory-3">
                    WHIP (OBS 30+, lowest delay): {s.publish.whipUrl}, bearer token is the stream key
                  </p>
                )}
                {s.health && (
                  <p className="tnum mt-1 text-[0.8rem] text-ivory-3">
                    {s.health.framesReceived} frames received, {s.health.framesAnalyzed} analyzed, {s.health.framesDropped} dropped
                    {s.health.lastFrameAt ? `, last ${relativeAge(s.health.lastFrameAt)}` : ""}
                    {s.health.cadenceMs ? `, every ${formatAge(s.health.cadenceMs)}` : ""}
                  </p>
                )}
                {s.health?.error && <p className="mt-1 text-[0.8rem] text-coral">{s.health.error}</p>}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={async () => {
                    setCreated(await api<Pick<CreateIngestSourceResponse, "publishUrl" | "streamKey" | "whip" | "srt">>(`/api/studio/sources/${s.id}/rotate-key`, { method: "POST" }));
                    await ctx.reload();
                  }}
                >
                  New key
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm text-coral"
                  onClick={async () => {
                    if (!window.confirm("Revoke this source? Its stream key stops working immediately.")) return;
                    await api(`/api/studio/sources/${s.id}`, { method: "DELETE" });
                    await ctx.reload();
                  }}
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="grid max-w-3xl gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="src-name">
            Source name
          </label>
          <input id="src-name" className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="src-label">
            What it sends
          </label>
          <select id="src-label" className="field" value={label} onChange={(e) => setLabel(e.target.value as "live" | "test")}>
            <option value="live">My live gameplay</option>
            <option value="test">A test recording (labeled TEST)</option>
          </select>
        </div>
        <button className="btn btn-primary">Create source</button>
        {error && <p className="text-sm text-coral sm:col-span-3">{error}</p>}
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

const COMMAND_HELP: Record<string, string> = {
  help: "List commands and current capability",
  status: "Chat/video state and observation age",
  now: "Describe the latest observed scene",
  recap: "Recap recent evidence-backed events",
  clip: "Create a Twitch clip",
  find: "Find matching evidence",
  ask: "Answer from session evidence",
  pause: "Pause analysis (creator / approved mods)",
  resume: "Resume analysis (creator / approved mods)",
  mute: "Mute automatic commentary (creator / approved mods)",
  unmute: "Unmute automatic commentary (creator / approved mods)",
  record: "Turn recording on or off (creator / approved mods)",
  autoclip: "Turn automatic clips on or off (creator / approved mods)",
  relay: "Show forwarding status, never keys (creator / approved mods)",
};

export function BotSection({ ctx }: { ctx: StudioCtx }) {
  const s = ctx.overview.settings;
  const [login, setLogin] = useState("");
  const [modError, setModError] = useState<string | null>(null);
  const [mods, setMods] = useState<{ id: string; login: string }[]>(() => s.approvedModeratorIds.map((id) => ({ id, login: id })));
  const toggleCommand = (c: string, on: boolean) => {
    const set = new Set(s.allowedCommands);
    if (on) set.add(c as (typeof s.allowedCommands)[number]);
    else set.delete(c as (typeof s.allowedCommands)[number]);
    void ctx.save({ allowedCommands: [...set] });
  };
  return (
    <div>
      <SectionTitle lede="SLOT1 answers !slot1 commands in your Twitch chat from what it has actually observed. Automatic commentary stays off until you turn it on.">
        Bot and chat
      </SectionTitle>
      {!ctx.caps.bot.available && (
        <p className="mb-4 max-w-[70ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
          The chat bot isn’t available on this deployment. {requirementText(ctx.caps.bot.reason)}
        </p>
      )}
      <Group title="Bot">
        <Toggle label="Bot active in my chat" description="Replies to !slot1 commands. Needs the channel:bot permission." checked={s.botEnabled} onChange={(v) => void ctx.save({ botEnabled: v })} />
        <Toggle
          label="Kill switch"
          description="Stops every reply and comment immediately, whatever else is enabled."
          checked={s.botKilled}
          danger
          onChange={(v) => void api("/api/studio/bot/kill", { method: "POST", json: { killed: v } }).then(() => ctx.reload())}
        />
        <Toggle
          label="Short aliases (!clip, !recap)"
          description="Off by default so SLOT1 doesn't clash with other bots in your chat."
          checked={s.shortAliasesEnabled}
          onChange={(v) => void ctx.save({ shortAliasesEnabled: v })}
        />
        <Toggle
          label="Announcements in chat"
          description="Off by default. When on, SLOT1 says once when it starts watching and posts a link when an auto-clip is ready. At most 3 per 5 minutes."
          checked={s.chatAnnouncements}
          onChange={(v) => void ctx.save({ chatAnnouncements: v })}
        />
      </Group>
      <Group title="Automatic commentary">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="cm-mode">
              Frequency
            </label>
            <select id="cm-mode" className="field" value={s.commentaryMode} onChange={(e) => void ctx.save({ commentaryMode: e.target.value as typeof s.commentaryMode })}>
              <option value="off">Off</option>
              <option value="rare">Rare, at most every 10 minutes</option>
              <option value="normal">Normal, at most every 4 minutes</option>
            </select>
          </div>
        </div>
        <p className="mt-2 max-w-[68ch] text-[0.82rem] text-ivory-3">
          Only salient, evidence-backed events from your own live source are ever posted. Never test recordings, never stale feeds, never every frame.
        </p>
        <Toggle label="Muted" checked={s.commentaryMuted} onChange={(v) => void api(`/api/studio/commentary/${v ? "mute" : "unmute"}`, { method: "POST" }).then(() => ctx.reload())} />
      </Group>
      <Group title="Commands">
        <ul className="grid gap-x-8 sm:grid-cols-2">
          {BotCommandName.options.map((c) => (
            <li key={c}>
              <label className="flex items-start gap-3 py-2 text-sm">
                <input type="checkbox" className="mt-1 accent-[#ffad72]" checked={s.allowedCommands.includes(c)} onChange={(e) => toggleCommand(c, e.target.checked)} />
                <span>
                  <code className="text-ivory">!slot1 {c}</code>
                  <span className="block text-[0.8rem] text-ivory-3">{COMMAND_HELP[c]}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Group>
      <Group title="Who can do what">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="clip-perm">
              Who can request clips in chat
            </label>
            <select id="clip-perm" className="field" value={s.clipPermission} onChange={(e) => void ctx.save({ clipPermission: e.target.value as typeof s.clipPermission })}>
              <option value="broadcaster">Only me</option>
              <option value="approved_moderators">Me and approved moderators</option>
              <option value="moderators">Any moderator</option>
              <option value="vips">Moderators and VIPs</option>
              <option value="everyone">Everyone</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="vq">
              Viewer questions on the website
            </label>
            <select id="vq" className="field" value={s.viewerQuestions} onChange={(e) => void ctx.save({ viewerQuestions: e.target.value as typeof s.viewerQuestions })}>
              <option value="off">Off</option>
              <option value="signed_in">Signed-in viewers</option>
              <option value="anyone">Anyone</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ucd">
              Per-viewer cooldown (seconds)
            </label>
            <input id="ucd" type="number" min={5} max={600} className="field tnum" defaultValue={s.userCooldownSec} onBlur={(e) => void ctx.save({ userCooldownSec: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="ccd">
              Per-command channel cooldown (seconds)
            </label>
            <input id="ccd" type="number" min={2} max={300} className="field tnum" defaultValue={s.channelCooldownSec} onBlur={(e) => void ctx.save({ channelCooldownSec: Number(e.target.value) })} />
          </div>
        </div>
        <div className="mt-6 max-w-3xl">
          <p className="label">Approved moderators</p>
          <p className="mb-3 text-[0.82rem] text-ivory-3">Can pause, resume, mute and unmute. Being a moderator alone isn’t enough; you approve them here.</p>
          <ul className="mb-3 space-y-1 text-sm">
            {mods.map((m) => (
              <li key={m.id} className="flex items-center justify-between border-b hairline py-1.5">
                <span>
                  {m.login} <span className="tnum text-ivory-3">({m.id})</span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    const next = mods.filter((x) => x.id !== m.id);
                    setMods(next);
                    void ctx.save({ approvedModeratorIds: next.map((x) => x.id) });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setModError(null);
              try {
                const u = await api<{ id: string; login: string }>(`/api/studio/lookup-user?login=${encodeURIComponent(login)}`);
                const next = [...mods.filter((x) => x.id !== u.id), { id: u.id, login: u.login }];
                setMods(next);
                setLogin("");
                await ctx.save({ approvedModeratorIds: next.map((x) => x.id) });
              } catch (err) {
                setModError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}` : ""}` : "Lookup failed");
              }
            }}
          >
            <label htmlFor="mod-login" className="sr-only">
              Moderator Twitch login
            </label>
            <input id="mod-login" className="field" placeholder="Twitch login" value={login} onChange={(e) => setLogin(e.target.value)} pattern="[A-Za-z0-9_]{3,25}" />
            <button className="btn btn-ghost shrink-0" disabled={login.length < 3}>
              Approve
            </button>
          </form>
          {modError && <p className="mt-2 text-sm text-coral">{modError}</p>}
        </div>
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

export function PrivacySection({ ctx }: { ctx: StudioCtx }) {
  const s = ctx.overview.settings;
  const isTwitch = ctx.overview.broadcaster.kind === "twitch";
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <SectionTitle lede="Nothing is public until you switch it on. You choose what is recorded, for how long, and you can delete it at any time.">Privacy and data</SectionTitle>
      <Group title="Visibility">
        <Toggle
          label="Public channel"
          description="Lets viewers open your SLOT1 watch page. Turning this off also removes you from the directory and hides your analysis."
          checked={s.visibility === "public"}
          onChange={(v) => void ctx.save({ visibility: v ? "public" : "private" })}
        />
        <Toggle
          label="List me on On Air"
          description={isTwitch ? "Appear in the SLOT1 directory with your live status." : "Only Twitch-connected channels can be listed."}
          checked={s.directoryOptIn}
          disabled={!isTwitch || s.visibility !== "public"}
          onChange={(v) => void ctx.save({ directoryOptIn: v })}
        />
        <Toggle
          label="Show my analysis publicly"
          description="Viewers see the live log and evidence frames for sessions you mark public."
          checked={s.publicAnalysis}
          disabled={s.visibility !== "public"}
          onChange={(v) => void ctx.save({ publicAnalysis: v })}
        />
      </Group>
      <Group title="Recording">
        <Toggle
          label="I consent to SLOT1 recording my ingest stream"
          description="Required before any of your live stream is stored beyond the analyzed frames."
          checked={s.recordingConsent}
          onChange={(v) => void ctx.save(v ? { recordingConsent: true } : { recordingConsent: false, rollingBufferEnabled: false })}
        />
        <Toggle
          label="Rolling buffer for clips"
          description={`Keeps only the last ${Math.round(s.rollingBufferSeconds / 60)} minutes of your ingest stream so you can render clips from it.`}
          checked={s.rollingBufferEnabled}
          disabled={!s.recordingConsent}
          onChange={(v) => void ctx.save({ rollingBufferEnabled: v })}
        />
        <div className="mt-3 max-w-xs">
          <label className="label" htmlFor="ret">
            Keep recordings and analysis for (days)
          </label>
          <input id="ret" type="number" min={1} max={365} className="field tnum" defaultValue={s.retentionDays} onBlur={(e) => void ctx.save({ retentionDays: Number(e.target.value) })} />
        </div>
      </Group>
      <Group title="Delete data">
        <p className="max-w-[68ch] text-sm text-ivory-2">Deletes every session’s media, frames, transcripts and analysis for this channel. This can’t be undone.</p>
        <form
          className="mt-3 flex max-w-md gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api<{ scheduled: number }>("/api/studio/data", { method: "DELETE", json: { confirm } });
            setMsg(`Deletion scheduled for ${r.scheduled} session${r.scheduled === 1 ? "" : "s"}.`);
            setConfirm("");
            await ctx.reload();
          }}
        >
          <label htmlFor="del-confirm" className="sr-only">
            Type DELETE to confirm
          </label>
          <input id="del-confirm" className="field" placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button className="btn btn-ghost shrink-0 text-coral" disabled={confirm !== "DELETE"}>
            Delete everything
          </button>
        </form>
        {msg && <p className="mt-2 text-sm text-ivory-2">{msg}</p>}
      </Group>
      {isTwitch && (
        <Group title="Twitch connection">
          <p className="text-sm text-ivory-2">
            Connected as {ctx.overview.twitch.login}. Disconnecting revokes SLOT1’s Twitch tokens, removes you from the directory, turns the bot off and revokes
            ingest keys.
          </p>
          <button
            type="button"
            className="btn btn-ghost mt-3"
            onClick={async () => {
              if (!window.confirm("Disconnect Twitch from SLOT1?")) return;
              await api("/api/studio/twitch/disconnect", { method: "POST" });
              await ctx.reload();
            }}
          >
            Disconnect Twitch
          </button>
        </Group>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

export function JobsSection({ ctx }: { ctx: StudioCtx }) {
  const { jobs, usage, recentErrors } = ctx.overview;
  return (
    <div>
      <SectionTitle lede="Background work, real errors and what analysis has cost so far this month.">Jobs and usage</SectionTitle>
      <Group title="Recent jobs">
        {jobs.length === 0 ? (
          <p className="text-sm text-ivory-3">No jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-[0.78rem] text-ivory-3">
                <tr>
                  <th className="py-2 font-normal">Job</th>
                  <th className="py-2 font-normal">State</th>
                  <th className="py-2 font-normal">Step</th>
                  <th className="py-2 text-right font-normal">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="py-2">{j.name}</td>
                    <td className={`py-2 ${j.state === "failed" ? "text-coral" : j.state === "succeeded" ? "text-ivory" : "text-apricot"}`}>{j.state}</td>
                    <td className="max-w-[28rem] py-2 text-ivory-2">{j.error ?? j.step ?? "—"}</td>
                    <td className="tnum py-2 text-right text-ivory-3">{j.startedAt ? relativeAge(j.startedAt) : "queued"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Group>
      <Group title="Errors">
        {recentErrors.length === 0 ? (
          <p className="text-sm text-ivory-3">No errors recorded.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {recentErrors.map((e, i) => (
              <li key={i} className="border-l-2 border-coral pl-3">
                <span className="tnum text-[0.78rem] text-ivory-3">
                  {relativeAge(e.at)}, {e.scope}
                </span>
                <p className="text-ivory-2">{e.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Group>
      <Group title="Usage this month">
        <dl className="tnum grid max-w-2xl grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          {[
            ["Vision requests", usage.visionCalls],
            ["Frames sent to vision", usage.framesAnalyzed],
            ["Audio transcribed", `${Math.round(usage.audioSeconds / 60)} min`],
            ["Input tokens", usage.inputTokens.toLocaleString()],
            ["Output tokens", usage.outputTokens.toLocaleString()],
            ["Estimated spend", usage.estimatedCostUsd === null ? "Not priced" : `$${usage.estimatedCostUsd.toFixed(2)}`],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <dt className="text-[0.78rem] text-ivory-3">{k}</dt>
              <dd className="text-lg">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 max-w-[70ch] text-[0.8rem] text-ivory-3">{usage.costBasis}</p>
        <div className="mt-5 max-w-xs">
          <label className="label" htmlFor="budget">
            Vision budget (requests per hour)
          </label>
          <input
            id="budget"
            type="number"
            min={0}
            max={3600}
            className="field tnum"
            defaultValue={usage.maxVisionCallsPerHour}
            onBlur={(e) => void ctx.save({ maxVisionCallsPerHour: Number(e.target.value) })}
          />
          <p className="tnum mt-1 text-[0.78rem] text-ivory-3">{usage.visionCallsLastHour} used in the last hour. Frames beyond the budget get OCR only.</p>
        </div>
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

export function AdvancedSection({ ctx }: { ctx: StudioCtx }) {
  const { caps, overview } = ctx;
  const s = overview.settings;
  const rows: [string, { available: boolean; reason: string | null }, string?][] = [
    ["Twitch app", caps.twitch],
    ["EventSub webhooks", caps.eventsub],
    ["Chat bot", caps.bot],
    ["Vision AI", caps.vision, caps.vision.available ? `${caps.vision.provider} ${caps.vision.model}` : undefined],
    ["Transcription", caps.transcription, caps.transcription.available ? `${caps.transcription.provider} ${caps.transcription.model}` : undefined],
    ["Local OCR", caps.ocr, caps.ocr.detail ?? undefined],
    ["Object storage", caps.storage, caps.storage.driver],
    ["Continuous ingest", caps.ingest, caps.ingest.gateway ?? undefined],
  ];
  return (
    <div>
      <SectionTitle lede="Infrastructure status and analysis tuning. Everything here reflects what is genuinely configured on this deployment.">Advanced setup</SectionTitle>
      <Group title="Integrations">
        <ul className="divide-y divide-line">
          {rows.map(([name, c, detail]) => (
            <li key={name} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
              <span className="text-ivory">{name}</span>
              <span className={`text-sm ${c.available ? "text-ivory-2" : "text-ivory-3"}`}>
                {c.available ? <span className="text-signal">Configured</span> : "Unavailable"}
                {detail ? `, ${detail}` : ""}
                {!c.available && c.reason ? `. ${c.reason}` : ""}
              </span>
            </li>
          ))}
          <li className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
            <span className="text-ivory">PS5 chat display</span>
            <span className="text-sm text-ivory-3">Needs console verification. See the console test checklist on the Setup page.</span>
          </li>
        </ul>
      </Group>
      {ctx.me.user?.isOperator && caps.bot.available && (
        <Group title="SLOT1 bot account">
          <p className="max-w-[68ch] text-sm text-ivory-2">
            Chat replies come from one dedicated Twitch account for the whole deployment. Linking opens Twitch&rsquo;s account chooser: sign in as the bot
            account, not your own. Any other account is refused.
          </p>
          <a href="/api/auth/twitch/start?role=bot&returnTo=/studio" className="btn btn-ghost btn-sm mt-3">
            Link bot account
          </a>
        </Group>
      )}
      {overview.twitch.linked && (
        <Group title="Twitch permissions granted">
          <p className="text-sm text-ivory-2">{overview.twitch.scopes.length ? overview.twitch.scopes.join(", ") : "None"}</p>
          <p className="mt-1 text-[0.8rem] text-ivory-3">
            Last validated {overview.twitch.lastValidatedAt ? relativeAge(overview.twitch.lastValidatedAt) : "never"}. Status {overview.twitch.grantStatus}.
          </p>
          <a href="/api/auth/twitch/start?clipAnalysis=1&returnTo=/studio" className="btn btn-ghost btn-sm mt-3">
            Grant clip analysis permission
          </a>
        </Group>
      )}
      <Group title="Analysis tuning">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="profile">
              Game profile
            </label>
            <select id="profile" className="field" value={s.gameProfile} onChange={(e) => void ctx.save({ gameProfile: e.target.value as typeof s.gameProfile })}>
              <option value="generic">Generic footage</option>
              <option value="gta5">GTA V (validation draft)</option>
            </select>
            <p className="mt-1 text-[0.8rem] text-ivory-3">
              {s.gameProfile === "gta5"
                ? "Screen regions follow the standard GTA V HUD but haven't been validated on real footage yet. A GTA VI profile will only be added from verified footage."
                : "Reads clearly legible text anywhere in the frame. No game-specific assumptions."}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="interval">
              Sample a frame every (seconds)
            </label>
            <input
              id="interval"
              type="number"
              min={1}
              max={60}
              className="field tnum"
              defaultValue={Math.round(s.sampleIntervalMs / 1000)}
              onBlur={(e) => void ctx.save({ sampleIntervalMs: Number(e.target.value) * 1000 })}
            />
            <p className="mt-1 text-[0.8rem] text-ivory-3">Staleness thresholds adapt to this interval and the measured delay.</p>
          </div>
        </div>
      </Group>
      <p className="mt-6 text-[0.8rem] text-ivory-3">
        Storage used by sources:{" "}
        {bytes(overview.sources.reduce((n, x) => n + (x.probe?.sizeBytes ?? 0), 0))}
      </p>
    </div>
  );
}
