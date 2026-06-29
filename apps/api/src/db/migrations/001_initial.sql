-- ============================================================
-- timing-hub — initial schema
-- Migration: 001_initial.sql
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'viewer'
                            CHECK (role IN ('admin', 'organizer', 'timekeeper', 'viewer')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users USING btree (email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users USING btree (role);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- registration_tokens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registration_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  email      TEXT,                             -- NULL = open invite
  role       TEXT        NOT NULL DEFAULT 'viewer'
                         CHECK (role IN ('admin', 'organizer', 'timekeeper', 'viewer')),
  used_at    TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reg_tokens_token      ON registration_tokens USING btree (token);
CREATE INDEX IF NOT EXISTS idx_reg_tokens_expires_at ON registration_tokens USING btree (expires_at);

-- ------------------------------------------------------------
-- refresh_tokens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,   -- bcrypt/argon2 hash of the raw token
  family      UUID        NOT NULL DEFAULT gen_random_uuid(), -- rotation family
  revoked_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  user_agent  TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family  ON refresh_tokens USING btree (family);

-- ------------------------------------------------------------
-- events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  slug         TEXT        NOT NULL UNIQUE,
  description  TEXT,
  date         DATE        NOT NULL,
  location     TEXT,
  status       TEXT        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'published', 'active', 'finished', 'archived')),
  config       JSONB       NOT NULL DEFAULT '{}',
  owner_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_slug       ON events USING btree (slug);
CREATE INDEX IF NOT EXISTS idx_events_status     ON events USING btree (status);
CREATE INDEX IF NOT EXISTS idx_events_owner_id   ON events USING btree (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_date       ON events USING btree (date DESC);
CREATE INDEX IF NOT EXISTS idx_events_name_trgm  ON events USING gin (name gin_trgm_ops);

CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- posten  (control stations along the course)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posten (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,           -- short identifier, e.g. "P01"
  sort_order  INT         NOT NULL DEFAULT 0,
  is_finish   BOOLEAN     NOT NULL DEFAULT false,
  is_start    BOOLEAN     NOT NULL DEFAULT false,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_posten_event_id ON posten USING btree (event_id);

CREATE TRIGGER trg_posten_updated_at
  BEFORE UPDATE ON posten
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- participants
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  bib_number      TEXT        NOT NULL,       -- start number / Startnummer
  first_name      TEXT        NOT NULL,
  last_name       TEXT        NOT NULL,
  club            TEXT,
  category        TEXT,
  gender          TEXT        CHECK (gender IN ('m', 'f', 'd', NULL)),
  birth_year      SMALLINT,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  is_dns          BOOLEAN     NOT NULL DEFAULT false,  -- did not start
  is_dnf          BOOLEAN     NOT NULL DEFAULT false,  -- did not finish
  is_dsq          BOOLEAN     NOT NULL DEFAULT false,  -- disqualified
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, bib_number)
);

CREATE INDEX IF NOT EXISTS idx_participants_event_id   ON participants USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_participants_bib        ON participants USING btree (event_id, bib_number);
CREATE INDEX IF NOT EXISTS idx_participants_name_trgm  ON participants USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

CREATE TRIGGER trg_participants_updated_at
  BEFORE UPDATE ON participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- time_entries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_entries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  posten_id       UUID        NOT NULL REFERENCES posten(id) ON DELETE CASCADE,
  participant_id  UUID        REFERENCES participants(id) ON DELETE SET NULL,
  bib_number      TEXT        NOT NULL,       -- denormalized for speed / offline scenarios
  recorded_at     TIMESTAMPTZ NOT NULL,       -- wall-clock time of passage
  source          TEXT        NOT NULL DEFAULT 'manual'
                              CHECK (source IN ('manual', 'rfid', 'barcode', 'import')),
  is_void         BOOLEAN     NOT NULL DEFAULT false,
  void_reason     TEXT,
  recorded_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  session_id      UUID,                       -- posten_session that recorded this entry
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_event_id       ON time_entries USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_posten_id      ON time_entries USING btree (posten_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_participant_id ON time_entries USING btree (participant_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_bib            ON time_entries USING btree (event_id, bib_number);
CREATE INDEX IF NOT EXISTS idx_time_entries_recorded_at    ON time_entries USING btree (recorded_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_session_id     ON time_entries USING btree (session_id);

-- ------------------------------------------------------------
-- results  (computed / finalized rankings)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id  UUID        NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  bib_number      TEXT        NOT NULL,
  category        TEXT,
  gender          TEXT,
  gun_time_ms     BIGINT,     -- total race time in milliseconds
  net_time_ms     BIGINT,     -- net time after wave correction
  rank_overall    INT,
  rank_category   INT,
  rank_gender     INT,
  splits          JSONB       NOT NULL DEFAULT '[]',  -- [{posten_id, recorded_at, split_ms}]
  is_dns          BOOLEAN     NOT NULL DEFAULT false,
  is_dnf          BOOLEAN     NOT NULL DEFAULT false,
  is_dsq          BOOLEAN     NOT NULL DEFAULT false,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  UNIQUE (event_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_results_event_id       ON results USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_results_rank_overall   ON results USING btree (event_id, rank_overall) WHERE rank_overall IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_results_rank_category  ON results USING btree (event_id, category, rank_category) WHERE rank_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_results_published_at   ON results USING btree (event_id, published_at);

-- ------------------------------------------------------------
-- posten_sessions  (per-device login at a Posten)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posten_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  posten_id   UUID        NOT NULL REFERENCES posten(id) ON DELETE CASCADE,
  event_id    UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  device_name TEXT,
  ip_address  INET,
  user_agent  TEXT,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  revoked_at  TIMESTAMPTZ,
  last_seen   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_posten_sessions_token     ON posten_sessions USING btree (token);
CREATE INDEX IF NOT EXISTS idx_posten_sessions_posten_id ON posten_sessions USING btree (posten_id);
CREATE INDEX IF NOT EXISTS idx_posten_sessions_event_id  ON posten_sessions USING btree (event_id);

-- ------------------------------------------------------------
-- audit_log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL   PRIMARY KEY,
  event_id    UUID        REFERENCES events(id) ON DELETE SET NULL,
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,           -- e.g. 'time_entry.create', 'user.login'
  entity_type TEXT,                           -- e.g. 'time_entry', 'participant'
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  user_agent  TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event_id    ON audit_log USING btree (event_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id     ON audit_log USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action      ON audit_log USING btree (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity      ON audit_log USING btree (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log USING brin (created_at);
