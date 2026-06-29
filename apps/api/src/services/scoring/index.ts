/**
 * services/scoring/index.ts — Scoring service
 *
 * Responsibilities:
 *  1. Wrap the @timing-hub/scoring-engine package to compute rankings
 *  2. Dispatch BullMQ jobs for async / debounced recomputation
 *  3. Persist computed results to the `results` table
 *  4. Broadcast result updates via Redis pub/sub → WebSocket hub
 *
 * Queue name: 'scoring'
 * Job types:
 *   - 'compute'  { eventId: string }  — recompute all results for an event
 *   - 'publish'  { eventId: string }  — mark results as published + broadcast
 *
 * Usage (from times route after a new entry is saved):
 *   await scoringService.enqueueCompute(app, eventId);
 */
import type { FastifyInstance } from 'fastify';
import { Queue, Worker } from 'bullmq';

export type ScoringJobData =
  | { type: 'compute'; eventId: string }
  | { type: 'publish'; eventId: string };

type AnyQueue = Queue<ScoringJobData, unknown, string>;

let scoringQueue: AnyQueue | null = null;

const redisConnection = () => ({
  host: new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').hostname,
  port: Number(new URL(process.env.REDIS_URL ?? 'redis://localhost:6379').port || 6379),
});

export function getScoringQueue(_app: FastifyInstance): AnyQueue {
  if (!scoringQueue) {
    scoringQueue = new Queue<ScoringJobData>('scoring', {
      connection: redisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    }) as AnyQueue;
  }
  return scoringQueue;
}

/**
 * Enqueue a debounced compute job.
 * Uses jobId deduplication so rapid entries collapse into one recompute.
 */
export async function enqueueCompute(
  app: FastifyInstance,
  eventId: string,
): Promise<void> {
  const queue = getScoringQueue(app);
  await queue.add(
    'compute',
    { type: 'compute', eventId },
    {
      jobId: `compute:${eventId}`,
      delay: 500, // debounce: wait 500 ms after the last entry
    },
  );
}

/**
 * Start the scoring worker (call once on server startup).
 * TODO: implement processCompute and processPublish handlers.
 */
export function startScoringWorker(app: FastifyInstance): Worker<ScoringJobData> {
  const worker = new Worker<ScoringJobData>(
    'scoring',
    async (job) => {
      // TODO: implement job processing
      switch (job.data.type) {
        case 'compute':
          // TODO: load time_entries → scoring-engine → upsert results
          app.log.info({ eventId: job.data.eventId }, 'Scoring compute — TODO');
          break;
        case 'publish':
          // TODO: set published_at, broadcast via redis pub/sub
          app.log.info({ eventId: job.data.eventId }, 'Scoring publish — TODO');
          break;
      }
    },
    {
      connection: redisConnection(),
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    app.log.error({ job: job?.id, err }, 'Scoring worker job failed');
  });

  return worker;
}
