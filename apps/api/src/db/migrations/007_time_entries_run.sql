-- ============================================================
-- timing-hub — time_entries run index and section_times cache
-- Migration: 007_time_entries_run.sql
-- lap_number in time_entries wird für Läufe bei GLP/SP/
-- Orientierung genutzt (nicht nur Rundstrecke). Wir ergänzen
-- einen kombinierten Index und eine Cache-Tabelle für
-- berechnete Sektionszeiten.
-- ============================================================

-- ------------------------------------------------------------
-- Zusätzlicher Index auf time_entries für Lauf-Abfragen
-- (event_id + posten_id + lap_number für schnelle Sektion-Lookups)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_time_entries_run
  ON time_entries(event_id, posten_id, lap_number);

-- ------------------------------------------------------------
-- section_times  (berechnete Sektionszeiten — optionaler Cache)
-- Wird nach jeder Zeiterfassung oder manuell berechnet und
-- gespeichert, um wiederholte Live-Berechnungen zu vermeiden.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS section_times (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id  UUID    NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  from_posten_id  UUID    NOT NULL REFERENCES posten(id),
  to_posten_id    UUID    NOT NULL REFERENCES posten(id),
  run_number      INTEGER NOT NULL DEFAULT 1,
  from_time_ms    BIGINT  NOT NULL,  -- absoluter Zeitstempel vom from_posten
  to_time_ms      BIGINT  NOT NULL,  -- absoluter Zeitstempel vom to_posten
  duration_ms     BIGINT  NOT NULL,  -- to_time_ms - from_time_ms
  target_time_ms  BIGINT,            -- Sollzeit für diesen Abschnitt (aus section_targets)
  deviation_ms    BIGINT,            -- duration_ms - target_time_ms (signed, NULL wenn kein Sollzeit)
  computed_at     BIGINT  NOT NULL DEFAULT extract(epoch from now()) * 1000,
  -- Eindeutig: pro Event, Teilnehmer, Abschnitt und Lauf nur ein Eintrag
  UNIQUE(event_id, participant_id, from_posten_id, to_posten_id, run_number)
);

CREATE INDEX IF NOT EXISTS idx_section_times_event       ON section_times(event_id);
CREATE INDEX IF NOT EXISTS idx_section_times_participant ON section_times(participant_id);
