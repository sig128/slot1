import type { Redis } from "ioredis";
import type { StoredEvent } from "@slot1/db";

type Listener = (e: StoredEvent) => void;

/**
 * One Redis subscriber per API process, fanning session channels out to SSE connections.
 * Subscriptions are reference-counted so idle sessions cost nothing.
 */
export class EventHub {
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly sub: Redis) {
    sub.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      let e: StoredEvent;
      try {
        e = JSON.parse(message) as StoredEvent;
      } catch {
        return;
      }
      for (const l of set) l(e);
    });
  }

  async subscribe(sessionId: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = `slot1:session:${sessionId}`;
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
