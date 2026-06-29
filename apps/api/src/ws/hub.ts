/**
 * ws/hub.ts — WebSocket hub with Redis pub/sub fan-out
 *
 * Architecture:
 *   - Each connected client subscribes to one or more channels (e.g. `event:{id}:times`)
 *   - The Redis subscriber connection listens for messages published by API workers
 *   - Messages are fanned out to all WebSocket clients subscribed to that channel
 *
 * Protocol (JSON messages):
 *   Client → Server:
 *     { type: 'subscribe',   channel: string }
 *     { type: 'unsubscribe', channel: string }
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'subscribed',   channel: string }
 *     { type: 'unsubscribed', channel: string }
 *     { type: 'message',      channel: string, payload: unknown }
 *     { type: 'pong' }
 *     { type: 'error',        message: string }
 *
 * Channels:
 *   event:{eventId}:times    — new time entry recorded
 *   event:{eventId}:results  — results recomputed / published
 *   event:{eventId}:status   — event status changed
 *
 * Auth:
 *   Client must send ?token=<jwt> on the WS handshake URL, or an Authorization
 *   header (Bearer <jwt>).  The connection is rejected if the token is invalid.
 *
 * TODO: implement full hub logic
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';

/** Map of channel → set of connected clients */
const channels = new Map<string, Set<WebSocket>>();

/** Register a client in a channel. */
function subscribe(ws: WebSocket, channel: string): void {
  // TODO: implement
  void ws;
  void channel;
}

/** Unregister a client from a channel. */
function unsubscribe(ws: WebSocket, channel: string): void {
  // TODO: implement
  void ws;
  void channel;
}

/** Unregister a client from ALL channels (on disconnect). */
function unsubscribeAll(ws: WebSocket): void {
  for (const [channel, clients] of channels) {
    clients.delete(ws);
    if (clients.size === 0) channels.delete(channel);
  }
}

/** Broadcast a payload to all clients in a channel. */
function broadcast(channel: string, payload: unknown): void {
  const clients = channels.get(channel);
  if (!clients) return;
  const message = JSON.stringify({ type: 'message', channel, payload });
  for (const client of clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(message);
    }
  }
}

/**
 * Register the WebSocket hub route and wire up Redis pub/sub.
 * Call once from server.ts after all plugins are registered.
 */
export async function registerWsHub(app: FastifyInstance): Promise<void> {
  // Wire Redis subscriber → broadcast
  // TODO: determine which Redis channels to subscribe to and fan out
  app.redisSub.on('message', (channel: string, message: string) => {
    try {
      const payload = JSON.parse(message) as unknown;
      broadcast(channel, payload);
    } catch (err) {
      app.log.warn({ err, channel }, 'WS hub: failed to parse Redis message');
    }
  });

  // WebSocket route — requires authentication
  app.get(
    '/ws',
    { websocket: true },
    async (socket, request) => {
      // TODO: authenticate the connection (JWT from query param or header)
      app.log.info({ remoteAddress: request.socket.remoteAddress }, 'WS client connected');

      socket.on('message', (raw: Buffer | string) => {
        // TODO: parse and handle subscribe/unsubscribe/ping messages
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; channel?: string };
          switch (msg.type) {
            case 'subscribe':
              if (msg.channel) subscribe(socket, msg.channel);
              break;
            case 'unsubscribe':
              if (msg.channel) unsubscribe(socket, msg.channel);
              break;
            case 'ping':
              socket.send(JSON.stringify({ type: 'pong' }));
              break;
            default:
              socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
          }
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      socket.on('close', () => {
        unsubscribeAll(socket);
        app.log.info('WS client disconnected');
      });

      socket.on('error', (err: Error) => {
        app.log.error({ err }, 'WS client error');
        unsubscribeAll(socket);
      });
    },
  );
}

// Re-export broadcast so API route handlers can publish to WS clients
export { broadcast };
