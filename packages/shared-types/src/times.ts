export type TimeSource = 'manual' | 'timy_bridge' | 'import';

export interface TimeEntry {
  id: string;
  event_id: string;
  posten_id: string;
  participant_id?: string;
  startnummer?: string;
  source: TimeSource;
  raw_timestamp_ms: number;
  server_recv_ms: number;
  lap_number?: number;
  sector_number?: number;
  channel?: string;
  is_confirmed: boolean;
  confirmed_by?: string;
  confirmed_at?: string;
  is_void: boolean;
  void_reason?: string;
  client_seq?: string;
  created_at: string;
  updated_at: string;
}

export type TimeEntryPublic = Omit<TimeEntry, 'confirmed_by' | 'client_seq'>;
