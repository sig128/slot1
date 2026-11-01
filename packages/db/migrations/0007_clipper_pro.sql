-- Clipper pro: export presets and formats on renders, thumbnails as their own library kind, and
-- files a creator uploads to use in edits (music, voice-overs, logos).

ALTER TABLE library_items DROP CONSTRAINT library_items_kind_check;
ALTER TABLE library_items ADD CONSTRAINT library_items_kind_check
  CHECK (kind IN ('recording', 'render', 'screenshot', 'twitch_clip', 'clip_export', 'thumbnail'));

-- Which export preset (tiktok, shorts, reels, x, youtube, original) and container a render used.
ALTER TABLE library_items ADD COLUMN preset text CHECK (preset IS NULL OR preset ~ '^[a-z]{1,20}$');
ALTER TABLE library_items ADD COLUMN format text NOT NULL DEFAULT 'mp4' CHECK (format IN ('mp4', 'gif', 'audio', 'png'));
-- Resolution, frame rate and quality the creator chose for this render.
ALTER TABLE library_items ADD COLUMN render_options jsonb CHECK (render_options IS NULL OR jsonb_typeof(render_options) = 'object');

-- Uploaded audio and images an edit can use. They belong to the creator (usable in any of their
-- edits); files live under the library prefix and go when the row or the creator is deleted.
CREATE TABLE project_media (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id      uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES edit_projects(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('audio', 'image')),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  storage_key         text NOT NULL UNIQUE,
  content_type        text NOT NULL,
  bytes               bigint NOT NULL CHECK (bytes >= 0),
  duration_ms         bigint CHECK (duration_ms >= 0),
  width               integer CHECK (width > 0),
  height              integer CHECK (height > 0),
  rights_confirmed_at timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_media_broadcaster_idx ON project_media (broadcaster_id, created_at DESC);
