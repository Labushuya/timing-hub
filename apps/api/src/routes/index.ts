import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { authRoutes } from './auth.js';
import { adminRoutes } from './admin.js';
import { eventRoutes } from './events.js';
import { postenRoutes } from './posten.js';
import { participantRoutes } from './participants.js';
import { timesRoutes } from './times.js';
import { resultsRoutes } from './results.js';

const API_PREFIX = '/api/v1';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Health — no prefix so it's reachable at the root level
  await app.register(healthRoutes);

  // Versioned API routes
  await app.register(
    async (api) => {
      await api.register(authRoutes,        { prefix: '/auth' });
      await api.register(adminRoutes,       { prefix: '/admin' });
      await api.register(eventRoutes,       { prefix: '/events' });
      // participantRoutes, postenRoutes register full paths under /events/:slug/...
      await api.register(participantRoutes);
      await api.register(postenRoutes);
      await api.register(timesRoutes,       { prefix: '/times' });
      await api.register(resultsRoutes,     { prefix: '/results' });
    },
    { prefix: API_PREFIX },
  );
}

// ---------------------------------------------------------------------------
// AppType — re-export for RPC-style type inference in @timing-hub/web
// ---------------------------------------------------------------------------
export type AppType = FastifyInstance;
