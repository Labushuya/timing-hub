/**
 * results.ts — Results / rankings routes
 *
 * Endpoints (planned):
 *   GET  /api/v1/results?event_id=           — full results list (paginated)
 *   GET  /api/v1/results?event_id=&category= — filtered by category
 *   GET  /api/v1/results/:participantId      — individual result + splits
 *   POST /api/v1/results/compute             — trigger manual recompute (organizer+)
 *   POST /api/v1/results/publish             — publish results (organizer+, sends WS broadcast)
 *   GET  /api/v1/results/export?event_id=    — export CSV/JSON
 *
 * Results are primarily populated by the scoring BullMQ worker.
 * Published results are broadcast via the WebSocket hub.
 */
import type { FastifyInstance } from 'fastify';

// TODO: implement results routes
export async function resultsRoutes(_app: FastifyInstance): Promise<void> {
  // TODO: GET  /
  // TODO: GET  /:participantId
  // TODO: POST /compute   — requireRole(['admin','organizer']) preHandler
  // TODO: POST /publish   — requireRole(['admin','organizer']) preHandler
  // TODO: GET  /export
}
