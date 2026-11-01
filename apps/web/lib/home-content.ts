/**
 * The home page's explanatory copy, shared by the page and its structured data (the FAQ
 * answers in JSON-LD must match what visitors read). Only features that exist are listed, and
 * each says what it needs.
 */

export interface Feature {
  name: string;
  body: string;
  href: string;
  cta: string;
}

export const FEATURES: Feature[] = [
  {
    name: "The live log",
    body: "A running record of what SLOT1 saw: mission titles, results, crashes, chases. Every entry links to its frames and says whether it was read on screen, seen, heard or inferred.",
    href: "/setup#ai",
    cta: "How the AI works",
  },
  {
    name: "SLOT1 live video",
    body: "When a creator streams to SLOT1, viewers watch its own copy over WebRTC, typically under a second behind the creator’s upload. The player shows its own estimate.",
    href: "/demo",
    cta: "Watch the demo",
  },
  {
    name: "Instant replay",
    body: "Replay a moment seconds after it happened while the stream is still live. Every timestamp in the log jumps the video to that second.",
    href: "/demo",
    cta: "Try it on the demo",
  },
  {
    name: "Moments",
    body: "MISSION PASSED, WASTED, BUSTED: the big moments SLOT1 read on screen, saved and searchable across public streams.",
    href: "/moments",
    cta: "Search moments",
  },
  {
    name: "Clipper studio",
    body: "Recording, screenshots and automatic clips of big moments, with a trim-and-caption editor in the browser. Send a finished clip to TikTok, YouTube or Instagram from your phone’s share sheet.",
    href: "/studio#library",
    cta: "Open Studio",
  },
  {
    name: "Stream everywhere",
    body: "Stream once from OBS. SLOT1 passes the same stream on to Twitch, YouTube and Kick without re-encoding it.",
    href: "/setup#stream",
    cta: "Set it up",
  },
  {
    name: "Los Santos right now",
    body: "Every public stream SLOT1 is watching on one page, with what each one is doing this minute. Flip between them with the radio wheel.",
    href: "/los-santos",
    cta: "See who’s live",
  },
  {
    name: "The chat bot",
    body: "!slot1 now, recap, find, ask and clip in Twitch chat. It answers only from what it observed, and says so when it hasn’t seen something.",
    href: "/setup#bot",
    cta: "Bot commands",
  },
];

export const STEPS: { title: string; body: string }[] = [
  {
    title: "Connect Twitch",
    body: "Sign in with the Twitch account you stream from. SLOT1 asks only for the permissions each feature needs.",
  },
  {
    title: "Send your stream",
    body: "Studio sets up OBS in one click. From a PS5 that means a capture card and OBS on a computer: the console on its own can only stream to Twitch or YouTube.",
  },
  {
    title: "SLOT1 watches",
    body: "It samples frames every few seconds, reads on-screen text on its own server, and describes the gameplay with an AI vision model when this site has one switched on.",
  },
  {
    title: "Viewers watch, you clip",
    body: "Your page shows the stream with the log beside it. Replay, clip and share from Studio, or straight from chat.",
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Is SLOT1 free?",
    a: "Yes, while SLOT1 is in beta. If paid features come later, you will see the price before anything is charged.",
  },
  {
    q: "Does SLOT1 work with a PS5?",
    a: "The chat bot works with any Twitch stream, including one from a PS5. To analyze the gameplay, SLOT1 needs its own copy of the video. The usual setup is a capture card and OBS on a computer, which SLOT1 configures in one click. A PS5 on its own can only stream to Twitch or YouTube.",
  },
  {
    q: "Can SLOT1 analyze any Twitch stream?",
    a: "No. It only analyzes video that a creator sends it, or clips and recordings they own. Pasting someone else's channel opens a watch-only page with Twitch's player and no analysis.",
  },
  {
    q: "What does the AI actually see?",
    a: "Frames from the creator's video, sampled every few seconds. SLOT1 reads on-screen text such as mission titles and MISSION PASSED on its own server, and an AI vision model describes the gameplay when this site has one switched on. Every entry must point to real frames, and anything about motion needs several. SLOT1's own GTA model is still being trained and isn't used for the log yet.",
  },
  {
    q: "How close to live is it?",
    a: "SLOT1's own player streams over WebRTC and is typically under a second behind the creator's upload; the player shows its own estimate. The log runs a few seconds behind the picture, because frames are analyzed after they arrive.",
  },
  {
    q: "Can I stream to Twitch, YouTube and Kick at the same time?",
    a: "Yes. Send one stream to SLOT1 from OBS and add Twitch, YouTube or Kick in Studio. SLOT1 passes the same stream on without re-encoding it. Each platform has its own rules about streaming to several places at once, so check them first.",
  },
  {
    q: "Who can see my streams and clips?",
    a: "Nothing is public until you switch it on. You choose whether your channel, its analysis, recordings and each clip are public, and how long recordings are kept. You can delete everything from Studio at any time.",
  },
  {
    q: "Is SLOT1 affiliated with Rockstar Games or Twitch?",
    a: "No. SLOT1 is an independent project, not endorsed or sponsored by Rockstar Games, Take-Two Interactive, Sony or Twitch. Grand Theft Auto is a trademark of Take-Two Interactive.",
  },
];
