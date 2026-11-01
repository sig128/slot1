import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { EncryptionKey } from "./config";

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison for strings of possibly different length. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a, "utf8");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn comparable time so length differences are not trivially observable.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacSha256(secret: Buffer | string, message: string | Buffer): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

/**
 * AES-256-GCM envelope for OAuth tokens at rest.
 * Format: v1.<keyId>.<iv>.<ciphertext>.<tag> (base64url parts). The first key in the ring
 * encrypts; any key in the ring can decrypt, which allows key rotation.
 */
export class TokenCipher {
  constructor(private readonly keys: EncryptionKey[]) {}

  get available(): boolean {
    return this.keys.length > 0;
  }

  get activeKeyId(): string {
    const k = this.keys[0];
    if (!k) throw new Error("No token encryption key configured (SLOT1_TOKEN_ENCRYPTION_KEYS)");
    return k.id;
  }

  encrypt(plaintext: string): { value: string; keyId: string } {
    const k = this.keys[0];
    if (!k) throw new Error("No token encryption key configured (SLOT1_TOKEN_ENCRYPTION_KEYS)");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", k.key, iv);
    cipher.setAAD(Buffer.from(`slot1:${k.id}`));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      value: ["v1", k.id, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join("."),
      keyId: k.id,
    };
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Malformed encrypted token");
    const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
    const k = this.keys.find((x) => x.id === keyId);
    if (!k) throw new Error(`Encryption key ${keyId} is not in the key ring`);
    const decipher = createDecipheriv("aes-256-gcm", k.key, Buffer.from(ivB64, "base64url"));
    decipher.setAAD(Buffer.from(`slot1:${k.id}`));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** Short-lived signed tokens (media URLs). Payload is JSON, signature is HMAC-SHA256. */
export function signPayload(secret: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = hmacSha256(secret, `slot1.v1.${body}`).toString("base64url");
  return `${body}.${sig}`;
}

export function verifyPayload<T extends Record<string, unknown>>(
  secret: Buffer,
  token: string,
  nowMs = Date.now(),
): { ok: true; payload: T } | { ok: false; reason: "malformed" | "bad_signature" | "expired" } {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmacSha256(secret, `slot1.v1.${body}`).toString("base64url");
  if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const exp = payload.exp;
  if (typeof exp !== "number" || exp * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
