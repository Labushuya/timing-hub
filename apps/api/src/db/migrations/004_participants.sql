-- ============================================================
-- timing-hub — participants (v2)
-- Migration: 004_participants.sql
-- Replaces the initial participants table with rally-specific
-- fields (startnummer, co-driver, car info, class, target/seed
-- times) and BIGINT epoch-ms timestamps.
-- ============================================================

-- Drop dependent objects from the initial schema first
DROP TRIGGER IF EXISTS trg_participants_updated_at ON participants;
DROP TABLE IF EXISTS participants CASCADE;

-- ------------------------------------------------------------
-- participants
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participants (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  startnummer    TEXT    NOT NULL,
  driver_name    TEXT    NOT NULL,
  co_driver_name TEXT,
  car_make       TEXT,
  car_model      TEXT,
  car_year       INTEGER,
  class          TEXT,
  target_time_ms BIGINT,
  seed_time_ms   BIGINT,
  notes          TEXT,
  created_at     BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  updated_at     BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  UNIQUE(event_id, startnummer)
);

CREATE INDEX IF NOT EXISTS idx_participants_event       ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_participants_startnummer ON participants(event_id, startnummer);
CREATE INDEX IF NOT EXISTS idx_participants_name_trgm   ON participants USING gin(driver_name gin_trgm_ops);
