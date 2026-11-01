import { spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adminPasswordConfigured,
  adminPasswordFingerprint,
  globalPauseMs,
  hashAdminPassword,
  loginAddressKey,
  parseAdminPasswordHash,
  verifyAdminPassword,
} from "../../apps/api/src/lib/admin-password";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSWORD = "correct horse battery staple";
const FORMAT = /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/;

/** The CLI exactly as `slot1 admin-password` runs it, with the password on stdin. */
function cli(input: string, args: string[] = []) {
  const r = spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "apps/api/src/admin-password.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("admin password hash", () => {
  it("is scrypt N=2^15 r=8 p=1 with a random 16-byte salt, encoded scrypt$N$r$p$salt$hash", async () => {
    const a = await hashAdminPassword(PASSWORD);
    const b = await hashAdminPassword(PASSWORD);
    expect(a).toMatch(FORMAT);
    expect(b).toMatch(FORMAT);
    expect(a).not.toBe(b);
    const h = parseAdminPasswordHash(a)!;
    expect(h).toMatchObject({ N: 2 ** 15, r: 8, p: 1 });
    expect(h.salt).toHaveLength(16);
    expect(h.key).toHaveLength(32);
    expect(a).not.toContain(PASSWORD);
  });

  it("needs at least 12 characters, counted as people count them", async () => {
    await expect(hashAdminPassword("short pass1")).rejects.toThrow(/at least 12/);
    await expect(hashAdminPassword("🔑🔑🔑🔑🔑🔑")).rejects.toThrow(/at least 12/); // 12 UTF-16 units, 6 characters
    expect(await hashAdminPassword("🔑".repeat(12))).toMatch(FORMAT);
    await expect(hashAdminPassword("x".repeat(1025))).rejects.toThrow(/at most 1024/);
  });

  it("verifies the right password only, in constant time on the scrypt output", async () => {
    const stored = await hashAdminPassword(PASSWORD);
    expect(await verifyAdminPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyAdminPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(await verifyAdminPassword(PASSWORD.toUpperCase(), stored)).toBe(false);
    expect(await verifyAdminPassword("", stored)).toBe(false);
    expect(await verifyAdminPassword(undefined, stored)).toBe(false);
    expect(await verifyAdminPassword(12345678901234, stored)).toBe(false);
    expect(await verifyAdminPassword(PASSWORD, null)).toBe(false);
    expect(await verifyAdminPassword(PASSWORD, "scrypt$broken")).toBe(false);
  });

  it("treats composed and decomposed accents as the same password", async () => {
    const composed = "caf\u00e9 au lait, s'il vous pla\u00eet";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const stored = await hashAdminPassword(composed);
    expect(await verifyAdminPassword(decomposed, stored)).toBe(true);
  });

  it("verifies with the parameters stored in the hash", async () => {
    const salt = randomBytes(16);
    const key = scryptSync(PASSWORD, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyAdminPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyAdminPassword("not the password at all", stored)).toBe(false);
  });

  it("accepts the value as an .env file quotes it", async () => {
    const stored = await hashAdminPassword(PASSWORD);
    for (const v of [`'${stored}'`, `"${stored}"`, ` ${stored} `]) {
      expect(adminPasswordConfigured(v)).toBe(true);
      expect(await verifyAdminPassword(PASSWORD, v)).toBe(true);
      expect(adminPasswordFingerprint(v)).toBe(adminPasswordFingerprint(stored));
    }
  });

  it("counts malformed or out-of-range values as no password", () => {
    const s = randomBytes(16).toString("base64");
    const k = randomBytes(32).toString("base64");
    for (const v of [
      null,
      undefined,
      "",
      "changeme",
      `bcrypt$32768$8$1$${s}$${k}`,
      `scrypt$32768$8$1$${s}`,
      `scrypt$30000$8$1$${s}$${k}`, // N not a power of two
      `scrypt$1024$8$1$${s}$${k}`, // too cheap
      `scrypt$2097152$8$1$${s}$${k}`, // too expensive
      `scrypt$32768$0$1$${s}$${k}`,
      `scrypt$32768$8$0$${s}$${k}`,
      `scrypt$32768$8$1$${randomBytes(8).toString("base64")}$${k}`, // salt too short
      `scrypt$32768$8$1$${s}$${randomBytes(8).toString("base64")}`, // hash too short
      `scrypt$32768$8$1$${s}$${k}$extra`,
    ]) {
      expect(adminPasswordConfigured(v), String(v)).toBe(false);
      expect(adminPasswordFingerprint(v)).toBe("none");
    }
  });

  it("tags sessions with a fingerprint that changes with the hash and reveals nothing", async () => {
    const a = await hashAdminPassword(PASSWORD);
    const b = await hashAdminPassword(PASSWORD);
    const fa = adminPasswordFingerprint(a);
    expect(fa).toMatch(/^[0-9a-f]{24}$/);
    expect(adminPasswordFingerprint(a)).toBe(fa);
    expect(adminPasswordFingerprint(b)).not.toBe(fa);
    for (const part of a.split("$").slice(4)) expect(fa).not.toContain(part.slice(0, 8));
  });
});

