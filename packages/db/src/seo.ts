import type { Queryable } from "./client";

/**
 * Public listings for search engines. Every query applies the same rules an anonymous visitor
 * gets: the channel must be public; listed channels must also have opted in to On Air; library
 * items must be public and ready. Private channels and private or unlisted items never match.
 * Only Twitch creators are listed: local accounts are development-only, and SLOT1's own demo
 * channel is temporary.
 */

export interface SitemapChannelRow {
  login: string;
  updated_at: Date;
}

export interface SitemapItemRow {
  id: string;
  kind: "recording" | "render" | "screenshot" | "twitch_clip" | "clip_export";
  title: string;
  login: string;
  display_name: string;
  created_at: Date;
  updated_at: Date;
  duration_ms: string | number | null;
  poster_asset_id: string | null;
  asset_id: string | null;
}

/** Channels listed on On Air (public, opted in, Twitch connection active). */
export async function listSitemapChannels(db: Queryable, limit = 5000): Promise<SitemapChannelRow[]> {
  const { rows } = await db.query<SitemapChannelRow>(
    `SELECT b.login, GREATEST(b.updated_at, cs.updated_at) AS updated_at
       FROM broadcasters b
       JOIN channel_settings cs ON cs.broadcaster_id = b.id
       JOIN broadcaster_connections bc ON bc.broadcaster_id = b.id
      WHERE b.kind = 'twitch' AND cs.visibility = 'public' AND cs.directory_opt_in AND bc.status = 'active'
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Public creator profiles: listed on On Air (opted in and connected), or sharing a public item. */
export async function listSitemapCreators(db: Queryable, limit = 5000): Promise<SitemapChannelRow[]> {
  const { rows } = await db.query<SitemapChannelRow>(
    `SELECT b.login,
            GREATEST(b.updated_at, cs.updated_at,
                     COALESCE((SELECT MAX(l.updated_at) FROM library_items l
                                WHERE l.broadcaster_id = b.id AND l.visibility = 'public' AND l.status = 'ready'), b.updated_at)) AS updated_at
       FROM broadcasters b
       JOIN channel_settings cs ON cs.broadcaster_id = b.id
      WHERE cs.visibility = 'public' AND b.kind = 'twitch'
        AND ((cs.directory_opt_in AND EXISTS (SELECT 1 FROM broadcaster_connections bc WHERE bc.broadcaster_id = b.id AND bc.status = 'active'))
             OR EXISTS (SELECT 1 FROM library_items l WHERE l.broadcaster_id = b.id AND l.visibility = 'public' AND l.status = 'ready'))
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Public, ready library items of public channels, newest first. */
export async function listSitemapItems(db: Queryable, limit = 5000): Promise<SitemapItemRow[]> {
  const { rows } = await db.query<SitemapItemRow>(
    `SELECT l.id, l.kind, l.title, b.login, b.display_name, l.created_at, l.updated_at, l.duration_ms, l.poster_asset_id, l.asset_id
       FROM library_items l
       JOIN broadcasters b ON b.id = l.broadcaster_id
       JOIN channel_settings cs ON cs.broadcaster_id = l.broadcaster_id
      WHERE l.visibility = 'public' AND l.status = 'ready' AND cs.visibility = 'public' AND b.kind = 'twitch'
      ORDER BY l.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
