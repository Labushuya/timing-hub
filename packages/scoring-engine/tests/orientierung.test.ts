import { describe, it, expect } from 'vitest';
import { computeOrientierung } from '../src/orientierung.js';
import type { ScoringInput } from '../src/types.js';
import type { Participant, TimeEntry, OrientierungConfig } from '@timing-hub/shared-types';

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
  channel: string,
  rawMs: number,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `entry-${participantId}-${channel}`,
    event_id: 'event-1',
    posten_id: `posten-${channel}`,
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: rawMs,
    server_recv_ms: rawMs,
    is_confirmed: true,
    is_void: false,
    channel,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOrientConfig(
  sections: OrientierungConfig['sections'],
  overrides: Partial<OrientierungConfig> = {},
): OrientierungConfig {
  return {
    format: 'orientierung',
    sections,
    late_penalty_per_second: 1,
    early_penalty_per_second: 1,
    ...overrides,
  };
}

function makeInput(
  participants: Participant[],
  entries: TimeEntry[],
  config: OrientierungConfig,
): ScoringInput {
  return { participants, entries, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeOrientierung', () => {
  it('throws if format is not orientierung', () => {
    const config = makeOrientConfig([]);
    const input = makeInput([], [], config);
    // @ts-expect-error — intentional wrong format
    input.config.format = 'glp';
    expect(() => computeOrientierung(input)).toThrow(
      'computeOrientierung called with format=glp',
    );
  });

  it('empty participants: returns empty results without crash', () => {
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: 60_000 }]);
    const result = computeOrientierung(makeInput([], [], config));
    expect(result.results).toHaveLength(0);
  });

  it('on-time section: no penalty', () => {
    const p = makeParticipant({ id: 'p1' });
    const target = 60_000;

    const entries = [makeEntry('p1', 'A', target)];
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: target }]);

    const result = computeOrientierung(makeInput([p], entries, config));
    expect(result.results[0]!.penalty_points).toBe(0);
    expect(result.results[0]!.is_dnf).toBe(false);
  });

  it('late section: penalty = seconds_late * late_penalty_per_second', () => {
    const p = makeParticipant({ id: 'p1' });
    const target = 60_000;
    const actual = target + 5_000; // 5 s late

    const entries = [makeEntry('p1', 'A', actual)];
    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: target }],
      { late_penalty_per_second: 2 },
    );

    const result = computeOrientierung(makeInput([p], entries, config));
    // 5 s late * 2 = 10 pts
    expect(result.results[0]!.penalty_points).toBeCloseTo(10);
  });

  it('early section: penalty = seconds_early * early_penalty_per_second', () => {
    const p = makeParticipant({ id: 'p1' });
    const target = 60_000;
    const actual = target - 3_000; // 3 s early

    const entries = [makeEntry('p1', 'A', actual)];
    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: target }],
      { early_penalty_per_second: 3, late_penalty_per_second: 1 },
    );

    const result = computeOrientierung(makeInput([p], entries, config));
    // 3 s early * 3 = 9 pts
    expect(result.results[0]!.penalty_points).toBeCloseTo(9);
  });

  it('multiple sections: penalties sum correctly', () => {
    const p = makeParticipant({ id: 'p1' });

    // Section A: 2 s late → 2 pts; Section B: 4 s early → 4 pts; total = 6
    const entries = [
      makeEntry('p1', 'A', 60_000 + 2_000), // 2 s late
      makeEntry('p1', 'B', 120_000 - 4_000), // 4 s early
    ];

    const config = makeOrientConfig(
      [
        { code: 'A', name: 'A', target_ms: 60_000 },
        { code: 'B', name: 'B', target_ms: 120_000 },
      ],
      { late_penalty_per_second: 1, early_penalty_per_second: 1 },
    );

    const result = computeOrientierung(makeInput([p], entries, config));
    expect(result.results[0]!.penalty_points).toBeCloseTo(6);
  });

  it('missing section time with no target: treated as DNF (Infinity penalty)', () => {
    const p = makeParticipant({ id: 'p1' });

    // No entries at all — section A has no target_ms (null), missing entry → infinity
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: null }]);
    const result = computeOrientierung(makeInput([p], [], config));

    // When target_ms is null and entry is missing: missingPenalty = Infinity → isDnf = true
    expect(result.results[0]!.is_dnf).toBe(true);
    expect(result.results[0]!.penalty_points).toBeUndefined(); // Infinity → undefined
  });

  it('missing section time with target_ms set: finite penalty, no DNF', () => {
    const p = makeParticipant({ id: 'p1' });

    // Section A: target = 60_000, no entry
    // missingPenalty = (60_000/1000) * max(1,1) = 60 pts (finite, no DNF)
    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: 60_000 }],
      { late_penalty_per_second: 1, early_penalty_per_second: 1 },
    );

    const result = computeOrientierung(makeInput([p], [], config));
    expect(result.results[0]!.is_dnf).toBe(false);
    expect(result.results[0]!.penalty_points).toBeCloseTo(60);
  });

  it('rank by total penalty ascending', () => {
    const p1 = makeParticipant({ id: 'p1' });
    const p2 = makeParticipant({ id: 'p2' });
    const p3 = makeParticipant({ id: 'p3' });

    const target = 60_000;

    // p2: 1 s late = 1 pt, p1: 5 s late = 5 pt, p3: 10 s late = 10 pt
    const entries = [
      makeEntry('p1', 'A', target + 5_000),
      makeEntry('p2', 'A', target + 1_000),
      makeEntry('p3', 'A', target + 10_000),
    ];

    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: target }]);
    const result = computeOrientierung(makeInput([p1, p2, p3], entries, config));

    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));
    expect(byId['p2']!.rank_overall).toBe(1);
    expect(byId['p1']!.rank_overall).toBe(2);
    expect(byId['p3']!.rank_overall).toBe(3);
  });

  it('class ranking: rank_in_class independent of overall rank', () => {
    const p1 = makeParticipant({ id: 'p1', class: 'Historic' });
    const p2 = makeParticipant({ id: 'p2', class: 'Modern' });
    const p3 = makeParticipant({ id: 'p3', class: 'Historic' });

    const target = 60_000;

    // p2 best overall (0 s), p1 second (3 s), p3 third (7 s)
    const entries = [
      makeEntry('p1', 'A', target + 3_000),
      makeEntry('p2', 'A', target),         // perfect
      makeEntry('p3', 'A', target + 7_000),
    ];

    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: target }]);
    const result = computeOrientierung(makeInput([p1, p2, p3], entries, config));
    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));

    // Overall
    expect(byId['p2']!.rank_overall).toBe(1);
    expect(byId['p1']!.rank_overall).toBe(2);
    expect(byId['p3']!.rank_overall).toBe(3);

    // Historic class: p1=1, p3=2
    expect(byId['p1']!.rank_in_class).toBe(1);
    expect(byId['p3']!.rank_in_class).toBe(2);
    // Modern class: p2=1
    expect(byId['p2']!.rank_in_class).toBe(1);
  });

  it('section with target_ms=null and entry present: no penalty', () => {
    const p = makeParticipant({ id: 'p1' });
    const entries = [makeEntry('p1', 'A', 999_999)];

    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: null }]);
    const result = computeOrientierung(makeInput([p], entries, config));

    expect(result.results[0]!.penalty_points).toBe(0);
    expect(result.results[0]!.is_dnf).toBe(false);
  });

  it('section matched by sector_number fallback', () => {
    const p = makeParticipant({ id: 'p1' });
    const target = 60_000;

    // Entry has no channel but has sector_number=1 matching section index 0+1=1
    const entry: TimeEntry = {
      id: 'e1',
      event_id: 'event-1',
      posten_id: 'posten-1',
      participant_id: 'p1',
      source: 'manual',
      raw_timestamp_ms: target + 2_000,
      server_recv_ms: target + 2_000,
      sector_number: 1,
      is_confirmed: true,
      is_void: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const config = makeOrientConfig([{ code: 'X', name: 'X', target_ms: target }]);
    const result = computeOrientierung(makeInput([p], [entry], config));

    // 2 s late → 2 pts
    expect(result.results[0]!.penalty_points).toBeCloseTo(2);
  });

  it('different late vs early penalty rates applied correctly', () => {
    const p = makeParticipant({ id: 'p1' });
    const target = 60_000;

    // 10 s late, late_penalty=3, early_penalty=1 → should use late rate = 30 pts
    const entries = [makeEntry('p1', 'A', target + 10_000)];
    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: target }],
      { late_penalty_per_second: 3, early_penalty_per_second: 1 },
    );

    const result = computeOrientierung(makeInput([p], entries, config));
    expect(result.results[0]!.penalty_points).toBeCloseTo(30);
  });

  // Sort branch: a.isDnf && !b.isDnf → return 1 (DNF goes last)
  it('sort: DNF placed last regardless of insertion order', () => {
    const pDnf = makeParticipant({ id: 'pDnf' }); // no entry → DNF
    const pOk = makeParticipant({ id: 'pOk' });

    const entries = [makeEntry('pOk', 'A', 60_000)];
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: 60_000 }]);

    // Insert DNF first
    const result = computeOrientierung(makeInput([pDnf, pOk], entries, config));
    expect(result.results[0]!.participant_id).toBe('pOk');
    expect(result.results[1]!.participant_id).toBe('pDnf');
  });

  // Sort branch: !a.isDnf && b.isDnf → return -1 (non-DNF first)
  it('sort: non-DNF wins over DNF (b is DNF)', () => {
    const pOk = makeParticipant({ id: 'pOk' }); // inserted first
    const pDnf = makeParticipant({ id: 'pDnf' }); // no entry → DNF, inserted second

    const entries = [makeEntry('pOk', 'A', 60_000)];
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: 60_000 }]);

    const result = computeOrientierung(makeInput([pOk, pDnf], entries, config));
    expect(result.results[0]!.participant_id).toBe('pOk');
    expect(result.results[1]!.participant_id).toBe('pDnf');
  });

  // Branch: section_times non-empty → section_times present in result
  it('section_times populated when sections have entries', () => {
    const p = makeParticipant({ id: 'p1' });
    const entries = [
      makeEntry('p1', 'A', 60_000),
      makeEntry('p1', 'B', 120_000),
    ];
    const config = makeOrientConfig([
      { code: 'A', name: 'A', target_ms: 60_000 },
      { code: 'B', name: 'B', target_ms: 120_000 },
    ]);

    const result = computeOrientierung(makeInput([p], entries, config));
    expect(result.results[0]!.section_times).toBeDefined();
    expect(result.results[0]!.section_times!['A']).toBe(60_000);
    expect(result.results[0]!.section_times!['B']).toBe(120_000);
  });

  // Branch: section_times empty → undefined in result (no sections config)
  it('no sections config: section_times is undefined in result', () => {
    const p = makeParticipant({ id: 'p1' });
    const config = makeOrientConfig([]); // no sections

    const result = computeOrientierung(makeInput([p], [], config));
    expect(result.results[0]!.section_times).toBeUndefined();
  });

  // Branch: participants without class → rank_in_class stays undefined
  it('participant without class: rank_in_class is undefined', () => {
    const p = makeParticipant({ id: 'p1' }); // no class
    const entries = [makeEntry('p1', 'A', 60_000)];
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: 60_000 }]);

    const result = computeOrientierung(makeInput([p], entries, config));
    expect(result.results[0]!.rank_in_class).toBeUndefined();
  });

  // Branch: missing section with larger late vs early penalty for missingPenalty calculation
  it('missing section: missingPenalty uses max(late, early) rate', () => {
    const p = makeParticipant({ id: 'p1' });

    // target_ms = 10_000, late_penalty=3, early_penalty=1 → max=3
    // missingPenalty = (10_000/1000) * 3 = 30 pts (finite → not DNF)
    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: 10_000 }],
      { late_penalty_per_second: 3, early_penalty_per_second: 1 },
    );

    const result = computeOrientierung(makeInput([p], [], config));
    expect(result.results[0]!.is_dnf).toBe(false);
    expect(result.results[0]!.penalty_points).toBeCloseTo(30);
  });

  // Branch: isDnf=true → totalPenalty=Infinity → penalty_points=undefined
  it('DNF participant: penalty_points is undefined', () => {
    const p = makeParticipant({ id: 'p1' });

    const config = makeOrientConfig(
      [{ code: 'A', name: 'A', target_ms: null }], // null target → missing → Infinity
    );

    const result = computeOrientierung(makeInput([p], [], config));
    expect(result.results[0]!.is_dnf).toBe(true);
    expect(result.results[0]!.penalty_points).toBeUndefined();
  });

  // Ensure sort comparator is called with both orientations of DNF vs non-DNF
  // This covers both branches of lines 152-153 in orientierung.ts
  it('sort comparator: exercises both (a=DNF,b=ok) and (a=ok,b=DNF) paths', () => {
    const pOk1 = makeParticipant({ id: 'pOk1' });
    const pOk2 = makeParticipant({ id: 'pOk2' });
    const pDnf = makeParticipant({ id: 'pDnf' });

    const target = 60_000;
    const entries = [
      makeEntry('pOk1', 'A', target + 1_000),
      makeEntry('pOk2', 'A', target + 2_000),
      // pDnf has no entry → isDnf=true (section has target_ms=null → missing → Infinity)
    ];
    const config = makeOrientConfig([{ code: 'A', name: 'A', target_ms: null }]);

    // With 3 participants, the sort comparator will be called with both
    // (a=pDnf, b=pOk1) → a.isDnf && !b.isDnf → return 1
    // (a=pOk1, b=pDnf) → !a.isDnf && b.isDnf → return -1
    const result = computeOrientierung(makeInput([pDnf, pOk1, pOk2], entries, config));
    expect(result.results.at(-1)!.participant_id).toBe('pDnf');
  });

  // Branch: returned computed_at is a number
  it('returns computed_at as a number (epoch ms)', () => {
    const before = Date.now();
    const config = makeOrientConfig([]);
    const result = computeOrientierung(makeInput([], [], config));
    const after = Date.now();
    expect(result.computed_at).toBeGreaterThanOrEqual(before);
    expect(result.computed_at).toBeLessThanOrEqual(after);
  });
});
