-- ============================================================
-- timing-hub — GLP section targets and run configuration
-- Migration: 006_glp_sections.sql
-- Adds section target times (Abschnitt-Sollzeiten) and
-- run/lap configuration columns to events.
-- ============================================================

-- ------------------------------------------------------------
-- section_targets
-- Sollzeit pro Posten-Übergang (Abschnitt).
-- Ein Abschnitt ist definiert durch from_posten_id → to_posten_id.
-- NULL in from_posten_id / to_posten_id bedeutet Gesamtstrecke.
-- NULL in class bedeutet: gilt für alle Klassen.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS section_targets (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  from_posten_id  UUID    REFERENCES posten(id) ON DELETE CASCADE,  -- NULL = Gesamtstrecke
  to_posten_id    UUID    REFERENCES posten(id) ON DELETE CASCADE,  -- NULL = Gesamtstrecke
  class           TEXT,                                              -- NULL = gilt für alle Klassen
  target_time_ms  BIGINT  NOT NULL,
  created_at      BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  -- Eindeutig: pro Event, Abschnitt und Klasse nur eine Sollzeit
  UNIQUE(event_id, from_posten_id, to_posten_id, class)
);

CREATE INDEX IF NOT EXISTS idx_section_targets_event ON section_targets(event_id);

-- ------------------------------------------------------------
-- events — zusätzliche Lauf-Konfigurationsspalten
-- ------------------------------------------------------------

-- Sollzeiten vor Teilnehmern verbergen (z.B. während laufendem Event)
ALTER TABLE events ADD COLUMN IF NOT EXISTS
  hide_target_times BOOLEAN NOT NULL DEFAULT false;

-- Anzahl der Läufe / Wertungsrunden
ALTER TABLE events ADD COLUMN IF NOT EXISTS
  run_count INTEGER NOT NULL DEFAULT 1;

-- Wertungsmodus über mehrere Läufe
--   sum        = Summe aller Läufe
--   best       = bester Lauf
--   best_of_n  = bester N von run_count Läufen (N in run_scoring_n)
ALTER TABLE events ADD COLUMN IF NOT EXISTS
  run_scoring TEXT NOT NULL DEFAULT 'best'
  CHECK (run_scoring IN ('sum', 'best', 'best_of_n'));

-- N für den Modus best_of_n (wie viele beste Läufe werden gewertet)
ALTER TABLE events ADD COLUMN IF NOT EXISTS
  run_scoring_n INTEGER;
