"use client";

import Link from "next/link";
import { Tabs } from "radix-ui";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { Capabilities, ChannelSettings, ChannelSettingsPatch, MeResponse, ReadinessStep, StudioOverview } from "@slot1/contracts";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { api, ApiError, getMe } from "@/lib/api";
import { requirementText } from "@/lib/requirements";
import { AdvancedSection, BotSection, JobsSection, OverviewSection, PrivacySection, SourcesSection } from "./StudioSections";
import { GtaModelSection } from "./GtaModelSection";
import { LibrarySection } from "./LibrarySection";
import { AiClipToolsSection } from "@/components/clipper/ai/AiClipToolsSection";
import { SoundsSection } from "@/components/clipper/library/SoundsSection";
import { StreamSetupSection } from "./StreamSetup";
import "./studio.css";

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
  ["ai-clips", "AI clip tools"],
  ["sounds", "Sounds and elements"],
  ["bot", "Bot and chat"],
  ["privacy", "Privacy and data"],
  ["jobs", "Jobs and usage"],
  ["gta", "GTA model"],
  ["advanced", "Advanced setup"],
] as const;

/** Visual grouping of the pause-menu list (wide screens only; not part of the tab order). */
const NAV_GROUPS: { title: string; first: (typeof SECTIONS)[number][0] }[] = [
  { title: "Broadcast", first: "overview" },
  { title: "Create", first: "library" },
  { title: "Channel", first: "bot" },
];

/** The Studio section that holds the next readiness step, flagged in the menu. */
const STEP_SECTION: Record<string, (typeof SECTIONS)[number][0]> = {
  video_source_ready: "sources",
  bot_ready: "bot",
  agent_enabled: "overview",
};

