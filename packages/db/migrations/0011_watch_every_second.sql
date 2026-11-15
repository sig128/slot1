-- Watching every second: SLOT1's own analyzers (OCR, the GTA model and the motion meter) read one
-- frame a second, and the vision model is asked only when something happens (plus every 10 s).
-- Channels still on the old default of one frame every 5 s move to the new default; a channel that
-- chose another interval keeps it.
ALTER TABLE channel_settings ALTER COLUMN sample_interval_ms SET DEFAULT 1000;
UPDATE channel_settings SET sample_interval_ms = 1000 WHERE sample_interval_ms = 5000;
