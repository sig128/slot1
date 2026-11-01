import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  CreateRelayDestinationInput,
  UpdateRelayDestinationInput,
  type IngestCredentials,
  type RelayDestinationView,
  type RelayOverview,
} from "@slot1/contracts";
import {
  countRelayDestinations,
  createIngestSource,
  deleteRelayDestination,
  getRelayDestination,
  insertRelayDestination,
  listRelayDestinations,
  listSources,
  updateRelayDestination,
  type MediaSourceRow,
} from "@slot1/db";
import { randomToken, sha256 } from "@slot1/platform";
import {
  assertPublicRelayHost,
  hasTwitchForwardingPermission,
  parseRelayServerUrl,
  RELAY_PLATFORM_LABEL,
  RelayDestinationError,
  relayDestinationView,
  validateStreamKey,
  type ServerContext,
} from "@slot1/services";
import { badRequest, conflict, notFound, unavailable } from "../lib/errors";
import { requireBroadcaster } from "../lib/session";
import { publishCredentials } from "./studio";

const IdParam = z.object({ id: z.string().uuid() });
/** Re-authorizes Twitch with channel:read:stream_key added, then lands back on Studio → Stream setup. */
const PERMISSION_URL = `/api/auth/twitch/start?relay=1&returnTo=${encodeURIComponent("/studio?tab=stream")}`;

/** The creator's main SLOT1 ingest: the newest LIVE source. Only LIVE sources are ever forwarded. */
function mainLiveSource(sources: MediaSourceRow[]): MediaSourceRow | null {
  return sources.filter((s) => s.kind === "live_ingest" && s.label === "live" && !s.revoked_at).sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null;
}

/**
 * Forwarding ("relay"): the creator streams once to SLOT1, and SLOT1 passes the same stream on
 * to Twitch, YouTube, Kick or a custom server. Keys are write-only and stored encrypted.
 */
