"use client";

import Link from "next/link";
import { Tabs } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import type { Capabilities, ChannelSettings, ChannelSettingsPatch, MeResponse, ReadinessStep, StudioOverview } from "@slot1/contracts";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { api, ApiError, getMe } from "@/lib/api";
import { requirementText } from "@/lib/requirements";
import { SetupFix } from "@/components/ui/SetupFix";
import { signInNotice, twitchSignInHref, type SignInNotice } from "@/lib/signin-notice";
import { SignInNoticeBox } from "./SignInNoticeBox";
import { AdvancedSection, BotSection, JobsSection, OverviewSection, PrivacySection, SourcesSection } from "./StudioSections";
import { GtaModelSection } from "./GtaModelSection";
import { LibrarySection } from "./LibrarySection";
import { StreamSetupSection } from "./StreamSetup";

export interface StudioCtx {
  overview: StudioOverview;
  caps: Capabilities;
  me: MeResponse;
  reload: () => Promise<void>;
  save: (patch: ChannelSettingsPatch) => Promise<ChannelSettings | null>;
  saving: boolean;
  saveError: string | null;
  runAction: (actionId: string) => Promise<void>;
}

const SECTIONS = [
  ["overview", "Overview"],
  ["stream", "Stream setup"],
  ["sources", "Video sources"],
  ["library", "Library"],
  ["bot", "Bot and chat"],
  ["privacy", "Privacy and data"],
  ["jobs", "Jobs and usage"],
  ["gta", "GTA model"],
  ["advanced", "Advanced setup"],
] as const;

