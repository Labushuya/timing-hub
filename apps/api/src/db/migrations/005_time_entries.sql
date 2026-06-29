-- ============================================================
-- timing-hub — time_entries, results, audit_log (v2)
-- Migration: 005_time_entries.sql
-- Replaces initial time_entries / results / audit_log tables
-- with rally-specific fields, BIGINT epoch-ms timestamps,
-- confirmation/void workflow, and client-sequence dedup index.
-- ============================================================

-- Drop dependent objects from the initial schema first
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS results   CASCADE;
DROP TABLE IF EXISTS time_entries CASCADE;

-- ------------------------------------------------------------
-- time_entries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_entries (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  posten_id         UUID    NOT NULL REFERENCES posten(id),
  participant_id    UUID    REFERENCES participants(id),
  startnummer       TEXT,
  source            TEXT    NOT NULL CHECK (source IN ('manual','timy_bridge','import')),
  raw_timestamp_ms  BIGINT  NOT NULL,
  server_recv_ms    BIGINT  NOT NULL,
  lap_number        INTEGER,
  sector_number     INTEGER,
  channel           INTEGER,
  is_confirmed      BOOLEAN NOT NULL DEFAULT false,
  confirmed_by      UUID    REFERENCES users(id),
  confirmed_at      BIGINT,
  is_void           BOOLEAN NOT NULL DEFAULT false,
  void_reason       TEXT,
  voided_by         UUID    REFERENCES users(id),
  client_seq        BIGINT,
  created_at        BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  updated_at        BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000
);

CREATE INDEX IF NOT EXISTS idx_time_entries_event       ON time_entries(event_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_posten      ON time_entries(posten_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_participant ON time_entries(participant_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_startnummer ON time_entries(event_id, startnummer);
CREATE INDEX IF NOT EXISTS idx_time_entries_timestamp   ON time_entries(event_id, raw_timestamp_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_client_seq ON time_entries(posten_id, client_seq) WHERE client_seq IS NOT NULL;

-- ------------------------------------------------------------
-- results  (computed / finalized rankings)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id   UUID    NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  computed_at      BIGINT  NOT NULL,
  actual_time_ms   BIGINT,
  target_time_ms   BIGINT,
  deviation_ms     BIGINT,
  penalty_points   NUMERIC(12,4),
  total_time_ms    BIGINT,
  best_lap_ms      BIGINT,
  lap_count        INTEGER,
  gap_to_leader_ms BIGINT,
  section_times    JSONB,
  rank_overall     INTEGER NOT NULL DEFAULT 0,
  rank_in_class    INTEGER,
  class            TEXT,
  scoring_detail   JSONB   NOT NULL DEFAULT '{}',
  UNIQUE(event_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_results_event ON results(event_id);
CREATE INDEX IF NOT EXISTS idx_results_rank  ON results(event_id, rank_overall);

-- ------------------------------------------------------------
-- audit_log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID    REFERENCES events(id) ON DELETE SET NULL,
  actor_id     UUID    REFERENCES users(id)  ON DELETE SET NULL,
  action       TEXT    NOT NULL,
  entity_type  TEXT    NOT NULL,
  entity_id    UUID,
  before_state JSONB,
  after_state  JSONB,
  ip_address   TEXT,
  created_at   BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000
);

CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
