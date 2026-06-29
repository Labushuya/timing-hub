/**
 * ws/hub.ts — Production WebSocket hub with Redis pub/sub fan-out
 *
 * Architecture:
 *   Single endpoint  GET /ws?token=...&type=user|zeitnehmer|bridge
 *
 *   Three client types:
 *     user        — Veranstalter / Kommissar / Admin.  Authenticates with a
 *                   short-lived JWT access token.  May subscribe to events.
 *     zeitnehmer  — Timing-post operator.  Authenticates with a posten session
 *                   token (stored in DB table posten_sessions).
 *                   May send manual_time and confirm_entry messages.
 *     bridge      — Timy hardware bridge.  Authenticates with a bridge token
 *                   (stored in DB table bridge_tokens).
 *                   May send timy_impulse messages.
 *
 *   Room model:
 *     Each event has a Redis pub/sub channel  "event:{slug}".
 *     All broadcasts (time_entry, results_update, …) are published to Redis so
 *     every API replica fans out the message to its local WS clients.
 *
 *   Heartbeat:
 *     Server sends a WebSocket ping frame every 30 s.
 *     If no pong arrives within 10 s the connection is terminated.
 *
 * Exported surface:
 *   registerWsHub(app)                   — register route + Redis subscriber
 *   broadcast(app, eventSlug, msg)       — publish msg to all room subscribers
 *   broadcastToPosten(app, postenId, msg)— publish msg to clients on one posten
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type {
  WsClient,
  WsClientType,
  AuthResult,
  RedisEnvelope,
  WSConnected,
  ClientMessage,
  ServerMessage,
  WSAck,
  WSError,
  TimeEntryPublic,
  Participant,
  EventStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;   // send ping every 30 s
const PONG_TIMEOUT_MS  = 10_000;   // wait 10 s for pong before closing
const WS_CLOSE_POLICY  = 4001;     // auth failure close code
const REDIS_CHANNEL_PREFIX = 'event:';

// ---------------------------------------------------------------------------
// Hub state (node-local, not shared across replicas)
// ---------------------------------------------------------------------------

/** All currently connected clients on this node. */
const clients = new Map<string, WsClient>();

/**
 * Room map: eventSlug → Set of clientIds subscribed to that event.
 * Mirrors the client's `eventSlugs` set for fast fan-out lookups.
 */
const rooms = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Utility: safe JSON send
// ---------------------------------------------------------------------------

function send(socket: WebSocket, msg: ServerMessage | WSConnected): void {
  if (socket.readyState === 1 /* OPEN */) {
    socket.send(JSON.stringify(msg));
  }
}

