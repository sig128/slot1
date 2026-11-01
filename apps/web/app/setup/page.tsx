import type { Metadata } from "next";
import Link from "next/link";
import { SkylineArt } from "@/components/brand/SkylineArt";

export const metadata: Metadata = { title: "Setup and help" };

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 font-display text-[length:var(--text-display-md)] font-black leading-[0.92]">
      {children}
    </h2>
  );
}

const MODES = [
  {
    name: "Watch",
    what: "The official Twitch player and, if you open it, Twitch chat.",
    sees: "Nothing. The player is Twitch's; SLOT1 can't read its pixels.",
    needs: "Nothing. Works for any public channel.",
  },
  {
    name: "Chat only",
    what: "SLOT1 answers !slot1 commands and creates clips on request.",
    sees: "No gameplay. Asked what's happening, it says vision isn't connected.",
    needs: "The creator connects Twitch and the operator links the SLOT1 bot account.",
  },
  {
    name: "Clip analysis",
    what: "Clips are downloaded through Twitch's official clip download and analyzed frame by frame.",
    sees: "Only the clipped seconds, after Twitch has made the clip available.",
    needs: "The creator grants the extra clip permission (channel:manage:clips).",
  },
  {
    name: "Continuous analysis",
    what: "A live copy of the gameplay video arrives at SLOT1's authenticated ingest and is sampled continuously.",
    sees: "The frames it receives, a few seconds behind, with gaps disclosed.",
    needs: "OBS streaming to SLOT1, set up once in Studio → Stream setup. SLOT1 can pass the same stream on to Twitch, YouTube or Kick.",
  },
  {
    name: "Replay",
    what: "An uploaded recording is analyzed and played back with its evidence timeline.",
    sees: "The whole recording, at the sampling interval you chose.",
    needs: "A recording you own. Labeled REPLAY everywhere; never shown as live.",
  },
];

const CHECKLIST = [
  "On the PS5, link Twitch: press the Create button, choose Broadcast, pick Twitch and sign in.",
  "While live, open the broadcast card and turn on Display Chat in its overlay options. Note the Position you chose. Broadcast settings live under Settings > Captures and Broadcasts > Broadcasts.",
  "Go live with a game, then type !slot1 help in your Twitch chat from another device.",
  "Check whether SLOT1's reply appears in the PS5 chat overlay, and how long after it appears in Twitch chat.",
  "If you use Convert Broadcast Chat to Speech, check whether the reply is read aloud and how it sounds.",
  "Request !slot1 clip, wait for the follow-up message, and check that the link opens the right moment.",
  "Note the console firmware, broadcast quality setting and anything that didn't match. Until this is done, PS5 chat display stays marked as needing console verification.",
];

