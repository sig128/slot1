import { describe, expect, it } from "vitest";
import type { ChannelCard } from "@slot1/contracts";
import { chatTextProblem, compareIds, featuredReply, isBotCall, normalizeChatText } from "../../apps/api/src/lib/chat";

describe("SLOT1 chat text", () => {
  it("keeps one line with single spaces and no invisible characters", () => {
    expect(normalizeChatText("  hi​  there\n\tchat‮ ")).toBe("hi there chat");
    expect(normalizeChatText("ｈｅｌｌｏ")).toBe("hello");
  });

  it("blocks links in their usual disguises", () => {
    for (const t of ["http://a.b", "www.site.com", "free robux at scam.gg", "discord dot gg/xyz", "visit evil . com", "go to bit.ly/abc", "x[.]ru"]) expect(chatTextProblem(t), t).toBe("link");
    for (const t of ["GTA V is 10 years old", "mission 2.5 done", "e.g. the heist", "lol...no"]) expect(chatTextProblem(t), t).toBeNull();
  });

  it("allows everyday swearing but not slurs or sexual terms", () => {
    for (const t of ["holy shit", "what the fuck was that", "that cop is a bastard", "bitch please"]) expect(chatTextProblem(t), t).toBeNull();
    for (const t of ["watch p0rn", "dildo", "f a g g o t"]) expect(chatTextProblem(t), t).toBe("words");
  });

  it("limits length and needs some text", () => {
    expect(chatTextProblem("")).toBe("empty");
    expect(chatTextProblem("a".repeat(300))).toBeNull();
    expect(chatTextProblem("a".repeat(301))).toBe("too_long");
  });

  it("knows a bot call and orders stream ids numerically", () => {
    expect(isBotCall("!slot1 now")).toBe(true);
    expect(isBotCall("@SLOT1 what happened")).toBe(true);
    expect(isBotCall("!slot10")).toBe(false);
    expect(isBotCall("hey !slot1")).toBe(false);
    expect(compareIds("1700000000000-10", "1700000000000-9")).toBe(1);
    expect(compareIds("999-0", "1000-0")).toBe(-1);
    expect(compareIds("5-5", "5-5")).toBe(0);
  });
});

describe("the bot on a featured channel", () => {
  const NOW = Date.parse("2026-11-15T18:00:00Z");
  const card = (over: Partial<ChannelCard["broadcast"]> = {}, followers: number | null = 925959): ChannelCard => ({
    broadcasterId: "preview:darkviperau",
    login: "darkviperau",
    displayName: "DarkViperAU",
    avatarUrl: null,
    twitchUrl: "https://www.twitch.tv/darkviperau",
    broadcast: {
      state: "live",
      title: "Chaos mod any%",
      category: "Grand Theft Auto V",
      thumbnailUrl: null,
      viewerCount: 4534,
      startedAt: "2026-11-15T15:46:00Z",
      lastRefreshedAt: null,
      ...over,
    },
    analysis: { state: "no_source", reason: null, sourceLabel: null, lastReceivedFrameAt: null, lastAnalyzedFrameAt: null, lastResultAt: null, measuredCadenceMs: null, measuredDelayMs: null, staleAfterMs: null, visionConfigured: false },
    publicAnalysis: false,
    followers,
    preview: true,
  });

  it("answers from Twitch's live info", () => {
    expect(featuredReply(card(), "darkviperau", "!slot1 now", NOW)).toBe("DarkViperAU is live in Grand Theft Auto V: “Chaos mod any%” · live 2h 14m · 4.5K watching.");
    expect(featuredReply(card(), "darkviperau", "!slot1 uptime", NOW)).toBe("DarkViperAU has been live for 2h 14m.");
    expect(featuredReply(card(), "darkviperau", "!slot1 followers", NOW)).toBe("DarkViperAU has 926K followers on Twitch.");
    expect(featuredReply(card(), "darkviperau", "!slot1 viewers", NOW)).toBe("4.5K watching DarkViperAU on Twitch right now.");
    expect(featuredReply(card(), "darkviperau", "!SLOT1 GAME", NOW)).toBe("DarkViperAU is playing Grand Theft Auto V.");
  });

  it("says it can't see the game instead of guessing", () => {
    expect(featuredReply(card(), "darkviperau", "@slot1 did he pass the mission?", NOW)).toMatch(/^I can't see the game on this stream, only Twitch's live info\. DarkViperAU is live/);
    expect(featuredReply(card(), "darkviperau", "!slot1 recap", NOW)).toMatch(/^I can't see the game on this stream/);
  });

  it("handles offline channels, missing data and unknown commands", () => {
    const off = card({ state: "offline", title: null, category: null, viewerCount: null, startedAt: null });
    expect(featuredReply(off, "darkviperau", "!slot1 now", NOW)).toBe("DarkViperAU is offline right now.");
    expect(featuredReply(card({}, null), "darkviperau", "!slot1 followers", NOW)).toBe("Twitch didn't give a follower count for DarkViperAU.");
    expect(featuredReply(null, "darkviperau", "!slot1 now", NOW)).toBe("I can't reach Twitch for darkviperau's live info right now.");
    expect(featuredReply(card(), "darkviperau", "!slot1 dance", NOW)).toBe("SLOT1 here: !slot1 now · uptime · game · title · viewers · followers");
  });
});
