import { formatTimeParam, parseTimeParam } from "@slot1/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string | null | undefined): v is string => typeof v === "string" && UUID.test(v);

/** A recording or uploaded replay at a moment: `?t=` is the moment itself; players land 3 s early. */
export function replayHref(sessionId: string, momentMs: number | null, observationId?: string | null): string {
  const q = new URLSearchParams();
  if (momentMs !== null && momentMs >= 0) q.set("t", formatTimeParam(momentMs));
  if (observationId) q.set("moment", observationId);
  const s = q.toString();
  return `/replay/${sessionId}${s ? `?${s}` : ""}`;
}

/** Where a saved moment or search result jumps to. Moments with an observation use the short link. */
export function momentHref(m: { observationId: string | null; sessionId: string; sessionKind: string; channelLogin: string; mediaStartMs: number | null }): string {
  if (m.observationId) return `/m/${m.observationId}`;
  if (m.sessionKind === "replay") return replayHref(m.sessionId, m.mediaStartMs);
  return `/watch/${encodeURIComponent(m.channelLogin)}`;
}

/** Read `?t=` and `?moment=` from page search params (anything malformed is ignored, never guessed). */
export function readJumpParams(sp: { t?: string | string[]; moment?: string | string[] }): { tMs: number | null; momentId: string | null } {
  const t = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const moment = Array.isArray(sp.moment) ? sp.moment[0] : sp.moment;
  return { tMs: parseTimeParam(t ?? null), momentId: isUuid(moment) ? moment.toLowerCase() : null };
}
