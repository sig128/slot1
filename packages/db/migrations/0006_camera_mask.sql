-- "Hide your camera from the AI": boxes a creator draws over their webcam on a live source.
-- The worker fills them with black in every frame it analyzes from that source (OCR, AI vision,
-- the GTA model, stored evidence frames, the AI view). Viewers still get the full stream.
-- Each box is {"x","y","w","h"} as fractions of the picture; at most three boxes.
ALTER TABLE media_sources ADD COLUMN camera_mask jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE media_sources ADD CONSTRAINT media_sources_camera_mask_check
  CHECK (CASE WHEN jsonb_typeof(camera_mask) = 'array' THEN jsonb_array_length(camera_mask) <= 3 ELSE false END);
