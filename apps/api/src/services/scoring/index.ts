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
import { createHash } from 'node:crypto';
import { computeResults } from '@timing-hub/scoring-engine';
import type { ScoringInput, ExtendedScoringInput, PostenWithOrder, SectionTarget } from '@timing-hub/scoring-engine';
import type { TimeEntry, Participant, EventConfig, GLPConfig } from '@timing-hub/shared-types';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic UUID v4-shaped ID derived from event_id + participant_id.
 * Ensures the results row always gets the same id across recomputes,
 * avoiding ghost rows when the ON CONFLICT path is not hit on first insert.
 */
function resultId(eventId: string, participantId: string): string {
  const hash = createHash('sha256').update(`${eventId}:${participantId}`).digest('hex');
  // Shape as UUID v4 (variant 2, version 4 bits set for readability)
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(parseInt(hash[16]!, 16) & 0x3 | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// DB row shapes (internal — not exported)
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  slug: string;
  format: string;
  status: string;
  config: EventConfig;
}

interface TimeEntryRow {
  id: string;
  event_id: string;
  posten_id: string;
  participant_id: string | null;
  startnummer: string | null;
  source: string;
  raw_timestamp_ms: string | number;
  server_recv_ms: string | number;
  lap_number: number | null;
  sector_number: number | null;
  channel: string | null;
  is_confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  is_void: boolean;
  void_reason: string | null;
  client_seq: string | null;
  created_at: string;
  updated_at: string;
  // joined from posten
  posten_role: string;
}

interface ParticipantRow {
  id: string;
  event_id: string;
  startnummer: string;
  driver_name: string;
  co_driver_name: string | null;
  car_make: string | null;
  car_model: string | null;
  car_year: number | null;
  class: string | null;
  target_time_ms: string | number | null;
  seed_time_ms: string | number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PostenRow {
  id: string;
  code: string;
  role: string;
  sort_order: number;
}

interface SectionTargetRow {
  from_posten_id: string | null;
  to_posten_id: string | null;
  class: string | null;
  target_time_ms: string | number;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapTimeEntryRow(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    event_id: row.event_id,
    posten_id: row.posten_id,
    source: row.source as TimeEntry['source'],
    raw_timestamp_ms: Number(row.raw_timestamp_ms),
    server_recv_ms: Number(row.server_recv_ms),
    is_confirmed: row.is_confirmed,
    is_void: row.is_void,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.participant_id != null ? { participant_id: row.participant_id } : {}),
    ...(row.startnummer    != null ? { startnummer:    row.startnummer }    : {}),
    ...(row.lap_number     != null ? { lap_number:     row.lap_number }     : {}),
    ...(row.sector_number  != null ? { sector_number:  row.sector_number }  : {}),
    ...(row.channel        != null ? { channel:        row.channel }        : {}),
    ...(row.confirmed_by   != null ? { confirmed_by:   row.confirmed_by }   : {}),
    ...(row.confirmed_at   != null ? { confirmed_at:   row.confirmed_at }   : {}),
    ...(row.void_reason    != null ? { void_reason:    row.void_reason }    : {}),
    ...(row.client_seq     != null ? { client_seq:     row.client_seq }     : {}),
  };
}

function mapParticipantRow(row: ParticipantRow): Participant {
  return {
    id: row.id,
    event_id: row.event_id,
    startnummer: row.startnummer,
    driver_name: row.driver_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.co_driver_name   != null ? { co_driver_name:  row.co_driver_name }                            : {}),
    ...(row.car_make         != null ? { car_make:        row.car_make }                                  : {}),
    ...(row.car_model        != null ? { car_model:       row.car_model }                                 : {}),
    ...(row.car_year         != null ? { car_year:        row.car_year }                                  : {}),
    ...(row.class            != null ? { class:           row.class }                                     : {}),
    ...(row.target_time_ms   != null ? { target_time_ms:  Number(row.target_time_ms) }                    : {}),
    ...(row.seed_time_ms     != null ? { seed_time_ms:    Number(row.seed_time_ms) }                      : {}),
    ...(row.notes            != null ? { notes:           row.notes }                                     : {}),
  };
}

