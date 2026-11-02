import type { Metadata } from "next";
import type { PublicStatus } from "@slot1/contracts";
import { serverApi } from "@/lib/server";
import { pageMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "System status",
    description: "Whether each part of SLOT1 works right now: the website, sign-in with Twitch, streaming, the AI, and which version is running.",
    path: "/status",
  });
}

type Tone = "ok" | "warn" | "down" | "off";

interface Row {
  name: string;
  tone: Tone;
  state: string;
  detail?: string;
}

const DOT: Record<Tone, string> = { ok: "bg-[#0ca30c]", warn: "bg-gold", down: "bg-coral", off: "bg-ivory-3" };

/** A failed sign-in caused by the site's own Twitch app settings: sign-in can't work until they're fixed. */
const SETUP_WHY: Record<string, string> = {
  app_secret: "Twitch isn't accepting the site's app secret.",
  app_client: "Twitch doesn't recognize the site's app.",
  redirect: "The site's Twitch app has the wrong redirect URL.",
  not_configured: "It isn't set up yet.",
};

function since(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function rows(st: PublicStatus, now: number): Row[] {
  const out: Row[] = [{ name: "Website", tone: "ok", state: "Working" }];
  out.push(
    st.services.database === "ok" && st.services.redis === "ok"
      ? { name: "Accounts and live updates", tone: "ok", state: "Working" }
      : { name: "Accounts and live updates", tone: "down", state: "Down", detail: "Pages load, but signing in, chat and live updates may not work." },
  );
  const last = st.twitchSignIn.last;
  if (!st.twitchSignIn.configured) {
    out.push({ name: "Sign in with Twitch", tone: "off", state: "Not open yet" });
  } else if (last && last.outcome === "error" && last.why && SETUP_WHY[last.why]) {
    out.push({ name: "Sign in with Twitch", tone: "down", state: "Not working", detail: `${SETUP_WHY[last.why]} Last attempt ${since(last.at, now)}.` });
  } else {
    out.push({
      name: "Sign in with Twitch",
      tone: "ok",
      state: "Working",
      detail: last ? (last.outcome === "connected" ? `Last sign-in ${since(last.at, now)}.` : `Last attempt ${since(last.at, now)} didn't finish on the person's side.`) : undefined,
    });
  }
  out.push(st.streaming.available ? { name: "Streaming to SLOT1", tone: "ok", state: "Open" } : { name: "Streaming to SLOT1", tone: "off", state: "Not open yet" });
  out.push(
    st.ai.configured
      ? { name: "AI that watches streams", tone: "ok", state: "On" }
      : { name: "AI that watches streams", tone: "off", state: "Off", detail: "Streams still get on-screen text and video measurements." },
  );
  const d = st.deploy;
  if (d?.state === "building") out.push({ name: "Updates", tone: "warn", state: "A new version is being built", detail: `Started ${since(d.at, now)}. The current version keeps running meanwhile.` });
  else if (d?.state === "failed") out.push({ name: "Updates", tone: "warn", state: "The last update didn't go through", detail: `Still running the previous version. Tried ${since(d.at, now)}.` });
  else out.push({ name: "Updates", tone: "ok", state: "Up to date", detail: d ? `Updated ${since(d.at, now)}.` : undefined });
  return out;
}

export default async function StatusPage() {
  const res = await serverApi<PublicStatus>("/api/status");
  // "x min ago" is measured from the moment the status was taken.
  const list: Row[] = res.ok
    ? rows(res.data, Date.parse(res.data.generatedAt))
    : [
        { name: "Website", tone: "ok", state: "Working" },
        { name: "Everything behind it", tone: "down", state: "Not answering", detail: "Signing in, live streams and the AI are unavailable until it's back." },
      ];
  const version = res.ok ? res.data.version : null;
  const checked = res.ok ? new Date(res.data.generatedAt) : null;
  return (
    <article className="mx-auto max-w-[56rem] px-4 pb-24 pt-12 sm:px-6">
      <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.9]">System status</h1>
      <p className="mt-4 max-w-[60ch] text-ivory-2">Whether each part of SLOT1 works right now.</p>
      <ul className="mt-10 border-b hairline" data-testid="status-list">
        {list.map((r) => (
          <li key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 border-t hairline py-4">
            <div className="min-w-0">
              <p className="font-display text-[1.35rem] font-bold leading-tight">{r.name}</p>
              {r.detail ? <p className="mt-1 text-[0.92rem] text-ivory-3">{r.detail}</p> : null}
            </div>
            <p className="flex items-center gap-2 text-right font-semibold">
              <span aria-hidden className={`h-2.5 w-2.5 flex-none rounded-full ${DOT[r.tone]}`} />
              {r.state}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[0.85rem] text-ivory-3">
        {checked ? <>Checked {checked.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</> : "Couldn't check just now"}
        {version ? <>, version {version}</> : null}. Reload for the latest.
      </p>
    </article>
  );
}
