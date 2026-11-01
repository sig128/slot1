-- SLOT1 0004: forwarding ("relay") of a creator's SLOT1 ingest to Twitch, YouTube, Kick or a
-- custom RTMP(S) server, creator chat controls, and opt-in chat announcements.

ALTER TABLE channel_settings ADD COLUMN chat_announcements boolean NOT NULL DEFAULT false;

-- The new creator controls (!slot1 record / autoclip / relay) are privileged commands; they are
-- allowed by default like pause/resume/mute/unmute, including for channels that already exist.
ALTER TABLE channel_settings ALTER COLUMN allowed_commands
  SET DEFAULT ARRAY['help','status','now','recap','clip','find','ask','pause','resume','mute','unmute','record','autoclip','relay'];
UPDATE channel_settings
   SET allowed_commands = allowed_commands || ARRAY(
         SELECT c FROM unnest(ARRAY['record','autoclip','relay']) AS c WHERE NOT (c = ANY (allowed_commands)));

CREATE TABLE relay_destinations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id     uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('twitch', 'youtube', 'kick', 'custom')),
  label              text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  -- Twitch uses SLOT1's configured ingest; everything else stores the server the creator gave.
  server_url         text CHECK (server_url IS NULL OR server_url ~ '^rtmps?://'),
  -- Stream key, encrypted with the token key ring (never stored or returned in plain text).
  key_enc            text,
  key_id             text,
  key_hint           text,
  enabled            boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'disabled'
                     CHECK (status IN ('disabled', 'idle', 'connecting', 'live', 'retrying', 'error', 'needs_permission')),
  status_detail      text,
  last_connected_at  timestamptz,
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (platform = 'twitch' OR (key_enc IS NOT NULL AND server_url IS NOT NULL)),
  CHECK (platform <> 'twitch' OR server_url IS NULL),
  CHECK ((key_enc IS NULL) = (key_id IS NULL))
);
CREATE UNIQUE INDEX relay_destinations_one_per_platform ON relay_destinations (broadcaster_id, platform) WHERE platform <> 'custom';
CREATE INDEX relay_destinations_enabled ON relay_destinations (broadcaster_id) WHERE enabled;
