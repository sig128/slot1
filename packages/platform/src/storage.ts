import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "./config";
import { signPayload } from "./crypto";

export interface StoredObject {
  stream: Readable;
  contentLength: number;
  contentType: string | null;
}

export interface StorageDriver {
  readonly driver: "fs" | "s3";
  putFile(key: string, filePath: string, contentType: string): Promise<{ bytes: number }>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<{ bytes: number }>;
  getStream(key: string, range?: { start: number; end: number }): Promise<StoredObject>;
  size(key: string): Promise<number | null>;
  downloadToFile(key: string, filePath: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  /** Short-lived URL the browser can use. Authorization must happen before calling this. */
  signedGetUrl(key: string, ttlSeconds: number, contentType: string): Promise<string>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,511}$/;

/** Validate object keys so they can never escape the storage root. */
export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new Error("Invalid storage key");
  }
}

export class FsStorage implements StorageDriver {
  readonly driver = "fs" as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly secret: Buffer,
    private readonly urlBase = "/api/media/f",
  ) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  /** Local path for server-side readers (ffmpeg seeks inside large files without copying them). */
  localPath(key: string): string {
    return this.resolve(key);
  }

  async putFile(key: string, filePath: string, _contentType: string): Promise<{ bytes: number }> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    await pipeline(createReadStream(filePath), createWriteStream(tmp));
    await rename(tmp, dest);
    const s = await stat(dest);
    return { bytes: s.size };
  }

  async putBuffer(key: string, body: Buffer, _contentType: string): Promise<{ bytes: number }> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    await pipeline(Readable.from([body]), createWriteStream(tmp));
    await rename(tmp, dest);
    return { bytes: body.length };
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<StoredObject> {
    const full = this.resolve(key);
    const s = await stat(full);
    if (range) {
      const end = Math.min(range.end, s.size - 1);
      return { stream: createReadStream(full, { start: range.start, end }), contentLength: end - range.start + 1, contentType: null };
    }
    return { stream: createReadStream(full), contentLength: s.size, contentType: null };
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.resolve(key))).size;
    } catch {
      return null;
    }
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(createReadStream(this.resolve(key)), createWriteStream(filePath));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, "");
    assertSafeKey(clean);
    const dir = this.resolve(clean);
    let count = 0;
    try {
      const walk = async (d: string): Promise<void> => {
        for (const entry of await readdir(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) await walk(p);
          else count += 1;
        }
      };
      await walk(dir);
    } catch {
      return 0;
    }
    await rm(dir, { recursive: true, force: true });
    return count;
  }

  async signedGetUrl(key: string, ttlSeconds: number, contentType: string): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.urlBase}/${signPayload(this.secret, { k: key, exp, ct: contentType })}`;
  }
}

export class S3Storage implements StorageDriver {
  readonly driver = "s3" as const;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(
    private readonly bucket: string,
    opts: {
      endpoint: string | null;
      publicEndpoint: string | null;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    },
  ) {
    const base = {
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    };
    this.client = new S3Client({ ...base, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
    const pub = opts.publicEndpoint ?? opts.endpoint;
    this.presignClient = new S3Client({ ...base, ...(pub ? { endpoint: pub } : {}) });
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<{ bytes: number }> {
    assertSafeKey(key);
    const s = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(filePath), ContentLength: s.size, ContentType: contentType }),
    );
    return { bytes: s.size };
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<{ bytes: number }> {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: contentType }));
    return { bytes: body.length };
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<StoredObject> {
    assertSafeKey(key);
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }),
    );
    if (!res.Body) throw new Error("Empty object body");
    return { stream: res.Body as Readable, contentLength: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null };
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return Number(res.ContentLength ?? 0);
    } catch {
      return null;
    }
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const { stream } = await this.getStream(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(stream, createWriteStream(filePath));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    let token: string | undefined;
    do {
      const list = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (list.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        count += keys.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return count;
  }

  async signedGetUrl(key: string, ttlSeconds: number, contentType: string): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: contentType }), {
      expiresIn: ttlSeconds,
    });
  }
}

export function createStorage(config: AppConfig): StorageDriver {
  const env = config.env;
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(config.capabilities.storage.reason ?? "S3 storage misconfigured");
    }
    return new S3Storage(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return new FsStorage(env.STORAGE_FS_ROOT, config.sessionSecret);
}

/** Canonical storage key layout. Everything for a session lives under one prefix. */
export const storageKeys = {
  sessionPrefix: (broadcasterId: string, sessionId: string) => `b/${broadcasterId}/s/${sessionId}`,
  original: (b: string, s: string, sourceId: string, ext: string) => `b/${b}/s/${s}/src/${sourceId}/original.${ext}`,
  playback: (b: string, s: string, sourceId: string) => `b/${b}/s/${s}/src/${sourceId}/playback.mp4`,
  poster: (b: string, s: string, sourceId: string) => `b/${b}/s/${s}/src/${sourceId}/poster.jpg`,
  frame: (b: string, s: string, sourceId: string, ptsMs: number) =>
    `b/${b}/s/${s}/src/${sourceId}/frames/${String(Math.max(0, Math.round(ptsMs))).padStart(10, "0")}.jpg`,
  clip: (b: string, s: string, clipId: string, variant: string) => `b/${b}/s/${s}/clips/${clipId}/${variant}.mp4`,
  audioChunk: (b: string, s: string, sourceId: string, startMs: number) => `b/${b}/s/${s}/src/${sourceId}/audio/${startMs}.mp3`,
  /** Recording segments and the finalized file live with their session (deleted with it). */
  recordingSegment: (b: string, s: string, runId: string, name: string) => `b/${b}/s/${s}/recording/runs/${runId}/${name}`,
  recordingFile: (b: string, s: string, version: string, name: string) => `b/${b}/s/${s}/recording/${version}/${name}`,
  /** Library files live outside any session so clips and screenshots outlive their source. */
  library: (b: string, itemId: string, name: string) => `b/${b}/library/${itemId}/${name}`,
  libraryPrefix: (b: string, itemId: string) => `b/${b}/library/${itemId}`,
};
