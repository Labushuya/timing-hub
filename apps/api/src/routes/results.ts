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

  // Determine page orientation based on participant count
  const isLandscape = rows.length > 30;

  // Column span for class sub-headers
  const colSpan = (): number => {
    switch (event.format) {
      case 'glp':          return 9;
      case 'rundstrecke':  return 7;
      case 'orientierung': return 5;
      default:             return 7; // sonderpruefung + fallback
    }
  };

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
          <td class="mono">${formatMs(r.actual_time_ms != null ? Number(r.actual_time_ms) : null)}</td>
          <td class="mono">${formatMs(r.target_time_ms != null ? Number(r.target_time_ms) : null)}</td>
          <td class="mono">${formatMs(r.deviation_ms != null ? Number(r.deviation_ms) : null)}</td>
          <td class="num">${r.penalty_points != null ? Number(r.penalty_points) : ''}</td>
        </tr>`;
      case 'rundstrecke':
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${r.driver_name}</td>
          <td>${r.class ?? ''}</td>
          <td class="num">${r.lap_count ?? ''}</td>
          <td class="mono">${formatMs(r.best_lap_ms != null ? Number(r.best_lap_ms) : null)}</td>
          <td class="mono">${formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null)}</td>
        </tr>`;
      case 'orientierung':
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${r.driver_name}</td>
          <td>${r.class ?? ''}</td>
          <td class="num">${r.penalty_points != null ? Number(r.penalty_points) : ''}</td>
        </tr>`;
      default:
        return `<tr${r.is_dnf ? ' class="dnf-row"' : ''}>
          <td>${r.rank_overall}${dnfBadge}</td>
          <td>${r.startnummer}</td>
          <td>${crew}</td>
          <td>${fahrzeug}</td>
          <td>${r.class ?? ''}</td>
          <td class="mono">${formatMs(r.total_time_ms != null ? Number(r.total_time_ms) : null)}</td>
          <td class="mono">${r.gap_to_leader_ms != null && Number(r.gap_to_leader_ms) > 0 ? '+' + formatMs(Number(r.gap_to_leader_ms)) : (r.rank_overall === 1 ? '—' : formatMs(r.gap_to_leader_ms != null ? Number(r.gap_to_leader_ms) : null))}</td>
        </tr>`;
    }
  };

  // Group rows by class and insert class sub-headers
  const buildTableBody = (): string => {
    // Collect unique classes in the order they first appear
    const classes: string[] = [];
    const byClass = new Map<string, ResultRow[]>();

    for (const r of rows) {
      const cls = r.class ?? '—';
      if (!byClass.has(cls)) {
        classes.push(cls);
        byClass.set(cls, []);
      }
      byClass.get(cls)!.push(r);
    }

    // Single class or no class info — no sub-headers needed
    if (classes.length <= 1) {
      return rows.map(buildTableRow).join('\n');
    }

    const parts: string[] = [];
    for (const cls of classes) {
      const clsRows = byClass.get(cls)!;
      parts.push(`<tr class="class-header"><td colspan="${colSpan()}">Klasse: ${cls} &mdash; ${clsRows.length} Teilnehmer</td></tr>`);
      parts.push(...clsRows.map(buildTableRow));
    }
    return parts.join('\n');
  };

  const printDate = new Date().toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

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
      font-size: 10.5pt;
      color: #000;
      background: #fff;
      padding: 12mm 14mm 10mm;
    }

    /* ---- Page header ---- */
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      border-bottom: 2px solid #000;
      padding-bottom: 8px;
      margin-bottom: 14px;
      gap: 16px;
    }

    .event-logo-placeholder {
      width: 52px;
      height: 52px;
      border: 1.5px solid #bbb;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 7pt;
      color: #aaa;
      text-align: center;
      flex-shrink: 0;
      line-height: 1.3;
    }

    .event-info { flex: 1; }
    .event-title { font-size: 17pt; font-weight: bold; margin-bottom: 3px; }
    .event-meta  { font-size: 9.5pt; color: #444; line-height: 1.6; }
    .event-meta span + span::before { content: ' · '; }

    /* ---- Table ---- */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
    }

    thead th {
      background: #1a1a1a;
      color: #fff;
      font-weight: bold;
      padding: 5px 7px;
      text-align: left;
      font-size: 9pt;
      border: 1px solid #1a1a1a;
    }

    td {
      padding: 4px 7px;
      border: 1px solid #d8d8d8;
      font-size: 9.5pt;
      vertical-align: top;
    }

    tbody tr:nth-child(even) td { background: #f5f5f5; }
    tbody tr:nth-child(odd)  td { background: #fff; }

    tr.class-header td {
      background: #e8e8e8 !important;
      font-weight: 700;
      font-size: 9pt;
      letter-spacing: 0.02em;
      border-top: 2px solid #555;
      border-bottom: 2px solid #555;
      padding: 4px 7px;
    }

    tr.dnf-row td { color: #888; }

    .dnf {
      display: inline-block;
      border: 1px solid #888;
      color: #666;
      font-size: 7pt;
      padding: 0 3px;
      border-radius: 2px;
      margin-left: 3px;
      font-weight: bold;
    }

    .mono { font-variant-numeric: tabular-nums; font-family: 'Courier New', monospace; font-size: 9pt; }
    .num  { text-align: right; font-variant-numeric: tabular-nums; }

    /* ---- Page footer ---- */
    .page-footer {
      margin-top: 14px;
      font-size: 8.5pt;
      color: #888;
      border-top: 1px solid #ccc;
      padding-top: 5px;
      display: flex;
      justify-content: space-between;
    }

    /* ---- Print styles ---- */
    @media print {
      body { padding: 0; }

      @page {
        size: A4 ${isLandscape ? 'landscape' : 'portrait'};
        margin: 12mm 14mm 10mm;
      }

      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }

      tbody tr { break-inside: avoid; }

      tr.class-header { break-before: auto; }

      thead th {
        background: #1a1a1a !important;
        color: #fff !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      tr.class-header td {
        background: #e8e8e8 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      tbody tr:nth-child(even) td {
        background: #f5f5f5 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .page-footer { position: fixed; bottom: 0; left: 0; right: 0; }
    }
  </style>
</head>
<body>

  <div class="page-header">
    <div class="event-logo-placeholder">Logo</div>
    <div class="event-info">
      <div class="event-title">${event.name}</div>
      <div class="event-meta">
        <span>Disziplin: ${formatName}</span>
        <span>Datum: ${eventDate}</span>
        <span>${rows.length} Teilnehmer</span>
      </div>
    </div>
  </div>

  <table>
    <thead>
      ${buildTableHeaders()}
    </thead>
    <tbody>
      ${buildTableBody()}
    </tbody>
  </table>

  <div class="page-footer">
    <span>Erstellt mit Timing Hub &middot; timinghub.de &middot; ${printDate}</span>
    <span>Ergebnisse vom ${new Date().toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
  </div>

  <script>
    setTimeout(function () { window.print(); }, 500);
  <\/script>
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
