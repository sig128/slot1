-- SLOT1 initial schema.
-- Conventions: uuid primary keys, timestamptz everywhere, CHECK constraints for enums,
-- idempotency keys for webhook processing and clip requests. Raw secrets are never stored:
-- OAuth tokens are AES-256-GCM encrypted, session ids / stream keys / OAuth states are hashed.

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('twitch', 'local')),
  twitch_user_id   text UNIQUE,
  display_name     text NOT NULL,
  is_operator      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'twitch') = (twitch_user_id IS NOT NULL))
);

-- Browser sessions. Only a SHA-256 of the cookie value is stored.
CREATE TABLE user_sessions (
  id_hash       bytea PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);

-- OAuth authorization-code state, bound to the browser session that started the flow.
CREATE TABLE oauth_states (
  state_hash        bytea PRIMARY KEY,
  session_id_hash   bytea NOT NULL REFERENCES user_sessions(id_hash) ON DELETE CASCADE,
  role              text NOT NULL CHECK (role IN ('broadcaster', 'bot')),
  redirect_uri      text NOT NULL,
  requested_scopes  text[] NOT NULL,
  return_to         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz
);

CREATE TABLE broadcasters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('twitch', 'local')),
  twitch_user_id   text UNIQUE,
  login            text NOT NULL,
  display_name     text NOT NULL,
  avatar_url       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'twitch') = (twitch_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX broadcasters_twitch_login_idx ON broadcasters (lower(login)) WHERE kind = 'twitch';
CREATE INDEX broadcasters_owner_idx ON broadcasters (owner_user_id);

-- Encrypted Twitch grants. Broadcaster identity and bot identity are distinct rows/roles.
CREATE TABLE encrypted_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role                text NOT NULL CHECK (role IN ('broadcaster', 'bot')),
  twitch_user_id      text NOT NULL,
  twitch_login        text NOT NULL,
  scopes              text[] NOT NULL,
  access_token_enc    text NOT NULL,
  refresh_token_enc   text,
  key_id              text NOT NULL,
  access_expires_at   timestamptz,
  status              text NOT NULL CHECK (status IN ('active', 'refresh_failed', 'revoked')),
  last_validated_at   timestamptz,
  last_refreshed_at   timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, twitch_user_id)
);

CREATE TABLE broadcaster_connections (
  broadcaster_id     uuid PRIMARY KEY REFERENCES broadcasters(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('active', 'refresh_failed', 'revoked', 'disconnected')),
  grant_id           uuid REFERENCES encrypted_grants(id) ON DELETE SET NULL,
  connected_at       timestamptz NOT NULL DEFAULT now(),
  disconnected_at    timestamptz,
  last_validated_at  timestamptz,
  last_error         text
);

