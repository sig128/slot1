"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  SettingsPatch,
  settingsEntries,
  type AdminLoginStatus,
  type AdminSettingsView,
  type SettingsField,
  type SettingsPatchInput,
  type SettingsRequestResult,
  type TwitchSignInEvent,
} from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { ago } from "./parts";

const POLL_MS = 4000;
/** After this the page stops waiting and says why the server may not have picked it up. */
const GIVE_UP_MS = 6 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What happened to the last save, in the page's words. */
type SaveState =
  | { phase: "idle" }
  | { phase: "sending"; group: string }
  | { phase: "waiting"; group: string; id: string; since: number; restarting: boolean; password: boolean }
  | { phase: "applied"; group: string; detail: string | null }
  | { phase: "refused"; group: string; detail: string | null }
  | { phase: "slow"; group: string }
  | { phase: "error"; group: string; message: string };

const WHY_TEXT: Record<string, string> = {
  app_secret: "Twitch didn't accept the app secret",
  app_client: "Twitch didn't recognize the Client ID",
  redirect: "The redirect URL didn't match",
  code: "The sign-in code was already used",
  expired: "The sign-in ran out or came from another browser",
  denied: "Cancelled on Twitch",
  twitch_down: "Twitch didn't answer",
  not_configured: "Sign-in wasn't set up",
  server: "SLOT1 couldn't save the connection",
};

/** A Twitch sign-in that failed because of the site's own settings, which only Settings can fix. */
const SETUP_PROBLEMS = new Set(["app_secret", "app_client", "redirect", "not_configured"]);

/** At the top of /admin when Sign in with Twitch can't work, with the way to fix it. */
export function SettingsAlert({ settings, events }: { settings: AdminSettingsView | null; events: TwitchSignInEvent[] }) {
  if (!settings) return null;
  const last = events[0] ?? null;
  const broken = !settings.working.twitch ? "Sign in with Twitch is off: the Twitch app isn't saved yet." : last && last.outcome === "error" && last.why && SETUP_PROBLEMS.has(last.why) ? `The last “Sign in with Twitch” failed: ${WHY_TEXT[last.why]}.` : null;
  if (!broken) return null;
  return (
    <div role="alert" className="mt-6 max-w-[80ch] border-l-4 border-coral bg-graphite-800/80 py-3 pl-4 pr-5">
      <p className="font-display text-xl font-bold">{broken}</p>
      <p className="mt-1 text-ivory-2">
        Fix it in{" "}
        <a href="#settings-twitch" className="underline hover:text-ivory">
          Settings → Twitch app
        </a>
        .
      </p>
    </div>
  );
}

