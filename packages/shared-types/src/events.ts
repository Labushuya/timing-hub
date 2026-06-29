export type EventFormat = 'glp' | 'sonderpruefung' | 'rundstrecke' | 'orientierung';

export type EventStatus = 'draft' | 'active' | 'finished' | 'archived';

export interface GLPConfig {
  format: 'glp';
  scoring: 'absolute_deviation' | 'percentage_deviation';
  penalty_per_second: number;
  max_penalty: number | null;
  allow_multiple_attempts: boolean;
  count_best_of: number | null;
}

export interface SPConfig {
  format: 'sonderpruefung';
  sectors: Array<{
    code: string;
    name: string;
    weight: number;
  }>;
  dnf_time_ms: number | null;
  ties_broken_by: 'earliest_start' | 'seed_time';
}

export interface RundstreckeConfig {
  format: 'rundstrecke';
  total_laps: number | null;
  duration_ms: number | null;
  standing_start: boolean;
}

export interface OrientierungConfig {
  format: 'orientierung';
  sections: Array<{
    code: string;
    name: string;
    target_ms: number | null;
  }>;
  late_penalty_per_second: number;
  early_penalty_per_second: number;
}

export type EventConfig = GLPConfig | SPConfig | RundstreckeConfig | OrientierungConfig;

export interface Event {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description?: string;
  format: EventFormat;
  status: EventStatus;
  starts_at: string;
  ends_at?: string;
  timezone: string;
  config: EventConfig;
  created_at: string;
  updated_at: string;
}
