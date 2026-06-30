/**
 * plugins/requestLogging.ts — Structured per-request access log
 *
 * Logs every request on completion with:
 *   method, url, status, duration_ms, request_id
 *
 * WebSocket connections (path = /ws) are enriched with:
 *   client_type, event_slug  (read from query params)
 *
 * The /health path is excluded to avoid noise in the logs.
 *
 * Uses the pino logger that Fastify wires up internally — no extra dependency.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const EXCLUDED_PATHS = new Set(['/health']);

async function requestLoggingPluginFn(app: FastifyInstance): Promise<void> {
  app.addHook(
    'onResponse',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url;

      // Strip query string for path comparison
      const path = url.split('?')[0] ?? url;

      if (EXCLUDED_PATHS.has(path)) return;

      const durationMs = Math.round(reply.elapsedTime);

      // Base log fields
      const logFields: Record<string, unknown> = {
        method: request.method,
        url,
        status: reply.statusCode,
        duration_ms: durationMs,
        // requestId may have been set by the requestId plugin
        request_id: (request as FastifyRequest & { requestId?: string }).requestId
          ?? request.id,
      };

      // Enrich WebSocket upgrade requests
      if (path === '/ws') {
        const query = request.query as Record<string, string | undefined>;
        if (query.type) logFields['client_type'] = query.type;
        if (query.event_slug) logFields['event_slug'] = query.event_slug;
      }

      request.log.info(logFields, 'request completed');
    },
  );
}

export const requestLoggingPlugin = fp(requestLoggingPluginFn, {
  name: 'request-logging',
  fastify: '5.x',
});
