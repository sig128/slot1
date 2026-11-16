-- Every channel is watched and learned from unless the creator turns that off.
-- The synthetic demo never enters the training pool.

ALTER TABLE channel_settings ALTER COLUMN agent_enabled SET DEFAULT true;
ALTER TABLE channel_settings ALTER COLUMN training_consent SET DEFAULT true;

UPDATE channel_settings cs
   SET agent_enabled = true,
       updated_at = now()
  FROM broadcasters b
 WHERE b.id = cs.broadcaster_id
   AND cs.analysis_paused = false
   AND cs.agent_enabled = false;

UPDATE channel_settings cs
   SET training_consent = true,
       updated_at = now()
  FROM broadcasters b
 WHERE b.id = cs.broadcaster_id
   AND cs.training_consent = false
   AND NOT (b.kind = 'local' AND b.login = 'slot1-demo');
