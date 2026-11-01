-- SLOT1 clipper: full-stream recording, screenshots, edit projects, renders, library and profiles.
-- Library items keep their own files (outside the session's storage prefix) so clips and
-- screenshots survive when a session or its recording is deleted or expires.

-- Creator controls. Recording is opt-in and expires on its own schedule.
ALTER TABLE channel_settings
  ADD COLUMN recording_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN recording_retention_days int NOT NULL DEFAULT 14 CHECK (recording_retention_days BETWEEN 1 AND 365),
  ADD COLUMN auto_clips               boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_clip_pre_roll_ms    int NOT NULL DEFAULT 8000 CHECK (auto_clip_pre_roll_ms BETWEEN 0 AND 60000),
  ADD COLUMN auto_clip_post_roll_ms   int NOT NULL DEFAULT 6000 CHECK (auto_clip_post_roll_ms BETWEEN 1000 AND 60000);

-- A finalized recording becomes a media source of its own kind (playable like an upload).
ALTER TABLE media_sources DROP CONSTRAINT media_sources_kind_check;
ALTER TABLE media_sources ADD CONSTRAINT media_sources_kind_check CHECK (kind IN ('upload', 'twitch_clip', 'live_ingest', 'recording'));
ALTER TABLE media_sources ADD CONSTRAINT media_sources_recording_label_check CHECK (kind <> 'recording' OR label IN ('live', 'test'));

ALTER TABLE evidence_assets DROP CONSTRAINT evidence_assets_kind_check;
ALTER TABLE evidence_assets ADD CONSTRAINT evidence_assets_kind_check CHECK (
  kind IN ('original', 'playback', 'frame', 'thumbnail', 'clip', 'export_landscape', 'export_vertical', 'audio_chunk',
           'recording_segment', 'screenshot', 'render', 'poster')
);

-- One recording per ingest session. Segments are uploaded as they complete (any worker can
-- finalize); `runs` maps each reader run's timeline onto the finalized file.
CREATE TABLE recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id  uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL UNIQUE REFERENCES stream_sessions(id) ON DELETE CASCADE,
  live_source_id  uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  source_id       uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'finalizing', 'ready', 'failed', 'expired')),
  runs            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(runs) = 'array'),
  rebased_until   timestamptz,
  duration_ms     bigint CHECK (duration_ms >= 0),
  bytes           bigint CHECK (bytes >= 0),
  error           text,
  expires_at      timestamptz,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finalized_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR (source_id IS NOT NULL AND duration_ms IS NOT NULL))
);
CREATE INDEX recordings_broadcaster ON recordings (broadcaster_id, created_at DESC);
CREATE INDEX recordings_expiry ON recordings (expires_at) WHERE status = 'ready';

-- Non-destructive edit decision lists. Auto clips are idempotent per source observation.
CREATE TABLE edit_projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id       uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  title                text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  origin               text NOT NULL CHECK (origin IN ('manual', 'auto')),
  auto_key             text,
  edl                  jsonb NOT NULL CHECK (jsonb_typeof(edl) = 'object'),
  source_observation_id uuid REFERENCES observations(id) ON DELETE SET NULL,
  created_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcaster_id, auto_key)
);
CREATE INDEX edit_projects_broadcaster ON edit_projects (broadcaster_id, updated_at DESC);

-- Everything a creator keeps: recordings, renders, screenshots and Twitch clips.
CREATE TABLE library_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id   uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('recording', 'render', 'screenshot', 'twitch_clip', 'clip_export')),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  visibility       text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  featured         boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  error            text,
  session_id       uuid REFERENCES stream_sessions(id) ON DELETE SET NULL,
  recording_id     uuid REFERENCES recordings(id) ON DELETE CASCADE,
  project_id       uuid REFERENCES edit_projects(id) ON DELETE SET NULL,
  -- Twitch clips and clip exports belong to their session's clip job and go with it.
  clip_job_id      uuid REFERENCES clip_jobs(id) ON DELETE CASCADE,
  job_run_id       uuid REFERENCES job_runs(id) ON DELETE SET NULL,
  -- An item whose file row is removed has nothing left to show. Renders and screenshots keep
  -- their files outside sessions (session_id NULL), so session deletion never reaches them.
  asset_id         uuid REFERENCES evidence_assets(id) ON DELETE CASCADE,
  poster_asset_id  uuid REFERENCES evidence_assets(id) ON DELETE SET NULL,
  external_url     text CHECK (external_url IS NULL OR external_url ~ '^https://'),
  media_ms         bigint CHECK (media_ms >= 0),
  width            int,
  height           int,
  duration_ms      bigint,
  bytes            bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'recording' OR recording_id IS NOT NULL),
  CHECK (status <> 'ready' OR asset_id IS NOT NULL OR external_url IS NOT NULL OR kind = 'recording')
);
CREATE INDEX library_items_owner ON library_items (broadcaster_id, created_at DESC);
CREATE INDEX library_items_public ON library_items (broadcaster_id, created_at DESC) WHERE visibility = 'public' AND status = 'ready';
CREATE UNIQUE INDEX library_items_clip_job ON library_items (clip_job_id) WHERE clip_job_id IS NOT NULL;
CREATE UNIQUE INDEX library_items_recording ON library_items (recording_id) WHERE recording_id IS NOT NULL;
