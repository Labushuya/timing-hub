import type { TimeEntryPublic } from './times.js';
import type { ResultRow } from './results.js';
import type { Participant } from './participants.js';
import type { EventStatus } from './events.js';

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface WSPing {
  type: 'ping';
}

export interface WSSubscribeEvent {
  type: 'subscribe_event';
  event_slug: string;
}

export interface WSUnsubscribeEvent {
  type: 'unsubscribe_event';
  event_slug: string;
}

export interface WSTimyImpulse {
  type: 'timy_impulse';
  posten_id: string;
  channel: string;
  raw_timestamp_ms: number;
  raw_string: string;
  bridge_seq: number;
}

export interface WSManualTime {
  type: 'manual_time';
  posten_id: string;
  startnummer: string;
  raw_timestamp_ms: number;
  client_seq: string;
}

export interface WSConfirmEntry {
  type: 'confirm_entry';
  entry_id: string;
  startnummer: string;
}

export type ClientMessage =
  | WSPing
  | WSSubscribeEvent
  | WSUnsubscribeEvent
  | WSTimyImpulse
  | WSManualTime
  | WSConfirmEntry;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface WSPong {
  type: 'pong';
}

export interface WSAck {
  type: 'ack';
  client_seq: string;
  entry_id: string;
  status: 'accepted' | 'duplicate' | 'error';
  error?: string;
}

export interface WSTimeEntry {
  type: 'time_entry';
  event_slug: string;
  entry: TimeEntryPublic;
}

export interface WSResultsUpdate {
  type: 'results_update';
  event_slug: string;
  results: ResultRow[];
  computed_at: string;
}

export interface WSParticipantConfirmed {
  type: 'participant_confirmed';
  event_slug: string;
  entry_id: string;
  participant: Participant;
}

export interface WSEventStatusChange {
  type: 'event_status';
  event_slug: string;
  status: EventStatus;
}

export interface WSError {
  type: 'error';
  code: string;
  message: string;
  ref_seq?: string;
}

export type ServerMessage =
  | WSPong
  | WSAck
  | WSTimeEntry
  | WSResultsUpdate
  | WSParticipantConfirmed
  | WSEventStatusChange
  | WSError;
