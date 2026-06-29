import type { OrientierungConfig, Participant } from '@timing-hub/shared-types';
import type { ScoringInput, ScoringResult, RankedResult } from './types.js';

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

export function computeOrientierung(input: ScoringInput): ScoringResult {
  if (input.config.format !== 'orientierung') {
    throw new Error(`computeOrientierung called with format=${input.config.format}`);
  }
  const config = input.config as OrientierungConfig;
  const computedAt = Date.now();

  type SectionResult = {
    code: string;
    actualMs: number | undefined;
    targetMs: number | undefined;
    deviationS: number | undefined;
    penaltyPoints: number;
    isMissing: boolean;
  };

  type Intermediate = {
    participant: Participant;
    totalPenalty: number;
    sectionResults: SectionResult[];
    sectionTimes: Record<string, number>;
    isDnf: boolean;
  };

  const intermediates: Intermediate[] = input.participants.map((p) => {
    const sectionResults: SectionResult[] = [];
    const sectionTimes: Record<string, number> = {};
    let totalPenalty = 0;
    let isDnf = false;

    for (const section of config.sections) {
      // Find the participant's entry for this section
      // Match by channel code or sector_number matching section index
      const sectionIdx = config.sections.indexOf(section);
      const entry = input.entries.find(
        (e) =>
          e.participant_id === p.id &&
          e.is_confirmed &&
          !e.is_void &&
          (e.channel === section.code ||
            e.sector_number === sectionIdx + 1),
      );

      if (!entry) {
        // Missing section: apply maximum penalty for the section
        const missingPenalty = section.target_ms !== null
          ? (section.target_ms / 1000) * Math.max(config.late_penalty_per_second, config.early_penalty_per_second)
          : Infinity;

        sectionResults.push({
          code: section.code,
          actualMs: undefined,
          targetMs: section.target_ms ?? undefined,
          deviationS: undefined,
          penaltyPoints: missingPenalty,
          isMissing: true,
        });
        totalPenalty += missingPenalty === Infinity ? 0 : missingPenalty;
        isDnf = missingPenalty === Infinity;
        continue;
      }

      const actualMs = entry.raw_timestamp_ms;
      sectionTimes[section.code] = actualMs;

      if (section.target_ms === null) {
        // No target defined for this section: no penalty
        sectionResults.push({
          code: section.code,
          actualMs,
          targetMs: undefined,
          deviationS: undefined,
          penaltyPoints: 0,
          isMissing: false,
        });
        continue;
      }

      const targetMs = section.target_ms;
      const deviationMs = actualMs - targetMs;
      const deviationS = deviationMs / 1000;

      // Positive deviation = late, negative = early
      const rate =
        deviationMs > 0
          ? config.late_penalty_per_second
          : config.early_penalty_per_second;

      const penaltyPoints = Math.abs(deviationS) * rate;
      totalPenalty += penaltyPoints;

      sectionResults.push({
        code: section.code,
        actualMs,
        targetMs,
        deviationS,
        penaltyPoints,
        isMissing: false,
      });
    }

    return {
      participant: p,
      totalPenalty: isDnf ? Infinity : totalPenalty,
      sectionResults,
      sectionTimes,
      isDnf,
    };
  });

  // Sort: DNF last, then by totalPenalty ASC
  intermediates.sort((a, b) => {
    if (a.isDnf && !b.isDnf) return 1;
    if (!a.isDnf && b.isDnf) return -1;
    return a.totalPenalty - b.totalPenalty;
  });

  const results: RankedResult[] = intermediates.map((im, idx) =>
    buildRanked(
      im.participant,
      {
        rank_overall: idx + 1,
        penalty_points: im.totalPenalty === Infinity ? undefined : im.totalPenalty,
        section_times: Object.keys(im.sectionTimes).length > 0 ? im.sectionTimes : undefined,
        is_dnf: im.isDnf,
        scoring_detail: {
          is_dnf: im.isDnf,
          section_results: im.sectionResults,
          late_penalty_per_second: config.late_penalty_per_second,
          early_penalty_per_second: config.early_penalty_per_second,
          section_count: config.sections.length,
        },
      },
      computedAt,
    ),
  );

  assignClassRanks(results);

  return { results, computed_at: computedAt };
}
