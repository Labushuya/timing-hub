import type { TimeEntry, RundstreckeConfig, Participant } from '@timing-hub/shared-types';
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

function getLapEntries(
  entries: TimeEntry[],
  participantId: string,
): TimeEntry[] {
  return entries
    .filter(
      (e) =>
        e.participant_id === participantId &&
        e.is_confirmed &&
        !e.is_void &&
        e.lap_number !== undefined,
    )
    .sort((a, b) => (a.lap_number ?? 0) - (b.lap_number ?? 0));
}

export function computeRundstrecke(input: ScoringInput): ScoringResult {
  if (input.config.format !== 'rundstrecke') {
    throw new Error(`computeRundstrecke called with format=${input.config.format}`);
  }
  const config = input.config as RundstreckeConfig;
  const computedAt = Date.now();

  const isTimeBased = config.duration_ms !== null && config.total_laps === null;
  const isLapBased = config.total_laps !== null;

  type Intermediate = {
    participant: Participant;
    lapCount: number;
    totalTimeMs: number | undefined;
    bestLapMs: number | undefined;
    lastLapMs: number | undefined;
    isDnf: boolean;
    lapTimes: number[];
  };

  const intermediates: Intermediate[] = input.participants.map((p) => {
    const lapEntries = getLapEntries(input.entries, p.id);

    if (lapEntries.length === 0) {
      return {
        participant: p,
        lapCount: 0,
        totalTimeMs: undefined,
        bestLapMs: undefined,
        lastLapMs: undefined,
        isDnf: true,
        lapTimes: [],
      };
    }

    // Calculate individual lap durations from consecutive timestamps
    // Entries represent crossing the line; first entry may be the start or lap 1.
    // We use the raw_timestamp_ms of each lap entry as a cumulative split.
    const timestamps = lapEntries.map((e) => e.raw_timestamp_ms);

    // Compute lap durations: diff between consecutive timestamps
    const lapDurations: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1];
      const curr = timestamps[i];
      if (prev !== undefined && curr !== undefined) {
        lapDurations.push(curr - prev);
      }
    }
    // If only one entry, treat it as total time (standing start scenario)
    if (timestamps.length === 1 && timestamps[0] !== undefined) {
      lapDurations.push(timestamps[0]);
    }

    const bestLapMs = lapDurations.length > 0 ? Math.min(...lapDurations) : undefined;
    const lastLapMs = lapDurations.at(-1);

    if (isTimeBased && config.duration_ms !== null) {
      // Count laps completed within the duration window
      const raceStart = timestamps[0];
      if (raceStart === undefined) {
        return {
          participant: p,
          lapCount: 0,
          totalTimeMs: undefined,
          bestLapMs,
          lastLapMs,
          isDnf: true,
          lapTimes: lapDurations,
        };
      }
      const validLaps = lapEntries.filter(
        (e) => e.raw_timestamp_ms - raceStart <= config.duration_ms!,
      );
      const lapCount = Math.max(0, validLaps.length - 1); // exclude start crossing
      const lastValidTimestamp = validLaps.at(-1)?.raw_timestamp_ms;
      const lastLapTimeMs = lastValidTimestamp !== undefined ? lastValidTimestamp - raceStart : undefined;

      return {
        participant: p,
        lapCount,
        totalTimeMs: lastLapTimeMs,
        bestLapMs,
        lastLapMs,
        isDnf: lapCount === 0,
        lapTimes: lapDurations,
      };
    }

    if (isLapBased && config.total_laps !== null) {
      // Total time to complete all required laps
      const requiredLaps = config.total_laps;
      const completedLaps = lapDurations.length;
      const isDnf = completedLaps < requiredLaps;
      const raceStart = timestamps[0];
      const finishEntry = lapEntries[requiredLaps]; // index = requiredLaps because idx 0 = start
      const totalTimeMs =
        raceStart !== undefined && finishEntry !== undefined
          ? finishEntry.raw_timestamp_ms - raceStart
          : undefined;

      return {
        participant: p,
        lapCount: completedLaps,
        totalTimeMs: isDnf ? undefined : totalTimeMs,
        bestLapMs,
        lastLapMs,
        isDnf,
        lapTimes: lapDurations,
      };
    }

    // Fallback: use number of lap entries
    const raceStart = timestamps[0];
    const lastTs = timestamps.at(-1);
    const totalTimeMs =
      raceStart !== undefined && lastTs !== undefined ? lastTs - raceStart : undefined;

    return {
      participant: p,
      lapCount: lapDurations.length,
      totalTimeMs,
      bestLapMs,
      lastLapMs,
      isDnf: false,
      lapTimes: lapDurations,
    };
  });

  // Sort logic
  if (isTimeBased) {
    // More laps = better; tiebreak by last lap time (sooner = better)
    intermediates.sort((a, b) => {
      if (a.isDnf && !b.isDnf) return 1;
      if (!a.isDnf && b.isDnf) return -1;
      if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
      // Tiebreak: who finished last lap sooner (lower total time = better)
      const aTime = a.totalTimeMs ?? Infinity;
      const bTime = b.totalTimeMs ?? Infinity;
      return aTime - bTime;
    });
  } else {
    // Lap-based: lower total time = better
    intermediates.sort((a, b) => {
      if (a.isDnf && !b.isDnf) return 1;
      if (!a.isDnf && b.isDnf) return -1;
      const aTime = a.totalTimeMs ?? Infinity;
      const bTime = b.totalTimeMs ?? Infinity;
      return aTime - bTime;
    });
  }

  const leader = intermediates.find((im) => !im.isDnf);
  const leaderTotalMs = leader?.totalTimeMs;

  const results: RankedResult[] = intermediates.map((im, idx) => {
    const gapMs =
      !im.isDnf && leaderTotalMs !== undefined && im.totalTimeMs !== undefined
        ? im.totalTimeMs - leaderTotalMs
        : undefined;

    return buildRanked(
      im.participant,
      {
        rank_overall: idx + 1,
        total_time_ms: im.totalTimeMs,
        best_lap_ms: im.bestLapMs,
        lap_count: im.lapCount,
        gap_to_leader_ms: gapMs,
        is_dnf: im.isDnf,
        scoring_detail: {
          is_dnf: im.isDnf,
          is_time_based: isTimeBased,
          is_lap_based: isLapBased,
          total_laps_required: config.total_laps,
          duration_ms: config.duration_ms,
          laps_completed: im.lapCount,
          lap_times: im.lapTimes,
        },
      },
      computedAt,
    );
  });

  assignClassRanks(results);

  return { results, computed_at: computedAt };
}
