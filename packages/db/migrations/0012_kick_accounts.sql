-- Sign in with Kick: creators and viewers can use a Kick account, like a Twitch one.
--
-- A Kick account is its own SLOT1 account (users.kind = 'kick'). A Kick creator's channel is a
-- broadcaster of kind 'kick' whose login is 'kick-<slug>' (Twitch logins never contain '-', so the
-- two can't collide). Kick's token is used once at sign-in and not kept.
ALTER TABLE users DROP CONSTRAINT users_kind_check;
ALTER TABLE users ADD CONSTRAINT users_kind_check CHECK (kind IN ('twitch', 'local', 'kick'));
ALTER TABLE users ADD COLUMN kick_user_id text UNIQUE;
ALTER TABLE users ADD CONSTRAINT users_kick_check CHECK ((kind = 'kick') = (kick_user_id IS NOT NULL));

ALTER TABLE broadcasters DROP CONSTRAINT broadcasters_kind_check;
ALTER TABLE broadcasters ADD CONSTRAINT broadcasters_kind_check CHECK (kind IN ('twitch', 'local', 'kick'));
ALTER TABLE broadcasters ADD COLUMN kick_user_id text UNIQUE;
ALTER TABLE broadcasters ADD CONSTRAINT broadcasters_kick_check CHECK ((kind = 'kick') = (kick_user_id IS NOT NULL));
CREATE UNIQUE INDEX broadcasters_kick_login_idx ON broadcasters (lower(login)) WHERE kind = 'kick';

-- Which sign-in a state belongs to (a Twitch state can't finish a Kick sign-in, or the reverse),
-- and Kick's PKCE verifier, encrypted, until the callback uses it.
ALTER TABLE oauth_states ADD COLUMN provider text NOT NULL DEFAULT 'twitch' CHECK (provider IN ('twitch', 'kick'));
ALTER TABLE oauth_states ADD COLUMN pkce_verifier_enc text;
