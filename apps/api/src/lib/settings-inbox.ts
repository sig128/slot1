import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeployStatus, type SettingEntry, type SettingsRequestResult } from "@slot1/contracts";

/**
 * The server's state folder, shared with the `slot1` command (scripts/server-setup.sh). The API
 * container sees it at SLOT1_STATE_DIR (default /srv/slot1-state):
 *   inbox/   read-write: settings saved in /admin wait here for the server to apply them
 *   outbox/  read-only: the server's answers (settings-<id>.json) and the deploy status
 * Request format (the server's apply-settings reads exactly this):
 *   slot1-settings v1
 *   set KEY BASE64VALUE
 *   clear KEY
 */

const ID = /^[a-z0-9]{8,40}$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function inboxDir(stateDir: string) {
  return path.join(stateDir, "inbox");
}
export function outboxDir(stateDir: string) {
  return path.join(stateDir, "outbox");
}

/** 20 lowercase letters and digits. */
export function newRequestId(): string {
  const b = randomBytes(20);
  let out = "";
  for (const x of b) out += ALPHABET[x % ALPHABET.length];
  return out;
}

export function encodeSettingsRequest(entries: SettingEntry[]): string {
  const lines = ["slot1-settings v1"];
  for (const e of entries) lines.push(e.value === null ? `clear ${e.key}` : `set ${e.key} ${Buffer.from(e.value, "utf8").toString("base64")}`);
  return `${lines.join("\n")}\n`;
}

/** Whether this server can take settings from the browser, and if not, why (in plain words). */
export async function inboxStatus(stateDir: string): Promise<{ available: boolean; reason: string | null }> {
  try {
    const s = await stat(inboxDir(stateDir));
    if (!s.isDirectory()) return { available: false, reason: "The server's settings folder is missing." };
    await access(inboxDir(stateDir), constants.W_OK);
    return { available: true, reason: null };
  } catch {
    return {
      available: false,
      reason: "Saving settings here needs a server installed with SLOT1's setup script (it shares a settings folder with the API). On this server, change them on the server itself.",
    };
  }
}

/** Leaves one request in the inbox: written to a dot-file first, then renamed, so the server never reads half of it. */
export async function writeSettingsRequest(stateDir: string, entries: SettingEntry[]): Promise<string> {
  const id = newRequestId();
  const body = encodeSettingsRequest(entries);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("settings request too large");
  const dir = inboxDir(stateDir);
  const tmp = path.join(dir, `.tmp-${id}`);
  await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
  await rename(tmp, path.join(dir, `${id}.settings`));
  return id;
}

const Answer = (raw: unknown): { ok: boolean; detail: string | null; at: string | null } | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  return { ok: r.ok, detail: typeof r.detail === "string" ? r.detail.slice(0, 200) : null, at: typeof r.at === "string" ? r.at : null };
};

export async function requestResult(stateDir: string, id: string): Promise<SettingsRequestResult> {
  if (!ID.test(id)) return { id, status: "unknown", detail: null, at: null };
  try {
    const a = Answer(JSON.parse(await readFile(path.join(outboxDir(stateDir), `settings-${id}.json`), "utf8")));
    if (a) return { id, status: a.ok ? "applied" : "refused", detail: a.detail, at: a.at };
  } catch {
    // No answer yet.
  }
  try {
    await access(path.join(inboxDir(stateDir), `${id}.settings`));
    return { id, status: "pending", detail: null, at: null };
  } catch {
    return { id, status: "unknown", detail: null, at: null };
  }
}

/** The server's latest answers, newest first. */
export async function recentResults(stateDir: string, limit = 8): Promise<SettingsRequestResult[]> {
  let names: string[];
  try {
    names = (await readdir(outboxDir(stateDir))).filter((n) => /^settings-[a-z0-9]{8,40}\.json$/.test(n));
  } catch {
    return [];
  }
  const withTimes = await Promise.all(
    names.map(async (n) => {
      try {
        return { n, t: (await stat(path.join(outboxDir(stateDir), n))).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    }),
  );
  withTimes.sort((a, b) => b.t - a.t);
  return Promise.all(withTimes.slice(0, limit).map(({ n }) => requestResult(stateDir, n.slice("settings-".length, -".json".length))));
}

export async function readDeployStatus(stateDir: string): Promise<DeployStatus | null> {
  try {
    const p = DeployStatus.safeParse(JSON.parse(await readFile(path.join(outboxDir(stateDir), "deploy.json"), "utf8")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** The last `lines` lines of the last deploy's output (read from the end, so a huge log costs little). */
export async function readDeployLog(stateDir: string, lines = 200): Promise<string | null> {
  const file = path.join(outboxDir(stateDir), "deploy.log");
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    const take = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(take);
    await fh.read(buf, 0, take, size - take);
    // Colors and cursor moves from the build tools, then the tail.
    // eslint-disable-next-line no-control-regex -- removing terminal escape codes is the point
    const text = buf.toString("utf8").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n");
    return text.split("\n").slice(-lines).join("\n").trimEnd();
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
