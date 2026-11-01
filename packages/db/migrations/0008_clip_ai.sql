-- AI clip tools (docs/CLIP_AI.md).
--
-- 1. Per-second loudness of a session's stored video (an upload or a finished recording),
--    measured once by the worker and used to rank highlights and find silence. One row per
--    session; it goes with the session. `asset_id` is the file it was measured on, so a newer
--    file (a recording finalized later) is measured again.
-- 2. Text-model calls made by the clip tools are counted as their own usage kind.

CREATE TABLE clip_ai_audio (
  session_id      uuid PRIMARY KEY REFERENCES stream_sessions(id) ON DELETE CASCADE,
  broadcaster_id  uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  asset_id        uuid REFERENCES evidence_assets(id) ON DELETE SET NULL,
  status          text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  error           text,
  -- One RMS level (dBFS) per second of media; -120 means digital silence.
  rms_db          real[],
  duration_ms     bigint CHECK (duration_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clip_ai_audio_broadcaster ON clip_ai_audio (broadcaster_id);

ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN ('vision', 'transcription', 'qa', 'clip_ai'));
