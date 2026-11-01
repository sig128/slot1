import type { Metadata } from "next";
import Link from "next/link";
import { ContactRoute } from "@/components/legal/ContactRoute";
import { DataItem, LegalDocument, type LegalSection } from "@/components/legal/LegalDocument";
import { aiProcessors, LEGAL_LAST_UPDATED, LEGAL_LAST_UPDATED_ISO, legalConfig, type LegalConfig } from "@/lib/legal";
import { pageMetadata } from "@/lib/site";

// The operator's name, contact details and the AI services in use come from the server's
// settings at request time.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Privacy Policy",
    description:
      "What SLOT1 collects when you watch, sign in or stream, why, how long it's kept, who processes it, and how to access or delete it. No ads, no selling, no tracking cookies.",
    path: "/privacy",
  });
}

function operator(cfg: LegalConfig) {
  return cfg.nameIsDefault ? "SLOT1" : cfg.name;
}

function sections(cfg: LegalConfig): LegalSection[] {
  const ai = aiProcessors();
  const op = operator(cfg);
  return [
    {
      id: "who",
      title: "Who is responsible",
      body: (
        <>
          <p>
            {cfg.nameIsDefault ? (
              <>SLOT1 (“we”, “us”) is responsible for the personal information described in this policy (its “controller”).</>
            ) : (
              <>
                SLOT1 is operated by <strong>{cfg.name}</strong>
                {cfg.address ? <>, {cfg.address}</> : null}, which is responsible for the personal information described in this policy (its
                “controller”). “We” and “us” mean {cfg.name}.
              </>
            )}
          </p>
          <p>
            This policy covers the SLOT1 website, its Twitch chat bot and its streaming features (together, “SLOT1”). To reach us about privacy, use{" "}
            <ContactRoute cfg={cfg} topic="privacy" />.
          </p>
        </>
      ),
    },
    {
      id: "summary",
      title: "The short version",
      body: (
        <ul>
          <li>We don’t sell your personal information or share it for advertising. SLOT1 shows no ads and runs no ad trackers.</li>
          <li>Visitor statistics use no cookies. Visits are counted with an ID that changes every day and can’t be traced back to you.</li>
          <li>SLOT1’s only cookie keeps you signed in and protects forms. It is not used for tracking.</li>
          <li>Creators decide what is analyzed, recorded and public, how long it is kept, and can delete it at any time in Studio.</li>
          <li>SLOT1 receives a creator’s whole stream, including any webcam, overlays and microphone. It goes to an outside AI service only when the operator has switched one on; section 6 lists what is switched on right now.</li>
        </ul>
      ),
    },
    {
      id: "collect",
      title: "What we collect and why",
      body: (
        <>
          <h3>Everyone who visits</h3>
          <DataItem
            title="Server logs"
            what="Your IP address, the time, and the page or address your browser asked for. The streaming gateway logs the IP address of each connection in the same way."
            why="Keeping SLOT1 secure and working: spotting abuse and attacks, and fixing errors."
            kept="The logs rotate automatically. Each service keeps at most three files of 10 MB and overwrites the oldest, so entries usually disappear within days, sooner when the site is busy."
          />
          <DataItem
            title="Visitor statistics"
            what={
              <>
                For each page view: the time, the page path (without anything after “?” or “#”), the host name of the site you came from (for example{" "}
                <code>google.com</code>, never the full address), the device type (mobile, tablet or desktop), the browser family, and a visitor ID. While
                a page is open and visible, your browser sends a short heartbeat every 30 seconds so we can count how many people are on the site right
                now.
              </>
            }
            why="Knowing how many people use SLOT1 and which pages they use, without tracking anyone. This uses no cookies, no local storage and no fingerprinting."
            kept="Page views are deleted after 90 days; after that only daily totals remain. The “on the site now” count lives only in memory and expires within 5 minutes."
          />
          <p>
            <strong>How the visitor ID works.</strong> It is a SHA-256 hash of a random value, your IP address, your browser’s User-Agent and the site’s
            host name, shortened. The random value is new every day (UTC), is kept only in memory on our server and is deleted after 48 hours, so the
            same visitor gets a different ID every day and the ID can’t be reversed to an IP address. Your IP address and full User-Agent are never
            stored with your visits.
          </p>
          <p>
            <strong>Not counted at all:</strong> browsers that send Do Not Track or Global Privacy Control, known bots, and the operator’s admin pages.
          </p>
          <DataItem
            title="Twitch content on our pages"
            what="Watch pages show Twitch’s official player and chat, and pages show channel pictures and stream thumbnails from Twitch’s servers."
            why="So you can watch streams on SLOT1."
            keptLabel="Note"
            kept={
              <>
                When these load, Twitch receives your IP address and may set its own cookies. That is handled by Twitch under the{" "}
                <a href="https://legal.twitch.com/legal/privacy-notice/" target="_blank" rel="noreferrer noopener">
                  Twitch Privacy Notice
                </a>
                , not by us.
              </>
            }
          />

          <h3>If you sign in with Twitch</h3>
          <DataItem
            title="Your Twitch identity"
            what="Your Twitch user ID, login name, display name and profile picture address. SLOT1 never sees your Twitch password and doesn’t ask Twitch for your email address."
            why="Signing you in and showing your channel on SLOT1."
            kept="While your SLOT1 account exists."
          />
          <DataItem
            title="Twitch permissions and tokens"
            what="The permissions you granted (for example letting the SLOT1 bot into your chat, or creating clips) and the access tokens Twitch gives us for them. Tokens are encrypted (AES-256-GCM) and never sent to your browser."
            why="Doing what you asked for: bot replies, clips, forwarding to your Twitch channel."
            kept="Until you disconnect Twitch in Studio, when they are revoked at Twitch, or until Twitch revokes them."
          />
          <DataItem
            title="Your browser session"
            what="A record of your signed-in session. We store only a hash of the session cookie, with when it was created, last used and expires."
            why="Keeping you signed in and protecting forms against cross-site attacks."
            kept="30 days, then deleted automatically. Signing out deletes it immediately."
          />

          <h3>If you stream or upload as a creator</h3>
          <p>
            <strong>SLOT1 receives your whole stream, not just the game.</strong> Whatever your streaming software (for example OBS) sends is what SLOT1
            gets: the gameplay plus your webcam or facecam, overlays and alerts if they are in your scene, and the sound, including your microphone.
            That full picture and sound is what is analyzed, shown to viewers of public sessions, recorded, forwarded to other platforms you add and, when
            the operator has switched an AI service on, sampled and sent to it (section 6). You decide what is in your stream. People who can be seen
            or heard in it are part of your content, and you need their permission where the law requires it.
          </p>
          <DataItem
            title="Video and audio you send to SLOT1"
            what={
              <>
                The live stream your streaming software sends to SLOT1 (picture and sound, as described above), recordings you upload, and Twitch clips
                you let SLOT1 download. SLOT1 samples frames from the video (every 5 seconds by default) to analyze them, and keeps the frames each log
                entry cites as its evidence. Full recordings, and the rolling buffer used to cut clips, are kept only if you consent to recording in
                Studio.
              </>
            }
            why="Analyzing the stream, showing the live log with its evidence, live video for viewers, forwarding, replays, clips and recordings: the features you turn on."
            kept={
              <>
                Analysis, evidence frames, transcripts and moments: for the number of days you choose in Studio (30 by default, up to 365) after the
                session ends. Recordings: for the recording period you choose (14 days by default, up to 365). The rolling buffer keeps only the last
                few minutes (3 by default, at most 15) and is overwritten continuously. Instant replays are short-lived files deleted soon after their
                links expire.
              </>
            }
          />
          <DataItem
            title="Your streaming connection"
            what="The IP address your streaming software connects from, stored with the video source while it is connected."
            why="A record of where a stream key was used from, so misuse of a key can be investigated."
            kept="With the video source, until it is replaced by the next connection or the source is deleted."
          />
          <DataItem
            title="Analysis results"
            what="The log entries: what was observed, when, the on-screen text SLOT1 read, how it knows (read on screen, seen, heard, inferred, measured), and links to the evidence frames, which show the whole stream picture. With transcription switched on, the text of what is said on stream, including into your microphone. Corrections you make."
            why="The live log, search, moments and chat answers."
            kept="Same as the session they belong to (see above)."
          />
          <DataItem
            title="Your library"
            what="Clips, screenshots, renders and recordings you keep, your edit projects, captions, and whether each item is private, unlisted or public."
            why="The clipper studio and your public profile."
            kept="Until you delete them. Clips and screenshots stay when their session expires; deleting everything in Studio deletes the whole library."
          />
          <DataItem
            title="Forwarding destinations"
            what="The platforms you forward your stream to, their server addresses and your stream keys for them. Keys are encrypted (AES-256-GCM) and never shown again after you save them. For Twitch, SLOT1 reads your Twitch stream key from Twitch each time forwarding starts."
            why="Passing your stream on to the destinations you added."
            kept="Until you remove the destination or disconnect."
          />
          <DataItem
            title="Settings and records"
            what="Your channel settings, how much AI analysis your channel used (calls, frames, tokens and estimated cost), background job history and error messages."
            why="Running your channel the way you set it up, showing you what analysis costs, and troubleshooting."
            kept="While your SLOT1 account exists."
          />
          <DataItem
            title="Training data (only with your consent)"
            what="If you switch on training consent in Studio, sampled frames from your streams and the labels added to them, used to train SLOT1’s own GTA model."
            why="Improving SLOT1’s analysis. This is optional and off by default."
            kept="Switching consent off removes your frames from all future training sets; “Delete my training data” removes every frame and label right away. Copies already exported into a finished training set can’t be recalled, which the consent text says before you agree."
          />

          <h3>In Twitch chat</h3>
          <DataItem
            title="Chat commands"
            what="In channels where the creator switched the bot on, SLOT1 receives chat messages from Twitch. Messages that don’t start with “!” are dropped without being stored. For commands, SLOT1 records the sender’s Twitch user ID and login, the message ID, the command, a hash and the length of what followed it (not the text itself), and what SLOT1 did. If a viewer asks for a clip, their Twitch user ID is stored with the clip request."
            why="Answering commands, enforcing cooldowns and permissions, and preventing abuse."
            kept="While the channel is connected to SLOT1, or until the creator or the person asks us to delete it."
          />
          <p>The bot’s replies are ordinary public Twitch chat messages.</p>

          <h3>Questions and messages</h3>
          <DataItem
            title="Ask SLOT1"
            what="The question you type about a stream."
            why="Finding the matching evidence and, when an AI text model is switched on, phrasing the answer."
            kept="The question itself is not stored. We record only that an AI model was used and how much (for the creator’s usage figures)."
          />
          <DataItem
            title="The contact form"
            what="Your name (optional), your email address, the topic and your message."
            why="Answering you. To limit spam, a counter keyed by a hash of your IP address is kept for one hour."
            kept="Up to 24 months, or sooner if you ask us to delete it."
          />
        </>
      ),
    },
    {
      id: "bases",
      title: "Legal bases",
      body: (
        <>
          <p>If you are in the European Economic Area, the United Kingdom or Switzerland, we rely on these legal bases:</p>
          <ul>
            <li>
              <strong>Contract:</strong> providing the features you sign up for and switch on.
            </li>
            <li>
              <strong>Legitimate interests:</strong> security, preventing abuse, cookieless visitor statistics, improving SLOT1 and answering messages.
              You can object to these (see section 10).
            </li>
            <li>
              <strong>Consent:</strong> recording your stream and using it for training. You can withdraw consent at any time in Studio; that doesn’t
              affect what happened before.
            </li>
            <li>
              <strong>Legal obligation:</strong> when the law requires us to keep or hand over information.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and similar technologies",
      body: (
        <>
          <p>SLOT1 sets one cookie, and it is strictly necessary:</p>
          <div className="legal-item">
            <h4>slot1_session</h4>
            <dl>
              <div>
                <dt>Purpose</dt>
                <dd>Keeps you signed in, binds Twitch sign-in to your browser, and protects forms against cross-site request forgery.</dd>
              </div>
              <div>
                <dt>Lifetime</dt>
                <dd>30 days. It is HttpOnly (scripts can’t read it), Secure (sent only over HTTPS) and SameSite=Lax.</dd>
              </div>
            </dl>
          </div>
          <p>
            We don’t use analytics, advertising or social media cookies, and SLOT1’s pages don’t use local storage or similar technologies to track
            you. Twitch’s embedded player and chat may set Twitch’s own cookies (see section 3).
          </p>
        </>
      ),
    },
    {
      id: "processors",
      title: "Who processes your information",
      body: (
        <>
          <p>We use these service providers, only for the purposes described here:</p>
          <ul>
            <li>
              <strong>Hetzner Online GmbH</strong> hosts SLOT1’s server in its data center in Helsinki, Finland (EU), along with the server’s backups
              when they are switched on.
            </li>
            <li>
              <strong>Twitch</strong> (Twitch Interactive, Inc.) for sign-in, chat, clips and stream status, when you use those features.
            </li>
            <li>
              <strong>AI services, only when the operator switches them on.</strong>{" "}
              {ai.length > 0 ? (
                <>
                  Switched on right now:{" "}
                  {ai.map((p, i) => (
                    <span key={p.name}>
                      {i > 0 ? "; " : ""}
                      <strong>{p.name}</strong>, which {p.purpose}
                    </span>
                  ))}
                  . They receive the sampled frames, audio or evidence needed for that, not your account details. A sampled frame is the whole stream
                  picture, so it includes a creator’s webcam, overlays and alerts when those are in the stream, and audio includes the creator’s
                  microphone.
                </>
              ) : (
                <>
                  None is switched on right now: frames are analyzed only on SLOT1’s own server (on-screen text reading and video measurements). If the
                  operator switches one on, such as Anthropic or OpenAI for AI vision or a speech-to-text service, it will be listed here and receive only
                  the sampled frames, audio or evidence needed for that. A sampled frame is the whole stream picture, so it would include a creator’s
                  webcam, overlays and alerts when those are in the stream, and audio would include the creator’s microphone.
                </>
              )}
            </li>
            <li>
              <strong>Let’s Encrypt</strong> issues the site’s HTTPS certificates. It receives only the site’s domain name, no personal information.
            </li>
            <li>
              <strong>A GPU provider for training</strong>, only for frames from creators who consented to training. We will name it here before any
              such data is sent.
            </li>
          </ul>
          <p>
            When you forward your stream to Twitch, YouTube, Kick or another server, SLOT1 sends your whole stream there, exactly as it received it,
            because you asked it to; those platforms handle it under their own policies. Sharing a clip to TikTok, YouTube or Instagram happens in your own device’s share sheet:
            SLOT1 doesn’t send anything to those apps.
          </p>
          <p>
            We may disclose information when the law requires it, to protect people’s safety or SLOT1’s security, or as part of a merger or sale of
            SLOT1, in which case this policy continues to apply. We don’t sell or rent personal information.
          </p>
        </>
      ),
    },
    {
      id: "transfers",
      title: "International transfers",
      body: (
        <p>
          SLOT1’s data is stored in the EU (Finland). Twitch and AI services may process information in the United States or other countries. When
          personal information leaves the EEA, the UK or Switzerland, we rely on the safeguards the provider offers, such as the European Commission’s
          Standard Contractual Clauses or an adequacy decision (for example the EU–US Data Privacy Framework, where the provider takes part in it).
        </p>
      ),
    },
    {
      id: "retention",
      title: "How long we keep it",
      body: (
        <>
          <p>The periods for each kind of information are in section 3. In short:</p>
          <ul>
            <li>Stream analysis and evidence: your setting, 30 days by default. Recordings: your setting, 14 days by default.</li>
            <li>Library items, settings and forwarding destinations: until you delete them or your account.</li>
            <li>Page views: 90 days, then only daily totals. Contact messages: up to 24 months.</li>
            <li>Server logs: overwritten as they rotate, usually within days.</li>
            <li>
              Backups: when server backups are switched on, Hetzner keeps up to seven daily backups, so deleted information can remain in a backup for
              about a week before it is overwritten.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "choices",
      title: "Your choices in Studio",
      body: (
        <ul>
          <li>Make your channel, its analysis and each session or clip public or private.</li>
          <li>Give or withdraw consent to recording, set how long recordings and analysis are kept, and switch training consent on or off.</li>
          <li>Delete a single session, or delete every session’s media, frames, transcripts and analysis, and your library, at once.</li>
          <li>Disconnect Twitch, which revokes SLOT1’s Twitch tokens, removes you from On Air, turns the bot off and revokes your stream keys.</li>
          <li>
            To delete your SLOT1 account entirely, including your profile, settings and the records in section 3, use{" "}
            <ContactRoute cfg={cfg} topic="privacy" />.
          </li>
        </ul>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>
            <strong>Everywhere.</strong> You can ask us what personal information we hold about you, to correct it, to delete it, or to stop using it.
            We answer these requests wherever you live.
          </p>
          <p>
            <strong>EEA, UK and Switzerland.</strong> You have the right to access, rectification, erasure, restriction of processing, data portability
            and to object to processing based on legitimate interests, and to withdraw consent at any time. You can also complain to a data protection
            supervisory authority, in particular where you live or work (in the UK, the Information Commissioner’s Office).
          </p>
          <p>
            <strong>United States.</strong> Depending on your state (for example California under the CCPA as amended by the CPRA), you may have the
            right to know what personal information we collect and how we use it, to get a copy, to correct it and to delete it. We don’t sell
            personal information or share it for cross-context behavioral advertising, and we don’t use sensitive personal information to infer
            characteristics about you. We won’t treat you differently for using your rights. In the last 12 months, SLOT1 collected identifiers (such
            as Twitch user IDs, login names and IP addresses), internet activity (pages visited, counted without cookies) and, from creators, the
            audio and video they chose to send. An authorized agent may make a request for you.
          </p>
          <p>
            <strong>How to ask.</strong> Use <ContactRoute cfg={cfg} topic="privacy" />. We may ask you to confirm the request by signing in with the
            Twitch account it concerns. We reply within one month, or within the time your local law sets (for example 45 days in California), and
            tell you if we need longer.
          </p>
        </>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: (
        <p>
          SLOT1 is not for children under 13, and Twitch’s own age rules apply to everyone who signs in with Twitch. Where local law sets a higher age
          for consenting to online services (up to 16 in some European countries), people under that age need a parent’s or guardian’s consent. If we
          learn that a child under 13 has given us personal information, we delete it.
        </p>
      ),
    },
    {
      id: "security",
      title: "Security",
      body: (
        <p>
          SLOT1 is served only over HTTPS. Twitch tokens and stream keys are encrypted at rest, and session IDs and SLOT1 stream keys are stored only
          as hashes. Access to the servers is limited to the operator. No system is perfectly secure; if a breach affects your information, we will
          tell you and the authorities as the law requires.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: (
        <p>
          When this policy changes, the date at the top changes too. For significant changes we will show a notice on the site before they take
          effect. The current version is always at <Link href="/privacy">/privacy</Link>.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions or requests about privacy: use <ContactRoute cfg={cfg} topic="privacy" />.{" "}
          {!cfg.nameIsDefault ? (
            <>
              {op}
              {cfg.address ? <>, {cfg.address}</> : null}.
            </>
          ) : null}
        </p>
      ),
    },
  ];
}

export default function PrivacyPage() {
  const cfg = legalConfig();
  return (
    <LegalDocument
      title="Privacy Policy"
      updated={LEGAL_LAST_UPDATED}
      updatedIso={LEGAL_LAST_UPDATED_ISO}
      intro={
        <p>
          SLOT1 is a companion for GTA streams on Twitch: a website with a live log of what happens in a stream, a chat bot, and tools for creators.
          This policy explains what personal information SLOT1 handles, why, for how long, who else processes it, and what you can do about it.
        </p>
      }
      sections={sections(cfg)}
    />
  );
}
