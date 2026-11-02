/**
 * The clipping guides: SEO landing pages for people who make GTA clips for TikTok, YouTube Shorts
 * and Instagram Reels, by platform (/gta-clips, /gta-clips/ps5, /gta-clips/xbox, /gta-clips/pc)
 * and for GTA VI (/gta-6). Pure data, unit tested (tests/unit/clip-guides.test.ts): every claim
 * here is something SLOT1 does today, or a console feature as the console makers document it
 * (PlayStation: capture-ps5-gameplay-screenshots and ps5-game-captures-ps-app support pages).
 */

export interface GuideLink {
  path: string;
  label: string;
  hint: string;
}

export interface GuideStep {
  title: string;
  body: string;
}

export interface GuidePanel {
  title: string;
  tag?: string;
  body: string;
  link?: { path: string; label: string };
}

export interface GuideSection {
  id: string;
  heading: string;
  intro?: string;
  steps?: GuideStep[];
  panels?: GuidePanel[];
  note?: string;
}

export interface GuideFaq {
  q: string;
  a: string;
}

export interface ClipGuide {
  slug: "gta-clips" | "ps5" | "xbox" | "pc" | "gta-6";
  path: string;
  /** <title> (the layout adds " — SLOT1"). */
  title: string;
  /** Meta description: 160 characters at most. */
  description: string;
  h1: string;
  lede: string;
  /** Breadcrumb trail after Home. */
  trail: { name: string; path: string }[];
  /** The short answer at the top: the routes, side by side. */
  routes?: GuidePanel[];
  sections: GuideSection[];
  faq: GuideFaq[];
  related: GuideLink[];
  /** The share card. Plain letters only: the card's font has no arrows or middle dots. */
  card: { title: string; line: string };
}

/** Steps every route ends with, once the video is in SLOT1. */
const UPLOAD_STEP: GuideStep = {
  title: "Upload it to SLOT1",
  body: "Open slot1.fun (it works on a phone), sign in with Twitch, then go to Studio → Video sources → Upload and analyze.",
};
const CUT_STEP: GuideStep = {
  title: "Cut it vertical and export",
  body: "SLOT1 marks the moments it reads on screen. Open one in the editor, frame it 9:16, add a caption, and export it for TikTok, YouTube Shorts or Instagram Reels.",
};

const FAQ_FREE: GuideFaq = {
  q: "Is SLOT1 free?",
  a: "Yes. Uploading, editing and exporting clips is free, with no watermark on your exports. Rewards for creators are planned but not live yet.",
};
const FAQ_FILES: GuideFaq = {
  q: "Which video files can I upload?",
  a: "MP4, MOV, M4V, MKV, WebM, TS, FLV and AVI: the files consoles, phones and recording apps make.",
};
const FAQ_OWN_VIDEO: GuideFaq = {
  q: "Can I clip someone else's stream?",
  a: "No. SLOT1 only analyzes video you own: your uploads and your own streams. Pasting another channel's link opens a watch-only page with no analysis.",
};
const FAQ_TWITCH: GuideFaq = {
  q: "Do I need a Twitch account?",
  a: "You sign in with Twitch, which is free. You don't have to stream on Twitch to upload, edit and export clips.",
};

const RELATED_ALL: Record<ClipGuide["slug"], GuideLink> = {
  "gta-clips": { path: "/gta-clips", label: "GTA clips for TikTok", hint: "The whole workflow, every platform" },
  ps5: { path: "/gta-clips/ps5", label: "GTA clips on PS5", hint: "Create button, PlayStation App, capture card" },
  xbox: { path: "/gta-clips/xbox", label: "GTA clips on Xbox", hint: "Share button, Xbox app, capture card" },
  pc: { path: "/gta-clips/pc", label: "Auto-clips on PC", hint: "OBS to SLOT1, clipped while you play" },
  "gta-6": { path: "/gta-6", label: "GTA 6 clips", hint: "Get ready before 19 November 2026" },
};
const related = (...slugs: ClipGuide["slug"][]) => slugs.map((s) => RELATED_ALL[s]);