function sendError(socket: WebSocket, code: string, message: string, refSeq?: string): void {
  const err: WSError = { type: 'error', code, message };
  if (refSeq !== undefined) err.ref_seq = refSeq;
  send(socket, err);
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------

function roomAdd(clientId: string, eventSlug: string): void {
  let room = rooms.get(eventSlug);
  if (!room) {
    room = new Set();
    rooms.set(eventSlug, room);
  }
  room.add(clientId);

  const client = clients.get(clientId);
  if (client) client.eventSlugs.add(eventSlug);
}

function roomRemove(clientId: string, eventSlug: string): void {
  const room = rooms.get(eventSlug);
  if (room) {
    room.delete(clientId);
    if (room.size === 0) rooms.delete(eventSlug);
  }
  const client = clients.get(clientId);
  if (client) client.eventSlugs.delete(eventSlug);
}

function roomRemoveAll(clientId: string): string[] {
  const client = clients.get(clientId);
  if (!client) return [];
  const emptyRooms: string[] = [];
  for (const slug of [...client.eventSlugs]) {
    roomRemove(clientId, slug);
    // After remove, check if the room was eliminated (size === 0 removes the entry)
    if (!rooms.has(slug)) {
      emptyRooms.push(slug);
    }
  }
  return emptyRooms;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

function startHeartbeat(client: WsClient, app: FastifyInstance): void {
  client.pingInterval = setInterval(() => {
    if (client.socket.readyState !== 1 /* OPEN */) {
      stopHeartbeat(client);
      return;
    }

    // Send WebSocket-level ping frame
    client.socket.ping();

    // Expect pong within PONG_TIMEOUT_MS
    client.pongTimer = setTimeout(() => {
      app.log.warn({ clientId: client.clientId }, 'WS heartbeat timeout — closing');
      client.socket.terminate();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function stopHeartbeat(client: WsClient): void {
  if (client.pingInterval) {
    clearInterval(client.pingInterval);
    delete client.pingInterval;
  }
  if (client.pongTimer) {
    clearTimeout(client.pongTimer);
    delete client.pongTimer;
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function resolveToken(
  app: FastifyInstance,
  token: string,
  type: string,
): Promise<AuthResult> {
  switch (type) {
    // -----------------------------------------------------------------------
    case 'user': {
      try {
        const payload = app.jwt.verify<{
          sub: string;
          email: string;
          role: 'admin' | 'organizer' | 'timekeeper' | 'viewer';
        }>(token);
        return {
          ok: true,
          type: 'user',
          userId: payload.sub,
          userRole: payload.role,
        };
      } catch {
        return { ok: false, reason: 'Invalid or expired JWT' };
      }
    }

    // -----------------------------------------------------------------------
    case 'zeitnehmer': {
      try {
        const rows = await app.db<
          { posten_id: string; event_id: string; expires_at: Date }[]
        >`
          SELECT ps.posten_id, ps.event_id, ps.expires_at
          FROM   posten_sessions ps
          WHERE  ps.token       = ${token}
            AND  ps.revoked_at  IS NULL
            AND  ps.expires_at  > now()
          LIMIT  1
        `;

        if (rows.length === 0) {
          return { ok: false, reason: 'Invalid or expired posten session token' };
        }

        const row = rows[0]!;
        return {
          ok: true,
          type: 'zeitnehmer',
          postenId: row.posten_id,
          eventId: row.event_id,
        };
      } catch (err) {
        app.log.error({ err }, 'WS auth: zeitnehmer DB error');
        return { ok: false, reason: 'Session validation error' };
      }
    }

    // -----------------------------------------------------------------------
    case 'bridge': {
      try {
        const rows = await app.db<
          { posten_id: string; event_id: string; expires_at: Date }[]
        >`
          SELECT bt.posten_id, p.event_id, bt.expires_at
          FROM   bridge_tokens bt
          JOIN   posten        p ON p.id = bt.posten_id
          WHERE  bt.token      = ${token}
            AND  bt.revoked_at IS NULL
            AND  bt.expires_at > now()
          LIMIT  1
        `;

        if (rows.length === 0) {
          return { ok: false, reason: 'Invalid or expired bridge token' };
        }

        const row = rows[0]!;
        return {
          ok: true,
          type: 'bridge',
          postenId: row.posten_id,
          eventId: row.event_id,
        };
      } catch (err) {
        app.log.error({ err }, 'WS auth: bridge DB error');
        return { ok: false, reason: 'Bridge token validation error' };
      }
    }

    // -----------------------------------------------------------------------
    default:
      return { ok: false, reason: `Unknown client type: ${type}` };
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleMessage(
  app: FastifyInstance,
  client: WsClient,
  raw: Buffer | string,
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw.toString()) as ClientMessage;
  } catch {
    sendError(client.socket, 'INVALID_JSON', 'Message is not valid JSON');
    return;
  }

  if (!msg || typeof msg.type !== 'string') {
    sendError(client.socket, 'INVALID_MSG', 'Message must have a type field');
    return;
  }

  switch (msg.type) {
    // -----------------------------------------------------------------------
    case 'ping':
      send(client.socket, { type: 'pong' });
      return;

    // -----------------------------------------------------------------------
    case 'subscribe_event':
      await handleSubscribeEvent(app, client, msg.event_slug);
      return;

    // -----------------------------------------------------------------------
    case 'unsubscribe_event':
      await handleUnsubscribeEvent(app, client, msg.event_slug);
      return;

    // -----------------------------------------------------------------------
    case 'timy_impulse':
      if (client.type !== 'bridge') {
        sendError(client.socket, 'FORBIDDEN', 'timy_impulse requires bridge client type');
        return;
      }
      await handleTimyImpulse(app, client, msg.posten_id, msg.channel, msg.raw_timestamp_ms, msg.raw_string, msg.bridge_seq);
      return;

    // -----------------------------------------------------------------------
    case 'manual_time':
      if (client.type !== 'zeitnehmer') {
        sendError(client.socket, 'FORBIDDEN', 'manual_time requires zeitnehmer client type');
        return;
      }
      await handleManualTime(app, client, msg.posten_id, msg.startnummer, msg.raw_timestamp_ms, msg.client_seq);
      return;

    // -----------------------------------------------------------------------
    case 'confirm_entry':
      if (client.type !== 'zeitnehmer') {
        sendError(client.socket, 'FORBIDDEN', 'confirm_entry requires zeitnehmer client type');
        return;
      }
      await handleConfirmEntry(app, client, msg.entry_id, msg.startnummer);
      return;

    // -----------------------------------------------------------------------
    default: {
      // TypeScript exhaustiveness — cast to get the type field for the error message
      const unknown = msg as { type: string };
      sendError(client.socket, 'UNKNOWN_MSG', `Unknown message type: ${unknown.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// subscribe_event
// ---------------------------------------------------------------------------

async function handleSubscribeEvent(
  app: FastifyInstance,
  client: WsClient,
  eventSlug: string,
): Promise<void> {
  if (!eventSlug) {
    sendError(client.socket, 'INVALID_PARAMS', 'event_slug is required');
    return;
  }

  // Verify event exists and fetch status
  let eventStatus: EventStatus = 'active';
  try {
    const rows = await app.db<{ slug: string; status: string }[]>`
      SELECT slug, status FROM events WHERE slug = ${eventSlug} LIMIT 1
    `;
    if (rows.length === 0) {
      sendError(client.socket, 'NOT_FOUND', `Event not found: ${eventSlug}`);
      return;
    }
    eventStatus = rows[0]!.status as import('./types.js').EventStatus;
  } catch (err) {
    app.log.error({ err, eventSlug }, 'WS subscribe_event: DB error');
    sendError(client.socket, 'INTERNAL', 'Failed to look up event');
    return;
  }

  // Register in local room
  roomAdd(client.clientId, eventSlug);

  // Ensure this node is subscribed to the Redis channel
  const redisChannel = `${REDIS_CHANNEL_PREFIX}${eventSlug}`;
  const subCount = rooms.get(eventSlug)?.size ?? 0;
  if (subCount === 1) {
    // First local subscriber — start listening on Redis
    app.redisSub.subscribe(redisChannel, (err) => {
      if (err) {
        app.log.error({ err, redisChannel }, 'WS: Redis subscribe error');
      }
    });
  }

  app.log.debug({ clientId: client.clientId, eventSlug }, 'WS: subscribed to event');

  // Send current event status as join confirmation
  send(client.socket, {
    type: 'event_status',
    event_slug: eventSlug,
    status: eventStatus,
  });
}

// ---------------------------------------------------------------------------
// unsubscribe_event
// ---------------------------------------------------------------------------

async function handleUnsubscribeEvent(
  app: FastifyInstance,
  client: WsClient,
  eventSlug: string,
): Promise<void> {
  if (!eventSlug) {
    sendError(client.socket, 'INVALID_PARAMS', 'event_slug is required');
    return;
  }

  roomRemove(client.clientId, eventSlug);

  // If no local subscribers remain, stop listening on Redis
  const remaining = rooms.get(eventSlug)?.size ?? 0;
  if (remaining === 0) {
    const redisChannel = `${REDIS_CHANNEL_PREFIX}${eventSlug}`;
    app.redisSub.unsubscribe(redisChannel, (err) => {
      if (err) {
        app.log.error({ err, redisChannel }, 'WS: Redis unsubscribe error');
      }
    });
  }

  app.log.debug({ clientId: client.clientId, eventSlug }, 'WS: unsubscribed from event');
}

// ---------------------------------------------------------------------------
// timy_impulse  (bridge only)
// ---------------------------------------------------------------------------

async function handleTimyImpulse(
  app: FastifyInstance,
  client: WsClient,
  postenId: string,
  channel: string,
  rawTimestampMs: number,
  rawString: string,
  bridgeSeq: number,
): Promise<void> {
  const seqStr = String(bridgeSeq);

  // Bridge must own the posten it claims
  if (client.postenId !== postenId) {
    const ack: WSAck = {
      type: 'ack',
      client_seq: seqStr,
      entry_id: '',
      status: 'error',
      error: 'Bridge does not own the specified posten',
    };
    send(client.socket, ack);
    return;
  }

  const serverRecvMs = Date.now();

  try {
    // Deduplication: check for existing entry with same posten + bridge_seq
    const existing = await app.db<{ id: string }[]>`
      SELECT id FROM time_entries
      WHERE posten_id  = ${postenId}
        AND source     = 'timy_bridge'
        AND client_seq = ${seqStr}
      LIMIT 1
    `;

    if (existing.length > 0) {
      const ack: WSAck = {
        type: 'ack',
        client_seq: seqStr,
        entry_id: existing[0]!.id,
        status: 'duplicate',
      };
      send(client.socket, ack);
      return;
    }

    // Resolve event_slug for publishing
    const eventInfo = await app.db<{ slug: string }[]>`
      SELECT e.slug
      FROM   events   e
      JOIN   posten   p ON p.event_id = e.id
      WHERE  p.id = ${postenId}
      LIMIT  1
    `;

    if (eventInfo.length === 0) {
      const ack: WSAck = {
        type: 'ack',
        client_seq: seqStr,
        entry_id: '',
        status: 'error',
        error: 'Could not resolve event for this posten',
      };
      send(client.socket, ack);
      return;
    }

    const eventSlug = eventInfo[0]!.slug;

    // Insert time entry
    const inserted = await app.db<{ id: string }[]>`
      INSERT INTO time_entries
        (posten_id, source, raw_timestamp_ms, server_recv_ms, channel, raw_string, client_seq, is_confirmed, is_void)
      VALUES
        (${postenId}, 'timy_bridge', ${rawTimestampMs}, ${serverRecvMs}, ${channel}, ${rawString}, ${seqStr}, false, false)
      RETURNING id
    `;

    const entryId = inserted[0]!.id;

    // ACK to bridge
    const ack: WSAck = {
      type: 'ack',
      client_seq: seqStr,
      entry_id: entryId,
      status: 'accepted',
    };
    send(client.socket, ack);

    // Fetch full entry for broadcast
    const entryRows = await app.db<Record<string, unknown>[]>`
      SELECT id, event_id, posten_id, participant_id, startnummer, source,
             raw_timestamp_ms, server_recv_ms, lap_number, sector_number,
             channel, is_confirmed, is_void, created_at, updated_at
      FROM   time_entries
      WHERE  id = ${entryId}
      LIMIT  1
    `;

    if (entryRows.length > 0) {
      // Publish to Redis so all nodes fan out
      await publishToRedis(app, eventSlug, {
        type: 'time_entry',
        event_slug: eventSlug,
        entry: entryRows[0] as unknown as TimeEntryPublic,
      });
    }

    // Enqueue scoring recompute
    const { enqueueCompute } = await import('../services/scoring/index.js');
    const eventRows = await app.db<{ id: string }[]>`
      SELECT e.id FROM events e JOIN posten p ON p.event_id = e.id WHERE p.id = ${postenId} LIMIT 1
    `;
    if (eventRows.length > 0) {
      await enqueueCompute(app, eventRows[0]!.id);
    }
  } catch (err) {
    app.log.error({ err, postenId, bridgeSeq }, 'WS handleTimyImpulse error');
    const ack: WSAck = {
      type: 'ack',
      client_seq: seqStr,
      entry_id: '',
      status: 'error',
      error: 'Internal server error',
    };
    send(client.socket, ack);
  }
}

// ---------------------------------------------------------------------------
// manual_time  (zeitnehmer only)
// ---------------------------------------------------------------------------

async function handleManualTime(
  app: FastifyInstance,
  client: WsClient,
  postenId: string,
  startnummer: string | undefined,
  rawTimestampMs: number,
  clientSeq: string,
): Promise<void> {
  // Zeitnehmer must own the posten
  if (client.postenId !== postenId) {
    const ack: WSAck = {
      type: 'ack',
      client_seq: clientSeq,
      entry_id: '',
      status: 'error',
      error: 'Session does not own the specified posten',
    };
    send(client.socket, ack);
    return;
  }

  const serverRecvMs = Date.now();

  try {
    // Deduplication via client_seq
    const existing = await app.db<{ id: string }[]>`
      SELECT id FROM time_entries
      WHERE posten_id  = ${postenId}
        AND source     = 'manual'
        AND client_seq = ${clientSeq}
      LIMIT 1
    `;

    if (existing.length > 0) {
      const ack: WSAck = {
        type: 'ack',
        client_seq: clientSeq,
        entry_id: existing[0]!.id,
        status: 'duplicate',
      };
      send(client.socket, ack);
      return;
    }

    // Resolve participant_id from startnummer (if provided)
    let participantId: string | null = null;
    let resolvedEventId: string | null = null;

    const eventInfo = await app.db<{ slug: string; id: string }[]>`
      SELECT e.slug, e.id
      FROM   events  e
      JOIN   posten  p ON p.event_id = e.id
      WHERE  p.id = ${postenId}
      LIMIT  1
    `;

    if (eventInfo.length === 0) {
      const ack: WSAck = {
        type: 'ack',
        client_seq: clientSeq,
        entry_id: '',
        status: 'error',
        error: 'Could not resolve event for this posten',
      };
      send(client.socket, ack);
      return;
    }

    const eventSlug = eventInfo[0]!.slug;
    resolvedEventId = eventInfo[0]!.id;

    if (startnummer) {
      const partRows = await app.db<{ id: string }[]>`
        SELECT id FROM participants
        WHERE  event_id    = ${resolvedEventId}
          AND  startnummer = ${startnummer}
        LIMIT  1
      `;
      if (partRows.length > 0) {
        participantId = partRows[0]!.id;
      }
    }

    // Insert
    const inserted = await app.db<{ id: string }[]>`
      INSERT INTO time_entries
        (posten_id, participant_id, startnummer, source, raw_timestamp_ms, server_recv_ms,
         client_seq, is_confirmed, is_void)
      VALUES
        (${postenId}, ${participantId}, ${startnummer ?? null}, 'manual',
         ${rawTimestampMs}, ${serverRecvMs}, ${clientSeq}, false, false)
      RETURNING id
    `;

    const entryId = inserted[0]!.id;

    // ACK
    const ack: WSAck = {
      type: 'ack',
      client_seq: clientSeq,
      entry_id: entryId,
      status: 'accepted',
    };
    send(client.socket, ack);

    // Fetch full entry and publish
    const entryRows = await app.db<Record<string, unknown>[]>`
      SELECT id, event_id, posten_id, participant_id, startnummer, source,
             raw_timestamp_ms, server_recv_ms, lap_number, sector_number,
             channel, is_confirmed, is_void, created_at, updated_at
      FROM   time_entries
      WHERE  id = ${entryId}
      LIMIT  1
    `;

    if (entryRows.length > 0) {
      await publishToRedis(app, eventSlug, {
        type: 'time_entry',
        event_slug: eventSlug,
        entry: entryRows[0] as unknown as TimeEntryPublic,
      });
    }

    // Enqueue scoring recompute
    const { enqueueCompute } = await import('../services/scoring/index.js');
    await enqueueCompute(app, resolvedEventId);
  } catch (err) {
    app.log.error({ err, postenId, clientSeq }, 'WS handleManualTime error');
    const ack: WSAck = {
      type: 'ack',
      client_seq: clientSeq,
      entry_id: '',
      status: 'error',
      error: 'Internal server error',
    };
    send(client.socket, ack);
  }
}

// ---------------------------------------------------------------------------
// confirm_entry  (zeitnehmer only)
// ---------------------------------------------------------------------------

async function handleConfirmEntry(
  app: FastifyInstance,
  client: WsClient,
  entryId: string,
  startnummer: string,
): Promise<void> {
  try {
    // Verify the entry belongs to this zeitnehmer's posten
    const entryRows = await app.db<{ posten_id: string; event_id: string }[]>`
      SELECT te.posten_id, te.event_id
      FROM   time_entries te
      WHERE  te.id = ${entryId}
      LIMIT  1
    `;

    if (entryRows.length === 0) {
      sendError(client.socket, 'NOT_FOUND', `time_entry ${entryId} not found`);
      return;
    }

    const entry = entryRows[0]!;

    if (entry.posten_id !== client.postenId) {
      sendError(client.socket, 'FORBIDDEN', 'Entry belongs to a different posten');
      return;
    }

    // Resolve participant from startnummer
    const partRows = await app.db<{ id: string }[]>`
      SELECT id FROM participants
      WHERE  event_id    = ${entry.event_id}
        AND  startnummer = ${startnummer}
      LIMIT  1
    `;

    if (partRows.length === 0) {
      sendError(client.socket, 'NOT_FOUND', `Participant with startnummer ${startnummer} not found`);
      return;
    }

    const participantId = partRows[0]!.id;

    // Update entry
    await app.db`
      UPDATE time_entries
      SET    participant_id = ${participantId},
             startnummer    = ${startnummer},
             is_confirmed   = true,
             confirmed_at   = now()
      WHERE  id = ${entryId}
    `;

    // Fetch event slug
    const slugRows = await app.db<{ slug: string }[]>`
      SELECT slug FROM events WHERE id = ${entry.event_id} LIMIT 1
    `;

    if (slugRows.length === 0) return;
    const eventSlug = slugRows[0]!.slug;

    // Fetch participant details for broadcast
    const participantFull = await app.db<Record<string, unknown>[]>`
      SELECT id, event_id, startnummer, first_name, last_name, team, category,
             bib_color, created_at, updated_at
      FROM   participants
      WHERE  id = ${participantId}
      LIMIT  1
    `;

    if (participantFull.length > 0) {
      await publishToRedis(app, eventSlug, {
        type: 'participant_confirmed',
        event_slug: eventSlug,
        entry_id: entryId,
        participant: participantFull[0] as unknown as Participant,
      });
    }

    // Enqueue scoring recompute
    const { enqueueCompute } = await import('../services/scoring/index.js');
    await enqueueCompute(app, entry.event_id);
  } catch (err) {
    app.log.error({ err, entryId }, 'WS handleConfirmEntry error');
    sendError(client.socket, 'INTERNAL', 'Failed to confirm entry');
  }
}

// ---------------------------------------------------------------------------
// Redis publish helper
// ---------------------------------------------------------------------------

async function publishToRedis(
  app: FastifyInstance,
  eventSlug: string,
  payload: unknown,
  postenId?: string,
): Promise<void> {
  const envelope: RedisEnvelope = {
    event_slug: eventSlug,
    payload,
    ...(postenId ? { posten_id: postenId } : {}),
  };
  const channel = `${REDIS_CHANNEL_PREFIX}${eventSlug}`;
  await app.redis.publish(channel, JSON.stringify(envelope));
}

// ---------------------------------------------------------------------------
// Redis subscriber fan-out
// ---------------------------------------------------------------------------

function setupRedisSubscriber(app: FastifyInstance): void {
  app.redisSub.on('message', (channel: string, message: string) => {
    let envelope: RedisEnvelope;
    try {
      envelope = JSON.parse(message) as RedisEnvelope;
    } catch (err) {
      app.log.warn({ err, channel }, 'WS hub: failed to parse Redis message');
      return;
    }

    const { event_slug: eventSlug, payload, posten_id: targetPostenId } = envelope;

    if (!eventSlug) {
      app.log.warn({ channel }, 'WS hub: Redis envelope missing event_slug');
      return;
    }

    const room = rooms.get(eventSlug);
    if (!room || room.size === 0) return;

    const msgStr = JSON.stringify(payload);

    for (const clientId of room) {
      const client = clients.get(clientId);
      if (!client) continue;
      if (client.socket.readyState !== 1 /* OPEN */) continue;

      // If message is targeted to a specific posten, filter
      if (targetPostenId && client.postenId !== targetPostenId) continue;

      client.socket.send(msgStr);
    }
  });
}

// ---------------------------------------------------------------------------
// Client disconnect cleanup
// ---------------------------------------------------------------------------

function cleanupClient(clientId: string, app: FastifyInstance): void {
  const client = clients.get(clientId);
  if (!client) return;

  stopHeartbeat(client);

  // roomRemoveAll returns slugs whose rooms just became empty on this node.
  // Unsubscribe from the corresponding Redis channels.
  const emptyRooms = roomRemoveAll(clientId);
  for (const slug of emptyRooms) {
    const redisChannel = `${REDIS_CHANNEL_PREFIX}${slug}`;
    app.redisSub.unsubscribe(redisChannel, (err) => {
      if (err) {
        app.log.error({ err, redisChannel }, 'WS cleanup: Redis unsubscribe error');
      }
    });
  }

  clients.delete(clientId);

  app.log.info({ clientId, type: client.type }, 'WS client disconnected');
}

// ---------------------------------------------------------------------------
// registerWsHub — main export
// ---------------------------------------------------------------------------

export async function registerWsHub(app: FastifyInstance): Promise<void> {
  // Wire Redis subscriber → local fan-out
  setupRedisSubscriber(app);

  // WebSocket route
  app.get(
    '/ws',
    { websocket: true },
    async (socket: WebSocket, request) => {
      const query = request.query as Record<string, string | undefined>;
      const token = query.token;
      const typeParam = (query.type ?? 'user') as WsClientType;

      // -----------------------------------------------------------------------
      // Authentication
      // -----------------------------------------------------------------------
      if (!token) {
        sendError(socket, 'AUTH_REQUIRED', 'token query parameter is required');
        socket.close(WS_CLOSE_POLICY, 'Authentication required');
        return;
      }

      const authResult = await resolveToken(app, token, typeParam);

      if (!authResult.ok) {
        app.log.warn({ type: typeParam, reason: authResult.reason }, 'WS auth failed');
        sendError(socket, 'AUTH_FAILED', authResult.reason);
        socket.close(WS_CLOSE_POLICY, 'Authentication failed');
        return;
      }

      // -----------------------------------------------------------------------
      // Build client record
      // -----------------------------------------------------------------------
      const clientId = crypto.randomUUID();

      const client: WsClient = {
        clientId,
        socket,
        type: authResult.type,
        eventSlugs: new Set(),
      };

      if (authResult.type === 'user') {
        client.userId = authResult.userId;
        if (authResult.userRole !== undefined) {
          client.userRole = authResult.userRole;
        }
      } else {
        // zeitnehmer or bridge
        client.postenId = authResult.postenId;
        client.eventId = authResult.eventId;
      }

      clients.set(clientId, client);

      app.log.info(
        {
          clientId,
          type: authResult.type,
          userId: 'userId' in authResult ? authResult.userId : undefined,
          postenId: 'postenId' in authResult ? authResult.postenId : undefined,
          remoteAddress: request.socket.remoteAddress,
        },
        'WS client connected',
      );

      // -----------------------------------------------------------------------
      // Send connected message
      // -----------------------------------------------------------------------
      const connectedMsg: WSConnected = {
        type: 'connected',
        client_id: clientId,
        server_time: Date.now(),
      };
      socket.send(JSON.stringify(connectedMsg));

      // -----------------------------------------------------------------------
      // Heartbeat setup
      // -----------------------------------------------------------------------
      startHeartbeat(client, app);

      // Clear pong timer when we receive a pong frame from the client
      socket.on('pong', () => {
        if (client.pongTimer) {
          clearTimeout(client.pongTimer);
          delete client.pongTimer;
        }
      });

      // -----------------------------------------------------------------------
      // Message handler
      // -----------------------------------------------------------------------
      socket.on('message', (raw: Buffer | string) => {
        handleMessage(app, client, raw).catch((err: unknown) => {
          app.log.error({ err, clientId }, 'WS handleMessage unhandled error');
        });
      });

      // -----------------------------------------------------------------------
      // Disconnect / error
      // -----------------------------------------------------------------------
      socket.on('close', (code: number, reason: Buffer) => {
        app.log.info({ clientId, code, reason: reason.toString() }, 'WS client close');
        cleanupClient(clientId, app);
      });

      socket.on('error', (err: Error) => {
        app.log.error({ err, clientId }, 'WS client socket error');
        cleanupClient(clientId, app);
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Exported broadcast helpers (for use by HTTP route handlers)
// ---------------------------------------------------------------------------

/**
 * Publish a server message to all WS clients subscribed to the given event.
 * Routes through Redis so all replicas receive and fan out the message.
 */
export async function broadcast(
  app: FastifyInstance,
  eventSlug: string,
  msg: unknown,
): Promise<void> {
  await publishToRedis(app, eventSlug, msg);
}

/**
 * Publish a server message to all WS clients on the given posten
 * (zeitnehmer and bridge clients with that postenId).
 * Requires the event_slug to determine the Redis channel.
 *
 * @param eventSlug - event slug (needed for Redis channel routing)
 * @param postenId  - target posten; only clients with this postenId receive the message
 * @param msg       - server→client message payload
 */
export async function broadcastToPosten(
  app: FastifyInstance,
  eventSlug: string,
  postenId: string,
  msg: unknown,
): Promise<void> {
  await publishToRedis(app, eventSlug, msg, postenId);
}
