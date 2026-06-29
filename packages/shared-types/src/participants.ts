export interface Participant {
  id: string;
  event_id: string;
  startnummer: string;
  driver_name: string;
  co_driver_name?: string;
  car_make?: string;
  car_model?: string;
  car_year?: number;
  class?: string;
  target_time_ms?: number;
  seed_time_ms?: number;
  notes?: string;
  created_at: string;
  updated_at: string;
}