export default function SetupPage() {
  return (
    <article>
      <SkylineArt className="h-[30vh] min-h-[240px] w-full" />
      <div className="mx-auto max-w-[1600px] px-4 pb-24 sm:px-6 lg:px-10">
        <header className="relative z-10 -mt-10 max-w-[70ch]">
          <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">How SLOT1 works</h1>
          <p className="mt-5 text-[1.08rem] text-ivory-2">
            SLOT1 is a website and a Twitch chat bot. Nothing is installed on your PS5. Watching a broadcast and analyzing gameplay are separate things,
            and SLOT1 always tells you which one you’re getting.
          </p>
        </header>

        <nav aria-label="On this page" className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-y hairline py-3 text-sm text-ivory-2">
          {[
            ["ps5", "PS5 broadcasting"],
            ["modes", "What SLOT1 can see"],
            ["twitch", "Connecting Twitch"],
            ["bot", "The chat bot"],
            ["sources", "Video sources"],
            ["ai", "AI analysis"],
            ["console-test", "Console test"],
            ["limits", "What SLOT1 won't do"],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="hover:text-ivory">
              {label}
            </a>
          ))}
        </nav>

        <div className="mt-14 grid gap-16 lg:grid-cols-12">
          <div className="min-w-0 space-y-20 lg:col-span-8">
            <section className="space-y-4">
              <H2 id="ps5">PS5 broadcasting stays on the PS5</H2>
              <p className="max-w-[68ch] text-ivory-2">
                A stock PS5 broadcasts to Twitch with its built-in feature: press the Create button, choose Broadcast, pick Twitch and go live. Your
                viewers watch on Twitch, or on SLOT1, which shows Twitch’s own player.
              </p>
              <p className="max-w-[68ch] text-ivory-2">
                The PS5 sends one stream, to Twitch. It doesn’t send a second copy to SLOT1, and there is no setting on the console where you could enter a
                SLOT1 address. That’s why SLOT1 can show the broadcast without being able to see the gameplay.
              </p>
              <p className="max-w-[68ch] text-ivory-2">
                SLOT1’s chat replies are ordinary Twitch chat messages. If you turn on the PS5’s chat overlay, they may show on your TV along with other
                chat. That hasn’t been verified on a console yet, so treat it as unconfirmed.
              </p>
            </section>

            <section className="space-y-6">
              <H2 id="modes">What SLOT1 can see</H2>
              {/* Narrow screens: one block per mode instead of a four-column table. */}
              <dl className="divide-y divide-line border-y hairline sm:hidden">
                {MODES.map((m) => (
                  <div key={m.name} className="space-y-2 py-4 text-sm">
                    <dt className="font-display text-lg font-bold">{m.name}</dt>
                    <dd className="text-ivory-2">{m.what}</dd>
                    <dd className="text-ivory-2">
                      <span className="text-ivory-3">Sees: </span>
                      {m.sees}
                    </dd>
                    <dd className="text-ivory-3">Needs: {m.needs}</dd>
                  </div>
                ))}
              </dl>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-[0.78rem] text-ivory-3">
                    <tr className="border-b hairline">
                      <th className="py-2 pr-4 font-normal">Mode</th>
                      <th className="py-2 pr-4 font-normal">What happens</th>
                      <th className="py-2 pr-4 font-normal">What SLOT1 sees</th>
                      <th className="py-2 font-normal">What it needs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line align-top">
                    {MODES.map((m) => (
                      <tr key={m.name}>
                        <th scope="row" className="py-3 pr-4 font-display text-lg font-bold">
                          {m.name}
                        </th>
                        <td className="py-3 pr-4 text-ivory-2">{m.what}</td>
                        <td className="py-3 pr-4 text-ivory-2">{m.sees}</td>
                        <td className="py-3 text-ivory-3">{m.needs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="max-w-[68ch] text-sm text-ivory-3">
                The Twitch player and SLOT1’s analysis travel on different paths and can be several seconds apart. Times shown as estimated are estimates.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="twitch">Connecting Twitch</H2>
              <p className="max-w-[68ch] text-ivory-2">
                In Studio, choose Connect my Twitch and sign in with the account you broadcast from. SLOT1 asks only for what each feature needs: letting the
                SLOT1 bot into your chat and creating clips. Downloading clips for analysis is a separate permission you can add later.
              </p>
              <p className="max-w-[68ch] text-ivory-2">
                Pasting someone else’s channel link never connects it. It opens a watch-only page with no analysis and no recording.
              </p>
              <p className="max-w-[68ch] text-sm text-ivory-3">
                Running your own SLOT1? The README covers registering a Twitch app, redirect URLs, the public HTTPS address EventSub needs, and embed hostnames.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="bot">The chat bot</H2>
              <p className="max-w-[68ch] text-ivory-2">
                Type <code className="text-ivory">!slot1 help</code> in chat. SLOT1 replies briefly and only from what it has observed; when it hasn’t seen
                something it says “I haven’t observed that.” Automatic commentary is off until the creator turns it on, and the creator can stop the bot
                instantly from Studio.
              </p>
              <ul className="grid max-w-[68ch] gap-1 text-sm text-ivory-2 sm:grid-cols-2">
                {["now", "recap", "find <thing>", "ask <question>", "clip", "status", "pause / resume", "mute / unmute"].map((c) => (
                  <li key={c}>
                    <code className="text-ivory">!slot1 {c}</code>
                  </li>
                ))}
              </ul>
              <p className="max-w-[68ch] text-ivory-2">
                The creator and moderators they approve can also run SLOT1 from chat while they play:
              </p>
              <ul className="grid max-w-[68ch] gap-1 text-sm text-ivory-2">
                <li>
                  <code className="text-ivory">!slot1 record on / off</code>: save the stream to your SLOT1 library. The first time, it asks you to give your OK in Studio.
                </li>
                <li>
                  <code className="text-ivory">!slot1 autoclip on / off</code>: clip MISSION PASSED, WASTED and BUSTED moments automatically.
                </li>
                <li>
                  <code className="text-ivory">!slot1 relay</code>: where SLOT1 is forwarding your stream right now. Never any addresses or keys.
                </li>
              </ul>
              <p className="max-w-[68ch] text-sm text-ivory-3">
                Chat announcements (“SLOT1 is watching”, a link when an auto-clip is ready) are off until the creator turns them on in Studio → Bot and chat,
                and there are never more than three in five minutes.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="sources">Video sources</H2>
              <p className="max-w-[68ch] text-ivory-2">
                For continuous analysis, SLOT1 needs its own copy of the gameplay video. The common way is a capture card between the PS5 and your TV,
                with OBS on a computer sending to Twitch and to the SLOT1 ingest address from Studio. Each source has its own stream key, which you can revoke
                at any time.
              </p>
              <p className="max-w-[68ch] text-ivory-2">
                Without a relay, upload recordings as replays, or let SLOT1 analyze clips. Looped or test recordings sent over the live ingest stay labeled
                TEST / REPLAY.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="stream">Stream once, go live everywhere</H2>
              <p className="max-w-[68ch] text-ivory-2">
                In Studio → Stream setup, choose Set up OBS automatically. In OBS, open Tools → WebSocket Server Settings, tick Enable WebSocket server,
                and paste the server password into Studio. SLOT1 puts its one Server and Stream Key into OBS for you. The password stays in your browser
                and is never saved. Prefer to do it by hand? Studio shows the same Server and Key with copy buttons.
              </p>
              <p className="max-w-[68ch] text-ivory-2">
                Then add where you want to be live. Twitch needs no key: allow SLOT1 to forward once and it reads your Twitch stream key itself. For
                YouTube or Kick, paste that platform’s stream key (and Kick’s Stream URL). SLOT1 sends each one the exact stream OBS sends, without
                re-encoding, and stops when you stop.
              </p>
              <p className="max-w-[68ch] text-sm text-ivory-3">
                Your upload stays at one stream. The trade-off: everything runs through SLOT1, so if SLOT1 has a problem, every platform goes quiet until
                it’s back. Platforms have their own rules on streaming to several places at once; check them before you go live everywhere.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="ai">AI analysis</H2>
              <p className="max-w-[68ch] text-ivory-2">
                Frames go to a vision-capable model configured by whoever runs SLOT1. Its output must match a strict schema, events over time need several
                frames, and every entry links to the frames behind it. Without a configured model, SLOT1 still reads on-screen text locally and measures the
                video itself (cuts, black screens, coverage), and it says AI isn’t configured rather than guessing.
              </p>
              <p className="max-w-[68ch] text-sm text-ivory-3">
                A model’s certainty score is its own estimate, not a measured accuracy. An explosion isn’t treated as a kill, a loading screen isn’t treated
                as mission success, and nothing about hidden inventory, exact coordinates or controller input is ever claimed.
              </p>
            </section>

            <section className="space-y-4">
              <H2 id="console-test">Console test checklist</H2>
              <p className="max-w-[68ch] text-ivory-2">Run this once on a real PS5 to confirm how SLOT1’s chat replies behave on the console.</p>
              <ol className="max-w-[72ch] space-y-3">
                {CHECKLIST.map((step, i) => (
                  <li key={i} className="grid grid-cols-[2rem_1fr] gap-3 text-ivory-2">
                    <span className="tnum font-display text-xl font-bold text-apricot">{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="space-y-4">
              <H2 id="limits">What SLOT1 won’t do</H2>
              <ul className="max-w-[68ch] list-disc space-y-1 pl-5 text-ivory-2">
                <li>Install anything on a PS5, modify a console, or use exploits of any kind.</li>
                <li>Draw an overlay on your TV. Its only on-screen presence is ordinary Twitch chat.</li>
                <li>Read pixels from the Twitch player or scrape Twitch’s video internals.</li>
                <li>Rewind a live Twitch stream to an event. It shows the stored evidence or a clip instead.</li>
                <li>Pretend a replay or test recording is a live broadcast.</li>
              </ul>
            </section>
          </div>
          <aside className="min-w-0 lg:col-span-4">
            <div className="lg:sticky lg:top-24">
              <p className="font-display text-2xl font-bold">Ready to try it?</p>
              <p className="mt-2 text-sm text-ivory-2">Connect your channel or upload a recording in Studio.</p>
              <Link href="/studio" className="btn btn-coral mt-5">
                Open Studio
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </article>
  );
}
