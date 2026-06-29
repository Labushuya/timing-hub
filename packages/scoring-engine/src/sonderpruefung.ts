import type { TimeEntry, SPConfig, Participant } from '@timing-hub/shared-types';
import type { ScoringInput, ScoringResult, RankedResult } from './types.js';

function getConfirmedEntry(
  entries: TimeEntry[],
  participantId: string,
  postenId: string,
  sectorNumber?: number,
): TimeEntry | undefined {
  return entries.find(
    (e) =>
      e.participant_id === participantId &&
      e.posten_id === postenId &&
      e.is_confirmed &&
      !e.is_void &&
      (sectorNumber === undefined || e.sector_number === sectorNumber),
  );
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

export function computeSonderprüfung(input: ScoringInput): ScoringResult {
  if (input.config.format !== 'sonderpruefung') {
    throw new Error(`computeSonderprüfung called with format=${input.config.format}`);
  }
  const config = input.config as SPConfig;
  const computedAt = Date.now();

  // Build a map of unique posten ids in entries — needed when no sectors defined
  const finishPostenIds = [...new Set(input.entries.map((e) => e.posten_id))];
  const finishPostenId = finishPostenIds[0];

  type Intermediate = {
    participant: Participant;
    totalTimeMs: number;
    sectionTimes: Record<string, number>;
    isDnf: boolean;
    startMs: number | undefined;
  };

  const intermediates: Intermediate[] = input.participants.map((p) => {
    const sectionTimes: Record<string, number> = {};
    let isDnf = false;

    if (config.sectors.length > 0) {
      // Sum up sector times
      let total = 0;
      for (const sector of config.sectors) {
        const entry = input.entries.find(
          (e) =>
            e.participant_id === p.id &&
            e.is_confirmed &&
            !e.is_void &&
            (e.channel === sector.code ||
              (e.sector_number !== undefined &&
                String(e.sector_number) === sector.code)),
        );
        if (!entry) {
          isDnf = true;
          break;
        }
        const sectorMs = entry.raw_timestamp_ms;
        sectionTimes[sector.code] = sectorMs;
        total += sectorMs * sector.weight;
      }

      if (isDnf) {
        const dnfMs = config.dnf_time_ms ?? Infinity;
        return {
          participant: p,
          totalTimeMs: dnfMs,
          sectionTimes,
          isDnf: true,
          startMs: undefined,
        };
      }

      return {
        participant: p,
        totalTimeMs: total,
        sectionTimes,
        isDnf: false,
        startMs: undefined,
      };
    }

    // No sectors: use single finish time
    if (!finishPostenId) {
      return {
        participant: p,
        totalTimeMs: config.dnf_time_ms ?? Infinity,
        sectionTimes,
        isDnf: true,
        startMs: undefined,
      };
    }

    // Find start entry (for tiebreaking)
    const startEntry = input.entries.find(
      (e) =>
        e.participant_id === p.id &&
        e.is_confirmed &&
        !e.is_void &&
        e.posten_id !== finishPostenId,
    );

    const finishEntry = getConfirmedEntry(input.entries, p.id, finishPostenId);

    if (!finishEntry) {
      return {
        participant: p,
        totalTimeMs: config.dnf_time_ms ?? Infinity,
        sectionTimes,
        isDnf: true,
        startMs: startEntry?.raw_timestamp_ms,
      };
    }

    const startMs = startEntry?.raw_timestamp_ms;
    const totalMs =
      startMs !== undefined
        ? finishEntry.raw_timestamp_ms - startMs
        : finishEntry.raw_timestamp_ms;

    return {
      participant: p,
      totalTimeMs: totalMs,
      sectionTimes,
      isDnf: false,
      startMs,
    };
  });

  // Sort: DNF last, then by totalTimeMs ASC with tiebreaking
  intermediates.sort((a, b) => {
    if (a.isDnf && !b.isDnf) return 1;
    if (!a.isDnf && b.isDnf) return -1;
    if (a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs - b.totalTimeMs;

    // Tiebreaking
    if (config.ties_broken_by === 'earliest_start') {
      const aStart = a.startMs ?? Infinity;
      const bStart = b.startMs ?? Infinity;
      return aStart - bStart;
    }
    if (config.ties_broken_by === 'seed_time') {
      const aSeed = a.participant.seed_time_ms ?? Infinity;
      const bSeed = b.participant.seed_time_ms ?? Infinity;
      return aSeed - bSeed;
    }
    return 0;
  });

  const leaderTimeMs = intermediates.find((im) => !im.isDnf)?.totalTimeMs;

  const results: RankedResult[] = intermediates.map((im, idx) => {
    const gapMs =
      !im.isDnf && leaderTimeMs !== undefined && im.totalTimeMs !== Infinity
        ? im.totalTimeMs - leaderTimeMs
        : undefined;

    return buildRanked(
      im.participant,
      {
        rank_overall: idx + 1,
        total_time_ms: im.totalTimeMs === Infinity ? undefined : im.totalTimeMs,
        gap_to_leader_ms: gapMs,
        section_times: Object.keys(im.sectionTimes).length > 0 ? im.sectionTimes : undefined,
        is_dnf: im.isDnf,
        scoring_detail: {
          is_dnf: im.isDnf,
          ties_broken_by: config.ties_broken_by,
          dnf_time_ms: config.dnf_time_ms,
          sector_count: config.sectors.length,
        },
      },
      computedAt,
    );
  });

  assignClassRanks(results);

  return { results, computed_at: computedAt };
}
