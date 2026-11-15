"use client";

import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { SiteChat } from "./SiteChat";

type View = "twitch" | "slot1";

// Lighter than the rail's own tabs above it: an underline marks the open chat.
const TRIGGER =
  "h-10 flex-1 border-b-2 border-transparent font-display text-[0.95rem] font-semibold tracking-[0.02em] text-ivory-3 transition-colors hover:text-ivory data-[state=active]:border-apricot data-[state=active]:text-ivory";

/**
 * The rail's chat: the channel's Twitch chat (Twitch's own embed) and SLOT1 chat, each at full
 * height, one at a time. Both stay mounted, so switching never reloads either, and SLOT1 chat counts
 * what arrived while it was out of view.
 */
export function ChatPanel({ twitchSrc, room, active, focusSlot1 }: { twitchSrc: string | null; room: string | null; active: boolean; focusSlot1: boolean }) {
  const [view, setView] = useState<View>(twitchSrc ? "twitch" : "slot1");
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    // Back from "Sign in with Twitch to chat": open SLOT1 chat.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (focusSlot1 && room) setView("slot1");
  }, [focusSlot1, room]);

  return (
    <Tabs.Root value={view} onValueChange={(v) => setView(v as View)} className="flex min-h-0 flex-1 flex-col">
      {twitchSrc && room && (
        <Tabs.List className="flex border-b hairline" aria-label="Chats">
          <Tabs.Trigger value="twitch" className={TRIGGER}>
            Twitch chat
          </Tabs.Trigger>
          <Tabs.Trigger value="slot1" className={TRIGGER}>
            SLOT1 chat
            {unread > 0 && view !== "slot1" && (
              <span className="tnum ml-2 inline-flex h-5 min-w-5 items-center justify-center bg-coral px-1 font-sans text-[0.72rem] font-semibold text-graphite" aria-label={`${unread} new`}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Tabs.Trigger>
        </Tabs.List>
      )}
      {twitchSrc && (
        <Tabs.Content value="twitch" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <iframe title="Twitch chat" src={twitchSrc} className="block min-h-0 w-full flex-1 bg-graphite" />
        </Tabs.Content>
      )}
      {room && (
        <Tabs.Content value="slot1" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <SiteChat room={room} visible={active && view === "slot1"} onUnread={setUnread} />
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}