export function SettingsPanel({ initial, initialEvents }: { initial: AdminSettingsView; initialEvents: TwitchSignInEvent[] }) {
  const [view, setView] = useState<AdminSettingsView>(initial);
  const [events, setEvents] = useState<TwitchSignInEvent[]>(initialEvents);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const off = !view.available;

  const reload = useCallback(async () => {
    try {
      const [v, e] = await Promise.all([api<AdminSettingsView>("/api/admin/settings"), api<{ events: TwitchSignInEvent[] }>("/api/admin/signins")]);
      setView(v);
      setEvents(e.events);
    } catch {
      // Keep what's shown; the next save or poll tries again.
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Once applied, the server restarts what reads the settings. Show the new state when it's back:
  // a restarted API (started after the answer), or right away when only the website restarts.
  const afterApplied = useCallback(
    async (r: SettingsRequestResult, password: boolean) => {
      const appliedAt = r.at ? Date.parse(r.at) : Date.now();
      const deadline = Date.now() + 120_000;
      while (mounted.current && Date.now() < deadline) {
        await sleep(3000);
        try {
          if (password) {
            // Every admin session ends with the old password: back to the door.
            const st = await api<AdminLoginStatus>("/api/admin/login");
            if (!st.signedIn) return window.location.reload();
            continue;
          }
          const v = await api<AdminSettingsView>("/api/admin/settings");
          if (r.detail !== "restart: apps" || Date.parse(v.apiStartedAt) >= appliedAt) {
            setView(v);
            void reload();
            return;
          }
        } catch (err) {
          if (password && err instanceof ApiError && err.status === 404) return window.location.reload();
          // Restarting: try again.
        }
      }
      if (password && mounted.current) window.location.reload();
    },
    [reload],
  );

  // Follow a saved request until the server applies or refuses it. While the server restarts
  // SLOT1, the API doesn't answer for a while: that is expected, keep asking.
  useEffect(() => {
    if (save.phase !== "waiting") return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - save.since > GIVE_UP_MS) {
        setSave({ phase: "slow", group: save.group });
        return;
      }
      try {
        const r = await api<SettingsRequestResult>(`/api/admin/settings/requests/${save.id}`);
        if (stop) return;
        if (r.status === "applied") {
          setSave({ phase: "applied", group: save.group, detail: r.detail });
          void afterApplied(r, save.password);
          return;
        }
        if (r.status === "refused") {
          setSave({ phase: "refused", group: save.group, detail: r.detail });
          return;
        }
        if (save.restarting) setSave({ ...save, restarting: false });
      } catch (err) {
        if (stop) return;
        if (save.password && err instanceof ApiError && err.status === 404) {
          // The new password is live and ended this admin session: back to the door.
          setSave({ phase: "applied", group: save.group, detail: null });
          window.location.reload();
          return;
        }
        if (!save.restarting) setSave({ ...save, restarting: true });
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    const t = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [save, reload, afterApplied]);

  /** True when the server took the request. */
  async function send(group: string, path: string, json: unknown, password = false): Promise<boolean> {
    setSave({ phase: "sending", group });
    try {
      const { id } = await api<{ id: string }>(path, { method: "POST", json });
      setSave({ phase: "waiting", group, id, since: Date.now(), restarting: false, password });
      return true;
    } catch (err) {
      setSave({ phase: "error", group, message: err instanceof ApiError ? err.message : "Couldn't reach SLOT1. Try again." });
      return false;
    }
  }

  const busy = save.phase === "sending" || save.phase === "waiting";
  const common = { view, off, busy, save, send };

  return (
    <div className="grid gap-12">
      {off && (
        <p className="max-w-[80ch] border-l-4 border-gold bg-graphite-800/80 py-3 pl-4 pr-5 text-ivory-2" data-testid="settings-unavailable">
          <span className="block font-display text-xl font-bold text-ivory">Saving settings isn’t available on this server.</span>
          {view.unavailableReason}
        </p>
      )}
      <div className="grid gap-x-14 gap-y-14 xl:grid-cols-2">
        <TwitchGroup {...common} />
        <AiGroup {...common} />
        <LegalGroup {...common} />
        <SeoGroup {...common} />
        <UpdatesGroup {...common} now={now} />
        <PasswordGroup {...common} />
      </div>
      <SignInAttempts events={events} now={now} onRefresh={() => void reload()} />
    </div>
  );
}

/* Groups --------------------------------------------------------------------------------- */

interface GroupProps {
  view: AdminSettingsView;
  off: boolean;
  busy: boolean;
  save: SaveState;
  send: (group: string, path: string, json: unknown, password?: boolean) => Promise<boolean>;
}

/**
 * One group of settings: its own form, only the fields that changed are sent, and the shared
 * rules (the same as the server's) are checked first, so a typo is caught here, not on the server.
 */
function useGroup(fields: SettingsField[], current: Partial<Record<SettingsField, string | boolean>>) {
  const [draft, setDraft] = useState<Partial<Record<SettingsField, string | boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const set = (f: SettingsField, v: string | boolean) => {
    setDraft((d) => ({ ...d, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
  };
  const value = (f: SettingsField) => (f in draft ? draft[f] : current[f]);
  /** The changed fields as a patch, or null with the problems shown under the fields. */
  function patch(): SettingsPatchInput | null {
    const out: Record<string, string | boolean> = {};
    for (const f of fields) {
      if (!(f in draft)) continue;
      const v = draft[f]!;
      if (typeof v === "string" && typeof current[f] !== "boolean" && v.trim() === String(current[f] ?? "").trim()) continue;
      if (v === current[f]) continue;
      out[f] = v;
    }
    const parsed = SettingsPatch.safeParse(out);
    if (!parsed.success) {
      setErrors({ [fields[0]!]: "Check this group's values." });
      return null;
    }
    const checked = settingsEntries(parsed.data);
    if (!checked.ok) {
      setErrors(checked.errors);
      return null;
    }
    return out;
  }
  /** After a save: secrets leave the page; other fields keep what was typed until the server's values arrive. */
  const forget = (fs: SettingsField[]) =>
    setDraft((d) => {
      const n = { ...d };
      for (const f of fs) delete n[f];
      return n;
    });
  return { draft, errors, set, value, patch, forget };
}

function Group({ id, title, status, children }: { id: string; title: string; status?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="min-w-0 scroll-mt-24 border-l-2 border-[color:var(--color-line-strong)] pl-5">
      <h3 id={`${id}-h`} className="font-display text-[1.6rem] font-bold leading-tight">
        {title}
      </h3>
      {status ? <div className="mt-1 text-[0.9rem]">{status}</div> : null}
      <div className="mt-5 grid gap-5">{children}</div>
    </section>
  );
}

function Working({ ok, yes, no }: { ok: boolean; yes: string; no: string | null }) {
  return (
    <p className="flex items-start gap-2">
      <span aria-hidden className={`mt-[0.45rem] h-2 w-2 flex-none rounded-full ${ok ? "bg-[#0ca30c]" : "bg-coral"}`} />
      <span className={ok ? "text-ivory-2" : "text-ivory"}>{ok ? yes : no}</span>
    </p>
  );
}

function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[0.85rem] text-coral" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[0.82rem] text-ivory-3">{hint}</p>
      ) : null}
    </div>
  );
}

function TextInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  type = "text",
  error,
  autoComplete = "off",
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  type?: "text" | "password" | "email";
  error?: string;
  autoComplete?: string;
}) {
  return (
    <input
      id={id}
      type={type}
      className="field"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete={autoComplete}
      spellCheck={false}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Toggle({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3">
      <input id={id} type="checkbox" className="h-5 w-5 accent-[var(--color-coral)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="font-display text-[1.1rem] font-semibold">{label}</span>
    </label>
  );
}

/** The save button and, for the group that was saved last, what happened to it. */
function SaveRow({ group, label, save, disabled, onSave }: { group: string; label: string; save: SaveState; disabled: boolean; onSave: () => void }) {
  const mine = save.phase !== "idle" && save.group === group;
  return (
    <div className="grid gap-3">
      <div>
        <button type="button" className="btn btn-coral" disabled={disabled} onClick={onSave}>
          {mine && save.phase === "sending" ? "Saving" : label}
        </button>
      </div>
      {mine ? <SaveMessage save={save} /> : null}
    </div>
  );
}

function SaveMessage({ save }: { save: SaveState }) {
  const box = (tone: string, title: string, body?: React.ReactNode) => (
    <div role="status" aria-live="polite" data-testid="settings-save-status" className={`max-w-[60ch] border-l-4 ${tone} bg-graphite-800/80 py-2.5 pl-4 pr-4`}>
      <p className="font-semibold text-ivory">{title}</p>
      {body ? <p className="mt-0.5 text-[0.9rem] text-ivory-2">{body}</p> : null}
    </div>
  );
  switch (save.phase) {
    case "waiting":
      return box(
        "border-apricot",
        "Saved. The server applies it within a minute, then restarts SLOT1 (about 30 seconds).",
        save.restarting ? "SLOT1 is restarting with the new settings…" : "If a new version is being built right now, this waits until the build is done.",
      );
    case "applied":
      return save.detail === "restart: none" || !save.detail
        ? box("border-[#0ca30c]", "Applied.", null)
        : box("border-[#0ca30c]", "Applied. SLOT1 restarted with the new settings.", null);
    case "refused":
      return box("border-coral", "The server didn’t accept it, so nothing changed.", save.detail ? `It said: ${save.detail}.` : null);
    case "slow":
      return box(
        "border-gold",
        "The server hasn’t picked it up yet.",
        "It checks every minute, but waits while a new version is being built. The change stays saved and is applied after that.",
      );
    case "error":
      return box("border-coral", save.message);
    default:
      return null;
  }
}

function TwitchGroup({ view, off, busy, save, send }: GroupProps) {
  const id = useId();
  const v = view.values;
  const g = useGroup(["twitchClientId", "twitchClientSecret", "adminTwitchLogins", "botTwitchLogin"], {
    twitchClientId: v.twitchClientId ?? "",
    twitchClientSecret: "",
    adminTwitchLogins: v.adminTwitchLogins,
    botTwitchLogin: v.botTwitchLogin ?? "",
  });
  const [copied, setCopied] = useState(false);
  const str = (f: SettingsField) => String(g.value(f) ?? "");
  return (
    <Group
      id="settings-twitch"
      title="Twitch app"
      status={<Working ok={view.working.twitch} yes="Sign in with Twitch is on." no={`Sign in with Twitch is off${view.working.twitchReason ? `: ${view.working.twitchReason}` : ""}.`} />}
    >
      <p className="max-w-[60ch] text-[0.9rem] text-ivory-2">
        From your app at dev.twitch.tv/console/apps (Manage). Its OAuth Redirect URL must be exactly:
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 max-w-full border hairline bg-graphite-800 px-2 py-1 text-[0.85rem] [overflow-wrap:anywhere]" data-testid="twitch-redirect-url">
          {view.twitchRedirectUrl}
        </code>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(view.twitchRedirectUrl).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Field label="Client ID" htmlFor={`${id}-cid`} error={g.errors.twitchClientId}>
        <TextInput id={`${id}-cid`} value={str("twitchClientId")} onChange={(x) => g.set("twitchClientId", x)} disabled={off || busy} error={g.errors.twitchClientId} />
      </Field>
      <Field
        label="Client Secret"
        htmlFor={`${id}-secret`}
        error={g.errors.twitchClientSecret}
        hint={v.twitchClientSecretSet ? "Saved. It's never shown again. To replace it, click New Secret in the Twitch console and paste it here." : "Not saved yet. Click New Secret in the Twitch console and paste it here."}
      >
        <TextInput
          id={`${id}-secret`}
          type="password"
          value={str("twitchClientSecret")}
          onChange={(x) => g.set("twitchClientSecret", x)}
          disabled={off || busy}
          placeholder={v.twitchClientSecretSet ? "•••••••• saved, paste a new one to replace it" : "Paste the Client Secret"}
          autoComplete="new-password"
          error={g.errors.twitchClientSecret}
        />
      </Field>
      <Field label="Admin Twitch usernames" htmlFor={`${id}-admins`} error={g.errors.adminTwitchLogins} hint="Signed in with one of these on Twitch, you can open /admin and link the chat bot. Comma-separated.">
        <TextInput id={`${id}-admins`} value={str("adminTwitchLogins")} onChange={(x) => g.set("adminTwitchLogins", x)} disabled={off || busy} placeholder="yourname" error={g.errors.adminTwitchLogins} />
      </Field>
      <Field label="Chat bot account (optional)" htmlFor={`${id}-bot`} error={g.errors.botTwitchLogin} hint="The Twitch account SLOT1's chat bot posts as. Leave empty for no bot.">
        <TextInput id={`${id}-bot`} value={str("botTwitchLogin")} onChange={(x) => g.set("botTwitchLogin", x)} disabled={off || busy} error={g.errors.botTwitchLogin} />
      </Field>
      <SaveRow
        group="twitch"
        label="Save Twitch app"
        save={save}
        disabled={off || busy}
        onSave={() => {
          const p = g.patch();
          if (p && Object.keys(p).length) void send("twitch", "/api/admin/settings", p).then((ok) => ok && g.forget(["twitchClientSecret"]));
        }}
      />
    </Group>
  );
}

function AiGroup({ view, off, busy, save, send }: GroupProps) {
  const id = useId();
  const v = view.values;
  const g = useGroup(["aiEnabled", "anthropicApiKey"], { aiEnabled: v.aiProvider === "anthropic", anthropicApiKey: "" });
  return (
    <Group id="settings-ai" title="AI" status={<Working ok={view.working.ai} yes="The AI watches streams." no={`The AI is off${view.working.aiReason ? `: ${view.working.aiReason}` : ""}.`} />}>
      {v.aiProvider === "openai" ? <p className="text-[0.9rem] text-ivory-2">This server uses OpenAI, set on the server. Switching the AI on here uses Anthropic instead.</p> : null}
      <Toggle id={`${id}-on`} label="AI watches streams (Anthropic)" checked={Boolean(g.value("aiEnabled"))} onChange={(x) => g.set("aiEnabled", x)} disabled={off || busy} />
      <Field
        label="Anthropic API key"
        htmlFor={`${id}-key`}
        error={g.errors.anthropicApiKey}
        hint={v.anthropicApiKeySet ? "Saved. It's never shown again. Paste a new one to replace it. Anthropic bills the usage." : "From console.anthropic.com. Anthropic bills the usage."}
      >
        <TextInput
          id={`${id}-key`}
          type="password"
          value={String(g.value("anthropicApiKey") ?? "")}
          onChange={(x) => g.set("anthropicApiKey", x)}
          disabled={off || busy}
          placeholder={v.anthropicApiKeySet ? "•••••••• saved, paste a new one to replace it" : "sk-ant-..."}
          autoComplete="new-password"
          error={g.errors.anthropicApiKey}
        />
      </Field>
      <SaveRow
        group="ai"
        label="Save AI"
        save={save}
        disabled={off || busy}
        onSave={() => {
          const p = g.patch();
          if (p && Object.keys(p).length) void send("ai", "/api/admin/settings", p).then((ok) => ok && g.forget(["anthropicApiKey"]));
        }}
      />
    </Group>
  );
}

function LegalGroup({ view, off, busy, save, send }: GroupProps) {
  const id = useId();
  const v = view.values;
  const g = useGroup(["legalName", "legalAddress", "contactEmail", "governingLaw"], {
    legalName: v.legalName ?? "",
    legalAddress: v.legalAddress ?? "",
    contactEmail: v.contactEmail ?? "",
    governingLaw: v.governingLaw ?? "",
  });
  const input = (f: SettingsField, label: string, hint: string, type: "text" | "email" = "text") => (
    <Field label={label} htmlFor={`${id}-${f}`} error={g.errors[f]} hint={hint}>
      <TextInput id={`${id}-${f}`} type={type} value={String(g.value(f) ?? "")} onChange={(x) => g.set(f, x)} disabled={off || busy} error={g.errors[f]} />
    </Field>
  );
  return (
    <Group id="settings-legal" title="Legal pages" status={<p className="text-ivory-2">Shown on the Privacy Policy, Terms and Contact pages. Empty fields are left out there.</p>}>
      {input("legalName", "Business or legal name", "Until it's set, the pages say “the operator of SLOT1”.")}
      {input("legalAddress", "Registered address", "One line.")}
      {input("contactEmail", "Public contact email", "Shown on the legal and contact pages.", "email")}
      {input("governingLaw", "Country whose law governs the Terms", "For example: Norway.")}
      <SaveRow
        group="legal"
        label="Save legal details"
        save={save}
        disabled={off || busy}
        onSave={() => {
          const p = g.patch();
          if (p && Object.keys(p).length) void send("legal", "/api/admin/settings", p);
        }}
      />
    </Group>
  );
}

function SeoGroup({ view, off, busy, save, send }: GroupProps) {
  const id = useId();
  const v = view.values;
  const g = useGroup(["googleVerification", "bingVerification"], { googleVerification: v.googleVerification ?? "", bingVerification: v.bingVerification ?? "" });
  return (
    <Group id="settings-seo" title="Search engines" status={<p className="text-ivory-2">Site verification for Google Search Console and Bing Webmaster Tools. Pasting the whole meta tag works too.</p>}>
      <Field label="Google verification code" htmlFor={`${id}-g`} error={g.errors.googleVerification} hint="After saving: click Verify in Search Console, then submit /sitemap.xml.">
        <TextInput id={`${id}-g`} value={String(g.value("googleVerification") ?? "")} onChange={(x) => g.set("googleVerification", x)} disabled={off || busy} error={g.errors.googleVerification} />
      </Field>
      <Field label="Bing verification code" htmlFor={`${id}-b`} error={g.errors.bingVerification}>
        <TextInput id={`${id}-b`} value={String(g.value("bingVerification") ?? "")} onChange={(x) => g.set("bingVerification", x)} disabled={off || busy} error={g.errors.bingVerification} />
      </Field>
      <SaveRow
        group="seo"
        label="Save codes"
        save={save}
        disabled={off || busy}
        onSave={() => {
          const p = g.patch();
          if (p && Object.keys(p).length) void send("seo", "/api/admin/settings", p);
        }}
      />
    </Group>
  );
}

const DEPLOY_TEXT = { live: "Live", building: "Building a new version", failed: "The last update failed" } as const;

function UpdatesGroup({ view, off, busy, save, send, now }: GroupProps & { now: number }) {
  const id = useId();
  const g = useGroup(["autodeploy"], { autodeploy: view.values.autodeploy });
  const [log, setLog] = useState<string | null | undefined>(undefined);
  const d = view.deploy;
  async function loadLog() {
    if (log !== undefined) return;
    try {
      setLog((await api<{ log: string | null }>("/api/admin/deploy-log")).log);
    } catch {
      setLog(null);
    }
  }
  return (
    <Group
      id="settings-updates"
      title="Automatic updates"
      status={<p className="text-ivory-2">The server checks for a new version every minute and puts it live by itself. The running version keeps serving while the next one builds.</p>}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[0.95rem]">
        <dt className="text-ivory-3">Running</dt>
        <dd className="tnum" data-testid="settings-version">
          {view.version ?? "not tracked yet"}
        </dd>
        <dt className="text-ivory-3">Last update</dt>
        <dd data-testid="settings-deploy">
          {d ? (
            <>
              <span className={d.state === "failed" ? "text-coral" : "text-ivory"}>{DEPLOY_TEXT[d.state]}</span>
              <span className="text-ivory-3">
                {" "}
                · {d.commit.slice(0, 7)} · {ago(d.at, now)}
              </span>
            </>
          ) : (
            <span className="text-ivory-3">No automatic update has run yet.</span>
          )}
        </dd>
      </dl>
      <details className="group" onToggle={(e) => (e.currentTarget.open ? void loadLog() : undefined)}>
        <summary className="cursor-pointer text-[0.9rem] text-ivory-2 underline decoration-line-strong underline-offset-4 hover:text-ivory">The last update’s log</summary>
        <pre className="mt-3 max-h-[24rem] overflow-auto border hairline bg-graphite-900 p-3 text-[0.75rem] leading-relaxed text-ivory-2" data-testid="settings-deploy-log">
          {log === undefined ? "Loading…" : log === null ? "No log yet." : log}
        </pre>
      </details>
      <Toggle id={`${id}-auto`} label="Update automatically" checked={Boolean(g.value("autodeploy"))} onChange={(x) => g.set("autodeploy", x)} disabled={off || busy} />
      <SaveRow
        group="updates"
        label="Save"
        save={save}
        disabled={off || busy || g.value("autodeploy") === view.values.autodeploy}
        onSave={() => {
          const p = g.patch();
          if (p && Object.keys(p).length) void send("updates", "/api/admin/settings", p).then((ok) => ok && g.forget(["autodeploy"]));
        }}
      />
    </Group>
  );
}

function PasswordGroup({ view, off, busy, save, send }: GroupProps) {
  const id = useId();
  const set = view.values.adminPasswordSet;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  return (
    <Group
      id="settings-password"
      title="Admin password"
      status={<p className="text-ivory-2">{set ? "Changing it signs out every admin session, this one too." : "No admin password yet. Set one to open /admin without Twitch."}</p>}
    >
      {set ? (
        <Field label="Current password" htmlFor={`${id}-cur`}>
          <input ref={firstField} id={`${id}-cur`} type="password" className="field" autoComplete="current-password" value={current} disabled={off || busy} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
      ) : null}
      <Field label="New password" htmlFor={`${id}-new`} hint="12 characters or more.">
        <input id={`${id}-new`} type="password" className="field" autoComplete="new-password" value={next} disabled={off || busy} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="New password again" htmlFor={`${id}-again`}>
        <input id={`${id}-again`} type="password" className="field" autoComplete="new-password" value={again} disabled={off || busy} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {error ? <p className="text-[0.9rem] text-coral">{error}</p> : null}
      <SaveRow
        group="password"
        label={set ? "Change password" : "Set password"}
        save={save}
        disabled={off || busy}
        onSave={() => {
          setError(null);
          if ([...next].length < 12) return setError("Use at least 12 characters.");
          if (next !== again) return setError("The two new passwords don't match.");
          void send("password", "/api/admin/password", set ? { current, next } : { next }, true).then((ok) => {
            if (!ok) return;
            setCurrent("");
            setNext("");
            setAgain("");
          });
        }}
      />
    </Group>
  );
}

const OUTCOME_TEXT = { connected: "Signed in", denied: "Cancelled", error: "Didn't finish" } as const;

function SignInAttempts({ events, now, onRefresh }: { events: TwitchSignInEvent[]; now: number; onRefresh: () => void }) {
  return (
    <section aria-labelledby="settings-signins-h" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id="settings-signins-h" className="font-display text-[1.6rem] font-bold">
          Recent “Sign in with Twitch” attempts
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {events.length === 0 ? (
        <p className="mt-3 text-[0.9rem] text-ivory-3">Nobody has tried to sign in with Twitch since the last restart of Redis.</p>
      ) : (
        <ul className="mt-3 grid text-[0.9rem]" data-testid="signin-attempts">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t hairline py-2.5">
              <div className="min-w-0">
                <p>
                  <span className={e.outcome === "error" ? "font-semibold text-coral" : e.outcome === "connected" ? "font-semibold text-ivory" : "font-semibold text-ivory-2"}>{OUTCOME_TEXT[e.outcome]}</span>
                  {e.why ? <span className="text-ivory-2">: {WHY_TEXT[e.why] ?? e.why}</span> : null}
                </p>
                {e.detail ? <p className="mt-0.5 text-[0.82rem] text-ivory-3 [overflow-wrap:anywhere]">{e.detail}</p> : null}
              </div>
              <time dateTime={e.at} className="text-ivory-3">
                {ago(e.at, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