const HUB: ClipGuide = {
  slug: "gta-clips",
  path: "/gta-clips",
  title: "GTA clips for TikTok, Shorts and Reels",
  description:
    "Turn GTA gameplay into vertical clips for TikTok, YouTube Shorts and Instagram Reels. SLOT1 finds MISSION PASSED, WASTED and BUSTED for you. PS5, Xbox and PC.",
  h1: "GTA clips for TikTok, Shorts and Reels",
  lede: "Play GTA and let SLOT1 do the clipping work: it finds the moments worth posting, cuts them vertical, and exports them sized for TikTok, YouTube Shorts and Instagram Reels. Footage from PS5, Xbox and PC all works.",
  trail: [{ name: "GTA clips", path: "/gta-clips" }],
  sections: [
    {
      id: "how",
      heading: "From gameplay to a posted clip",
      steps: [
        { title: "Get your footage to SLOT1", body: "Upload a recording from your console, phone or PC. Or stream to SLOT1 from OBS, and it clips while you play." },
        { title: "SLOT1 finds the moments", body: "It reads GTA's own on-screen text, so MISSION PASSED, WASTED and BUSTED land on your timeline at the second they happened." },
        { title: "Cut it vertical", body: "Open a moment in the editor: trim it, frame it for 9:16, and add captions, text, sounds and effects." },
        { title: "Export and post", body: "Pick TikTok, YouTube Shorts or Instagram Reels and SLOT1 renders the file in that shape. Download it to your phone and post it." },
      ],
    },
    {
      id: "platforms",
      heading: "Pick your platform",
      intro: "The clipping is the same everywhere. What changes is how the video reaches SLOT1.",
      panels: [
        {
          title: "PS5",
          tag: "No extra hardware",
          body: "Save a clip with the Create button and it shows up on your phone in the PlayStation App. Add a capture card and OBS for live auto-clips.",
          link: { path: "/gta-clips/ps5", label: "The PS5 guide" },
        },
        {
          title: "Xbox",
          tag: "No extra hardware",
          body: "Save a clip with the Share button and download it in the Xbox app on your phone. Add a capture card and OBS for live auto-clips.",
          link: { path: "/gta-clips/xbox", label: "The Xbox guide" },
        },
        {
          title: "PC",
          tag: "Live auto-clips",
          body: "OBS sends your game to SLOT1, which marks the moments as they happen and clips them while you play.",
          link: { path: "/gta-clips/pc", label: "The PC guide" },
        },
      ],
    },
    {
      id: "tools",
      heading: "Made for clippers",
      panels: [
        {
          title: "Every format from one edit",
          body: "Keep a 9:16 and a 16:9 version of the same edit side by side. Exports for TikTok (up to 10 minutes), YouTube Shorts and Instagram Reels (up to 3 minutes), X and YouTube.",
        },
        {
          title: "A real editor in your browser",
          body: "Tracks you can add, razor and ripple trims, keyframes, a media bin, and a library of sounds and elements. On a phone you get a simple editor: watch, trim, caption, export.",
        },
        {
          title: "Moments you can check",
          body: "Every moment SLOT1 marks links to the frames it read it from, so you know why it's there before you post it.",
        },
        {
          title: "Instant replay while you're live",
          body: "Streaming through SLOT1? Rewatch a moment seconds after it happened and clip it while you're still playing.",
        },
      ],
      note: "SLOT1 recognizes GTA V's screens today. GTA VI support comes after the game is out.",
    },
  ],
  faq: [
    FAQ_FREE,
    {
      q: "Do I need a PC to make GTA clips with SLOT1?",
      a: "No. On PS5 and Xbox you save a clip with the console's own button, get it on your phone through the PlayStation App or the Xbox app, and upload it to SLOT1 from the phone. A PC with OBS (plus a capture card for a console) adds live auto-clips while you play.",
    },
    {
      q: "Which GTA moments does SLOT1 find?",
      a: "GTA V's on-screen messages, like MISSION PASSED, WASTED and BUSTED, each with the frames it read them from. Any other footage can still be cut and exported; SLOT1 just won't mark moments in it.",
    },
    FAQ_TWITCH,
    FAQ_OWN_VIDEO,
    {
      q: "Where do my clips go?",
      a: "Into your private SLOT1 library. Nothing is public until you choose to share it.",
    },
    {
      q: "What about GTA 6?",
      a: "GTA VI comes out on 19 November 2026 on PS5 and Xbox Series X|S. You can cut and export its footage from day one; marking its moments automatically comes after release.",
    },
  ],
  related: related("ps5", "xbox", "pc", "gta-6"),
  card: { title: "GTA clips for TikTok, Shorts and Reels", line: "For PS5, Xbox and PC" },
};

