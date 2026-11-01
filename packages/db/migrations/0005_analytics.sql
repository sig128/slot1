-- Visitor analytics for the operator dashboard (/admin) and the contact inbox. See docs/ADMIN.md.
-- Cookieless by design: no IP address, no full User-Agent, no identifier that outlives a day.

-- One row per counted page view. visitor_id is the first 16 bytes of
-- SHA-256(daily salt + IP + User-Agent + site host). The salt is 32 random bytes per UTC day,
-- kept only in Redis and deleted after 48 hours, so an ID can't be recomputed or linked across
-- days. Raw rows are deleted after 90 days; analytics_daily keeps the daily totals.
CREATE TABLE page_views (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  path           text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300 AND left(path, 1) = '/'),
  referrer_host  text CHECK (referrer_host IS NULL OR referrer_host ~ '^[a-z0-9.-]{1,253}$'),
  device         text NOT NULL CHECK (device IN ('mobile', 'tablet', 'desktop')),
  browser        text NOT NULL CHECK (browser IN ('chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other')),
  visitor_id     bytea NOT NULL CHECK (octet_length(visitor_id) = 16)
);
CREATE INDEX page_views_created_idx ON page_views (created_at);

-- Daily totals (UTC days), kept after the raw rows are gone. Unique visitors are per day only.
CREATE TABLE analytics_daily (
  day         date PRIMARY KEY,
  views       integer NOT NULL CHECK (views >= 0),
  visitors    integer NOT NULL CHECK (visitors >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Messages sent through /contact. Operators read, close and delete them in /admin.
-- Deleted automatically 24 months after they were sent.
CREATE TABLE contact_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  name        text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 100),
  email       text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  topic       text NOT NULL CHECK (topic IN ('general', 'privacy', 'copyright', 'business', 'support')),
  message     text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 5000),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at   timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX contact_messages_created_idx ON contact_messages (created_at DESC);
