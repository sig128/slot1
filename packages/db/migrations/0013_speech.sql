-- Live speech transcripts, in whatever language is spoken: a creator switches them on in Studio.
-- Only text is kept (as 'transcript' evidence next to the frames), never the audio itself.
ALTER TABLE channel_settings ADD COLUMN speech_transcripts boolean NOT NULL DEFAULT false;

ALTER TABLE evidence_assets DROP CONSTRAINT evidence_assets_kind_check;
ALTER TABLE evidence_assets ADD CONSTRAINT evidence_assets_kind_check CHECK (
  kind IN ('original', 'playback', 'frame', 'thumbnail', 'clip', 'export_landscape', 'export_vertical', 'audio_chunk',
           'recording_segment', 'screenshot', 'render', 'poster', 'transcript')
);
