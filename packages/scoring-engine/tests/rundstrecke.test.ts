import { describe, it, expect } from 'vitest';
import { computeRundstrecke } from '../src/rundstrecke.js';
import type { ScoringInput } from '../src/types.js';
import type { Participant, TimeEntry, RundstreckeConfig } from '@timing-hub/shared-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParticipant(overrides: Partial<Participant> & { id: string }): Participant {
  return {
    event_id: 'event-1',
    startnummer: overrides.id,
    driver_name: `Driver ${overrides.id}`,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Make a lap entry. lap_number is required for getLapEntries() to include it.
 */
function makeLapEntry(
  participantId: string,
  lapNumber: number,
  rawMs: number,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `entry-${participantId}-lap${lapNumber}`,
    event_id: 'event-1',
    posten_id: 'posten-loop',
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: rawMs,
    server_recv_ms: rawMs,
    lap_number: lapNumber,
    is_confirmed: true,
    is_void: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRundConfig(overrides: Partial<RundstreckeConfig> = {}): RundstreckeConfig {
  return {
    format: 'rundstrecke',
    total_laps: null,
    duration_ms: null,
    standing_start: false,
    ...overrides,
  };
}

function makeInput(
  participants: Participant[],
  entries: TimeEntry[],
  config: RundstreckeConfig = makeRundConfig(),
): ScoringInput {
  return { participants, entries, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeRundstrecke', () => {
  it('throws if format is not rundstrecke', () => {
    const input = makeInput([], []);
    // @ts-expect-error — intentional wrong format
    input.config.format = 'glp';
    expect(() => computeRundstrecke(input)).toThrow(
      'computeRundstrecke called with format=glp',
    );
  });

  it('empty participants: returns empty results without crash', () => {
    const config = makeRundConfig({ total_laps: 3 });
    const result = computeRundstrecke(makeInput([], [], config));
    expect(result.results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Lap-based mode
  // -------------------------------------------------------------------------

  describe('lap-based (total_laps)', () => {
    it('fastest total time for N laps wins', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' });

      // 3-lap race
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 125_000),
        makeLapEntry('p1', 3, 195_000),
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 58_000),
        makeLapEntry('p2', 2, 118_000),
        makeLapEntry('p2', 3, 185_000),
      ];

      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
      expect(byId['p2']!.rank_overall).toBe(1);
      expect(byId['p1']!.rank_overall).toBe(2);
      expect(byId['p2']!.total_time_ms).toBe(185_000);
      expect(byId['p1']!.total_time_ms).toBe(195_000);
    });

    it('best_lap_ms is the minimum lap duration', () => {
      const p = makeParticipant({ id: 'p1' });

      // start=0, lap1=60_000 (60s), lap2=115_000 (55s), lap3=180_000 (65s)
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 115_000),
        makeLapEntry('p1', 3, 180_000),
      ];

      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p], entries, config));
      expect(result.results[0]!.best_lap_ms).toBe(55_000);
    });

    it('gap_to_leader_ms: leader=0, others = their total - leader total', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' });

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000), // total 120_000
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 65_000),
        makeLapEntry('p2', 2, 130_000), // total 130_000
      ];

      const config = makeRundConfig({ total_laps: 2 });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
      expect(byId['p1']!.gap_to_leader_ms).toBe(0);
      expect(byId['p2']!.gap_to_leader_ms).toBe(10_000);
    });

    it('lap_count: correct number of completed laps', () => {
      const p = makeParticipant({ id: 'p1' });
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000),
        makeLapEntry('p1', 3, 185_000),
      ];

      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p], entries, config));
      // 4 timestamps → 3 lap durations
      expect(result.results[0]!.lap_count).toBe(3);
    });

    it('DNF: fewer laps than required → is_dnf=true, ranked last', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' }); // DNF: only 2 of 3 laps

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000),
        makeLapEntry('p1', 3, 185_000),
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 58_000),
        makeLapEntry('p2', 2, 116_000), // only 2 laps done
      ];

      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
      expect(byId['p2']!.is_dnf).toBe(true);
      expect(byId['p1']!.rank_overall).toBe(1);
      expect(byId['p2']!.rank_overall).toBe(2);
    });

    it('no lap entries → is_dnf=true', () => {
      const p = makeParticipant({ id: 'p1' });
      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p], [], config));
      expect(result.results[0]!.is_dnf).toBe(true);
    });

    // Branch: lap-based, raceStart defined but no finishEntry at index requiredLaps → totalTimeMs=undefined
    it('lap-based: raceStart defined but missing finish entry → totalTimeMs=undefined for DNF', () => {
      const p = makeParticipant({ id: 'p1' });

      // 3 laps required, only 2 completed
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000),
      ];

      const config = makeRundConfig({ total_laps: 3 });
      const result = computeRundstrecke(makeInput([p], entries, config));
      expect(result.results[0]!.is_dnf).toBe(true);
      expect(result.results[0]!.total_time_ms).toBeUndefined();
    });

    // Branch: lap-based with exactly the required laps (finishEntry exists)
    it('lap-based: exactly required laps completed → not DNF, totalTimeMs set', () => {
      const p = makeParticipant({ id: 'p1' });

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000), // finishEntry at index 2 (total_laps=2)
      ];

      const config = makeRundConfig({ total_laps: 2 });
      const result = computeRundstrecke(makeInput([p], entries, config));
      expect(result.results[0]!.is_dnf).toBe(false);
      expect(result.results[0]!.total_time_ms).toBe(120_000);
    });
  });

  // -------------------------------------------------------------------------
  // Time-based mode
  // -------------------------------------------------------------------------

  describe('time-based (duration_ms)', () => {
    it('most laps within the time window wins', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' });

      const duration = 300_000; // 5 minutes

      // p1: 3 laps within 300 s
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 90_000),
        makeLapEntry('p1', 2, 185_000),
        makeLapEntry('p1', 3, 275_000), // still within 300_000
        makeLapEntry('p1', 4, 370_000), // outside window
        // p2: only 2 laps within 300 s
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 120_000),
        makeLapEntry('p2', 2, 245_000),
        makeLapEntry('p2', 3, 380_000), // outside window
      ];

      const config = makeRundConfig({ duration_ms: duration, total_laps: null });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
      expect(byId['p1']!.rank_overall).toBe(1);
      expect(byId['p2']!.rank_overall).toBe(2);
      expect(byId['p1']!.lap_count).toBeGreaterThan(byId['p2']!.lap_count!);
    });

    it('tiebreak: same lap count → earlier last lap timestamp wins', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' });

      const duration = 300_000;

      // Both complete 2 laps; p1 finishes last lap sooner (lower total time)
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 100_000),
        makeLapEntry('p1', 2, 200_000), // last valid: total = 200_000
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 110_000),
        makeLapEntry('p2', 2, 220_000), // last valid: total = 220_000
      ];

      const config = makeRundConfig({ duration_ms: duration, total_laps: null });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
      expect(byId['p1']!.rank_overall).toBe(1);
      expect(byId['p2']!.rank_overall).toBe(2);
    });

    it('best_lap_ms computed across all laps (including outside window)', () => {
      const p = makeParticipant({ id: 'p1' });
      const duration = 200_000;

      // Laps: 60s, 55s (best), 70s, extra lap after duration
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 115_000),
        makeLapEntry('p1', 3, 185_000),
        makeLapEntry('p1', 4, 250_000),
      ];

      const config = makeRundConfig({ duration_ms: duration, total_laps: null });
      const result = computeRundstrecke(makeInput([p], entries, config));
      expect(result.results[0]!.best_lap_ms).toBe(55_000);
    });

    it('zero laps within window → is_dnf=true', () => {
      const p = makeParticipant({ id: 'p1' });
      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 500_000), // only crossing after window
      ];

      const config = makeRundConfig({ duration_ms: 300_000, total_laps: null });
      const result = computeRundstrecke(makeInput([p], entries, config));
      expect(result.results[0]!.is_dnf).toBe(true);
    });

    // Sort branch: time-based DNF comes last
    it('time-based sort: non-DNF before DNF', () => {
      const p1 = makeParticipant({ id: 'p1' }); // has laps
      const pDnf = makeParticipant({ id: 'pDnf' }); // no entries

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 130_000),
      ];

      const config = makeRundConfig({ duration_ms: 300_000, total_laps: null });
      const result = computeRundstrecke(makeInput([pDnf, p1], entries, config));

      // p1 should rank before DNF
      expect(result.results[0]!.participant_id).toBe('p1');
      expect(result.results[1]!.participant_id).toBe('pDnf');
    });

    // Sort branch: time-based !a.isDnf && b.isDnf → -1 (non-DNF first)
    it('time-based sort: non-DNF a before DNF b (reverse order)', () => {
      const pOk = makeParticipant({ id: 'pOk' }); // finisher
      const pDnf = makeParticipant({ id: 'pDnf' }); // no entries, DNF

      const entries = [
        makeLapEntry('pOk', 0, 0),
        makeLapEntry('pOk', 1, 100_000),
        makeLapEntry('pOk', 2, 200_000),
      ];

      const config = makeRundConfig({ duration_ms: 300_000, total_laps: null });
      // Pass pDnf first in array to trigger the !a.isDnf && b.isDnf=-1 path
      const result = computeRundstrecke(makeInput([pOk, pDnf], entries, config));
      expect(result.results[0]!.participant_id).toBe('pOk');
    });
  });

  // -------------------------------------------------------------------------
  // Fallback mode (both total_laps=null and duration_ms=null)
  // -------------------------------------------------------------------------

  describe('fallback mode (neither laps nor time)', () => {
    it('uses number of lap entries as lap count, totalTime = last-first timestamp', () => {
      const p = makeParticipant({ id: 'p1' });

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 130_000),
      ];

      const config = makeRundConfig({ total_laps: null, duration_ms: null });
      const result = computeRundstrecke(makeInput([p], entries, config));

      expect(result.results[0]!.is_dnf).toBe(false);
      expect(result.results[0]!.lap_count).toBe(2); // 3 entries → 2 lap durations
      expect(result.results[0]!.total_time_ms).toBe(130_000); // last - first
    });

    it('fallback: single entry → lap duration = timestamp itself, totalTimeMs=0', () => {
      const p = makeParticipant({ id: 'p1' });

      // Only one entry: timestamps.length===1, lapDurations=[timestamps[0]]
      const entries = [makeLapEntry('p1', 0, 50_000)];

      const config = makeRundConfig({ total_laps: null, duration_ms: null });
      const result = computeRundstrecke(makeInput([p], entries, config));

      expect(result.results[0]!.is_dnf).toBe(false);
      // totalTimeMs: last - first = 50_000 - 50_000 = 0
      expect(result.results[0]!.total_time_ms).toBe(0);
      // best_lap_ms = min(lapDurations) = 50_000
      expect(result.results[0]!.best_lap_ms).toBe(50_000);
    });

    it('fallback sort: lower totalTime wins', () => {
      const p1 = makeParticipant({ id: 'p1' });
      const p2 = makeParticipant({ id: 'p2' });

      const entries = [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 150_000), // total 150_000
        makeLapEntry('p2', 0, 0),
        makeLapEntry('p2', 1, 120_000), // total 120_000 → p2 wins
      ];

      const config = makeRundConfig({ total_laps: null, duration_ms: null });
      const result = computeRundstrecke(makeInput([p1, p2], entries, config));

      expect(result.results[0]!.participant_id).toBe('p2');
      expect(result.results[1]!.participant_id).toBe('p1');
    });

    it('fallback: no entries → is_dnf=true', () => {
      const p = makeParticipant({ id: 'p1' });
      const config = makeRundConfig({ total_laps: null, duration_ms: null });
      const result = computeRundstrecke(makeInput([p], [], config));
      expect(result.results[0]!.is_dnf).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Single entry (standing start scenario)
  // -------------------------------------------------------------------------

  it('single lap entry: lapDurations=[timestamp], bestLapMs=that value', () => {
    const p = makeParticipant({ id: 'p1' });

    // Only one entry with lap_number
    const entries = [makeLapEntry('p1', 1, 90_000)];

    const config = makeRundConfig({ total_laps: null, duration_ms: null });
    const result = computeRundstrecke(makeInput([p], entries, config));

    expect(result.results[0]!.best_lap_ms).toBe(90_000);
  });

  // -------------------------------------------------------------------------
  // Gap and class ranking
  // -------------------------------------------------------------------------

  it('all DNF: gap_to_leader_ms is undefined', () => {
    const p1 = makeParticipant({ id: 'p1' });
    const p2 = makeParticipant({ id: 'p2' });

    const config = makeRundConfig({ total_laps: 3 });
    // No entries → all DNF
    const result = computeRundstrecke(makeInput([p1, p2], [], config));

    expect(result.results.every((r) => r.is_dnf)).toBe(true);
    expect(result.results.every((r) => r.gap_to_leader_ms === undefined)).toBe(true);
  });

  it('class ranking: rank_in_class independent of overall rank', () => {
    const p1 = makeParticipant({ id: 'p1', class: 'GT3' });
    const p2 = makeParticipant({ id: 'p2', class: 'GT4' });
    const p3 = makeParticipant({ id: 'p3', class: 'GT3' });

    // 2-lap race: p2 fastest, p1 second, p3 third
    const entries = [
      makeLapEntry('p1', 0, 0), makeLapEntry('p1', 1, 60_000), makeLapEntry('p1', 2, 122_000),
      makeLapEntry('p2', 0, 0), makeLapEntry('p2', 1, 55_000), makeLapEntry('p2', 2, 110_000),
      makeLapEntry('p3', 0, 0), makeLapEntry('p3', 1, 65_000), makeLapEntry('p3', 2, 135_000),
    ];

    const config = makeRundConfig({ total_laps: 2 });
    const result = computeRundstrecke(makeInput([p1, p2, p3], entries, config));
    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));

    expect(byId['p2']!.rank_overall).toBe(1);
    expect(byId['p1']!.rank_overall).toBe(2);
    expect(byId['p3']!.rank_overall).toBe(3);

    // GT3: p1=1, p3=2
    expect(byId['p1']!.rank_in_class).toBe(1);
    expect(byId['p3']!.rank_in_class).toBe(2);
    // GT4: p2=1
    expect(byId['p2']!.rank_in_class).toBe(1);
  });

  it('participants without class: rank_in_class stays undefined', () => {
    const p = makeParticipant({ id: 'p1' }); // no class
    const entries = [
      makeLapEntry('p1', 0, 0),
      makeLapEntry('p1', 1, 60_000),
      makeLapEntry('p1', 2, 120_000),
    ];

    const config = makeRundConfig({ total_laps: 2 });
    const result = computeRundstrecke(makeInput([p], entries, config));
    expect(result.results[0]!.rank_in_class).toBeUndefined();
  });

  // getLapEntries: entries without lap_number are filtered out
  it('getLapEntries: entries without lap_number are excluded', () => {
    const p = makeParticipant({ id: 'p1' });

    // One valid lap entry and one entry without lap_number
    const entries: TimeEntry[] = [
      makeLapEntry('p1', 0, 0),
      makeLapEntry('p1', 1, 60_000),
      // Entry without lap_number — should be excluded
      {
        id: 'no-lap',
        event_id: 'event-1',
        posten_id: 'posten-loop',
        participant_id: 'p1',
        source: 'manual',
        raw_timestamp_ms: 30_000,
        server_recv_ms: 30_000,
        is_confirmed: true,
        is_void: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ];

    const config = makeRundConfig({ total_laps: 1 });
    const result = computeRundstrecke(makeInput([p], entries, config));
    // Only lap entries 0 and 1 → 1 lap duration → not DNF
    expect(result.results[0]!.is_dnf).toBe(false);
    expect(result.results[0]!.lap_count).toBe(1);
  });
});
