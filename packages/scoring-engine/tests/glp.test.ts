import { describe, it, expect } from 'vitest';
import { computeGLP } from '../src/glp.js';
import type { ExtendedScoringInput, PostenWithOrder, SectionTarget } from '../src/types.js';
import type { Participant, TimeEntry, GLPConfig } from '@timing-hub/shared-types';

// ---------------------------------------------------------------------------
// Test setup: realistic 2-posten layout (START → ZIEL)
// raw_timestamp_ms = absolute wall-clock ms
// Duration = ZIEL_ts - START_ts
// ---------------------------------------------------------------------------

const START_ID = 'posten-start';
const ZIEL_ID  = 'posten-ziel';
const ZZ1_ID   = 'posten-zz1';

const DEFAULT_POSTEN: PostenWithOrder[] = [
  { id: START_ID, code: 'START', role: 'start',  sort_order: 0 },
  { id: ZIEL_ID,  code: 'ZIEL',  role: 'finish', sort_order: 1 },
];

const THREE_POSTEN: PostenWithOrder[] = [
  { id: START_ID, code: 'START', role: 'start',        sort_order: 0 },
  { id: ZZ1_ID,   code: 'ZZ1',   role: 'intermediate', sort_order: 1 },
  { id: ZIEL_ID,  code: 'ZIEL',  role: 'finish',        sort_order: 2 },
];

const BASE_TS = 10_000_000; // arbitrary epoch base so diffs are clean

