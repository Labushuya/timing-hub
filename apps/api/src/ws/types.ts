/**
 * ws/types.ts — Internal WebSocket hub types
 *
 * Wire-protocol shapes mirror packages/shared-types/src/ws-messages.ts.
 * Defined here to avoid a workspace-dependency edge while the API package
 * does not yet declare @timing-hub/shared-types as a dependency.
 *
 * If that dep is added later, replace the inline definitions with re-exports:
 *   export type { … } from '@timing-hub/shared-types';
 */

import type { WebSocket } from '@fastify/websocket';

// ---------------------------------------------------------------------------
// Shared domain types (minimal inline copies)
// ---------------------------------------------------------------------------

export type TimeSource = 'manual' | 'timy_bridge' | 'import';
export type EventStatus = 'draft' | 'active' | 'paused' | 'finished' | 'archived';

export interface TimeEntryPublic {
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
  is_void: boolean;
  void_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ResultRow {
  rank: number;
  participant_id: string;
  startnummer: string;
  total_ms: number;
  laps?: number;
  [key: string]: unknown;
}

export interface Participant {
  id: string;
  event_id: string;
  startnummer: string;
  first_name: string;
  last_name: string;
  team?: string;
  category?: string;
  bib_color?: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Client → Server messages  (mirrors ws-messages.ts)
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
  startnummer?: string;
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
// Server → Client messages  (mirrors ws-messages.ts)
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

export interface WSTimyStatus {
  type: 'timy_status';
  event_slug: string;
  posten_id: string;
  connected: boolean;
  bridge_id?: string;
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
  | WSTimyStatus
  | WSError;

// ---------------------------------------------------------------------------
// Connected acknowledgement (sent immediately after successful auth)
// ---------------------------------------------------------------------------

export interface WSConnected {
  type: 'connected';
  client_id: string;
  server_time: number;
}

// ---------------------------------------------------------------------------
// Client type discriminator
// ---------------------------------------------------------------------------

/** Three distinct principals that may open a WebSocket connection. */
export type WsClientType = 'user' | 'zeitnehmer' | 'bridge';

// ---------------------------------------------------------------------------
// Connected client record (hub-internal)
// ---------------------------------------------------------------------------

/**
 * All state we keep about a single connected WebSocket client.
 * Stored in the global `clients` Map keyed by `clientId`.
 */
export interface WsClient {
  /** Stable random UUID assigned at connect-time and sent in `connected`. */
  clientId: string;

  /** The underlying socket (raw @fastify/websocket WebSocket). */
  socket: WebSocket;

  /** Client type resolved during authentication. */
  type: WsClientType;

  /** Present for `user` clients: subject from JWT. */
  userId?: string;

  /** Present for `user` clients: role from JWT. */
  userRole?: 'admin' | 'organizer' | 'timekeeper' | 'viewer';

  /**
   * Present for `zeitnehmer` clients: posten_id from posten_sessions row.
   * Also present for `bridge` clients: posten_id from bridge_tokens row.
   */
  postenId?: string;

  /**
   * Present for `zeitnehmer` clients: event_id from posten_sessions row.
   * Also present for `bridge` clients: event_id derived from posten.
   */
  eventId?: string;

  /** Set of event slugs this client has subscribed to (subscribe_event). */
  eventSlugs: Set<string>;

  /** NodeJS timer for the heartbeat ping that was sent and awaits pong. */
  pongTimer?: ReturnType<typeof setTimeout>;

  /** NodeJS interval for sending periodic pings. */
  pingInterval?: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Redis pub/sub envelope
// ---------------------------------------------------------------------------

/**
 * Every message published on a Redis channel is wrapped in this envelope.
 * The `payload` field holds the ServerMessage that subscribers forward to WS clients.
 */
export interface RedisEnvelope {
  /**
   * The slug of the event this message belongs to.
   * Allows a single Redis subscriber to route across multiple rooms.
   */
  event_slug: string;

  /**
   * Optional: when set, only clients matching this posten_id receive the message.
   * Used for `timy_status` (bridge up/down) directed at zeitnehmer on the same posten.
   */
  posten_id?: string;

  /** The actual server→client message to forward. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Auth resolution result (internal)
// ---------------------------------------------------------------------------

/** Returned by the internal resolveToken() helper on successful auth. */
export type AuthResult =
  | {
      ok: true;
      type: 'user';
      userId: string;
      userRole: WsClient['userRole'];
    }
  | {
      ok: true;
      type: 'zeitnehmer';
      postenId: string;
      eventId: string;
    }
  | {
      ok: true;
      type: 'bridge';
      postenId: string;
      eventId: string;
    }
  | {
      ok: false;
      reason: string;
    };
