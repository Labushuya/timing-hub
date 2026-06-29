export interface ResultRow {
  id: string;
  event_id: string;
  participant_id: string;
  computed_at: string;
  actual_time_ms?: number | undefined;
  target_time_ms?: number | undefined;
  deviation_ms?: number | undefined;
  penalty_points?: number | undefined;
  total_time_ms?: number | undefined;
  best_lap_ms?: number | undefined;
  lap_count?: number | undefined;
  gap_to_leader_ms?: number | undefined;
  section_times?: Record<string, number> | undefined;
  rank_overall: number;
  rank_in_class?: number | undefined;
  class?: string | undefined;
  scoring_detail: Record<string, unknown>;
}