// Helper: make a participant
function makeParticipant(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    event_id: 'event-1',
    startnummer: id,
    driver_name: `Driver ${id}`,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// Helper: make a time entry at a given posten with a given absolute timestamp
function makeEntry(
  participantId: string,
  postenId: string,
  timestampMs: number,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `entry-${participantId}-${postenId}-${timestampMs}`,
    event_id: 'event-1',
    posten_id: postenId,
    participant_id: participantId,
    source: 'manual',
    raw_timestamp_ms: timestampMs,
    server_recv_ms: timestampMs,
    is_confirmed: true,
    is_void: false,
    lap_number: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// Helper: make start+finish entries for a participant given a duration
function makeRun(
  participantId: string,
  durationMs: number,
  lapNumber = 1,
): TimeEntry[] {
  return [
    makeEntry(participantId, START_ID, BASE_TS, { lap_number: lapNumber }),
    makeEntry(participantId, ZIEL_ID,  BASE_TS + durationMs, { lap_number: lapNumber }),
  ];
}

// Helper: default GLP config
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

// Helper: section target (total route = null→null)
function totalTarget(targetMs: number, cls: string | null = null): SectionTarget {
  return { from_posten_id: null, to_posten_id: null, class: cls, target_time_ms: targetMs };
}

// Helper: section target for a specific section
function sectionTarget(
  from: string, to: string, targetMs: number, cls: string | null = null,
): SectionTarget {
  return { from_posten_id: from, to_posten_id: to, class: cls, target_time_ms: targetMs };
}

// Helper: build ExtendedScoringInput
function makeInput(
  participants: Participant[],
  entries: TimeEntry[],
  sectionTargets: SectionTarget[],
  config: GLPConfig = makeGLPConfig(),
  posten: PostenWithOrder[] = DEFAULT_POSTEN,
  runScoring: 'sum' | 'best' | 'best_of_n' = 'best',
  runScoringN?: number,
): ExtendedScoringInput {
  return {
    participants,
    entries,
    config,
    posten,
    section_targets: sectionTargets,
    run_scoring: runScoring,
    run_scoring_n: runScoringN,
    hide_target_times: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeGLP', () => {

  it('throws if format is not glp', () => {
    const input = makeInput([], [], []);
    // @ts-expect-error — intentional wrong format
    input.config.format = 'sonderpruefung';
    expect(() => computeGLP(input)).toThrow();
  });

  it('empty participants: returns empty results, no crash', () => {
    const result = computeGLP(makeInput([], [], []));
    expect(result.results).toHaveLength(0);
  });

  it('basic scoring: 3 participants ranked by penalty ASC', () => {
    const target = 60_000;
    const p1 = makeParticipant('p1');
    const p2 = makeParticipant('p2');
    const p3 = makeParticipant('p3');

    // p2 is closest (1 s off), p1 is 5 s off, p3 is 10 s off
    const entries = [
      ...makeRun('p1', target + 5_000),
      ...makeRun('p2', target + 1_000),
      ...makeRun('p3', target + 10_000),
    ];

    const result = computeGLP(makeInput([p1, p2, p3], entries, [totalTarget(target)]));
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
    const p = makeParticipant('p1');
    const entries = makeRun('p1', target);

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)]));
    const r = result.results[0]!;

    expect(r.rank_overall).toBe(1);
    expect(r.deviation_ms).toBe(0);
    expect(r.penalty_points).toBe(0);
    expect(r.is_dnf).toBe(false);
  });

  it('early arrival (negative deviation) still produces positive penalty', () => {
    const target = 60_000;
    const p = makeParticipant('p1');
    const entries = makeRun('p1', target - 3_000); // 3 s early

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)]));
    expect(result.results[0]!.penalty_points).toBeCloseTo(3);
  });

  it('DNF participant: no finish entry → placed last, is_dnf=true', () => {
    const target = 60_000;
    const p1 = makeParticipant('p1');
    const p2 = makeParticipant('p2'); // DNF — has start but no finish

    const entries = [
      ...makeRun('p1', target + 2_000),
      makeEntry('p2', START_ID, BASE_TS), // only start, no finish
    ];

    const result = computeGLP(makeInput([p1, p2], entries, [totalTarget(target)]));
    const [first, second] = result.results;

    expect(first!.participant_id).toBe('p1');
    expect(second!.participant_id).toBe('p2');
    expect(second!.is_dnf).toBe(true);
    expect(second!.rank_overall).toBe(2);
  });

  it('all DNF: all participants DNF → all ranked, no penalty_points', () => {
    const p1 = makeParticipant('p1');
    const p2 = makeParticipant('p2');
    // No entries at all
    const result = computeGLP(makeInput([p1, p2], [], [totalTarget(60_000)]));
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.is_dnf)).toBe(true);
  });

  it('max_penalty cap: penalty never exceeds max_penalty', () => {
    const target = 60_000;
    const p = makeParticipant('p1');
    const entries = makeRun('p1', target + 120_000); // 120 s deviation → 120 pts raw

    const config = makeGLPConfig({ penalty_per_second: 1, max_penalty: 50 });
    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], config));
    expect(result.results[0]!.penalty_points).toBe(50);
  });

  it('max_penalty=null: no cap applied', () => {
    const target = 60_000;
    const p = makeParticipant('p1');
    const entries = makeRun('p1', target + 200_000); // 200 s

    const config = makeGLPConfig({ penalty_per_second: 1, max_penalty: null });
    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], config));
    expect(result.results[0]!.penalty_points).toBeCloseTo(200);
  });

  it('percentage_deviation mode: absolute deviation * penalty_per_second', () => {
    const target = 100_000;
    const p = makeParticipant('p1');
    const entries = makeRun('p1', target + 10_000); // 10 s off

    const config = makeGLPConfig({ scoring: 'percentage_deviation', penalty_per_second: 2, max_penalty: null });
    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], config));
    expect(result.results[0]!.penalty_points).toBeCloseTo(20); // (10_000/1000) * 2
  });

  it('class ranking: rank_in_class independent of overall rank', () => {
    const target = 60_000;
    const p1 = makeParticipant('p1', { class: 'A' });
    const p2 = makeParticipant('p2', { class: 'B' });
    const p3 = makeParticipant('p3', { class: 'A' });

    const entries = [
      ...makeRun('p1', target + 3_000),
      ...makeRun('p2', target + 500),
      ...makeRun('p3', target + 8_000),
    ];

    const result = computeGLP(makeInput([p1, p2, p3], entries, [totalTarget(target)]));
    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));

    expect(byId['p2']!.rank_overall).toBe(1);
    expect(byId['p1']!.rank_overall).toBe(2);
    expect(byId['p3']!.rank_overall).toBe(3);

    expect(byId['p1']!.rank_in_class).toBe(1); // best in class A
    expect(byId['p3']!.rank_in_class).toBe(2); // second in class A
    expect(byId['p2']!.rank_in_class).toBe(1); // only in class B
  });

  it('participants without class: rank_in_class stays undefined', () => {
    const p = makeParticipant('p1'); // no class
    const entries = makeRun('p1', 61_000);

    const result = computeGLP(makeInput([p], entries, [totalTarget(60_000)]));
    expect(result.results[0]!.rank_in_class).toBeUndefined();
  });

  it('class-specific section target overrides general target', () => {
    const p_a = makeParticipant('p1', { class: 'A' });
    const p_b = makeParticipant('p2', { class: 'B' });

    // Both run 62s. General target = 60s, Class A target = 62s (perfect for p1)
    const entries = [
      ...makeRun('p1', 62_000),
      ...makeRun('p2', 62_000),
    ];

    const targets = [
      totalTarget(60_000, null), // general: 60s
      totalTarget(62_000, 'A'),  // class A: 62s (perfect)
    ];

    const result = computeGLP(makeInput([p_a, p_b], entries, targets));
    const byId = Object.fromEntries(result.results.map((r) => [r.participant_id, r]));

    expect(byId['p1']!.penalty_points).toBe(0);       // p1: 62s vs 62s = perfect
    expect(byId['p2']!.penalty_points).toBeCloseTo(2); // p2: 62s vs 60s = 2 pts
  });

  it('tie breaking: equal penalty → both ranked with consecutive positions', () => {
    const target = 60_000;
    const p1 = makeParticipant('p1');
    const p2 = makeParticipant('p2');

    const entries = [
      ...makeRun('p1', target + 1_000), // +1s
      ...makeRun('p2', target - 1_000), // -1s (both 1 pt)
    ];

    const result = computeGLP(makeInput([p1, p2], entries, [totalTarget(target)]));
    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
    expect(result.results[1]!.penalty_points).toBeCloseTo(1);
    const ranks = result.results.map((r) => r.rank_overall).sort();
    expect(ranks).toEqual([1, 2]);
  });

  it('void entries are ignored', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    const entries = [
      makeEntry('p1', START_ID, BASE_TS),
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 1_000, { is_void: true }), // voided finish
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 5_000),                    // valid finish
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)]));
    expect(result.results[0]!.penalty_points).toBeCloseTo(5);
  });

  it('unconfirmed entries are ignored', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    const entries = [
      makeEntry('p1', START_ID, BASE_TS),
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 1_000, { is_confirmed: false }), // unconfirmed
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 7_000),                           // confirmed
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)]));
    expect(result.results[0]!.penalty_points).toBeCloseTo(7);
  });

  it('sort: non-DNF comes before DNF regardless of insertion order', () => {
    const target = 60_000;
    const dnf = makeParticipant('dnf');
    const finisher = makeParticipant('fin');

    const entries = makeRun('fin', target + 2_000);
    // dnf has no entries

    const result = computeGLP(makeInput([dnf, finisher], entries, [totalTarget(target)]));
    expect(result.results[0]!.participant_id).toBe('fin');
    expect(result.results[1]!.participant_id).toBe('dnf');
  });

  // -------------------------------------------------------------------------
  // Section scoring (multi-posten: START → ZZ1 → ZIEL)
  // -------------------------------------------------------------------------

  it('section scoring: two sections each with own target', () => {
    const p = makeParticipant('p1');

    // Abschnitt A: START→ZZ1 = 50s (target 50s → 0 penalty)
    // Abschnitt B: ZZ1→ZIEL = 30s (target 28s → 2s penalty)
    const entries = [
      makeEntry('p1', START_ID, BASE_TS),
      makeEntry('p1', ZZ1_ID,   BASE_TS + 50_000),
      makeEntry('p1', ZIEL_ID,  BASE_TS + 80_000),
    ];

    const targets = [
      sectionTarget(START_ID, ZZ1_ID,  50_000), // exact
      sectionTarget(ZZ1_ID,  ZIEL_ID,  28_000), // 2s slow
    ];

    const result = computeGLP(makeInput([p], entries, targets, makeGLPConfig(), THREE_POSTEN));
    expect(result.results[0]!.penalty_points).toBeCloseTo(2);
  });

  it('section scoring falls back to total target when no section targets defined', () => {
    const target = 80_000;
    const p = makeParticipant('p1');

    const entries = [
      makeEntry('p1', START_ID, BASE_TS),
      makeEntry('p1', ZZ1_ID,   BASE_TS + 40_000),
      makeEntry('p1', ZIEL_ID,  BASE_TS + 80_000 + 3_000), // 3s over total
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], makeGLPConfig(), THREE_POSTEN));
    expect(result.results[0]!.penalty_points).toBeCloseTo(3);
  });

  // -------------------------------------------------------------------------
  // Multiple runs
  // -------------------------------------------------------------------------

  it('run_scoring=best: only best run counts', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    // Lauf 1: 5s off, Lauf 2: 1s off (best)
    const entries = [
      ...makeRun('p1', target + 5_000, 1),
      ...makeRun('p1', target + 1_000, 2),
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], makeGLPConfig(), DEFAULT_POSTEN, 'best'));
    expect(result.results[0]!.penalty_points).toBeCloseTo(1);
  });

  it('run_scoring=sum: all runs summed', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    const entries = [
      ...makeRun('p1', target + 5_000, 1), // 5 pts
      ...makeRun('p1', target + 1_000, 2), // 1 pt
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], makeGLPConfig(), DEFAULT_POSTEN, 'sum'));
    expect(result.results[0]!.penalty_points).toBeCloseTo(6);
  });

  it('run_scoring=best_of_n: best N of M runs summed', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    // 3 runs: 10, 2, 5 pts → best 2 = 2+5 = 7
    const entries = [
      ...makeRun('p1', target + 10_000, 1),
      ...makeRun('p1', target + 2_000,  2),
      ...makeRun('p1', target + 5_000,  3),
    ];

    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], makeGLPConfig(), DEFAULT_POSTEN, 'best_of_n', 2));
    expect(result.results[0]!.penalty_points).toBeCloseTo(7);
  });

  it('allow_multiple_attempts=true within a run: takes attempt closest to target', () => {
    const target = 60_000;
    const p = makeParticipant('p1');

    // Two finish attempts in lap 1 — take the one with duration closer to target
    const entries = [
      makeEntry('p1', START_ID, BASE_TS),
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 15_000), // 15s off
      makeEntry('p1', ZIEL_ID, BASE_TS + target + 500),    // 0.5s off (best)
    ];

    const config = makeGLPConfig({ allow_multiple_attempts: true });
    const result = computeGLP(makeInput([p], entries, [totalTarget(target)], config));
    expect(result.results[0]!.penalty_points).toBeCloseTo(0.5);
  });
});
