-- SLOT1 GTA model training engine: consented training frames, labels, dataset versions and
-- the model registry. Frames are only collected while the creator's training consent is on.

ALTER TABLE channel_settings ADD COLUMN training_consent boolean NOT NULL DEFAULT false;

-- Model registry comes first: labels may reference the model that proposed them.
CREATE TABLE models (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  version             text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  task                text NOT NULL CHECK (task IN ('scene', 'detector')),
  taxonomy_version    int NOT NULL,
  -- Ordered class lists exactly as the network outputs them.
  classes             jsonb NOT NULL,
  -- Input tensor name/shape/normalization, output names.
  input_spec          jsonb NOT NULL,
  -- Array of evaluations: [{datasetVersionId, testSplitHash, primaryMetric, value, perClass, ...}]
  metrics             jsonb NOT NULL DEFAULT '[]'::jsonb,
  dataset_version_id  uuid,
  onnx_storage_key    text NOT NULL UNIQUE,
  onnx_sha256         text NOT NULL CHECK (onnx_sha256 ~ '^[0-9a-f]{64}$'),
  bytes               bigint NOT NULL CHECK (bytes > 0),
  status              text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'retired')),
  uploaded_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version),
  CHECK (jsonb_typeof(metrics) = 'array'),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
);
-- At most one active model per task.
CREATE UNIQUE INDEX models_one_active_per_task ON models (task) WHERE status = 'active';

CREATE TABLE training_frames (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id  uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  -- Deleting a session removes its training frames (and the files under the session prefix).
  session_id      uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  source_id       uuid REFERENCES media_sources(id) ON DELETE SET NULL,
  source_kind     text NOT NULL CHECK (source_kind IN ('upload', 'twitch_clip', 'live_ingest')),
  source_label    text NOT NULL CHECK (source_label IN ('replay', 'test', 'live', 'clip')),
  media_pts_ms    bigint CHECK (media_pts_ms >= 0),
  storage_key     text NOT NULL UNIQUE,
  width           int NOT NULL CHECK (width > 0),
  height          int NOT NULL CHECK (height > 0),
  bytes           int NOT NULL CHECK (bytes > 0),
  -- Snapshot: consent was on when this frame was collected.
  consent_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'unlabeled' CHECK (status IN ('unlabeled', 'labeled', 'skipped')),
  -- Review order: weak labels and uncertain model predictions first.
  priority        real NOT NULL DEFAULT 0,
  labeled_at      timestamptz,
  labeled_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'labeled') = (labeled_at IS NOT NULL))
);
CREATE INDEX training_frames_queue_idx ON training_frames (broadcaster_id, status, priority DESC, created_at);
CREATE INDEX training_frames_session_idx ON training_frames (session_id);

CREATE TABLE training_labels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id         uuid NOT NULL REFERENCES training_frames(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('scene', 'event', 'box')),
  class            text NOT NULL CHECK (class ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Normalized box (0..1, top-left origin); only for kind = 'box'.
  x                real,
  y                real,
  w                real,
  h                real,
  source           text NOT NULL CHECK (source IN ('auto_ocr', 'auto_measure', 'model', 'creator', 'labeler')),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  -- Reported by OCR or a model; never a measured accuracy. Null for human labels.
  confidence       real CHECK (confidence BETWEEN 0 AND 1),
  model_id         uuid REFERENCES models(id) ON DELETE SET NULL,
  labeler_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- What produced an automatic label (e.g. the OCR text), for review.
  evidence_text    text CHECK (char_length(evidence_text) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'box') = (x IS NOT NULL AND y IS NOT NULL AND w IS NOT NULL AND h IS NOT NULL)),
  CHECK (kind <> 'box' OR (x >= 0 AND y >= 0 AND w > 0 AND h > 0 AND x + w <= 1.0001 AND y + h <= 1.0001)),
  CHECK (source NOT IN ('creator', 'labeler') OR confidence IS NULL),
  CHECK (source NOT IN ('creator', 'labeler') OR labeler_user_id IS NOT NULL),
  CHECK (source NOT IN ('model', 'auto_ocr') OR confidence IS NOT NULL)
);
CREATE INDEX training_labels_frame_idx ON training_labels (frame_id, kind);
-- One scene label per frame per source.
CREATE UNIQUE INDEX training_labels_one_scene ON training_labels (frame_id, source) WHERE kind = 'scene' AND status <> 'rejected';

CREATE TABLE dataset_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version          int NOT NULL UNIQUE CHECK (version > 0),
  taxonomy_version int NOT NULL,
  -- Frozen across versions so a session always lands in the same split.
  split_seed       text NOT NULL,
  -- sha256 of the sorted test-split frame ids: models are only compared on identical test sets.
  test_split_hash  text NOT NULL CHECK (test_split_hash ~ '^[0-9a-f]{64}$'),
  counts           jsonb NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dataset_frames (
  dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  -- A deleted frame (session deleted, consent purge) disappears from every dataset version.
  frame_id           uuid NOT NULL REFERENCES training_frames(id) ON DELETE CASCADE,
  split              text NOT NULL CHECK (split IN ('train', 'val', 'test')),
  PRIMARY KEY (dataset_version_id, frame_id)
);
CREATE INDEX dataset_frames_frame_idx ON dataset_frames (frame_id);

ALTER TABLE models ADD CONSTRAINT models_dataset_fk FOREIGN KEY (dataset_version_id) REFERENCES dataset_versions(id) ON DELETE SET NULL;
