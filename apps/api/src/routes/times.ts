/**
 * times.ts — Time entry routes (core timing functionality)
 *
 * Endpoints (planned):
 *   POST   /api/v1/times                  — record a time entry (Posten device via authenticatePosten)
 *   POST   /api/v1/times/bulk             — record multiple entries at once (offline sync)
 *   GET    /api/v1/times?event_id=&posten_id=  — list entries with filters
 *   PATCH  /api/v1/times/:id              — correct an entry (organizer+)
 *   POST   /api/v1/times/:id/void         — void an entry with reason (organizer+)
 *
 * Note: POST /times dispatches a scoring recompute job via BullMQ after save.
 * The WebSocket hub broadcasts the new entry to all subscribers on channel
 * `event:{event_id}:times`.
 */
import type { FastifyInstance } from 'fastify';

// TODO: implement time entry routes
export async function timesRoutes(_app: FastifyInstance): Promise<void> {
  // TODO: POST   /        — authenticatePosten preHandler
  // TODO: POST   /bulk    — authenticatePosten preHandler
  // TODO: GET    /        — authenticate preHandler
  // TODO: PATCH  /:id     — requireRole(['admin','organizer']) preHandler
  // TODO: POST   /:id/void — requireRole(['admin','organizer']) preHandler
}
