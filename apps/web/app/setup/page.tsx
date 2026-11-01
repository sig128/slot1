import "@/components/setup/setup.css";
import type { Metadata } from "next";
import Link from "next/link";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { CopyButton } from "@/components/setup/CopyButton";
import { COMMANDS, CONSOLE_TEST, CREATOR_COMMANDS, MODES, PERMISSIONS, WONT_DO, type Command } from "@/components/setup/content";
import { RouteMap } from "@/components/setup/RouteMap";
import { SetupTabs } from "@/components/setup/SetupTabs";
import { VideoSources } from "@/components/setup/VideoSources";
import { pageMetadata } from "@/lib/site";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "How SLOT1 works",
    description:
      "Set up SLOT1 for your GTA streams: what it can see, connecting Twitch, the chat bot, sending your stream from OBS, streaming everywhere, and how the AI analysis works.",
    path: "/setup",
  });
}

function CommandList({ items }: { items: Command[] }) {
  return (
    <ul className="su-cmds">
      {items.map((c) => (
        <li key={c.cmd} className="su-cmd">
          <code>{c.cmd}</code>
          <CopyButton text={c.copy} label={c.cmd} />
          <p>{c.does}</p>
        </li>
      ))}
    </ul>
  );
}

export default function SetupPage() {
  return (
    <article className="su-page">
      <header className="su-top">
        <div className="su-art">
          <SkylineArt idPrefix="su" className="h-full w-full" />
        </div>
        <div className="su-head">
          <div>
            <h1 className="su-title">How SLOT1 works</h1>
            <p className="su-lede">
              SLOT1 is a website and a Twitch chat bot. <strong>Nothing is installed on your PS5.</strong> Watching a broadcast and analyzing gameplay are
              separate things, and SLOT1 always tells you which one you’re getting.
            </p>
          </div>
          <div className="su-head-cta">
            <Link href="/studio" className="btn btn-coral">
              Open Studio
            </Link>
            <Link href="/los-santos" className="btn btn-ghost">
              See who’s live
            </Link>
          </div>
        </div>
      </header>

      <SetupTabs />

      <div className="su-body">
        <section id="brief" className="su-section" aria-labelledby="brief-h">
          <h2 id="brief-h" className="su-h2">
            What SLOT1 sees depends on the route
          </h2>
          <p className="su-intro">A console sends its broadcast to Twitch only. SLOT1 analyzes gameplay only when it gets its own copy of the video.</p>
          <div className="su-brief-top">
            <RouteMap />
            <div className="su-brief-side">
              <h3 className="su-panel-title">Your setup, in four steps</h3>
              <ol className="su-objectives">
                <li className="su-objective">
                  <b>Connect Twitch</b>
                  <span>
                    <a href="/api/auth/twitch/start?returnTo=%2Fstudio">Sign in with Twitch</a> with the account you broadcast from. One approval covers everything.
                  </span>
                </li>
                <li className="su-objective">
                  <b>Turn on the bot</b>
                  <span>Its replies stay off until you switch them on in Studio → Bot and chat.</span>
                </li>
                <li className="su-objective">
                  <b>Send your video</b>
                  <span>Right after connecting, Studio sets up OBS in one click. From a console, add a capture card or Remote Play. Needed for live analysis.</span>
                </li>
                <li className="su-objective">
                  <b>Go live everywhere</b>
                  <span>SLOT1 passes the same stream on to Twitch (you choose, in the same setup), and to YouTube or Kick if you add them.</span>
                </li>
              </ol>
            </div>
          </div>

          <div id="ps5" className="su-grid su-brief" style={{ scrollMarginTop: "8.25rem" }}>
            <div className="su-panel">
              <h3 className="su-panel-title">PS5 broadcasting stays on the PS5</h3>
              <p className="mt-2">
                A stock PS5 broadcasts with its built-in feature: press the Create button, choose Broadcast, pick Twitch and go live. Viewers watch on Twitch,
                or on SLOT1, which shows Twitch’s own player.
              </p>
            </div>
            <div className="su-panel">
              <h3 className="su-panel-title">One stream, to Twitch</h3>
              <p className="mt-2">
                The PS5 sends one stream, to Twitch. It doesn’t send a second copy to SLOT1, and there’s no setting on the console where you could enter a SLOT1
                address. That’s why SLOT1 can show the broadcast without being able to see the gameplay.
              </p>
            </div>
            <div className="su-panel">
              <h3 className="su-panel-title flex flex-wrap items-center gap-2">
                Chat on your TV <span className="su-tag su-gold">Unconfirmed</span>
              </h3>
              <p className="mt-2">
                SLOT1’s replies are ordinary Twitch chat messages. If you turn on the PS5’s chat overlay, they may show on your TV with other chat. That hasn’t
                been verified on a console yet, so treat it as unconfirmed.
              </p>
            </div>
          </div>
        </section>

        <section id="modes" className="su-section" aria-labelledby="modes-h">
          <h2 id="modes-h" className="su-h2">
            What SLOT1 can see
          </h2>
          <p className="su-intro">Five ways SLOT1 meets a stream. The bar shows how much of the gameplay it actually gets to see.</p>
          <div className="su-grid su-modes">
            {MODES.map((m) => (
              <div key={m.name} className="su-panel su-mode">
                <h3 className="su-panel-title">{m.name}</h3>
                <div className="su-stat" aria-hidden>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span key={i} data-on={i < m.level ? "" : undefined} />
                  ))}
                </div>
                <p className="su-mode-sees">
                  <span className="sr-only">What SLOT1 sees: </span>
                  {m.sees}
                </p>
                <details className="su-more">
                  <summary>How it works</summary>
                  <dl>
                    <div>
                      <dt>What happens</dt>
                      <dd>{m.what}</dd>
                    </div>
                    <div>
                      <dt>What it needs</dt>
                      <dd>{m.needs}</dd>
                    </div>
                  </dl>
                </details>
              </div>
            ))}
          </div>
          <p className="su-note">
            The Twitch player and SLOT1’s analysis travel on different paths and can be several seconds apart. Times shown as estimated are estimates.
          </p>
          <p className="su-note">
            Frames include your webcam and overlays. To hide your camera from the AI, use Studio → Stream setup → “Hide your camera from the AI”; viewers still
            see the full stream.
          </p>
        </section>

        <section id="twitch" className="su-section" aria-labelledby="twitch-h">
          <h2 id="twitch-h" className="su-h2">
            Connecting Twitch
          </h2>
          <p className="su-intro">
            Choose Sign in with Twitch and use the account you broadcast from. Twitch asks you once for everything below, then Studio takes you
            straight to a one-minute OBS setup.
          </p>
          <div className="su-grid su-twitch">
            <div className="su-panel">
              <h3 className="su-panel-title flex flex-wrap items-center gap-2">
                What it asks Twitch for <span className="su-tag su-muted">All on connect, one approval</span>
              </h3>
              <ul className="su-perms">
                {PERMISSIONS.map((p) => (
                  <li key={p.scope} className="su-perm">
                    <code>{p.scope}</code>
                    <span className="su-tag su-gold">{p.feature}</span>
                    <p>{p.why}</p>
                  </li>
                ))}
              </ul>
              <p className="su-note">Connected before this? Studio shows a Grant the missing permissions button. One approval on Twitch adds what’s new.</p>
            </div>
            <div className="grid content-start gap-3">
              <div className="su-panel">
                <h3 className="su-panel-title">Someone else’s link never connects</h3>
                <p className="mt-2">Pasting another channel’s link opens a watch-only page, with no analysis and no recording.</p>
              </div>
              <div className="su-panel">
                <h3 className="su-panel-title">You can take it back</h3>
                <p className="mt-2">
                  Disconnect in Studio at any time, or remove SLOT1 in your Twitch settings under Connections. SLOT1 then stops using your channel.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="bot" className="su-section" aria-labelledby="bot-h">
          <h2 id="bot-h" className="su-h2">
            The chat bot
          </h2>
          <p className="su-intro">
            Type <code className="text-ivory">!slot1 help</code> in Twitch chat. SLOT1 replies briefly and only from what it has observed.
          </p>
          <div className="su-grid su-bot">
            <div className="su-phone">
              <p className="su-phone-status" aria-hidden>
                <span>SLOT1</span>
                <span>Twitch chat</span>
              </p>
              <h3 className="su-app-head">Anyone in chat</h3>
              <CommandList items={COMMANDS} />
            </div>
            <div className="su-phone">
              <p className="su-phone-status" aria-hidden>
                <span>SLOT1</span>
                <span>Twitch chat</span>
              </p>
              <h3 className="su-app-head" data-tone="coral">
                Creator and approved mods
              </h3>
              <CommandList items={CREATOR_COMMANDS} />
            </div>
            <div className="su-panel su-bot-rules">
              <h3 className="su-panel-title">House rules</h3>
              <ul className="su-rules">
                <li>When it hasn’t seen something, it says “I haven’t observed that.”</li>
                <li>Automatic commentary is off until the creator turns it on.</li>
                <li>The creator can stop the bot instantly from Studio.</li>
                <li>
                  Chat announcements (“SLOT1 is watching”, a link when an auto-clip is ready) are off until the creator turns them on in Studio → Bot and chat,
                  and there are never more than three in five minutes.
                </li>
                <li>The creator decides who may use !slot1 clip.</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="sources" className="su-section" aria-labelledby="sources-h">
          <h2 id="sources-h" className="su-h2">
            Video sources
          </h2>
          <VideoSources />
        </section>

        <section id="stream" className="su-section" aria-labelledby="stream-h">
          <h2 id="stream-h" className="su-h2">
            Stream once, go live everywhere
          </h2>
          <ol className="su-steps">
            <li className="su-step">
              <b>Open Stream setup</b>
              In Studio → Stream setup, choose <kbd>Set up OBS automatically</kbd>.
            </li>
            <li className="su-step">
              <b>Switch on OBS’s WebSocket</b>
              In OBS, open <kbd>Tools → WebSocket Server Settings</kbd> and tick <kbd>Enable WebSocket server</kbd>.
            </li>
            <li className="su-step">
              <b>Paste the password</b>
              Paste the server password into Studio. SLOT1 puts its one Server and Stream Key into OBS. The password stays in your browser and is never saved.
            </li>
            <li className="su-step">
              <b>Pick where to go live</b>
              Twitch needs no key: allow SLOT1 to forward once and it reads your stream key itself. For YouTube or Kick, paste that platform’s stream key (and
              Kick’s Stream URL).
            </li>
            <li className="su-step">
              <b>Go live in OBS</b>
              SLOT1 sends each platform the exact stream OBS sends, without re-encoding, and stops when you stop.
            </li>
          </ol>
          <p className="su-note">Prefer to do it by hand? Studio shows the same Server and Key with copy buttons.</p>
          <div className="su-tradeoff">
            <div className="su-panel">
              <h3 className="su-panel-title">Your upload stays at one stream</h3>
              <p className="mt-2">However many places you go live, OBS sends one stream, to SLOT1.</p>
            </div>
            <div className="su-panel">
              <h3 className="su-panel-title">The trade-off</h3>
              <p className="mt-2">
                Everything runs through SLOT1, so if SLOT1 has a problem, every platform goes quiet until it’s back. Platforms have their own rules on streaming
                to several places at once; check them before you go live everywhere.
              </p>
            </div>
          </div>
        </section>

        <section id="ai" className="su-section" aria-labelledby="ai-h">
          <h2 id="ai-h" className="su-h2">
            AI analysis
          </h2>
          <div className="su-grid su-ai">
            <div className="su-panel">
              <h3 className="su-panel-title flex flex-wrap items-center gap-2">
                With the AI switched on <span className="su-tag su-signal">Vision model</span>
              </h3>
              <p className="mt-2">
                Frames go to a vision-capable AI model. Its output must match a strict schema, events over time need several frames, and every entry links to
                the frames behind it.
              </p>
            </div>
            <div className="su-panel">
              <h3 className="su-panel-title">While it’s off</h3>
              <p className="mt-2">
                SLOT1 still reads on-screen text itself and measures the video (cuts, black screens, coverage), and it says the AI is off rather than
                guessing.
              </p>
            </div>
            <div className="su-panel">
              <h3 className="su-panel-title">Never claimed</h3>
              <ul className="su-rules">
                <li>A model’s certainty score is its own estimate, not a measured accuracy.</li>
                <li>An explosion isn’t treated as a kill.</li>
                <li>A loading screen isn’t treated as mission success.</li>
                <li>Nothing about hidden inventory, exact coordinates or controller input.</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="console-test" className="su-section" aria-labelledby="console-test-h">
          <h2 id="console-test-h" className="su-h2">
            PS5 console test
          </h2>
          <p className="su-intro">Run this once on a real PS5 to confirm how SLOT1’s chat replies behave on the console.</p>
          <details className="su-panel su-more mt-4">
            <summary>The checklist, {CONSOLE_TEST.length} steps</summary>
            <ol className="su-checklist">
              {CONSOLE_TEST.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        </section>

        <section id="limits" className="su-section" aria-labelledby="limits-h">
          <h2 id="limits-h" className="su-h2">
            What SLOT1 won’t do
          </h2>
          <ul className="su-wont">
            {WONT_DO.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>

        <div className="su-end">
          <p>Ready to try it?</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/studio" className="btn btn-coral">
              Open Studio
            </Link>
            <Link href="/los-santos" className="btn btn-ghost">
              See who’s live
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
