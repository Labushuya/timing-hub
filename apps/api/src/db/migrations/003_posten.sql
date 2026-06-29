-- ============================================================
-- timing-hub — posten and posten_sessions (v2)
-- Migration: 003_posten.sql
-- Replaces the initial posten / posten_sessions tables with
-- role-based design, access_token, bridge_token, and
-- BIGINT epoch-ms timestamps.
-- ============================================================

-- Drop dependent objects from the initial schema first
DROP TABLE IF EXISTS posten_sessions CASCADE;
DROP TRIGGER IF EXISTS trg_posten_updated_at ON posten;
DROP TABLE IF EXISTS posten CASCADE;

-- ------------------------------------------------------------
-- posten  (timing posts / control stations)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posten (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  role         TEXT    NOT NULL DEFAULT 'intermediate'
                       CHECK (role IN ('start','finish','intermediate','sector_split')),
  access_token TEXT    NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32),'hex'),
  bridge_token TEXT             DEFAULT encode(gen_random_bytes(32),'hex'),
  created_at   BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  UNIQUE(event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_posten_event        ON posten(event_id);
CREATE INDEX IF NOT EXISTS idx_posten_access_token ON posten(access_token);

-- ------------------------------------------------------------
-- posten_sessions  (per-device authenticated sessions)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posten_sessions (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  posten_id     UUID    NOT NULL REFERENCES posten(id) ON DELETE CASCADE,
  session_token TEXT    NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32),'hex'),
  device_hint   TEXT,
  created_at    BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  expires_at    BIGINT  NOT NULL,
  last_seen_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_posten_sessions_token  ON posten_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_posten_sessions_posten ON posten_sessions(posten_id);
