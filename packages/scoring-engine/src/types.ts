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

// --- Extended types for correct GLP computation ---

export interface PostenWithOrder {
  id: string;
  code: string;
  role: string;
  sort_order: number;
}

/**
 * Defines a target time for a section between two posten.
 * - from_posten_id=null AND to_posten_id=null → Gesamtstrecke (total route)
 * - from_posten_id=X AND to_posten_id=Y → specific section
 * - class=null → applies to all classes
 * - class='A' → class-specific override (higher priority)
 */
export interface SectionTarget {
  from_posten_id: string | null;
  to_posten_id: string | null;
  class: string | null;
  target_time_ms: number;
}

export interface ExtendedScoringInput extends ScoringInput {
  /** All posten for this event, with sort_order */
  posten: PostenWithOrder[];
  /** Target times per section (or total) */
  section_targets: SectionTarget[];
  /** How to aggregate multiple laps into a final score */
  run_scoring: 'sum' | 'best' | 'best_of_n';
  /** Used when run_scoring='best_of_n': how many best laps to sum */
  run_scoring_n?: number;
  /** Display hint only — does not affect computation */
  hide_target_times: boolean;
}
