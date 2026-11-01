"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { IngestCredentials } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { connectObs, OBS_DEFAULT_PORT, ObsError, obsIsStreaming, obsUrl, setObsStreamTarget, type ObsConnection } from "@/lib/obs";

/*
 * Getting OBS to stream to SLOT1: one click over OBS's local WebSocket, or the one Server + Key by
 * hand. Used by Studio → Stream setup and by the guided setup a new streamer lands in after
 * connecting Twitch (StreamOnboarding.tsx).
 */

/** Busy buttons keep keyboard focus: they're marked aria-disabled and ignore presses instead of being disabled. */
export const BUSY = "aria-disabled:cursor-progress aria-disabled:opacity-60";

/** "Couldn't reach OBS" -> "Couldn't reach OBS." (server and OBS messages carry no final period). */
export const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return [sentence(err.message), err.requirement ? sentence(err.requirement) : ""].filter(Boolean).join(" ");
  if (err instanceof ObsError) return sentence(err.message);
  return sentence(fallback);
}

/* ------------------------------------------------------------------------------------------ */
/* One click: SLOT1's Server + Key straight into OBS over its local WebSocket                 */
/* ------------------------------------------------------------------------------------------ */

export function ObsAutoSetup({
  disabledReason,
  onDone,
  onKeepCreds,
  title = "Set up OBS automatically",
  level = 4,
}: {
  disabledReason: string | null;
  onDone: () => Promise<void>;
  onKeepCreds: (c: IngestCredentials) => void;
  /** The heading above the steps; the guided setup words it as its own step. */
  title?: string;
  level?: 3 | 4;
}) {
  const id = useId();
  const Heading = level === 3 ? "h3" : "h4";
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(String(OBS_DEFAULT_PORT));
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || disabledReason) return;
    setResult(null);
    let conn: ObsConnection | null = null;
    let fresh: IngestCredentials | null = null;
    try {
      setBusy("Connecting to OBS…");
      conn = await connectObs({ url: obsUrl(Number(port)), password });
      if (await obsIsStreaming(conn)) throw new ObsError("streaming", "OBS is streaming right now. Click Stop Streaming in OBS, then try again");
      setBusy("Getting your SLOT1 key…");
      fresh = await api<IngestCredentials>("/api/studio/relay/ingest-credentials", { method: "POST", json: {} });
      setBusy("Saving it in OBS…");
      await setObsStreamTarget(conn, fresh.server, fresh.streamKey);
      setPassword("");
      setResult({ ok: true, text: "Done. OBS now streams to SLOT1. Click Start Streaming in OBS when you’re ready." });
      await onDone();
    } catch (err) {
      setResult({ ok: false, text: errorText(err, "Something went wrong. Copy the Server and Key by hand instead") });
      // The new key exists only in this page now: show it so it can still be pasted by hand.
      if (fresh) onKeepCreds(fresh);
    } finally {
      conn?.close();
      setBusy(null);
    }
  };

  return (
    <div className="max-w-2xl">
      <Heading className="font-display text-lg font-bold">{title}</Heading>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ivory-2">
        <li>Open OBS on this computer (version 28 or newer).</li>
        <li>
          In OBS, open <strong className="text-ivory">Tools → WebSocket Server Settings</strong> and tick <strong className="text-ivory">Enable WebSocket server</strong>.
        </li>
        <li>
          Click <strong className="text-ivory">Show Connect Info</strong>, copy the <strong className="text-ivory">Server Password</strong> and paste it here.
        </li>
        <li>If your browser asks to let this site connect to apps on this device, choose Allow. It only talks to OBS.</li>
      </ol>
      <form onSubmit={(e) => void run(e)} className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="min-w-0">
          <label className="label" htmlFor={`${id}-password`}>
            OBS WebSocket password
          </label>
          <input
            id={`${id}-password`}
            name="obs-websocket-password"
            type="password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-password-help`}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-port`}>
            Port
          </label>
          <input id={`${id}-port`} className="field tnum" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        </div>
        <p id={`${id}-password-help`} className="text-[0.8rem] text-ivory-3 sm:col-span-2">
          Used only to talk to OBS on this computer. SLOT1 never saves it or sends it anywhere. Leave it empty if you turned off authentication in OBS.
        </p>
        <div className="sm:col-span-2">
          <button className={`btn btn-primary ${BUSY}`} disabled={Boolean(disabledReason)} aria-disabled={Boolean(busy)}>
            {busy ?? "Set up OBS automatically"}
          </button>
          {disabledReason && <p className="mt-1 text-[0.8rem] text-ivory-3">{disabledReason}</p>}
        </div>
      </form>
      <p role="status" data-testid="obs-result" className={`mt-3 min-h-[1.25rem] max-w-[68ch] text-sm ${result?.ok ? "text-signal" : "text-coral"}`}>
        {result?.text ?? ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* By hand: one Server + one Key                                                              */
/* ------------------------------------------------------------------------------------------ */

export function ManualCredentials({ disabled, creds, setCreds }: { disabled: boolean; creds: IngestCredentials | null; setCreds: (c: IngestCredentials | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; canForce: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // The button that asked for the key is replaced by the key: move focus there.
  useEffect(() => {
    if (creds) box.current?.focus();
  }, [creds]);

  const get = async (force: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setCreds(await api<IngestCredentials>("/api/studio/relay/ingest-credentials", { method: "POST", json: { force } }));
    } catch (err) {
      setError({ text: errorText(err, "Couldn't get a key"), canForce: err instanceof ApiError && err.status === 409 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 max-w-2xl">
      <h4 className="font-display text-lg font-bold">Or paste it into OBS yourself</h4>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ivory-2">
        <li>
          In OBS, open <strong className="text-ivory">Settings → Stream</strong>.
        </li>
        <li>
          Set <strong className="text-ivory">Service</strong> to <strong className="text-ivory">Custom…</strong>
        </li>
        <li>Paste the Server and the Stream Key below, then click OK.</li>
      </ol>
      {creds ? (
        <div ref={box} tabIndex={-1} aria-label="Your SLOT1 Server and Stream Key" className="mt-3 border border-apricot/60 bg-graphite-800 p-4 outline-none" data-testid="ingest-credentials">
          <CopyField label="Server" value={creds.server} />
          <CopyField label="Stream Key" value={creds.streamKey} secret />
          <p className="mt-2 text-[0.8rem] text-ivory-3">Shown once. Getting a new key later replaces this one, and OBS will need the new one.</p>
          <button type="button" className="btn btn-quiet btn-sm mt-2" onClick={() => setCreds(null)}>
            Done
          </button>
        </div>
      ) : (
        <>
          <button type="button" className={`btn btn-ghost mt-3 ${BUSY}`} onClick={() => void get(false)} disabled={disabled} aria-disabled={busy}>
            {busy ? "Getting your key…" : "Show my Server and Key"}
          </button>
          <p className="mt-1 text-[0.8rem] text-ivory-3">This makes a fresh key. Any older SLOT1 key stops working.</p>
        </>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-coral">
          <p>{error.text}</p>
          {error.canForce && (
            <button type="button" className="btn btn-quiet btn-sm mt-1 px-0 underline" onClick={() => void get(true)}>
              Get a new key anyway (ends the current stream)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setShown(true); // no clipboard access: show it so it can be selected by hand
    }
  };
  const masked = `${"•".repeat(Math.min(16, Math.max(6, value.length - 4)))}${value.slice(-4)}`;
  return (
    <div className="py-2">
      <p className="label">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-[1_1_14rem] break-all bg-graphite-900 px-3 py-2 text-[0.88rem] text-ivory" data-testid={`copy-${label.toLowerCase().replace(/\s+/g, "-")}`}>
          {shown ? value : masked}
        </code>
        {secret && (
          <button type="button" className="btn btn-quiet btn-sm" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
            {shown ? "Hide" : "Show"}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
}
