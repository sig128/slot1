"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAT_MESSAGE_MAX, type ChatBadge, type ChatMessage, type ChatRoomResponse } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { chatSignInHref } from "@/lib/signin-notice";

/** A readable, stable color per name on the dark rail. */
function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 72%)`;
}

const BADGE: Record<ChatBadge, { label: string; className: string }> = {
  bot: { label: "Bot", className: "bg-apricot text-graphite" },
  creator: { label: "Creator", className: "bg-coral text-graphite" },
  team: { label: "SLOT1", className: "border border-ivory-2 text-ivory" },
};

/** Bot answers may carry a link to a moment on SLOT1; everything else is plain text. */
function Text({ text, bot }: { text: string; bot: boolean }) {
  if (!bot) return <>{text}</>;
  const parts = text.split(/(https:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https:\/\//.test(part) ? (
          <a key={i} href={part} className="text-apricot underline underline-offset-2 hover:text-ivory">
            {part.replace(/^https:\/\//, "")}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** Message ids are Redis stream ids, "<ms>-<seq>". */
function newer(a: string, b: string): boolean {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  return am! !== bm! ? am! > bm! : as! > bs!;
}

function sinceTitle(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * SLOT1 chat for one channel: everyone on the page reads it, signed-in viewers post, and the SLOT1
 * bot answers `!slot1` commands in it. Live over SSE (reconnects pick up what they missed and drop
 * what was deleted meanwhile). Admins and the channel's creator can delete and ban; viewers report.
 */
export function SiteChat({ room, visible, onUnread }: { room: string; visible: boolean; onUnread?: (n: number) => void }) {
  const [data, setData] = useState<ChatRoomResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const unread = useRef(0);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastId = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const add = useCallback((m: ChatMessage, mine = false) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-300)));
    if (!lastId.current || newer(m.id, lastId.current)) lastId.current = m.id;
    if (!mine && !visibleRef.current) {
      unread.current += 1;
      onUnread?.(unread.current);
    }
  }, [onUnread]);

  useEffect(() => {
    if (visible && unread.current) {
      unread.current = 0;
      onUnread?.(0);
    }
  }, [visible, onUnread]);

  // Load the room, then follow it live.
  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    api<ChatRoomResponse>(`/api/chat/${encodeURIComponent(room)}`)
      .then((r) => {
        if (stopped) return;
        setData(r);
        setMessages(r.messages);
        lastId.current = r.messages.at(-1)?.id ?? null;
        es = new EventSource(`/api/chat/${encodeURIComponent(room)}/events?after=${lastId.current ?? "0-0"}`);
        es.addEventListener("message", (e) => add(JSON.parse((e as MessageEvent<string>).data) as ChatMessage));
        es.addEventListener("delete", (e) => {
          const { ids } = JSON.parse((e as MessageEvent<string>).data) as { ids: string[] };
          setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
        });
        es.addEventListener("sync", (e) => {
          const { ids } = JSON.parse((e as MessageEvent<string>).data) as { ids: string[] };
          const keep = new Set(ids);
          const oldest = ids[0];
          // Anything newer than the oldest id still in the room, but not in it, was deleted.
          setMessages((prev) => prev.filter((m) => keep.has(m.id) || (oldest !== undefined && newer(oldest, m.id))));
        });
      })
      .catch((e: unknown) => setFailed(e instanceof ApiError && e.status === 404 ? "SLOT1 chat isn't open on this channel." : "SLOT1 chat didn't load. Reload the page to try again."));
    return () => {
      stopped = true;
      es?.close();
    };
  }, [room, add]);

  // Stay pinned to the newest message unless the reader scrolled up, including when the list
  // gets shorter (an error under the box, the panel resizing).
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom, visible]);
  useEffect(() => {
    const el = list.current;
    if (!el || !atBottom) return;
    const ro = new ResizeObserver(() => (el.scrollTop = el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [atBottom]);

  function onScroll() {
    const el = list.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  }

  async function send(value: string) {
    const t = value.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await api<{ message: ChatMessage }>(`/api/chat/${encodeURIComponent(room)}/messages`, { method: "POST", json: { text: t } });
      add(r.message, true);
      setText("");
      setAtBottom(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't send. Try again.");
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  async function act(m: ChatMessage, action: "delete" | "ban" | "ban_everywhere" | "report") {
    setActionsFor(null);
    setNotice(null);
    const base = `/api/chat/${encodeURIComponent(room)}/messages/${m.id}`;
    try {
      if (action === "delete") await api(base, { method: "DELETE" });
      else if (action === "report") await api(`${base}/report`, { method: "POST", json: {} });
      else await api(`${base}/ban`, { method: "POST", json: { everywhere: action === "ban_everywhere" } });
      if (action === "delete") setMessages((prev) => prev.filter((x) => x.id !== m.id));
      setNotice(
        action === "report"
          ? `Reported. SLOT1's admins will look at ${m.name}'s message.`
          : action === "delete"
            ? "Message deleted."
            : `${m.name} is banned ${action === "ban_everywhere" ? "from every SLOT1 chat" : "from this chat"}, and their messages here are gone.`,
      );
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    }
  }

  if (failed) return <p className="p-5 text-sm text-ivory-2">{failed}</p>;
  if (!data) return <p className="p-5 text-sm text-ivory-3">Loading SLOT1 chat…</p>;
  const v = data.viewer;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <ol ref={list} onScroll={onScroll} className="h-full space-y-1 overflow-y-auto px-3 py-3 text-[0.92rem] leading-snug" role="log" aria-label="SLOT1 chat messages">
          {messages.length === 0 && (
            <li className="px-1 py-6 text-sm text-ivory-2">
              <p className="font-display text-lg font-bold text-ivory">No messages yet</p>
              <p className="mt-1">Say hi, or ask the bot something: {data.commands[0] ?? "!slot1 help"}</p>
            </li>
          )}
          {messages.map((m) => {
            const bot = m.kind === "bot";
            const mine = !bot && v.name !== null && m.name === v.name;
            const canReport = v.signedIn && !bot && !mine;
            const canMod = v.canModerate && !bot;
            return (
              <li key={m.id} className={`group relative rounded-[2px] px-2 py-1 ${bot ? "border-l-2 border-apricot bg-graphite-800" : "hover:bg-graphite-800/60"}`}>
                {m.badges.length > 0 && (
                  <span className="mr-1.5 inline-flex translate-y-[-1px] gap-1 align-middle">
                    {m.badges.map((b) => (
                      <span key={b} className={`inline-flex h-[1.05rem] items-center px-1 font-display text-[0.68rem] font-bold tracking-[0.04em] ${BADGE[b].className}`}>
                        {BADGE[b].label}
                      </span>
                    ))}
                  </span>
                )}
                <span className="font-semibold" style={{ color: bot ? "var(--color-apricot)" : nameColor(m.name) }} title={sinceTitle(m.at)}>
                  {m.name}
                </span>
                <span className="text-ivory-3">: </span>
                {m.replyTo && <span className="text-ivory-3">@{m.replyTo.name} </span>}
                <span className="break-words text-ivory">
                  <Text text={m.text} bot={bot} />
                </span>
                {(canReport || canMod) && (
                  <button
                    type="button"
                    className="absolute right-1 top-1 hidden h-6 px-1.5 text-[0.8rem] text-ivory-2 hover:text-ivory focus-visible:inline-block group-hover:inline-block"
                    aria-label={`Options for ${m.name}'s message`}
                    aria-expanded={actionsFor === m.id}
                    onClick={() => setActionsFor(actionsFor === m.id ? null : m.id)}
                  >
                    •••
                  </button>
                )}
                {actionsFor === m.id && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pb-1">
                    {canMod && (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(m, "delete")}>
                          Delete
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(m, "ban")}>
                          Ban from this chat
                        </button>
                        {v.canBanEverywhere && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(m, "ban_everywhere")}>
                            Ban everywhere
                          </button>
                        )}
                      </>
                    )}
                    {canReport && !canMod && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(m, "report")}>
                        Report
                      </button>
                    )}
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setActionsFor(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {!atBottom && (
          <button
            type="button"
            className="btn btn-primary btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg shadow-black/40"
            onClick={() => {
              setAtBottom(true);
              list.current?.scrollTo({ top: list.current.scrollHeight });
            }}
          >
            Jump to newest
          </button>
        )}
      </div>

      <div className="border-t hairline p-3">
        {notice && (
          <p className="mb-2 text-[0.85rem] text-ivory-2" role="status">
            {notice}
          </p>
        )}
        {v.canPost ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <div className="flex gap-2">
              <label htmlFor={`chat-${room}`} className="sr-only">
                Message SLOT1 chat
              </label>
              <input
                ref={input}
                id={`chat-${room}`}
                className="field min-w-0 flex-1"
                placeholder="Send a message"
                autoComplete="off"
                maxLength={CHAT_MESSAGE_MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-describedby={error ? `chat-${room}-error` : undefined}
              />
              <button type="submit" className="btn btn-primary" disabled={sending || !text.trim()}>
                Chat
              </button>
            </div>
            {error && (
              <p id={`chat-${room}-error`} className="mt-2 text-[0.85rem] text-coral">
                {error}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {data.commands.map((c) => (
                <button
                  key={c}
                  type="button"
                  title="Send to the chat"
                  className="inline-flex h-7 items-center border hairline px-2 font-mono text-[0.76rem] text-ivory-2 transition-colors hover:border-ivory-2 hover:text-ivory disabled:opacity-50"
                  disabled={sending}
                  onClick={() => void send(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </form>
        ) : v.blocked === "banned" ? (
          <p className="text-sm text-ivory-2">You can’t post in this chat.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <a
              href={chatSignInHref("/")}
              // Come back to this page, with SLOT1 chat open.
              onClick={(e) => (e.currentTarget.href = chatSignInHref(`${window.location.pathname}?chat=slot1`))}
              className="btn btn-coral btn-sm"
            >
              Sign in with Twitch to chat
            </a>
            <span className="text-[0.85rem] text-ivory-3">Only your Twitch name is used.</span>
          </div>
        )}
        <p className="mt-2 text-[0.78rem] text-ivory-3">
          Everyone on SLOT1 sees this chat. Messages are kept 24 hours.{" "}
          <Link href="/terms#chat" className="underline underline-offset-2 hover:text-ivory">
            Chat rules
          </Link>
        </p>
      </div>
    </div>
  );
}