-- Cached app access token (client-credentials). Encrypted like user grants.
CREATE TABLE app_tokens (
  client_id         text PRIMARY KEY,
  access_token_enc  text NOT NULL,
  key_id            text NOT NULL,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_settings (
  broadcaster_id            uuid PRIMARY KEY REFERENCES broadcasters(id) ON DELETE CASCADE,
  visibility                text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  directory_opt_in          boolean NOT NULL DEFAULT false,
  public_analysis           boolean NOT NULL DEFAULT false,
  viewer_questions          text NOT NULL DEFAULT 'off' CHECK (viewer_questions IN ('off', 'signed_in', 'anyone')),
  bot_enabled               boolean NOT NULL DEFAULT false,
  bot_killed                boolean NOT NULL DEFAULT false,
  commentary_mode           text NOT NULL DEFAULT 'off' CHECK (commentary_mode IN ('off', 'rare', 'normal')),
  commentary_muted          boolean NOT NULL DEFAULT false,
  allowed_commands          text[] NOT NULL DEFAULT ARRAY['help','status','now','recap','clip','find','ask','pause','resume','mute','unmute'],
  short_aliases_enabled     boolean NOT NULL DEFAULT false,
  clip_permission           text NOT NULL DEFAULT 'approved_moderators'
                              CHECK (clip_permission IN ('broadcaster', 'approved_moderators', 'moderators', 'vips', 'everyone')),
  approved_moderator_ids    text[] NOT NULL DEFAULT '{}',
  user_cooldown_sec         int NOT NULL DEFAULT 30 CHECK (user_cooldown_sec BETWEEN 5 AND 600),
  channel_cooldown_sec      int NOT NULL DEFAULT 8 CHECK (channel_cooldown_sec BETWEEN 2 AND 300),
  agent_enabled             boolean NOT NULL DEFAULT false,
  analysis_paused           boolean NOT NULL DEFAULT false,
  recording_consent         boolean NOT NULL DEFAULT false,
  rolling_buffer_enabled    boolean NOT NULL DEFAULT false,
  rolling_buffer_seconds    int NOT NULL DEFAULT 180 CHECK (rolling_buffer_seconds BETWEEN 30 AND 900),
  retention_days            int NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  sample_interval_ms        int NOT NULL DEFAULT 5000 CHECK (sample_interval_ms BETWEEN 1000 AND 60000),
  max_vision_calls_per_hour int NOT NULL DEFAULT 120 CHECK (max_vision_calls_per_hour BETWEEN 0 AND 3600),
  game_profile              text NOT NULL DEFAULT 'generic' CHECK (game_profile IN ('generic', 'gta5')),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Publishing analysis publicly requires the channel itself to be public.
  CHECK (NOT public_analysis OR visibility = 'public'),
  CHECK (NOT directory_opt_in OR visibility = 'public')
);

CREATE TABLE stream_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id          uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('twitch_broadcast', 'replay', 'ingest')),
  label                   text CHECK (label IN ('replay', 'test', 'live', 'clip')),
  title                   text,
  category                text,
  twitch_stream_id        text,
  visibility              text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  broadcast_state         text NOT NULL DEFAULT 'unknown' CHECK (broadcast_state IN ('unknown', 'live', 'offline', 'error')),
  analysis_state          text NOT NULL DEFAULT 'no_source'
                            CHECK (analysis_state IN ('no_source','ready','analyzing_clip','live_vision','replay','delayed','stale','stopped','error')),
  analysis_reason         text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  last_received_frame_at  timestamptz,
  last_analyzed_frame_at  timestamptz,
  last_result_at          timestamptz,
  measured_cadence_ms     int,
  measured_delay_ms       int,
  expected_interval_ms    int,
  error_reason            text,
  frames_received         int NOT NULL DEFAULT 0,
  frames_analyzed         int NOT NULL DEFAULT 0,
  frames_dropped          int NOT NULL DEFAULT 0,
  analyzed_ms             bigint NOT NULL DEFAULT 0,
  duration_ms             bigint,
  gaps                    jsonb NOT NULL DEFAULT '[]',
  created_at              timestamptz NOT NULL DEFAULT now(),
  delete_requested_at     timestamptz,
  -- A replay is always labeled replay; it can never be presented as live.
  CHECK (kind <> 'replay' OR label = 'replay'),
  CHECK (kind <> 'replay' OR analysis_state NOT IN ('live_vision', 'delayed'))
);
CREATE UNIQUE INDEX stream_sessions_twitch_stream_idx ON stream_sessions (broadcaster_id, twitch_stream_id) WHERE twitch_stream_id IS NOT NULL;
CREATE INDEX stream_sessions_broadcaster_idx ON stream_sessions (broadcaster_id, started_at DESC);

CREATE TABLE media_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id      uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id          uuid REFERENCES stream_sessions(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('upload', 'twitch_clip', 'live_ingest')),
  label               text NOT NULL CHECK (label IN ('replay', 'test', 'live', 'clip')),
  name                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('pending','processing','ready','awaiting_publisher','publishing','idle','revoked','failed','deleted')),
  original_asset_id   uuid,
  playback_asset_id   uuid,
  publish_path        text UNIQUE,
  publish_key_hash    bytea,
  publish_key_hint    text,
  publisher_ip        text,
  publish_started_at  timestamptz,
  publish_ended_at    timestamptz,
  revoked_at          timestamptz,
  probe               jsonb,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'upload' OR label = 'replay'),
  CHECK (kind <> 'twitch_clip' OR label = 'clip'),
  CHECK (kind <> 'live_ingest' OR label IN ('live', 'test')),
  CHECK (kind <> 'live_ingest' OR publish_key_hash IS NOT NULL OR status IN ('revoked', 'deleted'))
);
CREATE INDEX media_sources_broadcaster_idx ON media_sources (broadcaster_id, created_at DESC);

CREATE TABLE evidence_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id  uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES stream_sessions(id) ON DELETE CASCADE,
  source_id       uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('original','playback','frame','thumbnail','clip','export_landscape','export_vertical','audio_chunk')),
  storage_key     text NOT NULL UNIQUE,
  content_type    text NOT NULL,
  bytes           bigint,
  width           int,
  height          int,
  duration_ms     int,
  media_pts_ms    bigint,
  sha256          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX evidence_assets_session_idx ON evidence_assets (session_id, kind);
