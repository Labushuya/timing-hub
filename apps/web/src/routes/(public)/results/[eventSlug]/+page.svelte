<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { wsStore } from '$lib/stores/ws.svelte.js';
  import ConnectionStatus from '$lib/components/ui/ConnectionStatus.svelte';

  // ---- Types -----------------------------------------------------------------

  type EventFormat = 'GLP' | 'SP' | 'Rundstrecke' | 'Orientierung';
  type EventStatus = 'upcoming' | 'active' | 'finished';

  interface EventInfo {
    name: string;
    slug: string;
    format: EventFormat;
    status: EventStatus;
    classes: string[];
  }

  interface ResultEntry {
    rank: number;
    startnummer: number;
    driver_name: string;
    co_driver_name?: string;
    class: string;
    // GLP
    actual_time_ms?: number | null;
    actual_time_display?: string;
    target_time_ms?: number | null;
    target_time_display?: string;
    deviation_ms?: number | null;
    deviation_display?: string;
    penalty_points?: number | null;
    // SP
    total_time_ms?: number | null;
    total_time_display?: string;
    gap_ms?: number | null;
    gap_display?: string;
    // Rundstrecke
    laps?: number | null;
    best_lap_ms?: number | null;
    best_lap_display?: string;
    // Common
    dns: boolean;
    dnf: boolean;
  }

  interface ResultsPayload {
    event: EventInfo | null;
    results: ResultEntry[];
    computed_at: string | null;
  }

  // ---- Props (from +page.ts load) -------------------------------------------

  let { data } = $props<{ data: ResultsPayload }>();

  // ---- State -----------------------------------------------------------------

  const eventSlug = $derived($page.params['eventSlug'] ?? '');

  let eventInfo = $state<EventInfo | null>(data.event ?? null);
  let entries = $state<ResultEntry[]>(data.results ?? []);
  let loading = $state(data.results.length === 0 && !data.event);
  let error = $state<string | null>(null);
  let selectedClass = $state<string>('all');
  let lastUpdated = $state<Date | null>(
    data.computed_at ? new Date(data.computed_at) : null
  );
  let shareSuccess = $state(false);

  const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

  // ---- Derived ---------------------------------------------------------------

  const filteredEntries = $derived(
    selectedClass === 'all'
      ? entries
      : entries.filter((e) => e.class === selectedClass)
  );

  const wsStatus = $derived(wsStore.status);
  const isLive = $derived(wsStatus === 'connected');
  const allClasses = $derived(eventInfo?.classes ?? []);
  const format = $derived(eventInfo?.format ?? 'SP');

  // Format label map
  const FORMAT_LABELS: Record<string, string> = {
    GLP: 'Gleichmassigkeitsprufung',
    SP: 'Sonderprufung',
    Rundstrecke: 'Rundstrecke',
    Orientierung: 'Orientierungsfahrt'
  };

  // ---- Data fetching ---------------------------------------------------------

  async function fetchResults() {
    try {
      loading = true;
      error = null;
      const res = await fetch(`${API_BASE}/v1/events/${encodeURIComponent(eventSlug)}/results`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload: ResultsPayload = await res.json();
      eventInfo = payload.event;
      entries = payload.results ?? [];
      if (payload.computed_at) lastUpdated = new Date(payload.computed_at);
      else lastUpdated = new Date();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Ergebnisse konnten nicht geladen werden';
    } finally {
      loading = false;
    }
  }

  // ---- WebSocket subscription ------------------------------------------------

  let unsubResults: (() => void) | null = null;

  function setupWsSubscription() {
    wsStore.subscribe(eventSlug);

    unsubResults = wsStore.onMessage('results_update', (msg) => {
      const update = msg as unknown as ResultsPayload;
      if (update.results) {
        entries = update.results;
        lastUpdated = new Date();
      }
      if (update.event) {
        eventInfo = update.event;
      }
    });
  }

  // ---- Lifecycle -------------------------------------------------------------

  onMount(() => {
    // If SSR gave us nothing, fetch client-side
    if (entries.length === 0 && !eventInfo) {
      fetchResults();
    } else {
      loading = false;
    }
    wsStore.connect();
    setupWsSubscription();
  });

  onDestroy(() => {
    unsubResults?.();
    wsStore.unsubscribe(eventSlug);
  });

  // ---- Helpers ---------------------------------------------------------------

  function trophyIcon(rank: number): string {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return String(rank);
  }

  function padTwo(n: number): string {
    return String(Math.floor(n)).padStart(2, '0');
  }

  function msToMinSecMs(ms: number): string {
    const absMs = Math.abs(ms);
    const minutes = Math.floor(absMs / 60000);
    const seconds = Math.floor((absMs % 60000) / 1000);
    const millis = absMs % 1000;
    return `${padTwo(minutes)}:${padTwo(seconds)}.${String(millis).padStart(3, '0')}`;
  }

  function formatDeviation(ms: number | null | undefined): string {
    if (ms == null) return '—';
    if (ms === 0) return '±0:00.000';
    const sign = ms < 0 ? '−' : '+';
    return `${sign}${msToMinSecMs(ms)}`;
  }

  function formatGap(ms: number | null | undefined, rank: number): string {
    if (rank === 1) return '—';
    if (ms == null) return '—';
    return `+${msToMinSecMs(ms)}`;
  }

  function deviationCls(ms: number | null | undefined): string {
    if (ms == null) return '';
    if (ms < 0) return 'dev-faster';
    if (ms > 0) return 'dev-slower';
    return 'dev-zero';
  }

  function displayStatus(entry: ResultEntry): string {
    if (entry.dns) return 'DNS';
    if (entry.dnf) return 'DNF';
    return '';
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      shareSuccess = true;
      setTimeout(() => { shareSuccess = false; }, 2000);
    } catch {
      // fallback: select the URL bar
    }
  }

  function lastUpdatedStr(d: Date): string {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
</script>

<svelte:head>
  <title>{eventInfo?.name ?? 'Ergebnisse'} — Timing Hub</title>
  <meta name="description" content={`Ergebnisse: ${eventInfo?.name ?? ''}`} />
</svelte:head>

<div class="results-page">

  <!-- ===== HEADER ===== -->
  <div class="page-header">
    <div class="page-header-inner">
      <div class="event-info">
        {#if loading && !eventInfo}
          <div class="skeleton" style="width: 220px; height: 28px;"></div>
          <div class="skeleton" style="width: 140px; height: 20px; margin-top: 6px;"></div>
        {:else if eventInfo}
          <h1 class="event-name">{eventInfo.name}</h1>
          <div class="event-meta">
            <span class="format-badge" title={FORMAT_LABELS[eventInfo.format] ?? eventInfo.format}>
              {eventInfo.format}
            </span>
            <span class="status-badge status-{eventInfo.status}">
              {#if eventInfo.status === 'active'}Aktiv
              {:else if eventInfo.status === 'upcoming'}Geplant
              {:else}Abgeschlossen{/if}
            </span>
          </div>
        {/if}
      </div>

      <div class="header-actions">
        {#if isLive && eventInfo?.status === 'active'}
          <div class="live-indicator" aria-label="Live-Updates aktiv">
            <span class="live-dot" aria-hidden="true"></span>
            <span>LIVE</span>
          </div>
        {/if}

        <button
          class="share-btn"
          onclick={copyShareLink}
          title="Link kopieren"
          aria-label="Link in Zwischenablage kopieren"
        >
          {#if shareSuccess}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Kopiert!
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
            Teilen
          {/if}
        </button>

        <ConnectionStatus status={wsStatus} />
      </div>
    </div>
  </div>

  <!-- ===== CLASS FILTER ===== -->
  {#if allClasses.length > 1}
    <div class="class-filter" role="tablist" aria-label="Nach Klasse filtern">
      <button
        class="class-pill"
        class:active={selectedClass === 'all'}
        role="tab"
        aria-selected={selectedClass === 'all'}
        onclick={() => { selectedClass = 'all'; }}
      >
        Alle
      </button>
      {#each allClasses as cls}
        <button
          class="class-pill"
          class:active={selectedClass === cls}
          role="tab"
          aria-selected={selectedClass === cls}
          onclick={() => { selectedClass = cls; }}
        >
          {cls}
        </button>
      {/each}
    </div>
  {/if}

  <!-- ===== ERROR STATE ===== -->
  {#if error}
    <div class="error-state" role="alert">
      <div class="error-icon" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <p class="error-msg">{error}</p>
      <button onclick={fetchResults} class="retry-btn">Erneut versuchen</button>
    </div>

  <!-- ===== LOADING SKELETON ===== -->
  {:else if loading && entries.length === 0}
    <div class="table-wrapper">
      <table class="results-table">
        <thead>
          <tr>
            <th class="col-rank">Rang</th>
            <th class="col-nr">Startnr</th>
            <th class="col-driver">Fahrer</th>
            <th class="col-class hide-xs">Klasse</th>
            <th class="col-time">Zeit</th>
            <th class="col-extra hide-sm">—</th>
          </tr>
        </thead>
        <tbody>
          {#each { length: 8 } as _, i}
            <tr>
              <td><div class="skeleton" style="width: 28px; height: 16px; margin: auto;"></div></td>
              <td><div class="skeleton" style="width: 36px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: {100 + (i * 17) % 80}px; height: 16px;"></div></td>
              <td class="hide-xs"><div class="skeleton" style="width: 56px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: 80px; height: 16px; margin-left: auto;"></div></td>
              <td class="hide-sm"><div class="skeleton" style="width: 64px; height: 16px; margin-left: auto;"></div></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

  <!-- ===== RESULTS TABLE ===== -->
  {:else}
    <div class="table-wrapper">
      {#if filteredEntries.length === 0}
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <h2 class="empty-title">Noch keine Ergebnisse</h2>
          <p class="empty-sub">
            {selectedClass !== 'all'
              ? `Keine Ergebnisse in Klasse "${selectedClass}".`
              : 'Die Ergebnisse werden hier angezeigt, sobald das Rennen beginnt.'}
          </p>
          {#if selectedClass !== 'all'}
            <button class="class-reset-btn" onclick={() => { selectedClass = 'all'; }}>
              Alle Klassen anzeigen
            </button>
          {/if}
        </div>
      {:else}
        <table class="results-table">
          <thead>
            <tr>
              <th class="col-rank">Rang</th>
              <th class="col-nr">Startnr</th>
              <th class="col-driver">Fahrer</th>
              <th class="col-class hide-xs">Klasse</th>

              {#if format === 'GLP'}
                <th class="col-time">Istzeit</th>
                <th class="col-extra hide-sm">Sollzeit</th>
                <th class="col-dev">Abweichung</th>
                <th class="col-pts hide-sm">Strafpunkte</th>
              {:else if format === 'SP'}
                <th class="col-time">Zeit</th>
                <th class="col-gap hide-sm">Abstand</th>
              {:else if format === 'Rundstrecke'}
                <th class="col-laps hide-sm">Runden</th>
                <th class="col-time">Bestzeit</th>
              {:else}
                <!-- Orientierung -->
                <th class="col-pts">Strafpunkte</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each filteredEntries as entry (entry.startnummer)}
              {@const status = displayStatus(entry)}
              <tr class="entry-row" class:dns={entry.dns} class:dnf={entry.dnf}>
                <!-- Rang -->
                <td class="col-rank">
                  {#if !entry.dns && !entry.dnf && entry.rank <= 3}
                    <span class="trophy" aria-label="Platz {entry.rank}">{trophyIcon(entry.rank)}</span>
                  {:else if !entry.dns && !entry.dnf}
                    <span class="rank-num">{entry.rank}</span>
                  {:else}
                    <span class="status-tag">{status}</span>
                  {/if}
                </td>

                <!-- Startnummer -->
                <td class="col-nr tabular-nums">
                  <strong>{entry.startnummer}</strong>
                </td>

                <!-- Fahrer -->
                <td class="col-driver">
                  <span class="driver-name">{entry.driver_name}</span>
                  {#if entry.co_driver_name}
                    <span class="co-driver"> / {entry.co_driver_name}</span>
                  {/if}
                </td>

                <!-- Klasse -->
                <td class="col-class hide-xs">
                  <span class="class-tag">{entry.class}</span>
                </td>

                {#if format === 'GLP'}
                  <!-- Istzeit -->
                  <td class="col-time tabular-nums">
                    {#if status}
                      <span class="status-tag">{status}</span>
                    {:else}
                      {entry.actual_time_display ?? msToMinSecMs(entry.actual_time_ms ?? 0)}
                    {/if}
                  </td>
                  <!-- Sollzeit -->
                  <td class="col-extra tabular-nums hide-sm">
                    {entry.target_time_display ?? (entry.target_time_ms != null ? msToMinSecMs(entry.target_time_ms) : '—')}
                  </td>
                  <!-- Abweichung -->
                  <td class="col-dev tabular-nums {deviationCls(entry.deviation_ms)}">
                    {entry.deviation_display ?? formatDeviation(entry.deviation_ms)}
                  </td>
                  <!-- Strafpunkte -->
                  <td class="col-pts tabular-nums hide-sm">
                    {entry.penalty_points != null ? entry.penalty_points.toFixed(2) : '—'}
                  </td>

                {:else if format === 'SP'}
                  <!-- Zeit -->
                  <td class="col-time tabular-nums">
                    {#if status}
                      <span class="status-tag">{status}</span>
                    {:else}
                      {entry.total_time_display ?? (entry.total_time_ms != null ? msToMinSecMs(entry.total_time_ms) : '—')}
                    {/if}
                  </td>
                  <!-- Abstand -->
                  <td class="col-gap tabular-nums hide-sm">
                    {entry.gap_display ?? formatGap(entry.gap_ms, entry.rank)}
                  </td>

                {:else if format === 'Rundstrecke'}
                  <!-- Runden -->
                  <td class="col-laps tabular-nums hide-sm">
                    {entry.laps ?? '—'}
                  </td>
                  <!-- Bestzeit -->
                  <td class="col-time tabular-nums">
                    {#if status}
                      <span class="status-tag">{status}</span>
                    {:else}
                      {entry.best_lap_display ?? (entry.best_lap_ms != null ? msToMinSecMs(entry.best_lap_ms) : '—')}
                    {/if}
                  </td>

                {:else}
                  <!-- Orientierung: Strafpunkte -->
                  <td class="col-pts tabular-nums">
                    {entry.penalty_points != null ? entry.penalty_points.toFixed(2) : '—'}
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- ===== FOOTER ===== -->
    <footer class="results-footer">
      {#if lastUpdated}
        <span class="last-updated">
          Letzte Aktualisierung: <time datetime={lastUpdated.toISOString()}>{lastUpdatedStr(lastUpdated)}</time>
        </span>
      {/if}
      <span class="entry-count">{filteredEntries.length} Fahrzeuge</span>
    </footer>
  {/if}
</div>

<style>
  /* ---- Layout ---- */
  .results-page {
    max-width: 1280px;
    margin: 0 auto;
    padding-bottom: 3rem;
  }

  /* ---- Header ---- */
  .page-header {
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 1rem;
    margin-bottom: 0.5rem;
  }

  .page-header-inner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .event-name {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 0.25rem;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .event-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }

  .format-badge, .status-badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .format-badge {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .status-active   { background: var(--color-success-bg); color: var(--color-success); }
  .status-upcoming { background: var(--color-info-bg, #dbeafe); color: var(--color-info, #2563eb); }
  .status-finished { background: var(--color-surface-2); color: var(--color-text-muted); }

  /* ---- Header actions ---- */
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.7rem;
    font-weight: 800;
    color: var(--color-live, #ef4444);
    letter-spacing: 0.12em;
  }

  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-live, #ef4444);
    animation: live-pulse 1.5s ease-in-out infinite;
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.4; transform: scale(0.85); }
  }

  .share-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: color 150ms, border-color 150ms, background 150ms;
    white-space: nowrap;
  }

  .share-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
    background: var(--color-surface-2);
  }

  /* ---- Class filter ---- */
  .class-filter {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .class-filter::-webkit-scrollbar { display: none; }

  .class-pill {
    flex-shrink: 0;
    padding: 0.3rem 0.875rem;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 150ms;
    white-space: nowrap;
  }

  .class-pill:hover {
    border-color: var(--color-text-muted);
    color: var(--color-text);
  }

  .class-pill.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;
  }

  /* ---- Table ---- */
  .table-wrapper {
    overflow-x: auto;
    padding: 0 1rem;
  }

  .results-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .results-table thead {
    position: sticky;
    top: 56px; /* matches public header height */
    z-index: 10;
  }

  .results-table th {
    padding: 0.5rem 0.75rem;
    text-align: left;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background-color: var(--color-surface);
    border-bottom: 2px solid var(--color-border);
    white-space: nowrap;
  }

  .results-table td {
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    vertical-align: middle;
  }

  .entry-row:hover td {
    background-color: var(--color-surface);
  }

  .entry-row.dns td,
  .entry-row.dnf td {
    color: var(--color-text-subtle, var(--color-text-muted));
    opacity: 0.6;
  }

  /* ---- Column widths ---- */
  .col-rank  { width: 3.5rem; text-align: center; }
  .col-nr    { width: 4rem; }
  .col-class { width: 5.5rem; }
  .col-time  { text-align: right; font-weight: 600; }
  .col-extra { text-align: right; }
  .col-dev   { text-align: right; font-size: 0.875rem; font-weight: 600; }
  .col-gap   { text-align: right; font-size: 0.875rem; }
  .col-pts   { text-align: right; font-size: 0.875rem; }
  .col-laps  { text-align: right; }

  /* ---- Rank / trophy ---- */
  .trophy {
    font-size: 1.25rem;
    line-height: 1;
  }

  .rank-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    border-radius: 50%;
    font-weight: 700;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .status-tag {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--color-text-subtle, var(--color-text-muted));
  }

  /* ---- Driver ---- */
  .driver-name {
    font-weight: 500;
  }

  .co-driver {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  /* ---- Class tag ---- */
  .class-tag {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  /* ---- Deviation colours ---- */
  .dev-faster { color: var(--color-success); }
  .dev-slower { color: var(--color-danger); }
  .dev-zero   { color: var(--color-text-muted); }

  /* ---- Tabular nums ---- */
  .tabular-nums { font-variant-numeric: tabular-nums; }

  /* ---- Error state ---- */
  .error-state {
    padding: 3rem 1rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .error-icon { color: var(--color-danger); opacity: 0.7; }
  .error-msg  { color: var(--color-danger); font-size: 0.9375rem; }

  .retry-btn {
    padding: 0.5rem 1.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.9375rem;
    cursor: pointer;
    transition: background 150ms;
  }

  .retry-btn:hover { background: var(--color-surface); }

  /* ---- Empty state ---- */
  .empty-state {
    padding: 4rem 1rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-text-muted);
  }

  .empty-icon {
    opacity: 0.3;
    margin-bottom: 0.5rem;
  }

  .empty-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
  }

  .empty-sub {
    font-size: 0.9375rem;
    max-width: 400px;
    margin: 0;
  }

  .class-reset-btn {
    margin-top: 0.5rem;
    padding: 0.5rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .class-reset-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  /* ---- Footer ---- */
  .results-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-subtle, var(--color-text-muted));
    border-top: 1px solid var(--color-border-subtle, var(--color-border));
  }

  /* ---- Skeleton ---- */
  .skeleton {
    background: linear-gradient(
      90deg,
      var(--color-surface-2) 25%,
      var(--color-border) 50%,
      var(--color-surface-2) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
    border-radius: 4px;
  }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ---- Responsive: hide columns on small screens ---- */
  @media (max-width: 640px) {
    .hide-sm { display: none; }
    .event-name { font-size: 1.25rem; }
  }

  @media (max-width: 400px) {
    .hide-xs { display: none; }
    .results-table td,
    .results-table th { padding: 0.5rem 0.5rem; }
  }
</style>