const PS5: ClipGuide = {
  slug: "ps5",
  path: "/gta-clips/ps5",
  title: "How to make GTA clips for TikTok on PS5",
  description:
    "Save GTA moments with the PS5 Create button, get them on your phone with the PlayStation App, and let SLOT1 find the moments and cut vertical clips for TikTok.",
  h1: "GTA clips on PS5, ready for TikTok",
  lede: "Your PS5 already records. SLOT1 turns those recordings into clips you can post: it finds MISSION PASSED, WASTED and BUSTED, cuts the moment vertical, and exports it for TikTok, YouTube Shorts and Instagram Reels. Nothing is installed on the console.",
  trail: [
    { name: "GTA clips", path: "/gta-clips" },
    { name: "PS5", path: "/gta-clips/ps5" },
  ],
  routes: [
    { title: "PlayStation App", tag: "No extra hardware", body: "Save a clip with the Create button. It shows up on your phone in the PlayStation App, and you upload it from there." },
    { title: "USB drive", tag: "Long recordings", body: "Record up to an hour, copy it to a USB drive, and upload it from a computer." },
    { title: "Capture card + OBS", tag: "Live auto-clips", body: "The PS5 plays through a capture card into a computer. OBS sends the picture to SLOT1, which clips while you play." },
  ],
  sections: [
    {
      id: "ps-app",
      heading: "Clip GTA on PS5 with the PlayStation App",
      steps: [
        {
          title: "Turn on auto-upload",
          body: "On the PS5, open Settings → Captures and Broadcasts → Captures → Auto-Upload, and link the PlayStation App on your phone. Leave the console in rest mode with Stay Connected to the Internet on.",
        },
        {
          title: "Save the moment",
          body: "Press the Create button and choose Save Recent Gameplay. Keep it to 3 minutes or less at 1080p: longer clips and 4K clips don't go to the app.",
        },
        {
          title: "Get it on your phone",
          body: "In the PlayStation App, open Library → Captures, open the clip and choose Download. Clips stay in the app for 14 days.",
        },
        UPLOAD_STEP,
        CUT_STEP,
      ],
    },
    {
      id: "long",
      heading: "Longer recordings",
      intro:
        "Press Create and choose Start New Recording to record up to an hour, or save up to the last hour with Save Recent Gameplay. Copy the recording from the Media Gallery to a USB drive, then upload it to SLOT1 from a computer. SLOT1 marks every moment in it, so you don't scrub through an hour to find them.",
    },
    {
      id: "live",
      heading: "Live auto-clips with a capture card",
      intro:
        "To clip while you play, SLOT1 needs its own copy of the video. The PS5's Broadcast button only sends to Twitch or YouTube, so the picture goes through a computer running OBS.",
      panels: [
        {
          title: "Capture card + OBS",
          tag: "Best quality",
          body: "The capture card sits between the PS5 and your TV and feeds the picture into the computer. On the PS5, turn off HDCP (Settings → System → HDMI) so the card gets a picture.",
        },
        {
          title: "PS Remote Play + OBS",
          tag: "No extra hardware",
          body: "Play through PS Remote Play on your PC and let OBS capture its window. The picture is lower quality than with a capture card.",
        },
      ],
      note: "Then, in Studio → Stream setup, SLOT1 puts its server and stream key into OBS in one click, and it can pass the same stream on to Twitch, so you still stream once.",
    },
    {
      id: "broadcast",
      heading: "Streaming straight from the PS5 to Twitch?",
      intro:
        "Keep doing it. SLOT1 can't see that video, but its chat bot works in your Twitch chat: !slot1 clip makes a Twitch clip on the spot, and SLOT1 can download and analyze your Twitch clips.",
    },
  ],
  faq: [
    {
      q: "Does SLOT1 install anything on my PS5?",
      a: "No. SLOT1 is a website. Your PS5 records with its own Create button, and SLOT1 works with the recordings.",
    },
    {
      q: "How long can a PS5 clip be?",
      a: "The PS5 saves anything from the last 15 seconds up to 1 hour of gameplay. The PlayStation App only takes clips up to 3 minutes at 1080p; for longer or 4K recordings, use a USB drive.",
    },
    {
      q: "Do I need PlayStation Plus?",
      a: "Not for auto-upload to the PlayStation App. Uploading to SLOT1 doesn't need it either.",
    },
    {
      q: "Can SLOT1 clip my PS5 stream automatically?",
      a: "Yes, when the video reaches SLOT1 through a capture card or PS Remote Play and OBS. The PS5's own Broadcast button sends only to Twitch or YouTube, so SLOT1 can't watch that stream.",
    },
    FAQ_FILES,
    FAQ_FREE,
  ],
  related: related("gta-clips", "xbox", "pc", "gta-6"),
  card: { title: "GTA clips on PS5, ready for TikTok", line: "From the Create button to TikTok" },
};