describe("admin sign-in limits", () => {
  it("keys attempts by an HMAC of the address, never the address", () => {
    const secret = randomBytes(32);
    const k = loginAddressKey(secret, "203.0.113.7");
    expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(k).not.toContain("203");
    expect(loginAddressKey(secret, "203.0.113.7")).toBe(k);
    expect(loginAddressKey(secret, "203.0.113.8")).not.toBe(k);
    expect(loginAddressKey(randomBytes(32), "203.0.113.7")).not.toBe(k);
  });

  it("pauses everyone after 20 failures: 1 minute, doubling every 10 more, at most 15 minutes", () => {
    expect(globalPauseMs(0)).toBe(0);
    expect(globalPauseMs(20)).toBe(0);
    expect(globalPauseMs(21)).toBe(60_000);
    expect(globalPauseMs(30)).toBe(60_000);
    expect(globalPauseMs(31)).toBe(120_000);
    expect(globalPauseMs(41)).toBe(240_000);
    expect(globalPauseMs(51)).toBe(480_000);
    expect(globalPauseMs(61)).toBe(900_000);
    expect(globalPauseMs(10_000)).toBe(900_000);
  });
});

describe("admin-password CLI", () => {
  it("reads the password from stdin and prints SLOT1_ADMIN_PASSWORD_HASH=… as the last line", async () => {
    const r = cli(`${PASSWORD}\n`);
    expect(r.code).toBe(0);
    const last = r.stdout.trim().split("\n").at(-1)!;
    expect(last).toMatch(/^SLOT1_ADMIN_PASSWORD_HASH=scrypt\$/);
    const hash = last.slice("SLOT1_ADMIN_PASSWORD_HASH=".length);
    expect(hash).toMatch(FORMAT);
    expect(await verifyAdminPassword(PASSWORD, hash)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
  }, 60_000);

  it("keeps every character but the final newline (spaces and CRLF included)", async () => {
    const r = cli("  spaced out password  \r\n");
    expect(r.code).toBe(0);
    const hash = r.stdout.trim().split("\n").at(-1)!.split("=").slice(1).join("=");
    expect(await verifyAdminPassword("  spaced out password  ", hash)).toBe(true);
  }, 60_000);

  it("refuses short and multi-line passwords, and never takes one from the command line", () => {
    const short = cli("too short\n");
    expect(short.code).toBe(1);
    expect(short.stdout).toBe("");
    expect(short.stderr).toMatch(/at least 12 characters/);

    const lines = cli("first line is long enough\nsecond line\n");
    expect(lines.code).toBe(1);
    expect(lines.stdout).toBe("");
    expect(lines.stderr).toMatch(/single line/);

    // An argument is ignored: with nothing on stdin there is no password.
    const argv = cli("", [PASSWORD]);
    expect(argv.code).toBe(1);
    expect(argv.stdout).toBe("");
  }, 60_000);
});