// ---------------------------------------------------------------------------
// Core compute handler
// ---------------------------------------------------------------------------

async function processCompute(app: FastifyInstance, eventId: string): Promise<void> {
  const db = app.db;

  // 1. Load event
  const eventRows = await db<EventRow[]>`
    SELECT id, slug, format, status, config
    FROM events
    WHERE id = ${eventId}
    LIMIT 1
  `;
  if (eventRows.length === 0) {
    app.log.warn({ eventId }, 'Scoring compute: event not found, skipping');
    return;
  }
  const event = eventRows[0]!;

  // 2. Load confirmed, non-void time entries with posten role via JOIN
  const entryRows = await db<TimeEntryRow[]>`
    SELECT
      te.id,
      te.event_id,
      te.posten_id,
      te.participant_id,
      te.startnummer,
      te.source,
      te.raw_timestamp_ms,
      te.server_recv_ms,
      te.lap_number,
      te.sector_number,
      te.channel,
      te.is_confirmed,
      te.confirmed_by,
      te.confirmed_at,
      te.is_void,
      te.void_reason,
      te.client_seq,
      te.created_at,
      te.updated_at,
      p.role AS posten_role
    FROM time_entries te
    JOIN posten p ON p.id = te.posten_id
    WHERE te.event_id = ${eventId}
      AND te.is_confirmed = true
      AND te.is_void = false
    ORDER BY te.raw_timestamp_ms ASC
  `;

  // 3. Load participants
  const participantRows = await db<ParticipantRow[]>`
    SELECT
      id, event_id, startnummer, driver_name, co_driver_name,
      car_make, car_model, car_year, class, target_time_ms,
      seed_time_ms, notes, created_at, updated_at
    FROM participants
    WHERE event_id = ${eventId}
    ORDER BY startnummer ASC
  `;

  if (participantRows.length === 0) {
    app.log.info({ eventId }, 'Scoring compute: no participants, skipping');
    return;
  }

  // 4. Load posten sorted by sort_order
  const postenRows = await db<PostenRow[]>`
    SELECT id, code, role, sort_order
    FROM posten
    WHERE event_id = ${eventId}
    ORDER BY sort_order ASC
  `;

  // 5. Load section_targets
  const sectionTargetRows = await db<SectionTargetRow[]>`
    SELECT from_posten_id, to_posten_id, class, target_time_ms
    FROM section_targets
    WHERE event_id = ${eventId}
  `;

  // 6. Build ScoringInput (extended for GLP, base for all other formats)
  const entries: TimeEntry[] = entryRows.map(mapTimeEntryRow);
  const participants: Participant[] = participantRows.map(mapParticipantRow);
  const posten: PostenWithOrder[] = postenRows;
  const section_targets: SectionTarget[] = sectionTargetRows.map((r) => ({
    from_posten_id: r.from_posten_id,
    to_posten_id: r.to_posten_id,
    class: r.class,
    target_time_ms: Number(r.target_time_ms),
  }));

  let input: ScoringInput | ExtendedScoringInput;

  if (event.format === 'glp') {
    const glpConfig = event.config as GLPConfig;
    // Map GLPConfig.run_scoring ('best_n_of_m') → ExtendedScoringInput ('best_of_n')
    const rawRunScoring = glpConfig.run_scoring ?? 'sum';
    const run_scoring: ExtendedScoringInput['run_scoring'] =
      rawRunScoring === 'best_n_of_m' ? 'best_of_n' : rawRunScoring;

    const extInput: ExtendedScoringInput = {
      entries,
      participants,
      config: event.config,
      posten,
      section_targets,
      run_scoring,
      hide_target_times: glpConfig.hide_target_times ?? false,
      ...(run_scoring === 'best_of_n' && glpConfig.run_best_n != null
        ? { run_scoring_n: glpConfig.run_best_n }
        : {}),
    };
    input = extInput;
  } else {
    input = { entries, participants, config: event.config };
  }

  // 7. Compute results
  const scoringResult = computeResults(input);

  // 8. Upsert results into the results table
  const now = new Date().toISOString();

  for (const result of scoringResult.results) {
    const rid = resultId(eventId, result.participant_id);
    await db`
      INSERT INTO results (
        id,
        event_id,
        participant_id,
        computed_at,
        actual_time_ms,
        target_time_ms,
        deviation_ms,
        penalty_points,
        total_time_ms,
        best_lap_ms,
        lap_count,
        gap_to_leader_ms,
        section_times,
        rank_overall,
        rank_in_class,
        class,
        scoring_detail
      ) VALUES (
        ${rid},
        ${eventId},
        ${result.participant_id},
        ${now},
        ${result.actual_time_ms ?? null},
        ${result.target_time_ms ?? null},
        ${result.deviation_ms ?? null},
        ${result.penalty_points ?? null},
        ${result.total_time_ms ?? null},
        ${result.best_lap_ms ?? null},
        ${result.lap_count ?? null},
        ${result.gap_to_leader_ms ?? null},
        ${result.section_times ? db.json(result.section_times) : null},
        ${result.rank_overall},
        ${result.rank_in_class ?? null},
        ${result.class ?? null},
        ${db.json(result.scoring_detail as import('postgres').JSONValue)}
      )
      ON CONFLICT (event_id, participant_id) DO UPDATE SET
        computed_at      = EXCLUDED.computed_at,
        actual_time_ms   = EXCLUDED.actual_time_ms,
        target_time_ms   = EXCLUDED.target_time_ms,
        deviation_ms     = EXCLUDED.deviation_ms,
        penalty_points   = EXCLUDED.penalty_points,
        total_time_ms    = EXCLUDED.total_time_ms,
        best_lap_ms      = EXCLUDED.best_lap_ms,
        lap_count        = EXCLUDED.lap_count,
        gap_to_leader_ms = EXCLUDED.gap_to_leader_ms,
        section_times    = EXCLUDED.section_times,
        rank_overall     = EXCLUDED.rank_overall,
        rank_in_class    = EXCLUDED.rank_in_class,
        class            = EXCLUDED.class,
        scoring_detail   = EXCLUDED.scoring_detail
    `;
  }

  app.log.info(
    { eventId, slug: event.slug, resultCount: scoringResult.results.length },
    'Scoring compute: results upserted',
  );

  // 9. Publish results_update to Redis channel event:{slug}
  await app.redis.publish(
    `event:${event.slug}`,
    JSON.stringify({
      type: 'results_update',
      event_slug: event.slug,
      results: scoringResult.results,
      computed_at: scoringResult.computed_at,
    }),
  );

  app.log.info({ eventId, slug: event.slug }, 'Scoring compute: results_update published');
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Start the scoring worker (call once on server startup).
 * Returns the Worker instance for lifecycle management.
 */
export function startScoringWorker(app: FastifyInstance): Worker<ScoringJobData> {
  const worker = new Worker<ScoringJobData>(
    'scoring',
    async (job) => {
      switch (job.data.type) {
        case 'compute':
          await processCompute(app, job.data.eventId);
          break;
        case 'publish':
          // publish jobs are handled elsewhere (results route)
          app.log.info({ eventId: job.data.eventId }, 'Scoring publish — no-op in worker');
          break;
      }
    },
    {
      connection: redisConnection(),
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    app.log.info({ jobId: job.id, type: job.data.type }, 'Scoring worker job completed');
  });

  worker.on('failed', (job, err) => {
    app.log.error({ jobId: job?.id, type: job?.data?.type, err }, 'Scoring worker job failed');
  });

  worker.on('error', (err) => {
    app.log.error({ err }, 'Scoring worker error');
  });

  app.log.info('Scoring worker started');

  return worker;
}
