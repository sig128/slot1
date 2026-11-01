"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IngestCredentials, RelayDestinationView, RelayOverview, RelayPlatform, RelayStatus, UpdateRelayDestinationInput } from "@slot1/contracts";
import { Toggle } from "@/components/ui/Toggle";
import { api } from "@/lib/api";
import { relativeAge } from "@/lib/format";
import { BUSY, errorText, ManualCredentials, ObsAutoSetup, sentence } from "./obs-setup";
import { SetupFix } from "@/components/ui/SetupFix";
import { StreamOnboarding, useStreamOnboarding } from "./StreamOnboarding";
import { TwitchPermissionsNotice } from "./TwitchPermissions";
import { requirementText } from "@/lib/requirements";
import type { StudioCtx } from "./StudioApp";

const PLATFORM: Record<RelayPlatform, string> = { twitch: "Twitch", youtube: "YouTube", kick: "Kick", custom: "Custom server" };

const STATUS: Record<RelayStatus, { word: string; chip: string }> = {
  disabled: { word: "Off", chip: "chip-muted" },
  idle: { word: "Ready", chip: "chip-muted" },
  connecting: { word: "Connecting", chip: "chip-replay" },
  live: { word: "Live", chip: "chip-live" },
  retrying: { word: "Reconnecting", chip: "chip-replay" },
  error: { word: "Problem", chip: "chip-error" },
  needs_permission: { word: "Needs permission", chip: "chip-replay" },
};