const XBOX: ClipGuide = {
  slug: "xbox",
  path: "/gta-clips/xbox",
  title: "How to make GTA clips for TikTok on Xbox",
  description:
    "Save GTA moments with the Xbox Share button, get them on your phone with the Xbox app, and let SLOT1 find the moments and cut vertical clips for TikTok.",
  h1: "GTA clips on Xbox, ready for TikTok",
  lede: "Your Xbox already records clips. SLOT1 finds the MISSION PASSED, WASTED and BUSTED moments in them, cuts them vertical, and exports them for TikTok, YouTube Shorts and Instagram Reels. Nothing is installed on the console.",
  trail: [
    { name: "GTA clips", path: "/gta-clips" },
    { name: "Xbox", path: "/gta-clips/xbox" },
  ],
  routes: [
    { title: "Xbox app", tag: "No extra hardware", body: "Save a clip with the Share button, then download it in the Xbox app on your phone and upload it from there." },
    { title: "Capture card + OBS", tag: "Live auto-clips", body: "The Xbox plays through a capture card into a computer. OBS sends the picture to SLOT1, which clips while you play." },
    { title: "Xbox app on PC + OBS", tag: "No capture card", body: "Play your console through the Xbox app on Windows and let OBS capture the window." },
  ],
  sections: [
    {
      id: "xbox-app",
      heading: "Clip GTA on Xbox with the Xbox app",
      steps: [
        {
          title: "Save the moment",
          body: "Hold the Share button on the controller to save what just happened. For a longer clip, press the Xbox button and choose Capture & share → Record what happened.",
        },
        {
          title: "Upload it to the Xbox network",
          body: "Clips only reach the Xbox app after they're uploaded. In Capture & share, open the clip and choose Upload if it isn't uploaded yet.",
        },
        {
          title: "Get it on your phone",
          body: "In the Xbox app on your phone, open Library → Captures and save the clip to your phone.",
        },
        UPLOAD_STEP,
        CUT_STEP,
      ],
      note: "Higher capture resolutions allow shorter clips. 1080p gives you the most room.",
    },
    {
      id: "live",
      heading: "Live auto-clips while you play",
      intro: "For SLOT1 to clip while you play, it needs its own copy of the video, so the picture goes through a computer running OBS.",
      panels: [
        {
          title: "Capture card + OBS",
          tag: "Best quality",
          body: "The capture card sits between the Xbox and your TV and feeds the picture into the computer.",
        },
        {
          title: "Xbox app on PC + OBS",
          tag: "No extra hardware",
          body: "Play your console through the Xbox app on Windows and let OBS capture its window. The picture is lower quality than with a capture card.",
        },
      ],
      note: "Then, in Studio → Stream setup, SLOT1 puts its server and stream key into OBS in one click, and it can pass the same stream on to Twitch, YouTube and Kick.",
    },
  ],
  faq: [
    {
      q: "Does SLOT1 install anything on my Xbox?",
      a: "No. SLOT1 is a website. Your Xbox records with its own Share button, and SLOT1 works with the clips.",
    },
    {
      q: "My clip doesn't show up in the Xbox app. Why?",
      a: "Clips only appear in the Xbox app after they're uploaded to the Xbox network. Open the clip in Capture & share on the console and choose Upload.",
    },
    {
      q: "How long can an Xbox clip be?",
      a: "It depends on your capture settings: higher resolutions allow shorter clips. 1080p gives you the most room. For long sessions, stream through OBS instead and let SLOT1 clip live.",
    },
    {
      q: "Can SLOT1 clip my Xbox stream automatically?",
      a: "Yes, when the video reaches SLOT1 through a capture card or the Xbox app on PC and OBS. A stream sent straight from the console to Twitch isn't visible to SLOT1, but its chat bot still makes Twitch clips with !slot1 clip.",
    },
    FAQ_FILES,
    FAQ_FREE,
  ],
  related: related("gta-clips", "ps5", "pc", "gta-6"),
  card: { title: "GTA clips on Xbox, ready for TikTok", line: "From the Share button to TikTok" },
};