export function StudioApp() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [overview, setOverview] = useState<StudioOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [section, setSection] = useState<string>("overview");
  const [banner, setBanner] = useState<string | null>(null);

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
    const msg: Record<string, string> = {
      "twitch=connected": "Twitch connected.",
      "twitch=denied": "Twitch connection was cancelled.",
      "twitch=error": "Twitch connection failed. Try again.",
      "bot=linked": "SLOT1 bot account linked.",
      "bot=wrong_account": "That Twitch account isn't the configured SLOT1 bot account.",
      "bot=missing_scopes": "The bot authorization was missing required permissions.",
    };
    for (const [k, v] of Object.entries(msg)) {
      const [key, val] = k.split("=");
      if (q.get(key!) === val) setBanner(v);
    }
    if (window.location.hash === "#sources") setSection("sources");
    if (window.location.hash === "#library") setSection("library");
    if (window.location.hash === "#sounds") setSection("sounds");
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
  if (!me.user || !me.broadcaster) return <SignIn caps={caps} onSignedIn={reload} />;
  if (!overview) return <p className="mx-auto max-w-[1600px] px-4 py-20 text-ivory-3 sm:px-6 lg:px-10">Loading your channel</p>;

  const ctx: StudioCtx = { overview, caps, me, reload, save, saving, saveError, runAction };

  const where = overview.broadcaster.kind === "local" ? "Local workspace" : overview.twitch.login ? `twitch.tv/${overview.twitch.login}` : null;
  const nextStep = overview.readiness.find((st) => st.status === "todo");
  const flagged = nextStep ? STEP_SECTION[nextStep.id] : undefined;

  return (
    <div className="st">
      <div className="st-top">
        <div className="st-art">
          <SkylineArt idPrefix="st" className="h-full w-full" />
        </div>
        <div className="st-head">
          <div className="min-w-0">
            <h1 className="st-title">Studio</h1>
            <p className="st-who">
              <span className="st-who-mark" aria-hidden>
                {overview.broadcaster.displayName.trim().charAt(0).toUpperCase() || "S"}
              </span>
              <span className="st-who-name">{overview.broadcaster.displayName}</span>
              {where && <span className="st-who-where">{where}</span>}
            </p>
          </div>
          <QuickControls ctx={ctx} />
        </div>
      </div>

      <div className="st-body">
        {banner && (
          <p role="status" className="st-banner">
            {banner}
          </p>
        )}

        <Readiness steps={overview.readiness} onAction={runAction} />
        {saveError && (
          <p role="alert" className="st-alert">
            {saveError}
          </p>
        )}

        <Tabs.Root value={section} onValueChange={setSection} orientation="vertical" className="st-layout">
          <Tabs.List aria-label="Studio sections" className="st-nav">
            {SECTIONS.map(([v, label]) => {
              const group = NAV_GROUPS.find((g) => g.first === v);
              return (
                <Fragment key={v}>
                  {group && (
                    <span className="st-nav-group" aria-hidden>
                      {group.title}
                    </span>
                  )}
                  <Tabs.Trigger value={v} className="st-tab">
                    {label}
                    {flagged === v && section !== v && (
                      <>
                        <span className="st-tab-flag" aria-hidden />
                        <span className="sr-only">, next step</span>
                      </>
                    )}
                  </Tabs.Trigger>
                </Fragment>
              );
            })}
          </Tabs.List>
          <div className="st-sheet">
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
          <Tabs.Content value="ai-clips" id="ai-clips">
            <AiClipToolsSection ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="sounds" id="sounds">
            <SoundsSection />
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
  const live = s.agentEnabled && !s.analysisPaused;
  return (
    <div className="st-controls" role="group" aria-label="Live controls">
      <span className="st-controls-label" data-state={live ? "live" : "idle"}>
        <span className="st-controls-dot" aria-hidden />
        {live ? "Analysis on" : s.agentEnabled ? "Analysis paused" : "Analysis off"}
      </span>
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
    <ol className="st-route" aria-label="Readiness">
      {steps.map((s, i) => {
        const current = i === firstTodo;
        return (
          <li key={s.id} className="st-step" data-status={s.status} data-current={current ? "" : undefined} aria-current={current ? "step" : undefined}>
            <span className="st-step-num tnum" aria-hidden>
              {s.status === "done" ? "✓" : i + 1}
            </span>
            <div className="st-step-top">
              <p className="st-step-label">
                <span className="sr-only">Step {i + 1}: </span>
                {s.label}
              </p>
              <span className="st-step-state">{STATUS_TEXT[s.status]}</span>
            </div>
            <p className="st-step-detail">{s.detail}</p>
            {s.action &&
              (s.action.kind === "link" && s.action.href ? (
                <a href={s.action.href} className={`btn btn-sm st-step-action ${current ? "btn-primary" : "btn-ghost"}`}>
                  {s.action.label}
                </a>
              ) : s.action.actionId ? (
                <button type="button" className={`btn btn-sm st-step-action ${current ? "btn-primary" : "btn-ghost"}`} onClick={() => onAction(s.action!.actionId!)}>
                  {s.action.label}
                </button>
              ) : null)}
          </li>
        );
      })}
    </ol>
  );
}

function SignIn({ caps, onSignedIn }: { caps: Capabilities; onSignedIn: () => Promise<void> }) {
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
    <section className="st-signin">
      <SkylineArt className="h-[30vh] min-h-[240px] w-full" />
      <div className="relative z-10 mx-auto grid max-w-[1600px] gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-12 lg:px-10">
        <div className="lg:col-span-6">
          <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">Bring your channel on air.</h1>
          <p className="mt-5 max-w-[56ch] text-ivory-2">
            Connect the Twitch account you broadcast from. SLOT1 only ever analyzes video you authorize, and nothing is public until you switch it on.
          </p>
          <div className="mt-8">
            {caps.twitch.available ? (
              <a href="/api/auth/twitch/start?returnTo=/studio" className="btn btn-coral">
                Connect my Twitch
              </a>
            ) : (
              <div className="max-w-[60ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
                <p>Twitch sign-in isn’t configured on this deployment.</p>
                <p className="mt-1 text-ivory-3">{requirementText(caps.twitch.reason)}</p>
                <Link href="/setup#twitch" className="mt-2 inline-block underline hover:text-ivory">
                  How to register a Twitch app
                </Link>
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
