"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IngestCredentials, RelayDestinationView, RelayOverview } from "@slot1/contracts";
import { SetupFix } from "@/components/ui/SetupFix";
import { Toggle } from "@/components/ui/Toggle";
import { api } from "@/lib/api";
import { BUSY, errorText, ManualCredentials, ObsAutoSetup } from "./obs-setup";
import type { StudioCtx } from "./StudioApp";
import { grantPermissionsUrl, TwitchPermissionsNotice } from "./TwitchPermissions";

/*
 * The guided setup a new streamer lands in right after "Connect my Twitch"
 * (/studio?tab=stream&onboarding=1, see apps/api/src/routes/auth.ts): OBS in one click, then
 * whether SLOT1 passes the stream on to Twitch. Nothing is created until they choose Finish.
 */

const HERE = "/studio?tab=stream&onboarding=1";

/** `?onboarding=1` in the address. Leaving the guided setup drops it, so a reload shows the full page. */
export function useStreamOnboarding(): { active: boolean; exit: () => void } {
  // Studio renders only in the browser (it waits for the signed-in creator), so reading the
  // address here can't differ from a server render.
  const [active, setActive] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("onboarding") === "1");
  const exit = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("onboarding");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setActive(false);
  }, []);
  return { active, exit };
}

export function StreamOnboarding({ ctx, data, onChange, onExit }: { ctx: StudioCtx; data: RelayOverview; onChange: () => Promise<void>; onExit: () => void }) {
  const twitchLinked = ctx.overview.twitch.linked;
  const twitchDest = data.destinations.find((d) => d.platform === "twitch") ?? null;
  const canForward = twitchLinked && data.available && data.twitch.connected && data.twitch.forwardingPermission;
  /** Twitch hasn't allowed SLOT1 to read the stream key (a connection from before one-approval connect). */
  const needsPermission = twitchLinked && data.available && !canForward;
  const ingestReady = ctx.caps.ingest.available;

  const [forward, setForward] = useState(() => (twitchDest ? twitchDest.enabled : true));
  const [creds, setCreds] = useState<IngestCredentials | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ forwarding: boolean } | null>(null);

  // Land on the panel, not on the readiness strip above it (on a phone that's a screen away).
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus();
  }, [done]);

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only the switch decides, and only when it can be used: a destination waiting for Twitch's
      // OK is left exactly as it is.
      if (canForward && forward && !twitchDest) {
        const created = await api<RelayDestinationView>("/api/studio/relay/destinations", { method: "POST", json: { platform: "twitch" } });
        await api(`/api/studio/relay/destinations/${created.id}`, { method: "PATCH", json: { enabled: true } });
      } else if (canForward && twitchDest && twitchDest.enabled !== forward) {
        await api(`/api/studio/relay/destinations/${twitchDest.id}`, { method: "PATCH", json: { enabled: forward } });
      }
      await onChange();
      setDone({ forwarding: canForward && forward });
    } catch (err) {
      setError(errorText(err, "Couldn’t finish the setup. Try again, or open all stream settings"));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <OnboardingDone headRef={head} data={data} forwarding={done.forwarding} waitingForTwitch={needsPermission} twitchLinked={twitchLinked} onExit={onExit} />;

  const obsReady = data.ingest.publishing || Boolean(data.ingest.keyHint);
  return (
    <section aria-labelledby="onboard-title" data-testid="stream-onboarding" className="border border-apricot/60 bg-graphite-800 p-5 sm:p-7">
      {twitchLinked && ctx.overview.twitch.login && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ivory-2">
          <span className="chip chip-live">Twitch connected</span>
          <span>twitch.tv/{ctx.overview.twitch.login}</span>
        </p>
      )}
      <h2 id="onboard-title" ref={head} tabIndex={-1} className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92] outline-none">
        {twitchLinked ? "Connected. Now set up OBS (about 1 minute)" : "Now set up OBS (about 1 minute)"}
      </h2>
      <p className="mt-2 max-w-[62ch] text-ivory-2">
        OBS sends your game to SLOT1 once. SLOT1 watches it for the AI and can pass the exact same stream on to Twitch, so you don’t stream twice.
      </p>
      <p className="mt-1 max-w-[62ch] text-sm text-ivory-3">
        Playing on PS5 or Xbox? OBS needs the picture first, from a capture card or Remote Play.{" "}
        <Link href="/setup#sources" className="underline hover:text-ivory">
          Your options
        </Link>
      </p>

      <div className="mt-5">
        <TwitchPermissionsNotice ctx={ctx} returnTo={HERE} />
      </div>
      {!ingestReady && (
        <p className="mb-4 max-w-[70ch] border-l-2 border-apricot pl-3 text-sm text-ivory-2">
          Streaming to SLOT1 isn’t open yet, so OBS can’t be set up here. Uploaded replays still work.
          <SetupFix cap={ctx.caps.ingest} />
        </p>
      )}

      <div className="grid gap-7">
        <div className="border-t hairline pt-5">
          <ObsAutoSetup
            title="1. Point OBS at SLOT1 in one click"
            level={3}
            disabledReason={!ingestReady ? "Not available yet." : data.ingest.publishing ? "You’re streaming to SLOT1 right now, so OBS is already set up." : null}
            onDone={onChange}
            onKeepCreds={(c) => {
              setCreds(c);
              setManualOpen(true);
            }}
          />
          <details className="mt-2 max-w-2xl" open={manualOpen || Boolean(creds)} onToggle={(e) => setManualOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer text-sm text-ivory-2 underline decoration-line-strong underline-offset-4 hover:text-ivory">
              Prefer to paste the Server and Key into OBS yourself?
            </summary>
            <ManualCredentials disabled={!ingestReady} creds={creds} setCreds={setCreds} />
          </details>
        </div>

        <div className="border-t hairline pt-5">
          <h3 className="font-display text-lg font-bold">2. Your stream on Twitch</h3>
          {!twitchLinked ? (
            <p className="mt-1 max-w-[64ch] text-sm text-ivory-3">This is a local workspace, so there’s no Twitch channel to forward to. Add YouTube or Kick later in Stream setup.</p>
          ) : !data.available ? (
            <p className="mt-1 max-w-[64ch] text-sm text-ivory-3">
              Forwarding isn’t switched on yet, so keep streaming to Twitch from OBS as you do now.
              <SetupFix cap={ctx.caps.relay} />
            </p>
          ) : (
            <div className="max-w-2xl" data-testid="onboarding-forwarding">
              <Toggle
                label="SLOT1 sends your stream on to Twitch"
                description="If SLOT1 has a problem, your stream pauses everywhere until it’s back."
                checked={canForward && forward}
                disabled={!canForward}
                onChange={setForward}
              />
              {needsPermission ? (
                ctx.overview.twitch.missingScopes.length > 0 ? (
                  <p className="text-sm text-ivory-2">Forwarding needs one more Twitch permission: Grant the missing permissions, above.</p>
                ) : (
                  <p className="text-sm text-ivory-2">
                    Your Twitch connection needs renewing first.{" "}
                    <a href={grantPermissionsUrl(HERE)} className="underline hover:text-ivory">
                      Reconnect Twitch
                    </a>
                  </p>
                )
              ) : forward ? (
                <p className="text-[0.82rem] text-ivory-3">Nothing to paste: SLOT1 gets your Twitch stream key from Twitch, stores it encrypted and never shows it.</p>
              ) : (
                <p className="text-[0.82rem] text-ivory-3">Off: OBS streams to SLOT1 only, so you won’t be live on Twitch. You can switch it on later in Stream setup.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t hairline pt-5">
        <button type="button" className={`btn btn-coral ${BUSY}`} aria-disabled={busy} onClick={() => void finish()}>
          {busy ? "Finishing…" : "Finish setup"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onExit}>
          Skip for now
        </button>
        <span className="text-[0.82rem] text-ivory-3">{obsReady ? "OBS is pointed at SLOT1." : "You can finish now and set up OBS later."}</span>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-coral">
          {error}
        </p>
      )}
    </section>
  );
}

function OnboardingDone({
  headRef,
  data,
  forwarding,
  waitingForTwitch,
  twitchLinked,
  onExit,
}: {
  headRef: React.RefObject<HTMLHeadingElement | null>;
  data: RelayOverview;
  forwarding: boolean;
  waitingForTwitch: boolean;
  twitchLinked: boolean;
  onExit: () => void;
}) {
  const obsReady = data.ingest.publishing || Boolean(data.ingest.keyHint);
  return (
    <section aria-labelledby="onboard-title" data-testid="stream-onboarding" className="border border-apricot/60 bg-graphite-800 p-5 sm:p-7">
      <h2 id="onboard-title" ref={headRef} tabIndex={-1} className="font-display text-[length:var(--text-display-md)] font-black leading-[0.92] outline-none">
        {obsReady ? "You’re set up" : "Almost there"}
      </h2>
      <ul className="mt-4 max-w-[64ch] list-disc space-y-2 pl-5 text-ivory-2">
        <li>
          {data.ingest.publishing
            ? "SLOT1 is receiving your stream from OBS."
            : obsReady
              ? "OBS is pointed at SLOT1."
              : "OBS isn’t pointed at SLOT1 yet. Use Set up OBS automatically, or paste the Server and Key, in Stream setup."}
        </li>
        {twitchLinked && (
          <li>
            {forwarding
              ? "SLOT1 sends your stream on to Twitch. It starts a few seconds after you go live and stops when you stop."
              : waitingForTwitch
                ? "Forwarding to Twitch waits for Twitch’s OK: choose Grant the missing permissions in Stream setup."
                : "SLOT1 keeps your stream to itself for now. You can switch on forwarding to Twitch in Stream setup."}
          </li>
        )}
        <li>
          Next: click <strong className="text-ivory">Start Streaming</strong> in OBS.
        </li>
      </ul>
      <button type="button" className="btn btn-primary mt-6" onClick={onExit}>
        Show all stream settings
      </button>
    </section>
  );
}
