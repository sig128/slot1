// TEMPORARY design-review route for the home intro's live state (fork D). Deleted before handoff.
import type { ChannelCard, DirectoryResponse } from "@slot1/contracts";
import { OnAirView } from "@/components/onair/OnAirView";

export const dynamic = "force-dynamic";

function card(login: string, name: string, state: "live" | "offline", viewers: number | null, title: string): ChannelCard {
  return {
    broadcasterId: `b-${login}`,
    login,
    displayName: name,
    avatarUrl: null,
    twitchUrl: `https://www.twitch.tv/${login}`,
    broadcast: { state, title, category: "Grand Theft Auto V", thumbnailUrl: null, viewerCount: viewers, startedAt: null, lastRefreshedAt: new Date().toISOString() },
    analysis: {
      state: "no_source",
      reason: null,
      sourceLabel: null,
      lastReceivedFrameAt: null,
      lastAnalyzedFrameAt: null,
      lastResultAt: null,
      measuredCadenceMs: null,
      measuredDelayMs: null,
      staleAfterMs: null,
      visionConfigured: false,
    },
    publicAnalysis: true,
  };
}

export default function IntroPreview() {
  const directory: DirectoryResponse = {
    channels: [
      card("fixture_one", "Fixture One", "live", 1240, "Heist prep, then the docks"),
      card("fixture_two", "Fixture Two", "live", 87, "Taxi missions until something explodes"),
      card("fixture_three", "Fixture Three", "offline", null, "Back tomorrow"),
    ],
    twitchConfigured: true,
    refreshedAt: new Date().toISOString(),
  };
  return <OnAirView directory={directory} capabilities={null} />;
}
