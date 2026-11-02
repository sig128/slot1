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
    name: "Auto-clips",
    body: "Big moments are cut into clips while you play. Trim, caption and share them to TikTok, YouTube or Instagram from your phone.",
    href: "/gta-clips",
    cta: "Make GTA clips for TikTok",
  },
  {
    name: "Instant replay",
    body: "Missed it? Jump back a few seconds while the stream is still live. Every timestamp in the log jumps the video to that second.",
    href: "/los-santos",
    cta: "Watch a live stream",
  },
  {
    name: "The live log",
    body: "What SLOT1 saw, as it happens: missions, results, crashes, chases. Each line links to its frames and says how SLOT1 knows.",
    href: "/setup#ai",
    cta: "How the AI works",
  },
  {
    name: "Moments",
    body: "MISSION PASSED, WASTED, BUSTED: the big moments from public streams, saved and searchable.",
    href: "/moments",
    cta: "Search moments",
  },
  {
    name: "Live video",
    body: "Watch SLOT1’s own copy of a stream, usually under a second behind the creator. The player shows its own estimate.",
    href: "/los-santos",
    cta: "See who’s live",
  },
  {
    name: "Stream everywhere",
    body: "Stream once from OBS and SLOT1 sends the same stream on to Twitch, YouTube and Kick.",
    href: "/setup#stream",
    cta: "Set it up",
  },
  {
    name: "Los Santos right now",
    body: "Every public stream SLOT1 is watching, on one page. Flip between them with the radio wheel.",
    href: "/los-santos",
    cta: "See who’s live",
  },
  {
    name: "The chat bot",
    body: "Type !slot1 now, recap, find, ask or clip in Twitch chat. It answers only from what it saw, and says so when it hasn’t seen something.",
    href: "/setup#bot",
    cta: "Bot commands",
  },
];

export interface Step {
  title: string;
  body: string;
  /** Words shown in the highlight colour, like the key words in a game's objective text. */
  keys: string[];
}

export const STEPS: Step[] = [
  {
    title: "Stream GTA like you always do",
    body: "Go live from OBS and send the stream to SLOT1. Studio sets it up in one click. Connect Twitch too and the chat bot joins your stream.",
    keys: ["OBS", "SLOT1", "Twitch"],
  },
  {
    title: "SLOT1’s AI watches along",
    body: "Live, while you play. It reads what’s on screen and spots the big moments: MISSION PASSED, WASTED, crashes and chases.",
    keys: ["reads what’s on screen", "big moments"],
  },
  {
    title: "You get the good stuff",
    body: "Auto-clips, instant replays and highlights, ready to share. Go live on Twitch, YouTube and Kick at the same time.",
    keys: ["Auto-clips", "instant replays", "highlights"],
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
    a: "Frames from the creator's stream, sampled every few seconds. A frame is the whole picture the creator sends, so it includes their webcam and overlays if those are in the stream, unless the creator hides them: in Studio, a creator can draw a box over their webcam, and SLOT1 blacks that box out of every frame before anything analyzes it. On-screen text reading, AI vision, the evidence frames SLOT1 keeps and “What the AI sees” never get what's inside; viewers still see the full stream. It only works while the camera stays inside the box. SLOT1 reads on-screen text such as mission titles and MISSION PASSED on its own server, and an AI vision model describes the gameplay when this site has one switched on. Every entry must point to real frames, and anything about motion needs several. SLOT1's own GTA model is still being trained and isn't used for the log yet.",
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
    q: "How is SLOT1 training its own GTA AI?",
    a: "Only with gameplay from creators who opt in, in Studio under GTA model. It learns from frames of their streams: missions, places, vehicles and moments. Switching it off stops collection and removes those frames from future training sets; copies already used in a training run can't be recalled. SLOT1's own GTA model is still being trained and isn't used for the log yet.",
  },
  {
    q: "Does SLOT1 work with GTA VI?",
    a: "Not yet. SLOT1 supports GTA V and GTA Online streams today, and it is getting ready to learn GTA VI's world as soon as players stream it.",
  },
  {
    q: "Is SLOT1 affiliated with Rockstar Games or Twitch?",
    a: "No. SLOT1 is an independent project, not endorsed or sponsored by Rockstar Games, Take-Two Interactive, Sony or Twitch. Grand Theft Auto is a trademark of Take-Two Interactive.",
  },
];
