import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SitemapResponse } from "@slot1/contracts";
import {
  createLocalBroadcaster,
  createLocalUser,
  insertAsset,
  insertLibraryItem,
  updateSettings,
  upsertConnection,
  upsertGrant,
  upsertTwitchBroadcaster,
  upsertTwitchUser,
} from "@slot1/db";
import { storageKeys } from "@slot1/platform";
import { clearSitemapCache } from "../../apps/api/src/routes/seo";
import { Browser, startHarness, type Harness } from "./harness";

/**
 * What search engines may list, against the real API and SQL: only what an anonymous visitor can
 * already open. Private channels, private and unlisted items, unfinished items and local or demo
 * channels never appear, and the stable media address answers only for public videos.
 */
describe("search engine listing", () => {
  let h: Harness;
  let anon: Browser;
  let seq = 0;

  async function twitchCreator(login: string, o: { visibility: "public" | "private"; directory: boolean; connected?: boolean }) {
    seq += 1;
    const id = `880${seq}${randomBytes(2).toString("hex")}`;
    const user = await upsertTwitchUser(h.ctx.db, id, login, false);
    const b = await upsertTwitchBroadcaster(h.ctx.db, { ownerUserId: user.id, twitchUserId: id, login, displayName: login.toUpperCase(), avatarUrl: null });
    if (o.connected ?? true) {
      const grant = await upsertGrant(h.ctx.db, { role: "broadcaster", twitchUserId: id, twitchLogin: login, scopes: [], accessTokenEnc: "x", refreshTokenEnc: null, keyId: "it1", expiresInSec: 3600 });
      await upsertConnection(h.ctx.db, b.id, grant.id);
    }
    await updateSettings(h.ctx.db, b.id, { visibility: o.visibility, directoryOptIn: o.visibility === "public" && o.directory });
    return b;
  }

  async function item(broadcasterId: string, o: { kind: "render" | "screenshot" | "recording"; visibility: "public" | "unlisted" | "private"; status?: "ready" | "processing"; title: string }) {
    const itemId = randomUUID();
    const key = storageKeys.library(broadcasterId, itemId, o.kind === "screenshot" ? "shot.jpg" : "clip.mp4");
    const contentType = o.kind === "screenshot" ? "image/jpeg" : "video/mp4";
    const { bytes } = await h.ctx.storage.putBuffer(key, randomBytes(64), contentType);
    const asset = await insertAsset(h.ctx.db, { broadcasterId, sessionId: null, sourceId: null, kind: o.kind === "screenshot" ? "screenshot" : "render", storageKey: key, contentType, bytes, mediaPtsMs: null });
    const posterKey = storageKeys.library(broadcasterId, itemId, "poster.jpg");
    await h.ctx.storage.putBuffer(posterKey, randomBytes(32), "image/jpeg");
    const poster = await insertAsset(h.ctx.db, { broadcasterId, sessionId: null, sourceId: null, kind: "poster", storageKey: posterKey, contentType: "image/jpeg", bytes: 32, mediaPtsMs: null });
    return insertLibraryItem(h.ctx.db, {
      broadcasterId,
      kind: o.kind,
      title: o.title,
      status: o.status ?? "ready",
      visibility: o.visibility,
      assetId: asset.id,
      posterAssetId: o.kind === "screenshot" ? null : poster.id,
      durationMs: o.kind === "screenshot" ? null : 42_000,
    });
  }

  async function sitemap(): Promise<SitemapResponse> {
    clearSitemapCache();
    const r = await anon.get("/api/seo/sitemap");
    expect(r.status).toBe(200);
    return r.json<SitemapResponse>();
  }

  let listed: { id: string; login: string };
  let sharing: { id: string; login: string };
  let publicClip: { id: string };
  let publicShot: { id: string };
  const hiddenIds: string[] = [];
  const hiddenLogins: string[] = [];
  let localClip: { id: string };

  beforeAll(async () => {
    h = await startHarness();
    anon = new Browser(h);
    await anon.refreshCsrf();

    // Listed on On Air: appears as a channel and as a creator.
    listed = await twitchCreator("listedcruiser", { visibility: "public", directory: true });
    // Public channel that isn't on On Air but shares public items: a creator, not a channel.
    sharing = await twitchCreator("clipsharer", { visibility: "public", directory: false });
    publicClip = await item(sharing.id, { kind: "render", visibility: "public", title: "Docks run" });
    publicShot = await item(sharing.id, { kind: "screenshot", visibility: "public", title: "Sunset over Vinewood" });
    hiddenIds.push((await item(sharing.id, { kind: "render", visibility: "unlisted", title: "Unlisted take" })).id);
    hiddenIds.push((await item(sharing.id, { kind: "render", visibility: "private", title: "Private take" })).id);
    hiddenIds.push((await item(sharing.id, { kind: "render", visibility: "public", status: "processing", title: "Still rendering" })).id);

    // A private channel's "public" item is still private.
    const secret = await twitchCreator("privateheister", { visibility: "private", directory: false });
    hiddenLogins.push(secret.login);
    hiddenIds.push((await item(secret.id, { kind: "render", visibility: "public", title: "Private channel clip" })).id);

    // Opted in but disconnected from Twitch: not on On Air.
    const gone = await twitchCreator("disconnectedone", { visibility: "public", directory: true, connected: false });
    hiddenLogins.push(gone.login);

    // Local accounts (development only, and SLOT1's own demo channel) are never listed.
    const localUser = await createLocalUser(h.ctx.db, "Local Tester");
    const local = await createLocalBroadcaster(h.ctx.db, localUser.id, `local${randomBytes(3).toString("hex")}`, "Local Tester");
    await updateSettings(h.ctx.db, local.id, { visibility: "public" });
    hiddenLogins.push(local.login);
    localClip = await item(local.id, { kind: "render", visibility: "public", title: "Local clip" });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("lists On Air channels, public creators and public items", async () => {
    const s = await sitemap();
    // Other test files share this database, so check membership rather than the whole list.
    const channels = s.channels.map((c) => c.login);
    const creators = s.creators.map((c) => c.login);
    expect(channels).toContain("listedcruiser");
    expect(channels).not.toContain("clipsharer");
    expect(creators).toEqual(expect.arrayContaining(["clipsharer", "listedcruiser"]));
    const ids = s.items.map((i) => i.id);
    expect(ids).toContain(publicClip.id);
    expect(ids).toContain(publicShot.id);
    const clip = s.items.find((i) => i.id === publicClip.id)!;
    expect(clip).toMatchObject({ kind: "render", title: "Docks run", login: "clipsharer", durationMs: 42_000, hasPoster: true, mediaPath: `/api/seo/media/${publicClip.id}` });
    // Screenshots are images: they have a poster (the image itself) but no video address.
    expect(s.items.find((i) => i.id === publicShot.id)).toMatchObject({ hasPoster: true, mediaPath: null });
    expect(listed.login).toBe("listedcruiser");
  });

  it("never lists private, unlisted, unfinished, local or disconnected things", async () => {
    const s = await sitemap();
    const raw = JSON.stringify(s);
    for (const id of [...hiddenIds, localClip.id]) expect(raw).not.toContain(id);
    for (const login of hiddenLogins) expect(raw).not.toContain(login);
    expect(raw).not.toMatch(/Private take|Unlisted take|Still rendering|Private channel clip|Local clip/);
  });

  it("follows privacy changes once the cache refreshes", async () => {
    await updateSettings(h.ctx.db, sharing.id, { visibility: "private", directoryOptIn: false });
    const s = await sitemap();
    expect(s.creators.map((c) => c.login)).not.toContain("clipsharer");
    expect(s.items.map((i) => i.id)).not.toContain(publicClip.id);
    await updateSettings(h.ctx.db, sharing.id, { visibility: "public" });
  });

  it("redirects crawlers to a fresh signed address for public videos only", async () => {
    const r = await anon.get(`/api/seo/media/${publicClip.id}`);
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toMatch(/^\/api\/media\//);
    expect(r.headers["cache-control"]).toBe("no-store");
    // The signed address really serves the file.
    const media = await anon.get(String(r.headers.location));
    expect(media.status).toBe(200);
    for (const id of [...hiddenIds, publicShot.id, randomUUID()]) expect((await anon.get(`/api/seo/media/${id}`)).status, id).toBe(404);
    // A local channel's public clip isn't listed, but anyone can already play it from its page.
    expect((await anon.get(`/api/seo/media/${localClip.id}`)).status).toBe(302);
    expect((await anon.get("/api/seo/media/not-a-uuid")).status).toBe(400);
  });

  it("caches the listing for search engines", async () => {
    const r = await anon.get("/api/seo/sitemap");
    expect(r.headers["cache-control"]).toBe("public, max-age=600");
  });
});
