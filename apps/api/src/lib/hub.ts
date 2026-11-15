import type { Redis } from "ioredis";
import type { StoredEvent } from "@slot1/db";

type Listener = (e: StoredEvent) => void;
type RawListener = (message: string) => void;

/**
 * One Redis subscriber per API process, fanning channels out to SSE connections: session events
 * (`subscribe`) and any other channel's raw messages (`subscribeRaw`, used by SLOT1 chat).
 * Subscriptions are reference-counted so idle channels cost nothing.
 */
export class EventHub {
  private listeners = new Map<string, Set<RawListener>>();

  constructor(private readonly sub: Redis) {
    sub.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      for (const l of set) l(message);
    });
  }

  async subscribe(sessionId: string, listener: Listener): Promise<() => Promise<void>> {
    return this.subscribeRaw(`slot1:session:${sessionId}`, (message) => {
      let e: StoredEvent;
      try {
        e = JSON.parse(message) as StoredEvent;
      } catch {
        return;
      }
      listener(e);
    });
  }

  async subscribeRaw(channel: string, listener: RawListener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(listener);
    return async () => {
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async close() {
    await this.sub.quit().catch(() => undefined);
  }
}