function SectionTitle({ children, lede }: { children: React.ReactNode; lede: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">{children}</h2>
      <p className="mt-2 max-w-[68ch] text-ivory-2">{lede}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t hairline py-6" aria-labelledby={`stream-step-${n}`}>
      <h3 id={`stream-step-${n}`} className="mb-3 flex items-center gap-3 font-display text-xl font-bold">
        <span aria-hidden className="select-bar inline-grid h-7 w-7 shrink-0 place-items-center font-black">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 max-w-[70ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">{children}</p>;
}

export function StreamSetupSection({ ctx }: { ctx: StudioCtx }) {
  const [data, setData] = useState<RelayOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creds, setCreds] = useState<IngestCredentials | null>(null);
  const onboarding = useStreamOnboarding();

  const load = useCallback(async () => {
    try {
      setData(await api<RelayOverview>("/api/studio/relay"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Couldn't load your stream setup"));
    }
  }, []);

  // Forwarding status changes on its own (connecting → live → reconnecting), so keep it fresh.
  useEffect(() => {
    // Initial load of this tab's data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const ingestReady = ctx.caps.ingest.available;
  if (onboarding.active && data) return <StreamOnboarding ctx={ctx} data={data} onChange={load} onExit={onboarding.exit} />;
  return (
    <div>
      <SectionTitle lede="Stream once from OBS to SLOT1. SLOT1 watches your gameplay and passes the exact same stream on to Twitch, YouTube or Kick. You only set this up once.">
        Stream setup
      </SectionTitle>
      {loadError && (
        <p role="alert" className="mb-4 text-sm text-coral">
          {loadError}
        </p>
      )}
      {!data ? (
        !loadError && <p className="text-sm text-ivory-3">Loading your stream setup…</p>
      ) : (
        <>
          {!ingestReady && <Notice>{requirementText(ctx.caps.ingest.reason)} Uploaded replays still work.<SetupFix cap={ctx.caps.ingest} /></Notice>}
          <TwitchPermissionsNotice ctx={ctx} />
          <Step n={1} title="Point OBS at SLOT1">
            <IngestState data={data} />
            <ObsAutoSetup
              disabledReason={!ingestReady ? "Not available yet." : data.ingest.publishing ? "You’re streaming to SLOT1 right now, so OBS is already set up." : null}
              onDone={load}
              onKeepCreds={setCreds}
            />
            <ManualCredentials disabled={!ingestReady} creds={creds} setCreds={setCreds} />
          </Step>
          <Step n={2} title="Choose where it goes">
            {!data.available && <Notice>{requirementText(data.reason)}<SetupFix cap={ctx.caps.relay} /></Notice>}
            <ul aria-label="Forwarding destinations">
              {data.destinations.map((d) => (
                <DestinationRow key={d.id} d={d} data={data} onChange={load} />
              ))}
            </ul>
            <TwitchAdd data={data} onChange={load} />
            <AddDestination data={data} onChange={load} />
          </Step>
          <Step n={3} title="Go live">
            <p className="max-w-[68ch] text-sm text-ivory-2">
              Click <strong className="text-ivory">Start Streaming</strong> in OBS. SLOT1 starts forwarding within a few seconds and stops when you stop. In your Twitch chat,{" "}
              <code className="text-ivory">!slot1 relay</code> shows where you’re live (never any keys).
            </p>
          </Step>
          <section className="border-t hairline py-6">
            <h3 className="mb-2 font-display text-xl font-bold">Good to know</h3>
            <ul className="max-w-[70ch] list-disc space-y-2 pl-5 text-sm text-ivory-2">
              <li>Your upload stays at one stream however many places SLOT1 forwards to. SLOT1’s servers send the copies, unchanged, at the quality OBS sends.</li>
              <li>
                Everything now runs through SLOT1. If SLOT1 has a problem, your stream on every platform stops until it’s back. Each platform reconnects on its own when that
                platform has a problem.
              </li>
              <li>
                Platform rules differ. Twitch allows simulcasting if Twitch gets equal or better quality and you don’t link other platforms on Twitch. YouTube allows it. Kick
                Partners must turn on Multistreaming, and Kick pays Partners less for hours also live elsewhere. Check each platform’s current rules.
              </li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function IngestState({ data }: { data: RelayOverview }) {
  const { publishing, keyHint } = data.ingest;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
      <span className={`chip ${publishing ? "chip-live" : "chip-muted"}`}>{publishing ? "Receiving" : "Not receiving"}</span>
      <span className="text-ivory-2">
        {publishing ? "SLOT1 is receiving your stream from OBS." : keyHint ? `Waiting for OBS. Your SLOT1 key ends in ${keyHint}.` : "Not set up yet. Start with the button below."}
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Destinations                                                                               */
/* ------------------------------------------------------------------------------------------ */

function DestinationRow({ d, data, onChange }: { d: RelayDestinationView; data: RelayOverview; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [server, setServer] = useState("");
  /** The switch moves at once; the server's answer then confirms (or undoes) it. */
  const [pending, setPending] = useState<boolean | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmRemove) keep.current?.focus();
  }, [confirmRemove]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
      return true;
    } catch (err) {
      setError(errorText(err, "Couldn't save"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: UpdateRelayDestinationInput) => act(() => api(`/api/studio/relay/destinations/${d.id}`, { method: "PATCH", json: body }));
  const toggle = async (on: boolean) => {
    if (busy) return;
    setPending(on);
    await patch({ enabled: on });
    setPending(null);
  };
  const replace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await patch({ streamKey: key, ...(server.trim() ? { serverUrl: server.trim() } : {}) })) {
      setKey("");
      setServer("");
      setEditing(false);
    }
  };

  const twitchNeedsOk = d.platform === "twitch" && !data.twitch.forwardingPermission;
  const st = STATUS[d.status];
  const detail = d.statusDetail ?? (d.status === "idle" ? "Starts when you stream to SLOT1." : null);
  const where = [PLATFORM[d.platform], d.serverHost, d.keyHint ? `key ends in ${d.keyHint}` : d.platform === "twitch" ? "key from your Twitch connection" : null].filter(Boolean).join(" · ");

  return (
    <li className="border-t hairline py-3 first:border-t-0" data-testid={`relay-destination-${d.platform}`}>
      <Toggle label={`Forward to ${d.label}`} description={where} checked={pending ?? d.enabled} disabled={!data.available} onChange={(v) => void toggle(v)} />
      <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <span className={`chip ${st.chip}`}>{st.word}</span>
        {detail && <span className="min-w-0 break-words text-ivory-2">{sentence(detail)}</span>}
      </p>
      {d.lastConnectedAt && <p className="mt-1 text-[0.8rem] text-ivory-3">Last connected {relativeAge(d.lastConnectedAt)}</p>}
      {twitchNeedsOk && data.twitch.permissionUrl && (
        <p className="mt-2 text-sm text-ivory-2">
          Twitch needs your OK before SLOT1 can read your stream key.{" "}
          <a href={data.twitch.permissionUrl} className="underline hover:text-ivory">
            Let SLOT1 forward to Twitch
          </a>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {d.platform !== "twitch" && (
          <button type="button" className="btn btn-quiet btn-sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Replace key"}
          </button>
        )}
        {confirmRemove ? (
          <>
            <span className="text-sm text-ivory-2">Remove {d.label}? Its saved key is erased.</span>
            <button type="button" className={`btn btn-coral btn-sm ${BUSY}`} aria-disabled={busy} onClick={() => void act(() => api(`/api/studio/relay/destinations/${d.id}`, { method: "DELETE" }))}>
              Remove
            </button>
            <button ref={keep} type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
      </div>
      {editing && (
        <form onSubmit={(e) => void replace(e)} className="mt-3 grid max-w-xl gap-3">
          {d.platform !== "youtube" && (
            <div>
              <label className="label" htmlFor={`srv-${d.id}`}>
                New server (leave empty to keep {d.serverHost ?? "the current one"})
              </label>
              <input id={`srv-${d.id}`} className="field" value={server} onChange={(e) => setServer(e.target.value)} placeholder="rtmps://" spellCheck={false} autoComplete="off" />
            </div>
          )}
          <div>
            <label className="label" htmlFor={`key-${d.id}`}>
              New stream key
            </label>
            <input id={`key-${d.id}`} type="password" className="field" value={key} onChange={(e) => setKey(e.target.value)} required minLength={4} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <button className={`btn btn-primary btn-sm ${BUSY}`} aria-disabled={busy}>
              Save new key
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-coral">
          {error}
        </p>
      )}
    </li>
  );
}

function TwitchAdd({ data, onChange }: { data: RelayOverview; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data.destinations.some((d) => d.platform === "twitch")) return null;
  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<RelayDestinationView>("/api/studio/relay/destinations", { method: "POST", json: { platform: "twitch" } });
      await api(`/api/studio/relay/destinations/${created.id}`, { method: "PATCH", json: { enabled: true } });
      await onChange();
    } catch (err) {
      setError(errorText(err, "Couldn't add Twitch"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t hairline py-4" data-testid="relay-add-twitch">
      <p className="font-display text-lg font-bold">Twitch</p>
      {!data.twitch.connected ? (
        <p className="text-sm text-ivory-3">Forwarding to Twitch needs a Twitch sign-in. YouTube, Kick and custom servers work without one.</p>
      ) : !data.twitch.forwardingPermission ? (
        <>
          <p className="max-w-[64ch] text-sm text-ivory-2">
            Twitch asks for your OK once so SLOT1 can read your Twitch stream key. SLOT1 stores it encrypted and never shows it to anyone, you included.
          </p>
          {data.twitch.permissionUrl ? (
            <a href={data.twitch.permissionUrl} className="btn btn-primary mt-3">
              Let SLOT1 forward to Twitch
            </a>
          ) : (
            <p className="mt-2 text-sm text-ivory-3">Twitch sign-in isn’t open on SLOT1 yet.</p>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-ivory-2">Nothing to paste: SLOT1 gets your Twitch stream key from Twitch.</p>
          <button
            type="button"
            className={`btn btn-primary mt-3 ${BUSY}`}
            disabled={!data.available || data.destinations.length >= data.maxDestinations}
            aria-disabled={busy}
            onClick={() => void add()}
          >
            {busy ? "Adding…" : "Forward to Twitch"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  );
}

type PastePlatform = Exclude<RelayPlatform, "twitch">;

const PASTE_HELP: Record<PastePlatform, string> = {
  youtube: "In YouTube Studio, click Create → Go live, open Stream and copy the Stream key. SLOT1 uses YouTube’s secure server, already filled in.",
  kick: "On Kick, open your creator dashboard → Settings → Stream, and copy the Stream URL and the Stream Key.",
  custom: "Any RTMP or RTMPS server. Paste its server address and stream key separately, as you would in OBS.",
};

function AddDestination({ data, onChange }: { data: RelayOverview; onChange: () => Promise<void> }) {
  const taken = new Set(data.destinations.map((d) => d.platform));
  const options = (["youtube", "kick", "custom"] as const).filter((p) => p === "custom" || !taken.has(p));
  const [choice, setChoice] = useState<PastePlatform>(options[0] ?? "custom");
  const platform: PastePlatform = options.includes(choice) ? choice : (options[0] ?? "custom");
  const [label, setLabel] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = data.destinations.length >= data.maxDestinations;
  const serverValue = server ?? (platform === "youtube" ? data.youtubeServer : "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const srv = serverValue.trim();
    if (platform !== "youtube" && !/^rtmps?:\/\//i.test(srv)) return setError("The server address must start with rtmps:// or rtmp://.");
    setBusy(true);
    try {
      const body =
        platform === "youtube"
          ? { platform, streamKey: key, ...(srv ? { serverUrl: srv } : {}) }
          : platform === "kick"
            ? { platform, streamKey: key, serverUrl: srv }
            : { platform, label: label.trim() || "Custom server", streamKey: key, serverUrl: srv };
      const created = await api<RelayDestinationView>("/api/studio/relay/destinations", { method: "POST", json: body });
      await api(`/api/studio/relay/destinations/${created.id}`, { method: "PATCH", json: { enabled: true } });
      setKey("");
      setServer(null);
      setLabel("");
      await onChange();
    } catch (err) {
      setError(errorText(err, "Couldn't add it"));
    } finally {
      setBusy(false);
    }
  };

  if (full) return <p className="border-t hairline py-4 text-sm text-ivory-3">You’re forwarding to the most places SLOT1 allows ({data.maxDestinations}). Remove one to add another.</p>;

  return (
    <form onSubmit={(e) => void submit(e)} className="border-t hairline py-4" aria-labelledby="add-destination-title">
      <p id="add-destination-title" className="font-display text-lg font-bold">
        Add YouTube, Kick or another server
      </p>
      <div className="mt-3 grid max-w-xl gap-4">
        <div>
          <label className="label" htmlFor="dest-platform">
            Platform
          </label>
          <select
            id="dest-platform"
            className="field"
            value={platform}
            onChange={(e) => {
              setChoice(e.target.value as PastePlatform);
              setServer(null);
              setError(null);
            }}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {p === "custom" ? "Custom RTMP server" : PLATFORM[p]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[0.8rem] text-ivory-3">{PASTE_HELP[platform]}</p>
        </div>
        {platform === "custom" && (
          <div>
            <label className="label" htmlFor="dest-label">
              Name
            </label>
            <input id="dest-label" className="field" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 40))} placeholder="My restream server" />
          </div>
        )}
        <div>
          <label className="label" htmlFor="dest-server">
            {platform === "kick" ? "Stream URL" : "Server"}
          </label>
          <input
            id="dest-server"
            className="field"
            value={serverValue}
            onChange={(e) => setServer(e.target.value)}
            placeholder={platform === "kick" ? "rtmps://…" : "rtmps:// or rtmp://"}
            required={platform !== "youtube"}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="label" htmlFor="dest-key">
            Stream key
          </label>
          <input id="dest-key" type="password" className="field" value={key} onChange={(e) => setKey(e.target.value)} required minLength={4} spellCheck={false} autoComplete="off" />
          <p className="mt-1 text-[0.8rem] text-ivory-3">Saved encrypted. SLOT1 never shows it again, only its last four characters.</p>
        </div>
        <div>
          <button className={`btn btn-primary ${BUSY}`} disabled={!data.available} aria-disabled={busy}>
            {busy ? "Adding…" : `Forward to ${platform === "custom" ? "this server" : PLATFORM[platform]}`}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-coral">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
