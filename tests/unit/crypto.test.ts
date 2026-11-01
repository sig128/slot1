import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEncryptionKeys, signPayload, TokenCipher, verifyPayload } from "@slot1/platform";

const k = (id: string) => ({ id, key: randomBytes(32) });

describe("TokenCipher", () => {
  it("round-trips and never stores plaintext", () => {
    const c = new TokenCipher([k("k1")]);
    const { value, keyId } = c.encrypt("oauth-access-token-value");
    expect(keyId).toBe("k1");
    expect(value).not.toContain("oauth-access-token-value");
    expect(value.startsWith("v1.k1.")).toBe(true);
    expect(c.decrypt(value)).toBe("oauth-access-token-value");
  });

  it("decrypts with an older key after rotation and encrypts with the newest", () => {
    const old = k("k1");
    const enc = new TokenCipher([old]).encrypt("refresh-token").value;
    const rotated = new TokenCipher([k("k2"), old]);
    expect(rotated.decrypt(enc)).toBe("refresh-token");
    expect(rotated.encrypt("x").keyId).toBe("k2");
  });

  it("detects tampering and unknown keys", () => {
    const c = new TokenCipher([k("k1")]);
    const parts = c.encrypt("token").value.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64url");
    expect(() => c.decrypt(parts.join("."))).toThrow();
    expect(() => new TokenCipher([k("other")]).decrypt(c.encrypt("t").value)).toThrow(/not in the key ring/);
    expect(() => c.decrypt("plaintext")).toThrow(/Malformed/);
  });

  it("parses the key ring spec", () => {
    const keys = parseEncryptionKeys(`new:${randomBytes(32).toString("base64")},old:${randomBytes(32).toString("base64")}`);
    expect(keys.map((x) => x.id)).toEqual(["new", "old"]);
    expect(() => parseEncryptionKeys(`short:${randomBytes(8).toString("base64")}`)).toThrow();
  });
});

describe("signed payloads", () => {
  const secret = randomBytes(32);
  it("verifies, expires and rejects tampering", () => {
    const now = Date.now();
    const token = signPayload(secret, { k: "a/b.jpg", exp: Math.floor(now / 1000) + 60 });
    expect(verifyPayload(secret, token, now)).toMatchObject({ ok: true, payload: { k: "a/b.jpg" } });
    expect(verifyPayload(secret, token, now + 120_000)).toEqual({ ok: false, reason: "expired" });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "other.jpg", exp: Math.floor(now / 1000) + 60 })).toString("base64url");
    expect(verifyPayload(secret, `${forged}.${sig}`, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyPayload(randomBytes(32), `${body}.${sig}`, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyPayload(secret, "nodot", now)).toEqual({ ok: false, reason: "malformed" });
  });
});
