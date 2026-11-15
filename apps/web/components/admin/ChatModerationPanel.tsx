"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AdminChatResponse, AdminChatReport } from "@slot1/contracts";
import { api, ApiError } from "@/lib/api";
import { relativeAge } from "@/lib/format";

/**
 * Admin → Chat: reported SLOT1 chat messages (dismiss, delete, or ban the writer from every chat)
 * and the people banned from chat (lift a ban). Reports are kept 30 days.
 */
export function ChatModerationPanel() {
  const [data, setData] = useState<AdminChatResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api<AdminChatResponse>("/api/admin/chat")
      .then(setData)
      .catch(() => setNote({ ok: false, text: "Couldn’t load chat reports. Reload the page." }));
  }, []);
  useEffect(load, [load]);

  async function resolve(r: AdminChatReport, action: "dismiss" | "delete" | "ban") {
    setBusy(`${r.room}:${r.messageId}`);
    setNote(null);
    try {
      await api("/api/admin/chat/reports/resolve", { method: "POST", json: { room: r.room, messageId: r.messageId, action } });
      setNote({
        ok: true,
        text: action === "dismiss" ? "Report dismissed." : action === "delete" ? `Deleted ${r.name}’s message.` : `${r.name} is banned from every SLOT1 chat.`,
      });
      load();
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : "That didn’t work. Try again." });
    } finally {
      setBusy(null);
    }
  }

  async function lift(id: string, name: string) {
    setBusy(`ban:${id}`);
    setNote(null);
    try {
      await api(`/api/admin/chat/bans/${id}`, { method: "DELETE" });
      setNote({ ok: true, text: `${name} can chat again.` });
      load();
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : "That didn’t work. Try again." });
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <p className="text-[0.95rem] text-ivory-2">{note?.text ?? "Loading chat reports…"}</p>;

  return (
    <div className="max-w-[56rem] space-y-8">
      <p className="text-[0.95rem] text-ivory-2">
        Messages viewers reported in SLOT1 chat. Links, slurs and sexual terms are blocked before they’re posted; this is for everything else. Creators can
        also delete messages and ban people in their own channel’s chat.
      </p>
      <div aria-live="polite" className="min-h-6 text-[0.9rem]">
        {note && <p className={note.ok ? "text-ivory-2" : "text-coral"}>{note.text}</p>}
      </div>

      <div>
        <h3 className="font-display text-xl font-bold">Reported messages</h3>
        {data.reports.length === 0 ? (
          <p className="mt-2 text-[0.95rem] text-ivory-2">Nothing reported right now.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-line)] border-y hairline">
            {data.reports.map((r) => {
              const key = `${r.room}:${r.messageId}`;
              return (
                <li key={key} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
                  <div className="min-w-0 flex-[1_1_22rem]">
                    <p className="text-[0.85rem] text-ivory-3">
                      <span className="text-ivory-2">{r.name}</span> in{" "}
                      <Link href={`/watch/${r.room}`} className="underline underline-offset-2 hover:text-ivory">
                        {r.room}
                      </Link>
                      , {relativeAge(r.at)} · reported by {r.reports} {r.reports === 1 ? "person" : "people"}
                      {!r.stillInChat && " · no longer in the chat"}
                    </p>
                    <p className="mt-1 break-words text-ivory">{r.text}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === key} onClick={() => void resolve(r, "dismiss")}>
                      Dismiss
                    </button>
                    {r.stillInChat && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy === key} onClick={() => void resolve(r, "delete")}>
                        Delete message
                      </button>
                    )}
                    <button type="button" className="btn btn-coral btn-sm" disabled={busy === key} onClick={() => void resolve(r, "ban")}>
                      Ban from all chats
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <h3 className="font-display text-xl font-bold">Banned from chat</h3>
        {data.bans.length === 0 ? (
          <p className="mt-2 text-[0.95rem] text-ivory-2">Nobody is banned.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-line)] border-y hairline">
            {data.bans.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
                <p className="text-[0.95rem]">
                  <span className="text-ivory">{b.name}</span>
                  <span className="text-ivory-3">
                    {" "}
                    · {b.room ? `in ${b.room}’s chat` : "every chat"} · {relativeAge(b.at)}
                    {b.bannedBy ? ` by ${b.bannedBy}` : ""}
                  </span>
                </p>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === `ban:${b.id}`} onClick={() => void lift(b.id, b.name)}>
                  Lift ban
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
