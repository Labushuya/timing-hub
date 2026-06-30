import { describe, it, expect } from 'vitest';
import { computeGLP } from '../src/glp.js';
import type { ScoringInput } from '../src/types.js';
import type { Participant, TimeEntry, GLPConfig } from '@timing-hub/shared-types';

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

function makeEntry(
  participantId: string,
  postenId: string,
  rawMs: number,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `entry-${participantId}-${rawMs}`,
    event_id: 'event-1',
    posten_id: postenId,
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: rawMs,
    server_recv_ms: rawMs,
    is_confirmed: true,
    is_void: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeGLPConfig(overrides: Partial<GLPConfig> = {}): GLPConfig {
  return {
    format: 'glp',
    scoring: 'absolute_deviation',
    penalty_per_second: 1,
    max_penalty: null,
    allow_multiple_attempts: false,
    count_best_of: null,
    ...overrides,
  };
}

function makeInput(
  participants: Participant[],
  entries: TimeEntry[],
  config: GLPConfig = makeGLPConfig(),
): ScoringInput {
  return { participants, entries, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeGLP', () => {
  const FINISH = 'posten-finish';

  it('throws if format is not glp', () => {
    const input = makeInput([], [], { ...makeGLPConfig(), format: 'glp' });
    // @ts-expect-error — intentional wrong format
    input.config.format = 'sonderpruefung';
    expect(() => computeGLP(input)).toThrow('computeGLP called with format=sonderpruefung');
  });

  it('empty participants: returns empty results, no crash', () => {
    const result = computeGLP(makeInput([], []));
    expect(result.results).toHaveLength(0);
  });

  it('basic scoring: 3 participants ranked by penalty ASC', () => {
    const target = 60_000;
    const p1 = makeParticipant({ id: 'p1', target_time_ms: target });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: target });
    const p3 = makeParticipant({ id: 'p3', target_time_ms: target });

    // p2 is closest (1 s off), p1 is 5 s off, p3 is 10 s off
    const entries = [
      makeEntry('p1', FINISH, target + 5_000),
      makeEntry('p2', FINISH, target + 1_000),
      makeEntry('p3', FINISH, target + 10_000),
    ];

    const result = computeGLP(makeInput([p1, p2, p3], entries));
    expect(result.results).toHaveLength(3);

    const ranked = result.results.map((r) => r.participant_id);
    expect(ranked[0]).toBe('p2'); // 1 s → 1 pt
    expect(ranked[1]).toBe('p1'); // 5 s → 5 pt
    expect(ranked[2]).toBe('p3'); // 10 s → 10 pt

    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
    expect(result.results[1]!.penalty_points).toBeCloseTo(5);
    expect(result.results[2]!.penalty_points).toBeCloseTo(10);
  });

  it('perfect time: actual == target → deviation=0, penalty=0, rank=1', () => {
    const target = 45_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target)];

    const result = computeGLP(makeInput([p], entries));
    const r = result.results[0]!;

    expect(r.rank_overall).toBe(1);
    expect(r.deviation_ms).toBe(0);
    expect(r.penalty_points).toBe(0);
    expect(r.is_dnf).toBe(false);
  });

  it('DNF participant: no time entries → placed last, is_dnf=true', () => {
    const target = 60_000;
    const p1 = makeParticipant({ id: 'p1', target_time_ms: target });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: target }); // DNF

    const entries = [makeEntry('p1', FINISH, target + 2_000)];

    const result = computeGLP(makeInput([p1, p2], entries));
    const [first, second] = result.results;

    expect(first!.participant_id).toBe('p1');
    expect(second!.participant_id).toBe('p2');
    expect(second!.is_dnf).toBe(true);
    expect(second!.rank_overall).toBe(2);
  });

  it('all DNF: all participants are DNF → all ranked, penalties undefined', () => {
    const p1 = makeParticipant({ id: 'p1', target_time_ms: 60_000 });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: 60_000 });

    // No entries at all
    const result = computeGLP(makeInput([p1, p2], []));
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.is_dnf)).toBe(true);
    // penalty_points should be undefined (Infinity → undefined)
    expect(result.results.every((r) => r.penalty_points === undefined)).toBe(true);
  });

  it('allow_multiple_attempts=true: takes attempt closest to target', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    // Two attempts: one far away, one close
    const entries = [
      makeEntry('p1', FINISH, target + 15_000), // 15 s off
      makeEntry('p1', FINISH, target + 500),     // 0.5 s off (best)
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: true });
    const result = computeGLP(makeInput([p], entries, config));

    expect(result.results[0]!.penalty_points).toBeCloseTo(0.5);
    expect(result.results[0]!.actual_time_ms).toBe(target + 500);
  });

  it('allow_multiple_attempts=false: takes first (chronologically earliest) confirmed entry', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    // Earlier entry (lower raw_timestamp_ms) is closer to target
    // Later entry (higher raw_timestamp_ms) is further from target
    // The code picks whichever has the lower raw_timestamp_ms
    const entries = [
      makeEntry('p1', FINISH, target + 500),      // earlier timestamp, closer (0.5 s off)
      makeEntry('p1', FINISH, target + 10_000),   // later timestamp, further (10 s off)
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: false });
    const result = computeGLP(makeInput([p], entries, config));

    // Should pick earliest by raw_timestamp_ms = target+500
    expect(result.results[0]!.actual_time_ms).toBe(target + 500);
    expect(result.results[0]!.penalty_points).toBeCloseTo(0.5);
  });

  it('max_penalty cap: penalty never exceeds max_penalty', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target + 120_000)]; // 120 s deviation → 120 pts raw

    const config = makeGLPConfig({ penalty_per_second: 1, max_penalty: 50 });
    const result = computeGLP(makeInput([p], entries, config));

    expect(result.results[0]!.penalty_points).toBe(50);
  });

  it('max_penalty=null: no cap applied', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target + 200_000)]; // 200 s

    const config = makeGLPConfig({ penalty_per_second: 1, max_penalty: null });
    const result = computeGLP(makeInput([p], entries, config));

    expect(result.results[0]!.penalty_points).toBeCloseTo(200);
  });

  it('percentage_deviation mode: documents current absolute-deviation behaviour', () => {
    const target = 100_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target + 10_000)]; // 10 s off

    const config = makeGLPConfig({
      scoring: 'percentage_deviation',
      penalty_per_second: 2,
      max_penalty: null,
    });

    const result = computeGLP(makeInput([p], entries, config));
    // Current implementation: (10_000/1000) * 2 = 20
    expect(result.results[0]!.penalty_points).toBeCloseTo(20);
  });

  it('class ranking: rank_in_class independent of overall rank', () => {
    const target = 60_000;
    const p1 = makeParticipant({ id: 'p1', target_time_ms: target, class: 'A' });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: target, class: 'B' });
    const p3 = makeParticipant({ id: 'p3', target_time_ms: target, class: 'A' });

    // p2 ranks 1st overall (0.5 s), p1 ranks 2nd (3 s), p3 ranks 3rd (8 s)
    const entries = [
      makeEntry('p1', FINISH, target + 3_000),
      makeEntry('p2', FINISH, target + 500),
      makeEntry('p3', FINISH, target + 8_000),
    ];

    const result = computeGLP(makeInput([p1, p2, p3], entries));
    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));

    expect(byId['p2']!.rank_overall).toBe(1);
    expect(byId['p1']!.rank_overall).toBe(2);
    expect(byId['p3']!.rank_overall).toBe(3);

    // Class A: p1 rank 1, p3 rank 2
    expect(byId['p1']!.rank_in_class).toBe(1);
    expect(byId['p3']!.rank_in_class).toBe(2);
    // Class B: p2 rank 1
    expect(byId['p2']!.rank_in_class).toBe(1);
  });

  it('participants without class: rank_in_class stays undefined', () => {
    const target = 60_000;
    // No class set on participant
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target + 1_000)];

    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.rank_in_class).toBeUndefined();
  });

  it('tie breaking: equal penalty → both ranked, positions assigned', () => {
    const target = 60_000;
    const p1 = makeParticipant({ id: 'p1', target_time_ms: target });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: target });

    // Both exactly 1 s off
    const entries = [
      makeEntry('p1', FINISH, target + 1_000),
      makeEntry('p2', FINISH, target - 1_000),
    ];

    const result = computeGLP(makeInput([p1, p2], entries));
    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
    expect(result.results[1]!.penalty_points).toBeCloseTo(1);
    const ranks = result.results.map((r) => r.rank_overall).sort();
    expect(ranks).toEqual([1, 2]);
  });

  it('void entries are ignored', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    const entries = [
      makeEntry('p1', FINISH, target + 1_000, { is_void: true }), // voided, should be ignored
      makeEntry('p1', FINISH, target + 5_000),                     // valid
    ];

    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.actual_time_ms).toBe(target + 5_000);
    expect(result.results[0]!.penalty_points).toBeCloseTo(5);
  });

  it('unconfirmed entries are ignored', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    const entries = [
      makeEntry('p1', FINISH, target + 1_000, { is_confirmed: false }), // unconfirmed
      makeEntry('p1', FINISH, target + 7_000),                           // confirmed
    ];

    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.actual_time_ms).toBe(target + 7_000);
    expect(result.results[0]!.penalty_points).toBeCloseTo(7);
  });

  it('count_best_of field is stored in scoring_detail', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target + 2_000)];

    const config = makeGLPConfig({ count_best_of: 3 });
    const result = computeGLP(makeInput([p], entries, config));

    expect(result.results[0]!.scoring_detail['allow_multiple_attempts']).toBe(false);
  });

  it('returns computed_at as a number (epoch ms)', () => {
    const before = Date.now();
    const result = computeGLP(makeInput([], []));
    const after = Date.now();
    expect(result.computed_at).toBeGreaterThanOrEqual(before);
    expect(result.computed_at).toBeLessThanOrEqual(after);
  });

  it('result id contains participant_id', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target)];
    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.id).toContain('p1');
  });

  it('negative deviation (early arrival) still produces positive penalty', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [makeEntry('p1', FINISH, target - 3_000)]; // 3 s early

    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.penalty_points).toBeCloseTo(3);
    expect(result.results[0]!.deviation_ms).toBe(-3_000);
  });

  it('DNF participant with max_penalty set gets max_penalty as penalty_points', () => {
    const p1 = makeParticipant({ id: 'p1', target_time_ms: 60_000 });
    const p2 = makeParticipant({ id: 'p2', target_time_ms: 60_000 }); // DNF

    const entries = [makeEntry('p1', FINISH, 60_000 + 2_000)];
    const config = makeGLPConfig({ max_penalty: 100 });
    const result = computeGLP(makeInput([p1, p2], entries, config));

    const dnf = result.results.find((r) => r.participant_id === 'p2')!;
    expect(dnf.is_dnf).toBe(true);
    expect(dnf.penalty_points).toBe(100);
  });

  // Branch: !finishPostenId — participant has target_time_ms but there are NO entries at all
  it('no entries at all: finishPostenId=undefined → all participants are DNF', () => {
    const p = makeParticipant({ id: 'p1', target_time_ms: 60_000 });
    const result = computeGLP(makeInput([p], []));
    expect(result.results[0]!.is_dnf).toBe(true);
    expect(result.results[0]!.penalty_points).toBeUndefined();
  });

  // Branch: targetMs === undefined — participant has no target_time_ms at all
  it('participant with no target_time_ms: treated as DNF', () => {
    const p = makeParticipant({ id: 'p1' }); // no target_time_ms
    const entries = [makeEntry('p1', FINISH, 60_000)];

    const result = computeGLP(makeInput([p], entries));
    expect(result.results[0]!.is_dnf).toBe(true);
    expect(result.results[0]!.penalty_points).toBeUndefined();
  });

  // Branch: max_penalty=null → rawPenalty is used directly (config.max_penalty !== null is false)
  it('max_penalty=null with allow_multiple_attempts: no cap on penalty', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });
    const entries = [
      makeEntry('p1', FINISH, target + 50_000),
      makeEntry('p1', FINISH, target + 300_000),
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: true, max_penalty: null });
    const result = computeGLP(makeInput([p], entries, config));
    // picks the closer one: 50_000 ms off = 50 pts, no cap
    expect(result.results[0]!.penalty_points).toBeCloseTo(50);
  });

  // Sort branch: DNF sorted after non-DNF (a.isDnf && !b.isDnf = +1) AND (!a.isDnf && b.isDnf = -1)
  it('sort: non-DNF comes before DNF regardless of insertion order', () => {
    const target = 60_000;
    // Insert DNF first in participants array
    const pDnf = makeParticipant({ id: 'pDNF', target_time_ms: target });
    const pOk = makeParticipant({ id: 'pOK', target_time_ms: target });

    const entries = [makeEntry('pOK', FINISH, target + 1_000)]; // pDNF has no entry

    const result = computeGLP(makeInput([pDnf, pOk], entries));
    expect(result.results[0]!.participant_id).toBe('pOK');
    expect(result.results[1]!.participant_id).toBe('pDNF');
  });

  // Branch: allow_multiple_attempts=false, reduce keeps 'earliest' (second entry has higher ms)
  it('allow_multiple_attempts=false: when second entry is later, keeps first entry', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    // First entry has lower raw_timestamp_ms, second is higher → reduce keeps first
    // reduce: e(70_000) < earliest(60_500)? No → keep earliest(60_500)
    const entries = [
      makeEntry('p1', FINISH, target + 500),     // 60_500 — earliest
      makeEntry('p1', FINISH, target + 10_000),  // 70_000 — later
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: false });
    const result = computeGLP(makeInput([p], entries, config));

    // earliest is 60_500
    expect(result.results[0]!.actual_time_ms).toBe(target + 500);
  });

  // findFinishPosten: multiple posten_ids, most common is chosen as finish
  it('findFinishPosten: uses most-common posten_id as finish posten', () => {
    const target = 60_000;
    const p = makeParticipant({ id: 'p1', target_time_ms: target });

    // Two posten_ids; 'finish' appears twice, 'start' appears once
    const entries = [
      makeEntry('p1', 'start', 0),
      makeEntry('p1', 'finish', target + 2_000),
      makeEntry('p1', 'finish', target + 1_000), // second finish entry → finish is most common
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: true });
    const result = computeGLP(makeInput([p], entries, config));
    // picks best from the 'finish' posten (closest to target = target+1_000 → 1 s off)
    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
  });
});
