-- SLOT1 chat: the shared chat on each channel's SLOT1 page.
--
-- Messages live in Redis for at most 24 hours (see apps/api/src/lib/chat.ts). Postgres keeps only
-- what moderation needs to outlast that: bans, and reports until they're handled (30 days at most).

-- "Sign in with Twitch" just to chat: identity only, no channel connected and no permissions.
ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_role_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_role_check CHECK (role IN ('broadcaster', 'bot', 'viewer'));

-- A ban keeps one person from posting: in one channel's chat (room = the channel's login), or in
-- every chat (room IS NULL). Only admins ban everywhere; a creator bans in their own chat.
CREATE TABLE chat_bans (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room        text,
  name        text NOT NULL,
  banned_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, room)
);

-- One row per person reporting a message. The message's text is copied here, because the message
-- itself leaves Redis after 24 hours or when it's deleted.
CREATE TABLE chat_reports (
  id                bigserial PRIMARY KEY,
  room              text NOT NULL,
  message_id        text NOT NULL,
  author_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  author_name       text NOT NULL,
  text              text NOT NULL,
  message_at        timestamptz NOT NULL,
  reporter_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  UNIQUE (room, message_id, reporter_user_id)
);
CREATE INDEX chat_reports_open ON chat_reports (created_at) WHERE resolved_at IS NULL;
