/**
 * routes/results.ts — Results / rankings routes
 *
 * Endpoints:
 *   GET  /events/:slug/results          — full results list (JSON or CSV)
 *   GET  /events/:slug/results/pdf      — print-ready HTML results page
 *   POST /events/:slug/results/recompute — immediately enqueue compute job
 *
 * Auth:
 *   GET results  — PUBLIC for active/finished events; owner/admin also see draft results
 *   GET pdf      — veranstalter / kommissar / admin
 *   POST recompute — veranstalter / kommissar / admin
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getScoringQueue } from '../services/scoring/index.js';
import { broadcast } from '../ws/hub.js';

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const ResultsQuerySchema = z.object({
  class:  z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

// ---------------------------------------------------------------------------
// DB row shape returned by the JOIN query
// ---------------------------------------------------------------------------

interface ResultRow {
  // from results table
  id:               string;
  event_id:         string;
  participant_id:   string;
  computed_at:      string;
  actual_time_ms:   string | number | null;
  target_time_ms:   string | number | null;
  deviation_ms:     string | number | null;
  penalty_points:   string | number | null;
  total_time_ms:    string | number | null;
  best_lap_ms:      string | number | null;
  lap_count:        number | null;
  gap_to_leader_ms: string | number | null;
  rank_overall:     number;
  rank_in_class:    number | null;
  class:            string | null;
  scoring_detail:   unknown;
  is_dnf:           boolean | null;
  // from participants table (joined)
  startnummer:      string;
  driver_name:      string;
  co_driver_name:   string | null;
  car_make:         string | null;
  car_model:        string | null;
}

interface EventRow {
  id:         string;
  slug:       string;
  name:       string;
  format:     string;
  status:     string;
  starts_at:  string | number;
  owner_id:   string;
}

// ---------------------------------------------------------------------------
// Serialise one result row to a plain object
// ---------------------------------------------------------------------------

function serialiseResult(row: ResultRow): Record<string, unknown> {
  return {
    rank_overall:     row.rank_overall,
    rank_in_class:    row.rank_in_class ?? null,
    startnummer:      row.startnummer,
    driver_name:      row.driver_name,
    co_driver_name:   row.co_driver_name ?? null,
    car_make:         row.car_make ?? null,
    car_model:        row.car_model ?? null,
    class:            row.class ?? null,
    total_time_ms:    row.total_time_ms != null ? Number(row.total_time_ms) : null,
    best_lap_ms:      row.best_lap_ms != null ? Number(row.best_lap_ms) : null,
    actual_time_ms:   row.actual_time_ms != null ? Number(row.actual_time_ms) : null,
    deviation_ms:     row.deviation_ms != null ? Number(row.deviation_ms) : null,
    penalty_points:   row.penalty_points != null ? Number(row.penalty_points) : null,
    gap_to_leader_ms: row.gap_to_leader_ms != null ? Number(row.gap_to_leader_ms) : null,
    lap_count:        row.lap_count ?? null,
    is_dnf:           row.is_dnf ?? false,
    scoring_detail:   row.scoring_detail ?? null,
  };
}

// ---------------------------------------------------------------------------
// Format milliseconds as MM:SS.mmm
// ---------------------------------------------------------------------------

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '';
  const sign = ms < 0 ? '-' : '';
  const abs  = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const millis  = abs % 1_000;
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Build CSV content (format-specific headers + rows)
// ---------------------------------------------------------------------------

function buildCsv(format: string, rows: ResultRow[]): string {
  const escape = (v: unknown): string => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const line = (...cols: unknown[]): string => cols.map(escape).join(',');

  let header: string;
  const dataLines: string[] = [];

  switch (format) {
    case 'glp': {
      header = line('Rang', 'Startnr', 'Fahrer', 'Beifahrer', 'Fahrzeug', 'Klasse', 'Istzeit', 'Sollzeit', 'Abweichung', 'Strafpunkte');
      for (const r of rows) {
        const fahrzeug = [r.car_make, r.car_model].filter(Boolean).join(' ');
        dataLines.push(line(
          r.rank_overall,
          r.startnummer,
          r.driver_name,
          r.co_driver_name ?? '',
          fahrzeug,
          r.class ?? '',
          formatMs(r.actual_time_ms != null ? Number(r.actual_time_ms) : null),
          formatMs(r.target_time_ms != null ? Number(r.target_time_ms) : null),
          formatMs(r.deviation_ms  != null ? Number(r.deviation_ms)   : null),
          r.penalty_points != null ? Number(r.penalty_points) : '',
        ));
      }
      break;
    }

    case 'sonderpruefung': {
      header = line('Rang', 'Startnr', 'Fahrer', 'Beifahrer', 'Fahrzeug', 'Klasse', 'Gesamtzeit', 'Abstand');
      for (const r of rows) {
        const fahrzeug = [r.car_make, r.car_model].filter(Boolean).join(' ');
        dataLines.push(line(
          r.rank_overall,
          r.startnummer,
          r.driver_name,
          r.co_driver_name ?? '',
          fahrzeug,
          r.class ?? '',
          formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null),
          formatMs(r.gap_to_leader_ms != null ? Number(r.gap_to_leader_ms) : null),
        ));
      }
      break;
    }

    case 'rundstrecke': {
      header = line('Rang', 'Startnr', 'Fahrer', 'Klasse', 'Runden', 'Bestzeit', 'Gesamtzeit');
      for (const r of rows) {
        dataLines.push(line(
          r.rank_overall,
          r.startnummer,
          r.driver_name,
          r.class ?? '',
          r.lap_count ?? '',
          formatMs(r.best_lap_ms  != null ? Number(r.best_lap_ms)  : null),
          formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null),
        ));
      }
      break;
    }

    case 'orientierung': {
      header = line('Rang', 'Startnr', 'Fahrer', 'Klasse', 'Strafpunkte');
      for (const r of rows) {
        dataLines.push(line(
          r.rank_overall,
          r.startnummer,
          r.driver_name,
          r.class ?? '',
          r.penalty_points != null ? Number(r.penalty_points) : '',
        ));
      }
      break;
    }

    default: {
      // Fallback: generic
      header = line('Rang', 'Startnr', 'Fahrer', 'Beifahrer', 'Fahrzeug', 'Klasse', 'Gesamtzeit', 'Abstand');
      for (const r of rows) {
        const fahrzeug = [r.car_make, r.car_model].filter(Boolean).join(' ');
        dataLines.push(line(
          r.rank_overall,
          r.startnummer,
          r.driver_name,
          r.co_driver_name ?? '',
          fahrzeug,
          r.class ?? '',
          formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null),
          formatMs(r.gap_to_leader_ms != null ? Number(r.gap_to_leader_ms) : null),
        ));
      }
    }
  }

  return [header, ...dataLines].join('\r\n');
}

// ---------------------------------------------------------------------------
// Build print-ready HTML
// ---------------------------------------------------------------------------

function buildPrintHtml(event: EventRow, rows: ResultRow[]): string {
  const eventDate = new Date(Number(event.starts_at)).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const formatLabel: Record<string, string> = {
    glp:            'Gleichmäßigkeitsprüfung',
    sonderpruefung: 'Sonderprüfung',
    rundstrecke:    'Rundstrecke',
    orientierung:   'Orientierungsfahrt',
  };
  const formatName = formatLabel[event.format] ?? event.format;

  const buildTableHeaders = (): string => {
    switch (event.format) {
      case 'glp':
        return '<tr><th>Rang</th><th>Startnr</th><th>Fahrer / Beifahrer</th><th>Fahrzeug</th><th>Klasse</th><th>Istzeit</th><th>Sollzeit</th><th>Abweichung</th><th>Strafpunkte</th></tr>';
      case 'rundstrecke':
        return '<tr><th>Rang</th><th>Startnr</th><th>Fahrer</th><th>Klasse</th><th>Runden</th><th>Bestzeit</th><th>Gesamtzeit</th></tr>';
      case 'orientierung':
        return '<tr><th>Rang</th><th>Startnr</th><th>Fahrer</th><th>Klasse</th><th>Strafpunkte</th></tr>';
      default: // sonderpruefung + fallback
        return '<tr><th>Rang</th><th>Startnr</th><th>Fahrer / Beifahrer</th><th>Fahrzeug</th><th>Klasse</th><th>Gesamtzeit</th><th>Abstand</th></tr>';
    }
  };

  const buildTableRow = (r: ResultRow): string => {
    const fahrzeug = [r.car_make, r.car_model].filter(Boolean).join(' ');
    const crew = r.co_driver_name ? `${r.driver_name}<br><small>${r.co_driver_name}</small>` : r.driver_name;
    const dnfBadge = r.is_dnf ? ' <span class="dnf">DNF</span>' : '';

    switch (event.format) {
      case 'glp':
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${crew}</td>
          <td>${fahrzeug}</td>
          <td>${r.class ?? ''}</td>
          <td>${formatMs(r.actual_time_ms != null ? Number(r.actual_time_ms) : null)}</td>
          <td>${formatMs(r.target_time_ms != null ? Number(r.target_time_ms) : null)}</td>
          <td>${formatMs(r.deviation_ms != null ? Number(r.deviation_ms) : null)}</td>
          <td>${r.penalty_points != null ? Number(r.penalty_points) : ''}</td>
        </tr>`;
      case 'rundstrecke':
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${r.driver_name}</td>
          <td>${r.class ?? ''}</td>
          <td>${r.lap_count ?? ''}</td>
          <td>${formatMs(r.best_lap_ms != null ? Number(r.best_lap_ms) : null)}</td>
          <td>${formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null)}</td>
        </tr>`;
      case 'orientierung':
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${r.driver_name}</td>
          <td>${r.class ?? ''}</td>
          <td>${r.penalty_points != null ? Number(r.penalty_points) : ''}</td>
        </tr>`;
      default:
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${crew}</td>
          <td>${fahrzeug}</td>
          <td>${r.class ?? ''}</td>
          <td>${formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null)}</td>
          <td>${r.gap_to_leader_ms != null && Number(r.gap_to_leader_ms) > 0 ? '+' + formatMs(Number(r.gap_to_leader_ms)) : formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null)}</td>
        </tr>`;
    }
  };

  const tableRows = rows.map(buildTableRow).join('\n');

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ergebnisse — ${event.name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11pt;
      color: #000;
      background: #fff;
      padding: 20mm 15mm;
    }
    header {
      border-bottom: 2px solid #000;
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    header h1 { font-size: 18pt; margin-bottom: 4px; }
    header .meta { font-size: 10pt; color: #555; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    th {
      background: #222;
      color: #fff;
      font-weight: bold;
      padding: 6px 8px;
      text-align: left;
      font-size: 10pt;
    }
    td {
      padding: 5px 8px;
      border-bottom: 1px solid #e0e0e0;
      font-size: 10pt;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #f7f7f7; }
    tr.dnf-row td { color: #888; }
    .dnf {
      display: inline-block;
      background: #d32f2f;
      color: #fff;
      font-size: 8pt;
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: 4px;
    }
    footer {
      margin-top: 20px;
      font-size: 9pt;
      color: #888;
      border-top: 1px solid #ccc;
      padding-top: 6px;
    }
    @media print {
      body { padding: 0; }
      @page { margin: 15mm; }
      th { background: #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${event.name}</h1>
    <div class="meta">
      Disziplin: ${formatName} &nbsp;|&nbsp;
      Datum: ${eventDate} &nbsp;|&nbsp;
      ${rows.length} Teilnehmer
    </div>
  </header>
  <table>
    <thead>
      ${buildTableHeaders()}
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
  <footer>
    Ergebnisliste generiert am ${new Date().toLocaleString('de-DE')} &mdash; Timing Hub
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function resultsRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // GET /events/:slug/results
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/results',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply,
    ) => {
      const queryParse = ResultsQuerySchema.safeParse(request.query);
      if (!queryParse.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid query parameters',
          issues: queryParse.error.flatten().fieldErrors,
        });
      }

      const q = queryParse.data;
      const slug = request.params.slug;

      // Fetch event
      const eventRows = await app.db<EventRow[]>`
        SELECT id, slug, name, format, status, starts_at, owner_id
        FROM events
        WHERE slug = ${slug}
        LIMIT 1
      `;

      if (eventRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Event not found',
        });
      }

      const event = eventRows[0]!;

      // Auth gate: draft results only visible to owner/admin
      const isPublicStatus = event.status === 'active' || event.status === 'finished';

      if (!isPublicStatus) {
        // Require valid JWT with organizer/admin role, or be the event owner
        let authorized = false;
        try {
          await request.jwtVerify();
          const role = request.user.role;
          if (role === 'admin' || role === 'organizer') {
            authorized = true;
          }
        } catch {
          // no valid JWT
        }

        if (!authorized) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Results for this event are not yet public',
          });
        }
      }

      // Fetch results JOIN participants, filtered by class if requested
      const rows = await app.db<ResultRow[]>`
        SELECT
          r.id,
          r.event_id,
          r.participant_id,
          r.computed_at,
          r.actual_time_ms,
          r.target_time_ms,
          r.deviation_ms,
          r.penalty_points,
          r.total_time_ms,
          r.best_lap_ms,
          r.lap_count,
          r.gap_to_leader_ms,
          r.rank_overall,
          r.rank_in_class,
          r.class,
          r.scoring_detail,
          r.is_dnf,
          p.startnummer,
          p.driver_name,
          p.co_driver_name,
          p.car_make,
          p.car_model
        FROM results r
        JOIN participants p ON p.id = r.participant_id
        WHERE r.event_id = ${event.id}
          ${q.class ? app.db`AND r.class = ${q.class}` : app.db``}
        ORDER BY r.rank_overall ASC
      `;

      // Latest computed_at
      const computed_at = rows.length > 0 ? rows[0]!.computed_at : null;

      if (q.format === 'csv') {
        const csvContent = buildCsv(event.format, rows);
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="ergebnisse-${slug}.csv"`)
          .send(csvContent);
      }

      // JSON
      return reply.send({
        results: rows.map(serialiseResult),
        event: {
          slug:   event.slug,
          name:   event.name,
          format: event.format,
          status: event.status,
        },
        computed_at: computed_at ?? null,
        total: rows.length,
      });
    },
  );

  // =========================================================================
  // GET /events/:slug/results/pdf — print-ready HTML
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/results/pdf',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply,
    ) => {
      // Auth: organizer / admin
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid or expired token',
        });
      }

      const allowedRoles = ['admin', 'organizer'];
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Required role: organizer or admin',
        });
      }

      const slug = request.params.slug;

      const eventRows = await app.db<EventRow[]>`
        SELECT id, slug, name, format, status, starts_at, owner_id
        FROM events
        WHERE slug = ${slug}
        LIMIT 1
      `;

      if (eventRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Event not found',
        });
      }

      const event = eventRows[0]!;

      const rows = await app.db<ResultRow[]>`
        SELECT
          r.id,
          r.event_id,
          r.participant_id,
          r.computed_at,
          r.actual_time_ms,
          r.target_time_ms,
          r.deviation_ms,
          r.penalty_points,
          r.total_time_ms,
          r.best_lap_ms,
          r.lap_count,
          r.gap_to_leader_ms,
          r.rank_overall,
          r.rank_in_class,
          r.class,
          r.scoring_detail,
          r.is_dnf,
          p.startnummer,
          p.driver_name,
          p.co_driver_name,
          p.car_make,
          p.car_model
        FROM results r
        JOIN participants p ON p.id = r.participant_id
        WHERE r.event_id = ${event.id}
        ORDER BY r.rank_overall ASC
      `;

      const html = buildPrintHtml(event, rows);

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(html);
    },
  );

  // =========================================================================
  // POST /events/:slug/results/recompute — bypass debounce, enqueue immediately
  // =========================================================================
  app.post<{ Params: { slug: string } }>(
    '/events/:slug/results/recompute',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply,
    ) => {
      // Auth: organizer / admin
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid or expired token',
        });
      }

      const allowedRoles = ['admin', 'organizer'];
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Required role: organizer or admin',
        });
      }

      const slug = request.params.slug;

      const eventRows = await app.db<{ id: string; slug: string }[]>`
        SELECT id, slug FROM events WHERE slug = ${slug} LIMIT 1
      `;

      if (eventRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Event not found',
        });
      }

      const event = eventRows[0]!;

      // Enqueue immediately (no delay, unique job id with timestamp to bypass debounce)
      const queue = getScoringQueue(app);
      const jobId = `compute:${event.id}:force:${Date.now()}`;

      const job = await queue.add(
        'compute',
        { type: 'compute', eventId: event.id },
        {
          jobId,
          delay: 0,
        },
      );

      app.log.info(
        { eventId: event.id, slug, jobId: job.id, actor: request.user.sub },
        'Results recompute enqueued (forced)',
      );

      // Notify WS subscribers that a recompute is in progress
      broadcast(app, slug, {
        type:       'results_recomputing',
        event_slug: slug,
      }).catch((err: unknown) =>
        app.log.warn({ err }, 'WS broadcast results_recomputing failed'),
      );

      return reply.status(202).send({
        queued: true,
        job_id: job.id,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Export — wrap with fastify-plugin for shared decorator scope
// ---------------------------------------------------------------------------

export const resultsRoutes = fp(resultsRoutesFn, {
  name: 'results-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