const PC: ClipGuide = {
  slug: "pc",
  path: "/gta-clips/pc",
  title: "Auto-clip GTA V on PC for TikTok",
  description:
    "Stream GTA V from OBS to SLOT1 and it clips MISSION PASSED, WASTED and BUSTED while you play, then cuts them vertical for TikTok, YouTube Shorts and Reels.",
  h1: "Auto-clips for GTA on PC",
  lede: "On PC, SLOT1 can watch your game live. OBS sends your stream to SLOT1, which marks the moments as they happen, keeps instant replays, and turns the best ones into vertical clips for TikTok, YouTube Shorts and Instagram Reels.",
  trail: [
    { name: "GTA clips", path: "/gta-clips" },
    { name: "PC", path: "/gta-clips/pc" },
  ],
  sections: [
    {
      id: "obs",
      heading: "Auto-clip GTA on PC with OBS",
      steps: [
        { title: "Sign in with Twitch", body: "At slot1.fun, with the Twitch account you stream from." },
        {
          title: "Set up OBS in one click",
          body: "In Studio → Stream setup, choose Set up OBS automatically. Turn on OBS's WebSocket server (Tools → WebSocket Server Settings) and paste its password into Studio: SLOT1 fills in its server and stream key.",
        },
        {
          title: "Go live",
          body: "Stream as usual. SLOT1 can pass the same stream on to Twitch, YouTube and Kick, so you still stream once.",
        },
        {
          title: "Let it clip",
          body: "Turn on Auto clips in Studio → Library, or type !slot1 autoclip on in your chat, and MISSION PASSED, WASTED and BUSTED get clipped for you.",
        },
        { title: "Post the best ones", body: "Open a clip in the editor, frame it 9:16, and export it for TikTok, YouTube Shorts or Instagram Reels." },
      ],
    },
    {
      id: "upload",
      heading: "Not streaming? Upload a recording",
      intro:
        "Recorded with OBS, NVIDIA or AMD software, or the Xbox Game Bar? Upload the file in Studio → Video sources and SLOT1 marks the moments in it, ready to cut.",
    },
  ],
  faq: [
    {
      q: "Do I need to install anything?",
      a: "No. SLOT1 is a website, and OBS is the only program you use.",
    },
    {
      q: "Will SLOT1 slow down my game?",
      a: "No. The analysis runs on SLOT1's server, not on your PC. Your PC only sends the stream, as it would to Twitch.",
    },
    {
      q: "Can I stream to Twitch, YouTube and Kick at the same time?",
      a: "Yes. OBS sends one stream to SLOT1 and SLOT1 passes it on to each platform without re-encoding. Check each platform's rules on streaming to several places at once.",
    },
    FAQ_TWITCH,
    FAQ_FREE,
  ],
  related: related("gta-clips", "ps5", "xbox", "gta-6"),
  card: { title: "Auto-clips for GTA on PC", line: "Clipped while you play" },
};

