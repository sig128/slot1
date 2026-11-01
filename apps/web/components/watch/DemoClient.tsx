"use client";

import { useEffect, useState } from "react";
import { SkylineArt } from "@/components/brand/SkylineArt";
import { buildDemo } from "@/lib/fixtures";
import { SessionWorkspace } from "./SessionWorkspace";

/** Design review only. Every value is a fixture and the page says so. */
export function DemoClient() {
  const [demo, setDemo] = useState<ReturnType<typeof buildDemo> | null>(null);
  // Fixture times are relative to the viewer's clock, which only exists after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDemo(buildDemo(Date.now())), []);
  if (!demo) return <div className="min-h-[60vh]" />;
  return (
    <div>
      <div className="border-b border-apricot/50 bg-graphite-800">
        <p className="mx-auto max-w-[1600px] px-4 py-3 text-sm text-ivory sm:px-6 lg:px-10">
          <strong className="font-display tracking-wider">DEMO</strong> Fixture data for design review. This is not a broadcast and nothing here was observed.
        </p>
      </div>
      <SessionWorkspace
        mode="live"
        session={demo.session}
        initialPage={demo.page}
        initialClips={[]}
        identity={{ displayName: "Fixture Channel", avatarUrl: null, title: "Design fixture session", category: "Design fixture", twitchUrl: null }}
        broadcast="unknown"
        fallbackStatus={demo.status}
        livePlayer={
          <div className="relative aspect-video w-full overflow-hidden bg-graphite-800">
            <SkylineArt className="absolute inset-0 h-full w-full" />
            <p className="absolute left-4 top-4 font-display text-lg font-bold tracking-wider">PLAYER PLACEHOLDER (DEMO)</p>
          </div>
        }
        isCreator={false}
        canAsk
        askPolicy="anyone"
        emptyState={null}
        fixture={{ details: demo.details, answer: demo.answer }}
      />
    </div>
  );
}
