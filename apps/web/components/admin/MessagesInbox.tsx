"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONTACT_TOPIC_TEXT, type AdminMessagesResponse, type ContactMessageView } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { ago } from "./parts";

type Tab = "open" | "closed";

/** The /contact inbox: newest first, close or reopen, delete with a second confirming click. */
export function MessagesInbox({ initial, openCount, now }: { initial: AdminMessagesResponse | null; openCount: number; now: number }) {
  const [tab, setTab] = useState<Tab>("open");
  const [data, setData] = useState<AdminMessagesResponse | null>(initial);
  const [error, setError] = useState<string | null>(initial ? null : "Couldn't load the messages.");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (which: Tab) => {
    try {
      setData(await api<AdminMessagesResponse>(`/api/admin/messages?status=${which}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load the messages.");
    }
  }, []);

  // The overview's open count changed (a message arrived or was closed elsewhere): refresh once.
  const seenCount = useRef(openCount);
  useEffect(() => {
    if (openCount === seenCount.current) return;
    seenCount.current = openCount;
    if (tab !== "open") return;
    const t = setTimeout(() => void load("open"), 0);
    return () => clearTimeout(t);
  }, [openCount, tab, load]);

  async function switchTab(t: Tab) {
    setTab(t);
    setConfirming(null);
    await load(t);
  }

  async function act(m: ContactMessageView, action: "close" | "reopen" | "delete") {
    setBusy(m.id);
    try {
      if (action === "delete") await api(`/api/admin/messages/${m.id}`, { method: "DELETE" });
      else await api(`/api/admin/messages/${m.id}`, { method: "PATCH", json: { status: action === "close" ? "closed" : "open" } });
      setConfirming(null);
      await load(tab);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function more() {
    if (!data?.nextBefore) return;
    setLoadingMore(true);
    try {
      const next = await api<AdminMessagesResponse>(`/api/admin/messages?status=${tab}&before=${encodeURIComponent(data.nextBefore)}`);
      setData({ ...next, messages: [...data.messages, ...next.messages] });
    } catch {
      setError("Couldn't load older messages.");
    } finally {
      setLoadingMore(false);
    }
  }

  const counts = data?.counts ?? { open: openCount, closed: 0 };
  return (
    <div>
      <div role="tablist" aria-label="Messages" className="flex gap-1">
        {(["open", "closed"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            className={`btn btn-sm ${tab === t ? "select-bar" : "btn-quiet"}`}
            onClick={() => void switchTab(t)}
          >
            {t === "open" ? "Open" : "Closed"} <span className="tnum">{counts[t]}</span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-4 border-l-2 border-coral pl-3 text-[0.9rem]">
          {error}
        </p>
      )}
      {data && data.messages.length === 0 ? (
        <p className="mt-6 text-ivory-2">
          {tab === "open" ? "No open messages. New messages from the contact page show up here." : "No closed messages."}
        </p>
      ) : null}
      <ol className="mt-4 grid gap-0">
        {data?.messages.map((m) => (
          <li key={m.id} className="border-t hairline py-5">
            <article aria-labelledby={`msg-${m.id}`} className="grid gap-x-8 gap-y-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <header className="min-w-0 text-[0.9rem]">
                <p id={`msg-${m.id}`} className="font-display text-[1.15rem] font-bold">
                  {CONTACT_TOPIC_TEXT[m.topic]}
                </p>
                <p className="mt-1 truncate text-ivory" title={m.name ?? undefined}>
                  {m.name ?? <span className="text-ivory-3">No name given</span>}
                </p>
                <a href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${CONTACT_TOPIC_TEXT[m.topic]}`)}`} className="block truncate text-signal underline" title={m.email}>
                  {m.email}
                </a>
                <p className="mt-1 text-ivory-3">
                  <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString("en-US")}>
                    {ago(m.createdAt, now)}
                  </time>
                  {m.closedAt ? `, closed ${ago(m.closedAt, now)}` : ""}
                </p>
              </header>
              <div className="min-w-0">
                <p className="whitespace-pre-wrap text-[0.95rem] text-ivory [overflow-wrap:anywhere]">{m.message}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {m.status === "open" ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === m.id} onClick={() => void act(m, "close")}>
                      Close
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === m.id} onClick={() => void act(m, "reopen")}>
                      Reopen
                    </button>
                  )}
                  {confirming === m.id ? (
                    <>
                      <button type="button" className="btn btn-coral btn-sm" disabled={busy === m.id} onClick={() => void act(m, "delete")}>
                        Delete for good
                      </button>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(m.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </article>
          </li>
        ))}
      </ol>
      {data?.nextBefore ? (
        <button type="button" className="btn btn-ghost btn-sm mt-2" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? "Loading…" : "Load older messages"}
        </button>
      ) : null}
    </div>
  );
}