export const relayRoutes =
  (ctx: ServerContext): FastifyPluginAsync =>
  async (app) => {
    const env = ctx.config.env;

    async function sealKey(key: string) {
      const enc = ctx.cipher.encrypt(validateStreamKey(key));
      return { keyEnc: enc.value, keyId: enc.keyId, keyHint: key.trim().slice(-4) };
    }

    async function checkServer(raw: string): Promise<string> {
      const url = parseRelayServerUrl(raw);
      await assertPublicRelayHost(url, env.RELAY_ALLOW_PRIVATE_DESTINATIONS);
      // Kept as pasted (some servers care about the path's case), with the scheme lowercased.
      return raw.trim().replace(/^rtmps?:\/\//i, (m) => m.toLowerCase());
    }

    const userError = (err: unknown) => (err instanceof RelayDestinationError ? badRequest(err.message) : err);

    app.get("/api/studio/relay", async (req): Promise<RelayOverview> => {
      const b = requireBroadcaster(req);
      const src = mainLiveSource(await listSources(ctx.db, b.id));
      const cap = ctx.config.capabilities.relay;
      const forwardingPermission = await hasTwitchForwardingPermission(ctx, b.twitch_user_id);
      const destinations = (await listRelayDestinations(ctx.db, b.id)).map((d) => relayDestinationView(d, ctx));
      return {
        available: cap.available,
        reason: cap.reason,
        ingest: {
          server: env.INGEST_PUBLIC_RTMP_URL ?? null,
          sourceId: src?.id ?? null,
          keyHint: src?.publish_key_hint ?? null,
          publishing: src?.status === "publishing",
        },
        twitch: {
          connected: b.kind === "twitch" && Boolean(b.twitch_user_id),
          forwardingPermission,
          permissionUrl: b.kind === "twitch" && ctx.oauth ? PERMISSION_URL : null,
        },
        destinations,
        maxDestinations: env.RELAY_MAX_DESTINATIONS,
        youtubeServer: env.RELAY_YOUTUBE_INGEST_URL,
      };
    });

    /**
     * The one Server + Key the creator pastes into OBS (or that "Set up OBS automatically" sends
     * to OBS). A fresh key every time: only its hash is stored, so it can't be shown again later.
     */
    app.post("/api/studio/relay/ingest-credentials", async (req): Promise<IngestCredentials> => {
      const b = requireBroadcaster(req);
      const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
      if (!ctx.config.capabilities.ingest.available) throw unavailable("Streaming to SLOT1 isn't configured on this deployment", ctx.config.capabilities.ingest.reason);
      let src = mainLiveSource(await listSources(ctx.db, b.id));
      if (src?.status === "publishing" && !force) {
        throw conflict("You're streaming to SLOT1 right now", "A new key would cut your stream. Stop streaming first, or keep using the key you have");
      }
      const secret = randomToken(24).replace(/[^A-Za-z0-9]/g, "x");
      if (!src) {
        const name = `s${randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)}${Date.now().toString(36).slice(-4)}`;
        src = await createIngestSource(ctx.db, { broadcasterId: b.id, name: "OBS", label: "live", publishPath: `live/${name}`, keyHash: sha256(secret), keyHint: secret.slice(-4) });
      } else {
        await ctx.db.query(`UPDATE media_sources SET publish_key_hash = $2, publish_key_hint = $3, updated_at = now() WHERE id = $1`, [src.id, sha256(secret), secret.slice(-4)]);
      }
      const creds = publishCredentials(ctx, src.publish_path!, secret);
      return { server: env.INGEST_PUBLIC_RTMP_URL ?? "", streamKey: creds.streamKey, sourceId: src.id };
    });

    app.post("/api/studio/relay/destinations", async (req): Promise<RelayDestinationView> => {
      const b = requireBroadcaster(req);
      const input = CreateRelayDestinationInput.parse(req.body);
      if (!ctx.config.capabilities.relay.available) throw unavailable("Forwarding isn't configured on this deployment", ctx.config.capabilities.relay.reason);
      if ((await countRelayDestinations(ctx.db, b.id)) >= env.RELAY_MAX_DESTINATIONS) throw conflict(`You can forward to at most ${env.RELAY_MAX_DESTINATIONS} places`);
      if (input.platform === "twitch" && (b.kind !== "twitch" || !b.twitch_user_id)) throw badRequest("Connect your Twitch account first");
      try {
        const sealed = input.platform === "twitch" ? { keyEnc: null, keyId: null, keyHint: null } : await sealKey(input.streamKey);
        const serverUrl =
          input.platform === "twitch" ? null : await checkServer(input.platform === "youtube" ? (input.serverUrl ?? env.RELAY_YOUTUBE_INGEST_URL) : input.serverUrl);
        const row = await insertRelayDestination(ctx.db, {
          broadcasterId: b.id,
          platform: input.platform,
          label: input.label ?? RELAY_PLATFORM_LABEL[input.platform],
          serverUrl,
          ...sealed,
        });
        return relayDestinationView(row, ctx);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw conflict(`You already forward to ${RELAY_PLATFORM_LABEL[input.platform]}`);
        throw userError(err);
      }
    });

    app.patch("/api/studio/relay/destinations/:id", async (req): Promise<RelayDestinationView> => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      const input = UpdateRelayDestinationInput.parse(req.body);
      const row = await getRelayDestination(ctx.db, id);
      if (!row || row.broadcaster_id !== b.id) throw notFound("Destination not found");
      if (row.platform === "twitch" && (input.streamKey !== undefined || input.serverUrl !== undefined)) {
        throw badRequest("Twitch's key comes from your Twitch connection; there's nothing to paste");
      }
      try {
        const sealed = input.streamKey !== undefined ? await sealKey(input.streamKey) : {};
        const serverUrl = input.serverUrl !== undefined ? await checkServer(input.serverUrl) : undefined;
        let updated = await updateRelayDestination(ctx.db, id, { label: input.label, enabled: input.enabled, serverUrl, ...sealed });
        // New credentials clear a previous error so the relay tries again.
        if (updated && (input.streamKey !== undefined || input.serverUrl !== undefined) && updated.enabled && updated.status === "error") {
          await ctx.db.query(`UPDATE relay_destinations SET status = 'idle', status_detail = NULL, status_changed_at = now() WHERE id = $1`, [id]);
          updated = await getRelayDestination(ctx.db, id);
        }
        return relayDestinationView(updated!, ctx);
      } catch (err) {
        throw userError(err);
      }
    });

    app.delete("/api/studio/relay/destinations/:id", async (req) => {
      const b = requireBroadcaster(req);
      const { id } = IdParam.parse(req.params);
      if (!(await deleteRelayDestination(ctx.db, b.id, id))) throw notFound("Destination not found");
      return { ok: true };
    });
  };
