/**
 * The facts behind /setup ("How SLOT1 works"). Every line here describes how SLOT1 actually
 * behaves: modes, permissions (docs/TWITCH_SCOPES.md), chat commands (packages/bot) and limits.
 * Change the code first, then this file.
 */

export interface Mode {
  name: string;
  /** How much of the gameplay SLOT1 sees, 0–5, drawn as a stat bar next to the words below. */
  level: number;
  sees: string;
  what: string;
  needs: string;
}

export const MODES: Mode[] = [
  {
    name: "Watch",
    level: 0,
    sees: "Nothing. The player is Twitch’s; SLOT1 can’t read its pixels.",
    what: "The official Twitch player and, if you open it, Twitch chat.",
    needs: "Nothing. Works for any public channel.",
  },
  {
    name: "Chat only",
    level: 0,
    sees: "No gameplay. Asked what’s happening, it says vision isn’t connected.",
    what: "SLOT1 answers !slot1 commands and creates clips on request.",
    needs: "The creator connects Twitch and the operator links the SLOT1 bot account.",
  },
  {
    name: "Clip analysis",
    level: 2,
    sees: "Only the clipped seconds, after Twitch has made the clip available.",
    what: "Clips come through Twitch’s official clip download and are analyzed frame by frame.",
    needs: "The creator grants the extra clip permission (channel:manage:clips).",
  },
  {
    name: "Continuous analysis",
    level: 4,
    sees: "The frames it receives, a few seconds behind, with gaps disclosed.",
    what: "A live copy of the gameplay video arrives at SLOT1’s authenticated ingest and is sampled continuously.",
    needs: "OBS streaming to SLOT1, set up once in Studio → Stream setup. SLOT1 can pass the same stream on to Twitch, YouTube or Kick.",
  },
  {
    name: "Replay",
    level: 5,
    sees: "The whole recording, at the sampling interval you chose.",
    what: "An uploaded recording is analyzed and played back with its evidence timeline.",
    needs: "A recording you own. Labeled REPLAY everywhere; never shown as live.",
  },
];

export interface Permission {
  scope: string;
  when: "Always" | "Optional";
  what: string;
}

/** What Connect my Twitch asks for (docs/TWITCH_SCOPES.md). */
export const PERMISSIONS: Permission[] = [
  { scope: "channel:bot", when: "Always", what: "Lets the SLOT1 bot account into your chat." },
  { scope: "clips:edit", when: "Always", what: "Creates a clip when you, or the chat users you allow, ask for one." },
  { scope: "channel:manage:clips", when: "Optional", what: "Downloads your clips so SLOT1 can analyze them. Add it later in Studio." },
  { scope: "channel:read:stream_key", when: "Optional", what: "Forwards your stream to Twitch. Only when you choose it in Studio → Stream setup." },
];

export interface Command {
  cmd: string;
  /** What gets copied: the command without its placeholder. */
  copy: string;
  does: string;
}

export const COMMANDS: Command[] = [
  { cmd: "!slot1 help", copy: "!slot1 help", does: "The commands, and whether SLOT1 can see gameplay right now." },
  { cmd: "!slot1 now", copy: "!slot1 now", does: "What it saw in the last couple of minutes, or why it can’t say." },
  { cmd: "!slot1 recap", copy: "!slot1 recap", does: "The last 10 minutes, with how much of it was analyzed." },
  { cmd: "!slot1 find <thing>", copy: "!slot1 find ", does: "Searches what it has seen and links the best moment." },
  { cmd: "!slot1 ask <question>", copy: "!slot1 ask ", does: "Answers only from what it observed." },
  { cmd: "!slot1 clip", copy: "!slot1 clip", does: "Posts the clip link once Twitch confirms it. The creator decides who may clip." },
  { cmd: "!slot1 status", copy: "!slot1 status", does: "Live or not, what it can see, and the commentary setting." },
];

/** The creator and the moderators they approve. */
export const CREATOR_COMMANDS: Command[] = [
  { cmd: "!slot1 pause / resume", copy: "!slot1 pause", does: "Stops and restarts the analysis." },
  { cmd: "!slot1 mute / unmute", copy: "!slot1 mute", does: "Silences automatic commentary. Commands keep working." },
  { cmd: "!slot1 record on / off", copy: "!slot1 record on", does: "Saves the stream to your SLOT1 library. The first time, it asks for your OK in Studio." },
  { cmd: "!slot1 autoclip on / off", copy: "!slot1 autoclip on", does: "Clips MISSION PASSED, WASTED and BUSTED moments automatically." },
  { cmd: "!slot1 relay", copy: "!slot1 relay", does: "Where SLOT1 is forwarding your stream right now. Never any addresses or keys." },
];

export const CONSOLE_TEST = [
  "On the PS5, link Twitch: press the Create button, choose Broadcast, pick Twitch and sign in.",
  "While live, open the broadcast card and turn on Display Chat in its overlay options. Note the Position you chose. Broadcast settings live under Settings > Captures and Broadcasts > Broadcasts.",
  "Go live with a game, then type !slot1 help in your Twitch chat from another device.",
  "Check whether SLOT1’s reply appears in the PS5 chat overlay, and how long after it appears in Twitch chat.",
  "If you use Convert Broadcast Chat to Speech, check whether the reply is read aloud and how it sounds.",
  "Request !slot1 clip, wait for the follow-up message, and check that the link opens the right moment.",
  "Note the console firmware, broadcast quality setting and anything that didn’t match. Until this is done, PS5 chat display stays marked as needing console verification.",
];

export const WONT_DO = [
  "Install anything on a PS5, modify a console, or use exploits of any kind.",
  "Draw an overlay on your TV. Its only on-screen presence is ordinary Twitch chat.",
  "Read pixels from the Twitch player or scrape Twitch’s video internals.",
  "Rewind a live Twitch stream to an event. It shows the stored evidence or a clip instead.",
  "Pretend a replay or test recording is a live broadcast.",
];

/** The pause-menu tabs, in page order. Their ids are linked from Studio, the API and the home page. */
export const SECTIONS = [
  { id: "brief", label: "Brief" },
  { id: "modes", label: "What it sees" },
  { id: "twitch", label: "Twitch" },
  { id: "bot", label: "Chat bot" },
  { id: "sources", label: "Video" },
  { id: "stream", label: "Go live everywhere" },
  { id: "ai", label: "AI" },
  { id: "console-test", label: "PS5 test" },
  { id: "limits", label: "Won’t do" },
] as const;
