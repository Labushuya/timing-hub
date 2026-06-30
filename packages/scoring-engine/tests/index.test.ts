import { describe, it, expect } from 'vitest';
import { computeResults } from '../src/index.js';
import type { ScoringInput } from '../src/types.js';
import type {
  Participant,
  TimeEntry,
  GLPConfig,
  SPConfig,
  RundstreckeConfig,
  OrientierungConfig,
  EventConfig,
} from '@timing-hub/shared-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParticipant(id: string): Participant {
  return {
    id,
    event_id: 'event-1',
    startnummer: id,
    driver_name: `Driver ${id}`,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function makeLapEntry(participantId: string, lapNumber: number, rawMs: number): TimeEntry {
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
  };
}

function makeFinishEntry(participantId: string, rawMs: number): TimeEntry {
  return {
    id: `entry-${participantId}-finish`,
    event_id: 'event-1',
    posten_id: 'posten-finish',
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: rawMs,
    server_recv_ms: rawMs,
    is_confirmed: true,
    is_void: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function makeChannelEntry(participantId: string, channel: string, rawMs: number): TimeEntry {
  return {
    id: `entry-${participantId}-${channel}`,
    event_id: 'event-1',
    posten_id: `posten-${channel}`,
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: rawMs,
    server_recv_ms: rawMs,
    channel,
    is_confirmed: true,
    is_void: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeResults (dispatch)', () => {
  it('dispatches to computeGLP for format=glp', () => {
    const config: GLPConfig = {
      format: 'glp',
      scoring: 'absolute_deviation',
      penalty_per_second: 1,
      max_penalty: null,
      allow_multiple_attempts: false,
      count_best_of: null,
    };

    const p = makeParticipant('p1');
    const input: ScoringInput = {
      participants: [{ ...p, target_time_ms: 60_000 }],
      entries: [makeFinishEntry('p1', 61_000)],
      config,
    };

    const result = computeResults(input);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.is_dnf).toBe(false);
    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
  });

  it('dispatches to computeSonderprüfung for format=sonderpruefung', () => {
    const config: SPConfig = {
      format: 'sonderpruefung',
      sectors: [],
      dnf_time_ms: null,
      ties_broken_by: 'earliest_start',
    };

    const p = makeParticipant('p1');
    const input: ScoringInput = {
      participants: [p],
      entries: [makeFinishEntry('p1', 30_000)],
      config,
    };

    const result = computeResults(input);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.rank_overall).toBe(1);
    expect(result.results[0]!.is_dnf).toBe(false);
  });

  it('dispatches to computeRundstrecke for format=rundstrecke', () => {
    const config: RundstreckeConfig = {
      format: 'rundstrecke',
      total_laps: 2,
      duration_ms: null,
      standing_start: false,
    };

    const p = makeParticipant('p1');
    const input: ScoringInput = {
      participants: [p],
      entries: [
        makeLapEntry('p1', 0, 0),
        makeLapEntry('p1', 1, 60_000),
        makeLapEntry('p1', 2, 120_000),
      ],
      config,
    };

    const result = computeResults(input);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.is_dnf).toBe(false);
    expect(result.results[0]!.total_time_ms).toBe(120_000);
  });

  it('dispatches to computeOrientierung for format=orientierung', () => {
    const config: OrientierungConfig = {
      format: 'orientierung',
      sections: [{ code: 'A', name: 'Section A', target_ms: 60_000 }],
      late_penalty_per_second: 1,
      early_penalty_per_second: 1,
    };

    const p = makeParticipant('p1');
    const input: ScoringInput = {
      participants: [p],
      entries: [makeChannelEntry('p1', 'A', 60_000)],
      config,
    };

    const result = computeResults(input);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.penalty_points).toBe(0);
    expect(result.results[0]!.is_dnf).toBe(false);
  });

  it('throws for unknown format', () => {
    const config = { format: 'unknown_format' } as unknown as EventConfig;
    const input: ScoringInput = {
      participants: [],
      entries: [],
      config,
    };

    expect(() => computeResults(input)).toThrow('Unknown event format');
  });

  it('returns a ScoringResult with computed_at as a number', () => {
    const config: GLPConfig = {
      format: 'glp',
      scoring: 'absolute_deviation',
      penalty_per_second: 1,
      max_penalty: null,
      allow_multiple_attempts: false,
      count_best_of: null,
    };

    const before = Date.now();
    const result = computeResults({ participants: [], entries: [], config });
    const after = Date.now();

    expect(typeof result.computed_at).toBe('number');
    expect(result.computed_at).toBeGreaterThanOrEqual(before);
    expect(result.computed_at).toBeLessThanOrEqual(after);
  });
});
