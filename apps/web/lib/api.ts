import type { MeResponse } from "@slot1/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requirement: string | null,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let mePromise: Promise<MeResponse> | null = null;
const listeners = new Set<(me: MeResponse) => void>();

/** Subscribe to identity changes (sign-in, sign-out). Returns an unsubscribe function. */
export function onMeChange(fn: (me: MeResponse) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current identity. Also provides the CSRF token used on every mutation. */
export function getMe(force = false): Promise<MeResponse> {
  if (!mePromise || force) {
    mePromise = fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new ApiError(r.status, "me_failed", "Couldn't reach SLOT1", null);
        return (await r.json()) as MeResponse;
      })
      .then((me) => {
        csrfToken = me.csrfToken;
        if (force) for (const l of listeners) l(me);
        return me;
      })
      .catch((err: unknown) => {
        mePromise = null;
        throw err;
      });
  }
  return mePromise;
}

interface ApiInit extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit;
}

export async function api<T>(path: string, init: ApiInit = {}, retried = false): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await getMe();
    if (csrfToken) headers.set("x-slot1-csrf", csrfToken);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, method, headers, body, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    let err = { code: "error", message: `Request failed (${res.status})`, requirement: null as string | null };
    try {
      const j = (await res.json()) as { error?: typeof err };
      if (j.error) err = { ...err, ...j.error };
    } catch {
      /* non-JSON */
    }
    // A rotated session invalidates the CSRF token: refresh it once and retry.
    if (res.status === 403 && /csrf/i.test(err.message) && !retried) {
      await getMe(true);
      return api<T>(path, init, true);
    }
    throw new ApiError(res.status, err.code, err.message, err.requirement ?? null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
