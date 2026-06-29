import type {
  TimeEntry,
  Participant,
  EventConfig,
  ResultRow,
} from '@timing-hub/shared-types';

export type { TimeEntry, Participant, EventConfig, ResultRow };

export interface ScoringInput {
  entries: TimeEntry[];
  participants: Participant[];
  config: EventConfig;
}

export interface RankedResult extends ResultRow {
  driver_name: string;
  co_driver_name?: string | undefined;
  startnummer: string;
  car_make?: string | undefined;
  car_model?: string | undefined;
  car_year?: number | undefined;
  is_dnf: boolean;
}

export interface ScoringResult {
  results: RankedResult[];
  computed_at: number;
}