const GTA6: ClipGuide = {
  slug: "gta-6",
  path: "/gta-6",
  title: "GTA 6 clips for TikTok: get ready before launch",
  description:
    "GTA VI comes out on 19 November 2026 on PS5 and Xbox Series X|S. Set up your clipping now with SLOT1: vertical clips for TikTok, YouTube Shorts and Reels.",
  h1: "Get ready to clip GTA 6",
  lede: "GTA VI comes out on 19 November 2026 on PS5 and Xbox Series X|S, with a PC version expected later. Set up your clipping before launch, so your first GTA VI clip goes out the day you play it.",
  trail: [{ name: "GTA 6 clips", path: "/gta-6" }],
  sections: [
    {
      id: "day-one",
      heading: "What works on day one",
      panels: [
        { title: "Upload and cut", tag: "Ready", body: "Upload your GTA VI recordings, cut them in the editor, add captions, text and sounds, and export them for TikTok, YouTube Shorts and Instagram Reels." },
        { title: "Every console route", tag: "Ready", body: "The PS5 and Xbox routes in our guides work for any game: capture buttons, the phone apps, or a capture card and OBS." },
        { title: "Moments found for you", tag: "After launch", body: "SLOT1 recognizes GTA V's screens today. It learns GTA VI's from streams creators choose to share, so marking GTA VI moments by itself comes after release." },
      ],
    },
    {
      id: "now",
      heading: "Get set up before launch",
      steps: [
        { title: "Sign in with Twitch", body: "At slot1.fun. It's free." },
        { title: "Pick your console route", body: "Follow the PS5 or Xbox guide, so you know how your clips reach SLOT1." },
        { title: "Practice on GTA V", body: "Clip a few GTA V moments now: SLOT1 finds them for you, and the editor and exports are the same for GTA VI." },
      ],
    },
  ],
  faq: [
    {
      q: "When does GTA 6 come out?",
      a: "19 November 2026, on PS5 and Xbox Series X|S. A PC version is expected later.",
    },
    {
      q: "Will SLOT1 find GTA 6 moments automatically?",
      a: "That's the plan. SLOT1 learns new games from streams creators choose to share, so it starts after release. Until then you cut and export GTA VI footage yourself, with the same editor and exports.",
    },
    {
      q: "Can I record GTA 6 on PS5 and Xbox?",
      a: "Yes, with the consoles' own capture buttons, the same way as other games. Our PS5 and Xbox guides show how to get those clips into SLOT1.",
    },
    FAQ_FREE,
  ],
  related: related("gta-clips", "ps5", "xbox", "pc"),
  card: { title: "Get ready to clip GTA 6", line: "Out 19 November 2026 on PS5 and Xbox" },
};

export const CLIP_GUIDES: Record<ClipGuide["slug"], ClipGuide> = { "gta-clips": HUB, ps5: PS5, xbox: XBOX, pc: PC, "gta-6": GTA6 };

/** Every guide, in the order the hub and the footer list them. */
export const CLIP_GUIDE_LIST: ClipGuide[] = [HUB, PS5, XBOX, PC, GTA6];
