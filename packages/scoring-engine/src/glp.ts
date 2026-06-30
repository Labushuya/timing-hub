import type { TimeEntry, GLPConfig, Participant } from '@timing-hub/shared-types';
import type {
  ScoringInput,
  ScoringResult,
  RankedResult,
  ExtendedScoringInput,
  PostenWithOrder,
  SectionTarget,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LapScore {
  lap_number: number;
  penalty_points: number;
  total_ms: number | undefined;
  section_times: Record<string, number>;
  section_deviations: Record<string, number>;
  is_complete: boolean;
}

interface ParticipantAggregate {
  participant: Participant;
  penalty_points: number;
  total_ms: number | undefined;
  section_times: Record<string, number>;
  section_deviations: Record<string, number>;
  lap_scores: LapScore[];
  is_dnf: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Find the best matching SectionTarget for a given section and participant class.
 * Priority: class-specific > general (class=null).
 */
function findSectionTarget(
  sectionTargets: SectionTarget[],
  fromPostenId: string | null,
  toPostenId: string | null,
  participantClass: string | null | undefined,
): SectionTarget | undefined {
  const candidates = sectionTargets.filter(
    (st) => st.from_posten_id === fromPostenId && st.to_posten_id === toPostenId,
  );
  if (candidates.length === 0) return undefined;

  // Prefer class-specific match
  if (participantClass) {
    const classSpecific = candidates.find((st) => st.class === participantClass);
    if (classSpecific) return classSpecific;
  }

  // Fall back to general target (class=null)
  return candidates.find((st) => st.class === null);
}

/**
 * Get confirmed, non-void time entry for participant at a given posten and lap.
 */
function getEntry(
  entries: TimeEntry[],
  participantId: string,
  postenId: string,
  lapNumber: number,
): TimeEntry | undefined {
  const matches = entries.filter(
    (e) =>
      e.participant_id === participantId &&
      e.posten_id === postenId &&
      (e.lap_number ?? 1) === lapNumber &&
      e.is_confirmed &&
      !e.is_void,
  );
  if (matches.length === 0) return undefined;
  // Take the earliest confirmed entry for this posten+lap (in case of duplicates)
  return matches.reduce((earliest, e) =>
    e.raw_timestamp_ms < earliest.raw_timestamp_ms ? e : earliest,
  );
}

/**
 * Compute penalty points for a given deviation.
 */
function computePenalty(
  deviationMs: number,
  penaltyPerSecond: number,
  maxPenalty: number | null,
): number {
  const raw = (Math.abs(deviationMs) / 1000) * penaltyPerSecond;
  return maxPenalty !== null ? Math.min(raw, maxPenalty) : raw;
}

// ---------------------------------------------------------------------------
// Core: compute a single lap for a participant (extended mode)
// ---------------------------------------------------------------------------

function computeLap(
  participant: Participant,
  lapNumber: number,
  sortedPosten: PostenWithOrder[],
  sectionTargets: SectionTarget[],
  entries: TimeEntry[],
  config: GLPConfig,
): LapScore {
  const section_times: Record<string, number> = {};
  const section_deviations: Record<string, number> = {};
  let totalPenalty = 0;
  let isComplete = true;

  // Collect timestamps at each posten for this lap
  const postenTs = new Map<string, number>();
  for (const posten of sortedPosten) {
    const entry = getEntry(entries, participant.id, posten.id, lapNumber);
    if (entry) {
      postenTs.set(posten.id, entry.raw_timestamp_ms);
    }
  }

  // We need at least the first and last posten timestamps for total_ms
  const firstPosten = sortedPosten[0];
  const lastPosten = sortedPosten[sortedPosten.length - 1];
  const startTs = firstPosten ? postenTs.get(firstPosten.id) : undefined;
  const finishTs = lastPosten ? postenTs.get(lastPosten.id) : undefined;
  const total_ms = startTs !== undefined && finishTs !== undefined
    ? finishTs - startTs
    : undefined;

  // Try section-by-section scoring first
  let hasSectionTargets = false;

  for (let i = 0; i < sortedPosten.length - 1; i++) {
    const fromPosten = sortedPosten[i]!;
    const toPosten = sortedPosten[i + 1]!;
    const sectionKey = `${fromPosten.code}->${toPosten.code}`;

    const fromTs = postenTs.get(fromPosten.id);
    const toTs = postenTs.get(toPosten.id);

    if (fromTs === undefined || toTs === undefined) {
      isComplete = false;
      continue;
    }

    const sectionMs = toTs - fromTs;
    section_times[sectionKey] = sectionMs;

    const target = findSectionTarget(
      sectionTargets,
      fromPosten.id,
      toPosten.id,
      participant.class,
    );

    if (target) {
      hasSectionTargets = true;
      const deviationMs = sectionMs - target.target_time_ms;
      section_deviations[sectionKey] = deviationMs;
      totalPenalty += computePenalty(deviationMs, config.penalty_per_second, config.max_penalty);
    }
  }

  // If no section-level targets were found, fall back to total-time target
  if (!hasSectionTargets) {
    const totalTarget = findSectionTarget(sectionTargets, null, null, participant.class);
    if (totalTarget && total_ms !== undefined) {
      const deviationMs = total_ms - totalTarget.target_time_ms;
      const totalKey = 'total';
      section_deviations[totalKey] = deviationMs;
      totalPenalty = computePenalty(deviationMs, config.penalty_per_second, config.max_penalty);
    } else if (total_ms === undefined) {
      isComplete = false;
      totalPenalty = config.max_penalty ?? Infinity;
    }
    // No target at all → zero penalty (config issue, not participant's fault)
  }

  if (!isComplete && totalPenalty === 0) {
    totalPenalty = config.max_penalty ?? Infinity;
  }

  return {
    lap_number: lapNumber,
    penalty_points: totalPenalty,
    total_ms,
    section_times,
    section_deviations,
    is_complete: isComplete,
  };
}

// ---------------------------------------------------------------------------
// Core: aggregate laps
// ---------------------------------------------------------------------------

function aggregateLaps(
  lapScores: LapScore[],
  runScoring: ExtendedScoringInput['run_scoring'],
  runScoringN: number | undefined,
): { penalty_points: number; contributing_laps: LapScore[] } {
  const complete = lapScores.filter((l) => l.is_complete);

  if (complete.length === 0) {
    return { penalty_points: Infinity, contributing_laps: [] };
  }

  switch (runScoring) {
    case 'best': {
      const best = complete.reduce((b, l) => (l.penalty_points < b.penalty_points ? l : b));
      return { penalty_points: best.penalty_points, contributing_laps: [best] };
    }

    case 'best_of_n': {
      const n = runScoringN ?? 1;
      const sorted = [...complete].sort((a, b) => a.penalty_points - b.penalty_points);
      const top = sorted.slice(0, n);
      const sum = top.reduce((acc, l) => acc + l.penalty_points, 0);
      return { penalty_points: sum, contributing_laps: top };
    }

    case 'sum':
    default: {
      const sum = complete.reduce((acc, l) => acc + l.penalty_points, 0);
      return { penalty_points: sum, contributing_laps: complete };
    }
  }
}

// ---------------------------------------------------------------------------
// Extended mode: full multi-posten, multi-lap scoring
// ---------------------------------------------------------------------------

function computeExtended(input: ExtendedScoringInput): ScoringResult {
  const config = input.config as GLPConfig;
  const computedAt = Date.now();

  // Sort posten by sort_order ascending
  const sortedPosten = [...input.posten].sort((a, b) => a.sort_order - b.sort_order);

  if (sortedPosten.length < 2) {
    throw new Error('GLP scoring requires at least 2 posten (start + finish)');
  }

  // Determine which lap numbers exist in the entries
  function getLapNumbers(participantId: string): number[] {
    const laps = new Set<number>();
    for (const e of input.entries) {
      if (e.participant_id === participantId && e.is_confirmed && !e.is_void) {
        laps.add(e.lap_number ?? 1);
      }
    }
    return laps.size > 0 ? Array.from(laps).sort((a, b) => a - b) : [1];
  }

  const aggregates: ParticipantAggregate[] = input.participants.map((participant) => {
    const lapNumbers = getLapNumbers(participant.id);

    const lapScores: LapScore[] = lapNumbers.map((lapNum) =>
      computeLap(participant, lapNum, sortedPosten, input.section_targets, input.entries, config),
    );

    const { penalty_points, contributing_laps } = aggregateLaps(
      lapScores,
      input.run_scoring,
      input.run_scoring_n,
    );

    // Merge section_times and section_deviations from contributing laps
    const merged_section_times: Record<string, number> = {};
    const merged_section_deviations: Record<string, number> = {};
    for (const lap of contributing_laps) {
      for (const [k, v] of Object.entries(lap.section_times)) {
        merged_section_times[k] = (merged_section_times[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(lap.section_deviations)) {
        merged_section_deviations[k] = (merged_section_deviations[k] ?? 0) + v;
      }
    }

    const best_total_ms = contributing_laps.length > 0
      ? contributing_laps.reduce<number | undefined>((acc, l) => {
          if (l.total_ms === undefined) return acc;
          return acc === undefined ? l.total_ms : acc + l.total_ms;
        }, undefined)
      : undefined;

    const isDnf = penalty_points === Infinity || contributing_laps.length === 0;

    return {
      participant,
      penalty_points: isDnf ? (config.max_penalty ?? Infinity) : penalty_points,
      total_ms: best_total_ms,
      section_times: merged_section_times,
      section_deviations: merged_section_deviations,
      lap_scores: lapScores,
      is_dnf: isDnf,
    };
  });

  // Sort: DNF last, then ascending by penalty
  aggregates.sort((a, b) => {
    if (a.is_dnf && !b.is_dnf) return 1;
    if (!a.is_dnf && b.is_dnf) return -1;
    return a.penalty_points - b.penalty_points;
  });

  const results: RankedResult[] = aggregates.map((agg, idx) => {
    // For single-section GLP (total target), derive actual/target/deviation from total_ms
    const totalTarget = input.section_targets.find(
      (st) => st.from_posten_id === null && st.to_posten_id === null &&
              (st.class === null || st.class === agg.participant.class),
    );
    const classTarget = input.section_targets.find(
      (st) => st.from_posten_id === null && st.to_posten_id === null &&
              st.class === agg.participant.class,
    );
    const resolvedTarget = classTarget ?? totalTarget;

    const deviationMs = (!agg.is_dnf && agg.total_ms !== undefined && resolvedTarget !== undefined)
      ? agg.total_ms - resolvedTarget.target_time_ms
      : undefined;

    return buildRanked(
      agg.participant,
      {
        rank_overall: idx + 1,
        penalty_points: agg.penalty_points === Infinity ? undefined : agg.penalty_points,
        actual_time_ms: agg.is_dnf ? undefined : agg.total_ms,
        target_time_ms: resolvedTarget?.target_time_ms,
        deviation_ms: deviationMs,
        total_time_ms: agg.total_ms,
        section_times: Object.keys(agg.section_times).length > 0 ? agg.section_times : undefined,
        is_dnf: agg.is_dnf,
        scoring_detail: {
          is_dnf: agg.is_dnf,
          run_scoring: input.run_scoring,
          run_scoring_n: input.run_scoring_n,
          penalty_per_second: config.penalty_per_second,
          max_penalty: config.max_penalty,
          lap_scores: agg.lap_scores,
          section_deviations: agg.section_deviations,
        },
      },
      computedAt,
    );
  });

  assignClassRanks(results);
  return { results, computed_at: computedAt };
}

// ---------------------------------------------------------------------------
// Fallback mode: legacy ScoringInput without posten/section_targets
// Treats lap_number=1 only, uses participant.target_time_ms for total deviation.
// Finds start posten (role='start') and finish posten (role='finish') by heuristic.
// ---------------------------------------------------------------------------

function findStartPostenId(entries: TimeEntry[]): string | undefined {
  // The start posten typically has the smallest timestamps (earliest times).
  // Group by posten_id, find the one with smallest min timestamp.
  const minTs = new Map<string, number>();
  for (const e of entries) {
    if (!e.is_void && e.is_confirmed) {
      const current = minTs.get(e.posten_id);
      if (current === undefined || e.raw_timestamp_ms < current) {
        minTs.set(e.posten_id, e.raw_timestamp_ms);
      }
    }
  }
  if (minTs.size === 0) return undefined;
  return Array.from(minTs.entries()).sort((a, b) => a[1] - b[1])[0]![0];
}

function findFinishPostenIdFallback(entries: TimeEntry[], startPostenId: string): string | undefined {
  // The finish posten is not the start posten and appears most often.
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.is_void && e.is_confirmed && e.posten_id !== startPostenId) {
      counts.set(e.posten_id, (counts.get(e.posten_id) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]![0];
}

function computeFallback(input: ScoringInput): ScoringResult {
  const config = input.config as GLPConfig;
  const computedAt = Date.now();

  const startPostenId = findStartPostenId(input.entries);
  const finishPostenId = startPostenId
    ? findFinishPostenIdFallback(input.entries, startPostenId)
    : undefined;

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

    if (!startPostenId || !finishPostenId || targetMs === undefined) {
      return {
        participant: p,
        penaltyPoints: config.max_penalty ?? Infinity,
        deviationMs: undefined,
        actualTimeMs: undefined,
        targetTimeMs: targetMs,
        isDnf: true,
      };
    }

    const startEntry = getEntry(input.entries, p.id, startPostenId, 1);
    const finishEntries = input.entries.filter(
      (e) =>
        e.participant_id === p.id &&
        e.posten_id === finishPostenId &&
        (e.lap_number ?? 1) === 1 &&
        e.is_confirmed &&
        !e.is_void,
    );

    if (!startEntry || finishEntries.length === 0) {
      return {
        participant: p,
        penaltyPoints: config.max_penalty ?? Infinity,
        deviationMs: undefined,
        actualTimeMs: undefined,
        targetTimeMs: targetMs,
        isDnf: true,
      };
    }

    let finishEntry: TimeEntry;
    if (config.allow_multiple_attempts) {
      // Choose the finish entry whose resulting duration is closest to target
      finishEntry = finishEntries.reduce((best, e) => {
        const bestDuration = best.raw_timestamp_ms - startEntry.raw_timestamp_ms;
        const eDuration = e.raw_timestamp_ms - startEntry.raw_timestamp_ms;
        return Math.abs(eDuration - targetMs) < Math.abs(bestDuration - targetMs) ? e : best;
      });
    } else {
      // Take earliest finish entry
      finishEntry = finishEntries.reduce((earliest, e) =>
        e.raw_timestamp_ms < earliest.raw_timestamp_ms ? e : earliest,
      );
    }

    const actualTimeMs = finishEntry.raw_timestamp_ms - startEntry.raw_timestamp_ms;
    const deviationMs = actualTimeMs - targetMs;
    const rawPenalty = (Math.abs(deviationMs) / 1000) * config.penalty_per_second;
    const penaltyPoints =
      config.max_penalty !== null ? Math.min(rawPenalty, config.max_penalty) : rawPenalty;

    return {
      participant: p,
      penaltyPoints,
      deviationMs,
      actualTimeMs,
      targetTimeMs: targetMs,
      isDnf: false,
    };
  });

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
        total_time_ms: im.actualTimeMs,
        is_dnf: im.isDnf,
        scoring_detail: {
          is_dnf: im.isDnf,
          mode: 'fallback',
          allow_multiple_attempts: config.allow_multiple_attempts,
          penalty_per_second: config.penalty_per_second,
          max_penalty: config.max_penalty,
        },
      },
      computedAt,
    ),
  );

  assignClassRanks(results);
  return { results, computed_at: computedAt };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute GLP (Gleichmäßigkeitsprüfung) results.
 *
 * Accepts either ExtendedScoringInput (with posten + section_targets) for
 * correct multi-section, multi-lap computation, or a plain ScoringInput for
 * backwards-compatible fallback mode (uses participant.target_time_ms,
 * lap_number=1, single total-time deviation).
 */
export function computeGLP(input: ScoringInput | ExtendedScoringInput): ScoringResult {
  if (input.config.format !== 'glp') {
    throw new Error(`computeGLP called with format=${input.config.format}`);
  }

  // Detect extended input by presence of 'posten' field
  if ('posten' in input && Array.isArray(input.posten) && input.posten.length > 0) {
    return computeExtended(input as ExtendedScoringInput);
  }

  return computeFallback(input);
}
