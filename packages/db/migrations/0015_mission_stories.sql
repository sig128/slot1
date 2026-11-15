-- Missions as stories, and what leads to each result (contracts/src/mission-stories.ts).
-- Rebuilt per stream from its entries by the worker; never edited by hand.

ALTER TABLE stream_sessions ADD COLUMN stories_refreshed_at timestamptz;

CREATE TABLE mission_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  broadcaster_id        uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  seq                   int NOT NULL,
  name                  text,
  name_from             text CHECK (name_from IN ('result_screen', 'title', 'retry')),
  mission_key           text,
  outcome               text NOT NULL CHECK (outcome IN ('passed', 'failed', 'unknown')),
  fail_reason           text,
  started_ms            bigint NOT NULL,
  ended_ms              bigint NOT NULL,
  duration_ms           bigint,
  objectives            text[] NOT NULL DEFAULT '{}',
  last_objective        text,
  deaths                int NOT NULL DEFAULT 0,
  busts                 int NOT NULL DEFAULT 0,
  activities            text[] NOT NULL DEFAULT '{}',
  places                text[] NOT NULL DEFAULT '{}',
  start_observation_id  uuid REFERENCES observations(id) ON DELETE SET NULL,
  end_observation_id    uuid REFERENCES observations(id) ON DELETE SET NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX mission_attempts_key_idx ON mission_attempts (mission_key);

CREATE TABLE story_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  broadcaster_id  uuid NOT NULL REFERENCES broadcasters(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('wasted', 'busted', 'mission_failed', 'mission_passed')),
  at_ms           bigint NOT NULL,
  observation_id  uuid REFERENCES observations(id) ON DELETE CASCADE,
  attempt_seq     int,
  before          text[] NOT NULL DEFAULT '{}',
  places          text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX story_events_session_idx ON story_events (session_id);
CREATE INDEX story_events_kind_idx ON story_events (kind);
