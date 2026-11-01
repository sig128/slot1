import type { Metadata } from "next";
import Link from "next/link";
import { ContactRoute } from "@/components/legal/ContactRoute";
import { LegalDocument, type LegalSection } from "@/components/legal/LegalDocument";
import { LEGAL_LAST_UPDATED, LEGAL_LAST_UPDATED_ISO, legalConfig, type LegalConfig } from "@/lib/legal";
import { pageMetadata } from "@/lib/site";

// The operator's name, address and governing law come from the server's settings at request time.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Terms of Service",
    description:
      "The rules for using SLOT1: accounts, what creators stream, the licence SLOT1 needs, AI output, forwarding to other platforms, clips, copyright complaints and liability.",
    path: "/terms",
  });
}

function sections(cfg: LegalConfig): LegalSection[] {
  const we = cfg.nameIsDefault ? "SLOT1" : cfg.name;
  const law = cfg.governingLaw;
  return [
    {
      id: "agreement",
      title: "This agreement",
      body: (
        <>
          <p>
            These terms are an agreement between you and {cfg.nameIsDefault ? <>the operator of SLOT1</> : <strong>{cfg.name}</strong>}
            {cfg.address ? <> ({cfg.address})</> : null} (“SLOT1”, “we”, “us”) about your use of the SLOT1 website, its Twitch chat bot and its
            streaming features (together, the “service”). By using the service you agree to them. If you use SLOT1 for a business or a team, you
            confirm that you may accept these terms on its behalf.
          </p>
          <p>
            The <Link href="/privacy">Privacy Policy</Link> explains how we handle personal information and is part of these terms.
          </p>
        </>
      ),
    },
    {
      id: "service",
      title: "The service",
      body: (
        <>
          <p>
            SLOT1 is a companion for GTA streams. It shows Twitch streams with a log of what SLOT1 observed in the gameplay, lets creators send their
            stream to SLOT1 for analysis and live video, offers instant replays, moments, a clipper and a chat bot, and can forward a creator’s stream
            to other platforms.
          </p>
          <p>
            Some features depend on what the operator has switched on, such as an AI vision model or speech-to-text. SLOT1 shows what is and isn’t
            available instead of pretending.
          </p>
        </>
      ),
    },
    {
      id: "eligibility",
      title: "Who can use SLOT1",
      body: (
        <>
          <p>
            You must be at least 13 years old and old enough to use Twitch where you live. Where local law sets a higher age for agreeing to online
            services, you need a parent’s or guardian’s permission until you reach it.
          </p>
          <p>
            Signing in uses your Twitch account. Everything you do on Twitch through SLOT1, including the bot’s messages in your chat and clips it
            creates, is also subject to Twitch’s{" "}
            <a href="https://legal.twitch.com/legal/terms-of-service/" target="_blank" rel="noreferrer noopener">
              Terms of Service
            </a>{" "}
            and Community Guidelines. Keep your Twitch account and your SLOT1 stream keys secure; you are responsible for what happens with them.
          </p>
        </>
      ),
    },
    {
      id: "creators",
      title: "Your content as a creator",
      body: (
        <>
          <p>
            You keep all rights you have in what you stream, upload, record and clip (“your content”). Your content is everything your streaming
            software sends to SLOT1: the gameplay and also your webcam or facecam, overlays, alerts and microphone audio, plus anyone who can be seen
            or heard in it. You decide what goes into it. You are responsible for it, and you confirm that you have the rights and permissions needed to
            send it to SLOT1 and to make it public. That includes:
          </p>
          <ul>
            <li>
              following the game publisher’s policies for videos and streams of their games. For GTA, that is Rockstar Games’ policy on video content.
            </li>
            <li>having the rights to any music, video or other material in your stream.</li>
            <li>having permission from other people who can be seen or heard in your stream where the law requires it.</li>
          </ul>
          <p>You choose what is public. Nothing you send is public until you switch it on in Studio.</p>
        </>
      ),
    },
    {
      id: "licence",
      title: "The licence SLOT1 needs",
      body: (
        <>
          <p>
            To run the service you give SLOT1 a worldwide, non-exclusive, royalty-free licence to host, store, copy, process, analyze, transcode,
            display and transmit your content. It covers only what is needed for the features you switch on and only as your settings allow, for
            example analyzing your stream, showing a public clip on your profile, playing your live video to viewers of a public session, or
            forwarding your stream to destinations you added.
          </p>
          <p>
            Your content is used to train SLOT1’s own model only if you switch on training consent, and you can switch it off at any time.
          </p>
          <p>
            The licence ends when you delete the content, except for copies in backups until they are overwritten (about a week), copies other people
            already made of content you made public, and anything we must keep by law.
          </p>
        </>
      ),
    },
    {
      id: "conduct",
      title: "Acceptable use",
      body: (
        <>
          <p>Whether you watch, chat or stream, don’t use SLOT1 to:</p>
          <ul>
            <li>break the law, or share content that is illegal, sexually exploits anyone, or promotes violence against real people;</li>
            <li>harass, threaten or impersonate anyone, or post hateful content;</li>
            <li>send or publish content you don’t have the rights to;</li>
            <li>try to get around access controls, see other people’s private sessions or data, or probe, overload or attack SLOT1’s systems;</li>
            <li>scrape the service in ways that ignore robots.txt or put unreasonable load on it, or automate the bot, questions or forms to flood them;</li>
            <li>upload malware, or misuse stream keys or another person’s account;</li>
            <li>break Twitch’s rules or the rules of any platform you forward to.</li>
          </ul>
          <p>Creators control the bot in their own channel and can stop it at any time from Studio.</p>
        </>
      ),
    },
    {
      id: "ai",
      title: "AI output",
      body: (
        <>
          <p>
            SLOT1’s log, chat answers, moments and automatic clips are produced by software, including AI models. They can be wrong, incomplete or
            late. Each log entry links to the frames it is based on and says how SLOT1 knows it, so you can check it. A model’s confidence score is
            its own estimate, not a measured accuracy.
          </p>
          <p>
            Don’t rely on SLOT1’s output for decisions that matter, such as accusations against a player, bets or disputes. If an entry is wrong,
            creators can correct it in their session.
          </p>
        </>
      ),
    },
    {
      id: "forwarding",
      title: "Forwarding your stream",
      body: (
        <p>
          When you add a destination, you ask SLOT1 to pass the stream it receives from you on to that platform, using the stream key you entered or,
          for Twitch, the key Twitch gives SLOT1 with your permission. You are responsible for following each platform’s rules, including rules about
          streaming to several platforms at once and any exclusivity agreement you have. If SLOT1 has a problem, forwarding stops too. SLOT1 isn’t
          responsible for what a platform does with your stream or your account there.
        </p>
      ),
    },
    {
      id: "sharing",
      title: "Clips and sharing",
      body: (
        <p>
          Share buttons open your device’s share sheet. Posting to TikTok, YouTube, Instagram or anywhere else happens in those apps, under their
          terms, and you are responsible for what you post. Anyone can view and share content you make public, and copies others have made can’t be
          recalled when you delete the original.
        </p>
      ),
    },
    {
      id: "third-parties",
      title: "Other services",
      body: (
        <p>
          SLOT1 works with services we don’t control, such as Twitch, YouTube, Kick, OBS and, when switched on, AI providers. Their terms and privacy
          policies apply to your use of them, and SLOT1 can’t guarantee that they stay available or keep working the same way.
        </p>
      ),
    },
    {
      id: "beta",
      title: "Beta, availability and changes",
      body: (
        <p>
          SLOT1 is in beta. Features may change, break or be removed, and there is no guaranteed uptime. Keep your own copies of anything important;
          recordings and analysis are deleted when their retention period ends.
        </p>
      ),
    },
    {
      id: "fees",
      title: "Fees",
      body: (
        <p>
          SLOT1 is free to use right now. If we introduce paid features, we will tell you in advance and show the price clearly, and we won’t charge
          you anything unless you agree to it.
        </p>
      ),
    },
    {
      id: "copyright",
      title: "Copyright complaints",
      body: (
        <>
          <p>
            If you believe content on SLOT1 infringes your copyright, send a notice through <ContactRoute cfg={cfg} topic="copyright" />. Include:
          </p>
          <ul>
            <li>the work you believe is infringed, and the address (URL) of the material on SLOT1;</li>
            <li>your name and contact details;</li>
            <li>a statement that you believe in good faith the use isn’t authorized by the owner, its agent or the law;</li>
            <li>
              a statement that the information in your notice is accurate and that you are the owner or authorized to act for the owner, with your
              physical or electronic signature.
            </li>
          </ul>
          <p>
            We remove or disable material that is the subject of a valid notice and tell the creator, who can send a counter-notice if they believe it
            was removed by mistake. We close the accounts of repeat infringers.
          </p>
        </>
      ),
    },
    {
      id: "termination",
      title: "Suspension and ending",
      body: (
        <>
          <p>
            You can stop using SLOT1 at any time. In Studio you can disconnect Twitch and delete your content; to delete your account entirely, use{" "}
            <ContactRoute cfg={cfg} topic="support" />.
          </p>
          <p>
            We may suspend or remove content, features or accounts that break these terms or the law, or to protect people or the service. Where it is
            reasonable and lawful, we will tell you why and give you a chance to respond. Sections that by their nature should continue (for example
            the licence for copies already shared, disclaimers and liability) continue after the agreement ends.
          </p>
        </>
      ),
    },
    {
      id: "disclaimers",
      title: "Disclaimers",
      body: (
        <p>
          To the extent the law allows, the service is provided “as is” and “as available”, without warranties of any kind, including that it will be
          accurate, uninterrupted or fit for a particular purpose. If you are a consumer, you keep the rights that your local law gives you and that
          can’t be excluded by contract.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <>
          <p>
            To the extent the law allows, {we} is not liable for indirect, incidental, special or consequential damages, or for lost profits, revenue,
            data or audience, arising from the service. Our total liability for all claims about the service is limited to the greater of what you paid
            us in the 12 months before the claim and 100 US dollars (or the equivalent in your currency).
          </p>
          <p>
            Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud, for gross negligence or willful
            misconduct, or any other liability that can’t be limited by law. If you are a consumer in the EU, the EEA or the UK, we are responsible for
            foreseeable loss caused by our breach of these terms or our failure to use reasonable care and skill.
          </p>
        </>
      ),
    },
    {
      id: "indemnity",
      title: "Indemnity",
      body: (
        <p>
          If you use SLOT1 for a business, or as a creator, and someone makes a claim against us because of your content or your breach of these
          terms, you will cover our reasonable costs and losses from that claim. This doesn’t apply to consumers where the law doesn’t allow it.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: (
        <>
          <p>
            {law ? (
              <>These terms are governed by the laws of {law}, without regard to its conflict-of-laws rules.</>
            ) : (
              <>These terms are governed by the laws of the place where the operator of SLOT1 is established, without regard to conflict-of-laws rules.</>
            )}{" "}
            If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and you may bring a claim in the
            courts there.
          </p>
          <p>
            Before going to court, please contact us through <ContactRoute cfg={cfg} topic="general" /> so we can try to resolve the issue.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms. The date at the top always shows the current version. For significant changes we will show a notice on the site
          before they take effect. If you keep using SLOT1 after that, the new terms apply; if you don’t agree, stop using SLOT1 and delete your
          content.
        </p>
      ),
    },
    {
      id: "general",
      title: "General",
      body: (
        <p>
          These terms and the Privacy Policy are the whole agreement between you and us about the service. If a part of them is found unenforceable,
          the rest still applies. Not enforcing a right isn’t a waiver of it. We may transfer this agreement to a successor that continues the
          service; you may not transfer it without our consent. If these terms are translated, the English version applies.
        </p>
      ),
    },
    {
      id: "trademarks",
      title: "Trademarks and affiliation",
      body: (
        <p>
          SLOT1 is independent and is not affiliated with, endorsed by or sponsored by Rockstar Games, Take-Two Interactive, Sony Interactive
          Entertainment or Twitch. Grand Theft Auto, GTA and related marks are trademarks of Take-Two Interactive Software, Inc. PlayStation and PS5 are
          trademarks of Sony Interactive Entertainment Inc. Twitch is a trademark of Twitch Interactive, Inc. Other names belong to their owners.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms: use <ContactRoute cfg={cfg} topic="general" />.
          {!cfg.nameIsDefault ? (
            <>
              {" "}
              {cfg.name}
              {cfg.address ? <>, {cfg.address}</> : null}.
            </>
          ) : null}
        </p>
      ),
    },
  ];
}

export default function TermsPage() {
  const cfg = legalConfig();
  return (
    <LegalDocument
      title="Terms of Service"
      updated={LEGAL_LAST_UPDATED}
      updatedIso={LEGAL_LAST_UPDATED_ISO}
      intro={<p>These are the rules for using SLOT1, in plain language. Please read them before you sign in or stream.</p>}
      sections={sections(cfg)}
    />
  );
}
