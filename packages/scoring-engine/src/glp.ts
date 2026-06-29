import type { TimeEntry, GLPConfig, Participant } from '@timing-hub/shared-types';
import type { ScoringInput, ScoringResult, RankedResult } from './types.js';

function findFinishEntries(
  entries: TimeEntry[],
  participantId: string,
  finishPostenId: string,
): TimeEntry[] {
  return entries.filter(
    (e) =>
      e.participant_id === participantId &&
      e.posten_id === finishPostenId &&
      e.is_confirmed &&
      !e.is_void,
  );
}

function findFinishPosten(entries: TimeEntry[]): string | undefined {
  // Heuristic: use the posten_id that appears most as a finish marker.
  // In practice the caller should pass a filtered set or config should include
  // the finish posten id. We pick the most-common posten_id as a fallback.
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.posten_id, (counts.get(e.posten_id) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  return best;
}

function buildRanked(
  participant: Participant,
  overrides: Partial<RankedResult>,
  computedAt: number,
): RankedResult {
  return {
    id: `${participant.id}-${computedAt}`,
    event_id: participant.event_id,
    participant_id: participant.id,
    computed_at: new Date(computedAt).toISOString(),
    rank_overall: 0,
    rank_in_class: undefined,
    class: participant.class,
    scoring_detail: {},
    driver_name: participant.driver_name,
    co_driver_name: participant.co_driver_name,
    startnummer: participant.startnummer,
    car_make: participant.car_make,
    car_model: participant.car_model,
    car_year: participant.car_year,
    is_dnf: false,
    ...overrides,
  };
}

export function computeGLP(input: ScoringInput): ScoringResult {
  if (input.config.format !== 'glp') {
    throw new Error(`computeGLP called with format=${input.config.format}`);
  }
  const config = input.config as GLPConfig;
  const computedAt = Date.now();

  const finishPostenId = findFinishPosten(input.entries);

  type Intermediate = {
    participant: Participant;
    penaltyPoints: number;
    deviationMs: number | undefined;
    actualTimeMs: number | undefined;
    targetTimeMs: number | undefined;
    isDnf: boolean;
  };

  const intermediates: Intermediate[] = input.participants.map((p) => {
    const targetMs = p.target_time_ms;

    if (!finishPostenId || targetMs === undefined) {
      return {
        participant: p,
        penaltyPoints: config.max_penalty ?? Infinity,
        deviationMs: undefined,
        actualTimeMs: undefined,
        targetTimeMs: targetMs,
        isDnf: true,
      };
    }

    const finishEntries = findFinishEntries(input.entries, p.id, finishPostenId);

    if (finishEntries.length === 0) {
      return {
        participant: p,
        penaltyPoints: config.max_penalty ?? Infinity,
        deviationMs: undefined,
        actualTimeMs: undefined,
        targetTimeMs: targetMs,
        isDnf: true,
      };
    }

    let chosen: TimeEntry;

    if (config.allow_multiple_attempts) {
      // Take the attempt closest to the target time
      chosen = finishEntries.reduce((best, e) => {
        const bestDev = Math.abs(best.raw_timestamp_ms - targetMs);
        const eDev = Math.abs(e.raw_timestamp_ms - targetMs);
        return eDev < bestDev ? e : best;
      });
    } else {
      // Take first confirmed entry chronologically
      chosen = finishEntries.reduce((earliest, e) =>
        e.raw_timestamp_ms < earliest.raw_timestamp_ms ? e : earliest,
      );
    }

    const deviationMs = chosen.raw_timestamp_ms - targetMs;
    const rawPenalty = (Math.abs(deviationMs) / 1000) * config.penalty_per_second;
    const penaltyPoints =
      config.max_penalty !== null ? Math.min(rawPenalty, config.max_penalty) : rawPenalty;

    return {
      participant: p,
      penaltyPoints,
      deviationMs,
      actualTimeMs: chosen.raw_timestamp_ms,
      targetTimeMs: targetMs,
      isDnf: false,
    };
  });

  // Sort: DNF last, then by penalty ASC
  intermediates.sort((a, b) => {
    if (a.isDnf && !b.isDnf) return 1;
    if (!a.isDnf && b.isDnf) return -1;
    return a.penaltyPoints - b.penaltyPoints;
  });

  const results: RankedResult[] = intermediates.map((im, idx) =>
    buildRanked(
      im.participant,
      {
        rank_overall: idx + 1,
        penalty_points: im.penaltyPoints === Infinity ? undefined : im.penaltyPoints,
        deviation_ms: im.deviationMs,
        actual_time_ms: im.actualTimeMs,
        target_time_ms: im.targetTimeMs,
        is_dnf: im.isDnf,
        scoring_detail: {
          is_dnf: im.isDnf,
          allow_multiple_attempts: config.allow_multiple_attempts,
          penalty_per_second: config.penalty_per_second,
          max_penalty: config.max_penalty,
        },
      },
      computedAt,
    ),
  );

  // Assign rank_in_class
  assignClassRanks(results);

  return { results, computed_at: computedAt };
}

function assignClassRanks(results: RankedResult[]): void {
  const classCounters = new Map<string, number>();
  for (const r of results) {
    if (r.class) {
      const next = (classCounters.get(r.class) ?? 0) + 1;
      classCounters.set(r.class, next);
      r.rank_in_class = next;
    }
  }
}