CREATE INDEX evidence_assets_expiry_idx ON evidence_assets (expires_at) WHERE deleted_at IS NULL;

ALTER TABLE media_sources ADD CONSTRAINT media_sources_original_fk FOREIGN KEY (original_asset_id) REFERENCES evidence_assets(id) ON DELETE SET NULL;
ALTER TABLE media_sources ADD CONSTRAINT media_sources_playback_fk FOREIGN KEY (playback_asset_id) REFERENCES evidence_assets(id) ON DELETE SET NULL;

CREATE TABLE source_health (
  source_id             uuid PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
  state                 text NOT NULL,
  frames_received       bigint NOT NULL DEFAULT 0,
  frames_analyzed       bigint NOT NULL DEFAULT 0,
  frames_dropped        bigint NOT NULL DEFAULT 0,
  last_frame_at         timestamptz,
  last_analyzed_at      timestamptz,
  last_frame_asset_id   uuid REFERENCES evidence_assets(id) ON DELETE SET NULL,
  last_frame_pts_ms     bigint,
  cadence_ms            int,
  delay_ms              int,
  error                 text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE observations (
  id                 uuid PRIMARY KEY,
  schema_version     int NOT NULL,
  broadcaster_id     uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id         uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  source_id          uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  media_start_ms     bigint,
  media_end_ms       bigint,
  captured_at        timestamptz,
  received_at        timestamptz NOT NULL,
  analyzed_at        timestamptz,
  published_at       timestamptz,
  type               text NOT NULL,
  description        text NOT NULL,
  origin             text NOT NULL CHECK (origin IN ('twitch', 'video', 'ocr', 'audio', 'user_correction')),
  interpretation     text NOT NULL CHECK (interpretation IN ('directly_visible', 'inferred', 'unknown')),
  evidence           jsonb NOT NULL DEFAULT '[]',
  raw_text           text,
  model_provider     text,
  model_version      text,
  model_confidence   real CHECK (model_confidence IS NULL OR (model_confidence >= 0 AND model_confidence <= 1)),
  review_status      text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'confirmed', 'corrected', 'rejected')),
  related_entities   jsonb NOT NULL DEFAULT '[]',
  dedupe_key         text,
  search             tsvector GENERATED ALWAYS AS (
                       to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(raw_text, ''))
                     ) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Platform facts never inherit a vision model's confidence.
  CHECK (origin <> 'twitch' OR (model_confidence IS NULL AND model_provider IS NULL)),
  -- Gameplay observations must carry evidence.
  CHECK (origin IN ('twitch', 'user_correction') OR jsonb_array_length(evidence) > 0),
  CHECK (media_end_ms IS NULL OR media_start_ms IS NULL OR media_end_ms >= media_start_ms)
);
CREATE UNIQUE INDEX observations_dedupe_idx ON observations (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX observations_session_time_idx ON observations (session_id, media_start_ms);
CREATE INDEX observations_session_received_idx ON observations (session_id, received_at);
CREATE INDEX observations_search_idx ON observations USING gin (search);

CREATE TABLE transcripts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  source_id        uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  media_start_ms   bigint NOT NULL,
  media_end_ms     bigint NOT NULL,
  text             text NOT NULL,
  segments         jsonb NOT NULL DEFAULT '[]',
  provider         text NOT NULL,
  model            text NOT NULL,
  language         text,
  search           tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, source_id, media_start_ms),
  CHECK (media_end_ms >= media_start_ms)
);
CREATE INDEX transcripts_search_idx ON transcripts USING gin (search);

CREATE TABLE review_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id   uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  previous         jsonb NOT NULL,
  correction       jsonb NOT NULL,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_corrections_obs_idx ON review_corrections (observation_id, created_at);

CREATE TABLE saved_moments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id      uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  observation_id      uuid REFERENCES observations(id) ON DELETE SET NULL,
  title               text NOT NULL,
  note                text,
  media_start_ms      bigint,
  media_end_ms        bigint,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  search              tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || coalesce(note, ''))) STORED,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_moments_broadcaster_idx ON saved_moments (broadcaster_id, created_at DESC);
CREATE INDEX saved_moments_search_idx ON saved_moments USING gin (search);