export function StudioApp() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [overview, setOverview] = useState<StudioOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [section, setSection] = useState<string>("overview");
  const [notice, setNotice] = useState<SignInNotice | null>(null);

  const reload = useCallback(async () => {
    try {
      const m = await getMe(true);
      setMe(m);
      setCaps(await api<Capabilities>("/api/capabilities"));
      if (m.broadcaster) setOverview(await api<StudioOverview>("/api/studio"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach SLOT1");
    }
  }, []);

  useEffect(() => {
    // Initial data load for the signed-in creator.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    const q = new URLSearchParams(window.location.search);
    // What happened on Twitch, shown on whichever screen the person lands on (signed in or not).
    setNotice(signInNotice(q, window.location.origin));
    if (window.location.hash === "#sources") setSection("sources");
    if (window.location.hash === "#library") setSection("library");
    if (window.location.hash === "#stream" || q.get("tab") === "stream") setSection("stream");
  }, [reload]);

  // Keep source health and the last-frame preview current.
  useEffect(() => {
    if (!overview) return;
    const t = setInterval(() => void api<StudioOverview>("/api/studio").then(setOverview).catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [overview]);

  const save = useCallback(async (patch: ChannelSettingsPatch) => {
    setSaving(true);
    setSaveError(null);
    try {
      const s = await api<ChannelSettings>("/api/studio/settings", { method: "PATCH", json: patch });
      setOverview((o) => (o ? { ...o, settings: s } : o));
      void api<StudioOverview>("/api/studio").then(setOverview).catch(() => undefined);
      return s;
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save");
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const runAction = useCallback(
    async (actionId: string) => {
      try {
        if (actionId === "enable_bot") await save({ botEnabled: true, botKilled: false });
        if (actionId === "enable_agent") await api("/api/studio/agent", { method: "POST", json: { enabled: true } });
        if (actionId === "add_source") setSection("sources");
        await reload();
      } catch (err) {
        setSaveError(err instanceof ApiError ? `${err.message}${err.requirement ? `. ${err.requirement}.` : ""}` : "Action failed");
      }
    },
    [reload, save],
  );

  if (error) return <p className="mx-auto max-w-[1600px] px-4 py-20 text-coral sm:px-6 lg:px-10">{error}</p>;
  if (!me || !caps) return <p className="mx-auto max-w-[1600px] px-4 py-20 text-ivory-3 sm:px-6 lg:px-10">Loading Studio</p>;
  if (!me.user || !me.broadcaster) return <SignIn caps={caps} notice={notice} onSignedIn={reload} />;
  if (!overview) return <p className="mx-auto max-w-[1600px] px-4 py-20 text-ivory-3 sm:px-6 lg:px-10">Loading your channel</p>;

  const ctx: StudioCtx = { overview, caps, me, reload, save, saving, saveError, runAction };

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-20 pt-8 sm:px-6 lg:px-10">
      {notice && (
        <div className="mb-6">
          <SignInNoticeBox notice={notice} showRetry={false} />
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">Studio</h1>
          <p className="mt-2 text-ivory-2">
            {overview.broadcaster.displayName}
            {overview.broadcaster.kind === "local" ? ", local workspace" : overview.twitch.login ? `, twitch.tv/${overview.twitch.login}` : ""}
          </p>
        </div>
        <QuickControls ctx={ctx} />
      </div>

      <Readiness steps={overview.readiness} onAction={runAction} />
      {saveError && (
        <p role="alert" className="mt-4 text-sm text-coral">
          {saveError}
        </p>
      )}

      <Tabs.Root value={section} onValueChange={setSection} orientation="vertical" className="mt-12 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Tabs.List aria-label="Studio sections" className="-mx-1 flex gap-1 overflow-x-auto lg:sticky lg:top-24 lg:mx-0 lg:flex-col lg:self-start">
          {SECTIONS.map(([v, label]) => (
            <Tabs.Trigger
              key={v}
              value={v}
              className="h-10 shrink-0 px-3 text-left font-display text-[1.05rem] font-semibold tracking-[0.02em] text-ivory-2 hover:text-ivory data-[state=active]:select-bar"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="min-w-0">
          <Tabs.Content value="overview">
            <OverviewSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="stream" id="stream">
            <StreamSetupSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="sources" id="sources">
            <SourcesSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="bot">
            <BotSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="privacy">
            <PrivacySection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="jobs">
            <JobsSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="gta">
            <GtaModelSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="library" id="library">
            <LibrarySection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="advanced">
            <AdvancedSection ctx={ctx} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
      <p className="sr-only" aria-live="polite">
        {ctx.saving ? "Saving" : ""}
      </p>
    </div>
  );
}

function QuickControls({ ctx }: { ctx: StudioCtx }) {
  const s = ctx.overview.settings;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await ctx.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy || !s.agentEnabled}
        className="btn btn-ghost btn-sm"
        onClick={() => act(() => api(`/api/studio/analysis/${s.analysisPaused ? "resume" : "pause"}`, { method: "POST" }))}
      >
        {s.analysisPaused ? "Resume analysis" : "Pause analysis"}
      </button>
      {s.agentEnabled && (
        <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={() => act(() => api("/api/studio/agent", { method: "POST", json: { enabled: false } }))}>
          Stop analysis
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        className="btn btn-ghost btn-sm"
        onClick={() => act(() => api(`/api/studio/commentary/${s.commentaryMuted ? "unmute" : "mute"}`, { method: "POST" }))}
      >
        {s.commentaryMuted ? "Unmute commentary" : "Mute commentary"}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-pressed={s.botKilled}
        className={`btn btn-sm ${s.botKilled ? "btn-coral" : "btn-ghost"}`}
        onClick={() => act(() => api("/api/studio/bot/kill", { method: "POST", json: { killed: !s.botKilled } }))}
      >
        {s.botKilled ? "Bot stopped: turn back on" : "Stop bot now"}
      </button>
    </div>
  );
}

const STATUS_TEXT: Record<ReadinessStep["status"], string> = { done: "Done", todo: "Next", blocked: "Waiting", unavailable: "Unavailable" };

/** The readiness sequence: each missing requirement offers exactly one next action. */
function Readiness({ steps, onAction }: { steps: ReadinessStep[]; onAction: (id: string) => void }) {
  const firstTodo = steps.findIndex((s) => s.status === "todo");
  return (
    <ol className="mt-10 grid border-y hairline md:grid-cols-5" aria-label="Readiness">
      {steps.map((s, i) => {
        const current = i === firstTodo;
        return (
          <li key={s.id} className={`border-b hairline p-4 md:border-b-0 md:border-r md:last:border-r-0 ${current ? "bg-graphite-800" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="tnum font-display text-sm font-semibold text-ivory-3">{i + 1}</span>
              <span
                className={`text-[0.75rem] ${
                  s.status === "done" ? "text-signal" : s.status === "todo" ? "text-apricot" : s.status === "unavailable" ? "text-ivory-3" : "text-ivory-2"
                }`}
              >
                {STATUS_TEXT[s.status]}
              </span>
            </div>
            <p className={`mt-2 font-display text-[1.3rem] font-bold leading-tight ${s.status === "done" ? "text-ivory" : "text-ivory-2"}`}>{s.label}</p>
            <p className="mt-1 text-[0.82rem] text-ivory-3">{s.detail}</p>
            {s.action &&
              (s.action.kind === "link" && s.action.href ? (
                <a href={s.action.href} className={`btn btn-sm mt-3 ${current ? "btn-primary" : "btn-ghost"}`}>
                  {s.action.label}
                </a>
              ) : s.action.actionId ? (
                <button type="button" className={`btn btn-sm mt-3 ${current ? "btn-primary" : "btn-ghost"}`} onClick={() => onAction(s.action!.actionId!)}>
                  {s.action.label}
                </button>
              ) : null)}
          </li>
        );
      })}
    </ol>
  );
}

function SignIn({ caps, notice, onSignedIn }: { caps: Capabilities; notice: SignInNotice | null; onSignedIn: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/local", { method: "POST", json: { displayName: name } });
      await getMe(true);
      await onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign in");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <SkylineArt className="h-[30vh] min-h-[240px] w-full" />
      <div className="relative z-10 mx-auto grid max-w-[1600px] gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-6">
          {notice && !(notice.code === "not_configured" && !caps.twitch.available) && (
            <div className="mb-8">
              <SignInNoticeBox notice={notice} showRetry={false} />
            </div>
          )}
          <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">Bring your channel on air.</h1>
          <p className="mt-5 max-w-[56ch] text-ivory-2">
            Connect the Twitch account you broadcast from. SLOT1 only ever analyzes video you authorize, and nothing is public until you switch it on.
          </p>
          <div className="mt-8">
            {caps.twitch.available ? (
              <a href={twitchSignInHref()} className="btn btn-coral h-12 px-5 text-[1.12rem]">
                {notice?.retry ? "Sign in with Twitch again" : "Sign in with Twitch"}
              </a>
            ) : (
              <div className="max-w-[60ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2" data-testid="twitch-signin-closed">
                <p className="font-display text-lg font-bold text-ivory">{caps.twitch.setup ? requirementText(caps.twitch.reason) : "Twitch sign-in isn’t open yet."}</p>
                <p className="mt-1 text-ivory-3">
                  Creators can’t connect a channel until it is. Meanwhile, see{" "}
                  <Link href="/setup" className="underline hover:text-ivory">
                    how SLOT1 works
                  </Link>
                  .
                </p>
                <SetupFix cap={caps.twitch} />
              </div>
            )}
          </div>
        </div>
        {caps.localLogin && (
          <form onSubmit={local} className="self-end border hairline p-6 lg:col-span-5 lg:col-start-8">
            <h2 className="font-display text-2xl font-bold">Local workspace</h2>
            <p className="mt-1 text-sm text-ivory-3">Development only. Upload and analyze your own recordings without Twitch. Disabled in production.</p>
            <label className="label mt-5" htmlFor="local-name">
              Display name
            </label>
            <input id="local-name" className="field" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={40} required />
            {error && <p className="mt-2 text-sm text-coral">{error}</p>}
            <button className="btn btn-primary mt-4" disabled={busy || name.trim().length < 2}>
              {busy ? "Creating" : "Open local workspace"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
