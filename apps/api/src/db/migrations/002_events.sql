-- ============================================================
-- timing-hub — events schema (v2)
-- Migration: 002_events.sql
-- Replaces the initial events table with full config JSONB
-- and BIGINT epoch-ms timestamps.
-- ============================================================

-- Drop dependent objects from the initial schema first
DROP TRIGGER  IF EXISTS trg_events_updated_at ON events;
DROP TABLE    IF EXISTS events CASCADE;

-- ------------------------------------------------------------
-- events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL,
  description  TEXT,
  format       TEXT        NOT NULL CHECK (format IN ('glp','sonderpruefung','rundstrecke','orientierung')),
  status       TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','finished','archived')),
  starts_at    BIGINT      NOT NULL,
  ends_at      BIGINT,
  timezone     TEXT        NOT NULL DEFAULT 'Europe/Berlin',
  config       JSONB       NOT NULL DEFAULT '{}',
  created_at   BIGINT      NOT NULL DEFAULT extract(epoch from now()) * 1000,
  updated_at   BIGINT      NOT NULL DEFAULT extract(epoch from now()) * 1000
);

CREATE INDEX IF NOT EXISTS idx_events_owner   ON events(owner_id);
CREATE INDEX IF NOT EXISTS idx_events_slug    ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_starts  ON events(starts_at);