CREATE TABLE clip_jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id           uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id               uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  moment_id                uuid REFERENCES saved_moments(id) ON DELETE SET NULL,
  kind                     text NOT NULL CHECK (kind IN ('twitch_live', 'twitch_vod', 'owned_render')),
  state                    text NOT NULL CHECK (state IN ('requested', 'processing', 'ready', 'failed', 'expired')),
  media_state              text NOT NULL DEFAULT 'not_requested'
                             CHECK (media_state IN ('not_requested','missing_scope','queued','downloading','analyzing','ready','failed','expired')),
  idempotency_key          text NOT NULL,
  request_source           text NOT NULL CHECK (request_source IN ('web', 'chat', 'system')),
  requested_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_chatter_id  text,
  twitch_clip_id           text,
  edit_url                 text,
  clip_url                 text,
  embed_url                text,
  thumbnail_url            text,
  vod_id                   text,
  vod_offset_sec           int,
  duration_ms              int,
  center_ms                bigint,
  pre_roll_ms              int,
  post_roll_ms             int,
  vertical                 boolean NOT NULL DEFAULT false,
  caption                  text,
  landscape_asset_id       uuid REFERENCES evidence_assets(id) ON DELETE SET NULL,
  portrait_asset_id        uuid REFERENCES evidence_assets(id) ON DELETE SET NULL,
  source_resolution        text,
  error_code               text,
  error_message            text,
  attempts                 int NOT NULL DEFAULT 0,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  ready_at                 timestamptz,
  expires_at               timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcaster_id, idempotency_key),
  -- A clip is "ready" only when it really exists.
  CHECK (state <> 'ready' OR kind = 'owned_render' OR clip_url IS NOT NULL),
  CHECK (state <> 'ready' OR kind <> 'owned_render' OR landscape_asset_id IS NOT NULL)
);
CREATE INDEX clip_jobs_session_idx ON clip_jobs (session_id, requested_at DESC);

-- Bot command audit. Never stores message text: only the command name and a hash of the args.
CREATE TABLE bot_command_audit (
  id                bigserial PRIMARY KEY,
  broadcaster_id    uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  chatter_user_id   text NOT NULL,
  chatter_login     text NOT NULL,
  message_id        text NOT NULL,
  command           text NOT NULL,
  args_sha256       text,
  args_length       int NOT NULL DEFAULT 0,
  decision          text NOT NULL CHECK (decision IN ('answered','queued','denied','rate_limited','duplicate','disabled','killed','error')),
  reason            text,
  reply_message_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcaster_id, message_id)
);

-- EventSub deliveries: message-id is the idempotency key (Twitch delivers at least once).
CREATE TABLE eventsub_deliveries (
  message_id             text PRIMARY KEY,
  message_type           text NOT NULL,
  subscription_id        text,
  subscription_type      text,
  broadcaster_twitch_id  text,
  received_at            timestamptz NOT NULL DEFAULT now(),
  processed_at           timestamptz,
  status                 text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error                  text
);
CREATE INDEX eventsub_deliveries_received_idx ON eventsub_deliveries (received_at);

CREATE TABLE eventsub_subscriptions (
  id               text PRIMARY KEY,
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  type             text NOT NULL,
  version          text NOT NULL,
  status           text NOT NULL,
  condition        jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcaster_id, type, version)
);

-- Persisted session event log for SSE backfill. `public_payload` is NULL when the event
-- must never reach public subscribers.
CREATE TABLE session_events (
  id               bigserial PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  payload          jsonb NOT NULL,
  public_payload   jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_session_idx ON session_events (session_id, id);

CREATE TABLE job_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id       uuid REFERENCES stream_sessions(id) ON DELETE SET NULL,
  queue            text NOT NULL,
  name             text NOT NULL,
  state            text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  step             text,
  progress         real,
  error            text,
  usage            jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX job_runs_broadcaster_idx ON job_runs (broadcaster_id, created_at DESC);

CREATE TABLE usage_events (
  id                   bigserial PRIMARY KEY,
  broadcaster_id       uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id           uuid REFERENCES stream_sessions(id) ON DELETE SET NULL,
  kind                 text NOT NULL CHECK (kind IN ('vision', 'transcription', 'qa')),
  provider             text NOT NULL,
  model                text NOT NULL,
  input_tokens         int NOT NULL DEFAULT 0,
  output_tokens        int NOT NULL DEFAULT 0,
  frames               int NOT NULL DEFAULT 0,
  audio_seconds        real NOT NULL DEFAULT 0,
  estimated_cost_usd   numeric(12, 6),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_broadcaster_idx ON usage_events (broadcaster_id, created_at DESC);

-- Meaningful, sanitized errors surfaced in Studio (no tokens, no stack traces).
CREATE TABLE ops_errors (
  id               bigserial PRIMARY KEY,
  broadcaster_id   uuid REFERENCES broadcasters(id) ON DELETE CASCADE,
  scope            text NOT NULL,
  message          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_errors_broadcaster_idx ON ops_errors (broadcaster_id, created_at DESC);
