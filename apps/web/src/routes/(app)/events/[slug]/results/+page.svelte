<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api/client.js';
  import type { Event, EventFormat } from '@timing-hub/shared-types';

  // ---- Types ------------------------------------------------------------------

  interface ResultEntry {
    rank: number | null;
    startnummer: string;
    driver_name: string;
    co_driver_name?: string;
    class: string;
    car_make?: string;
    car_model?: string;
    // Common
    total_time_ms: number | null;
    total_time_display: string;
    gap_ms: number | null;
    gap_display: string;
    // GLP
    penalty_points: number | null;
    deviation_ms: number | null;
    deviation_display: string;
    // SP/Rundstrecke
    run_count: number;
    // Status
    dns: boolean;
    dnf: boolean;
    dsq: boolean;
  }

  interface ResultsMeta {
    event_name: string;
    event_slug: string;
    format: EventFormat;
    classes: string[];
    computed_at: string | null;
    total_participants: number;
  }

  // ---- State ------------------------------------------------------------------

  const slug = $derived($page.params['slug'] ?? '');

  let meta = $state<ResultsMeta | null>(null);
  let results = $state<ResultEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedClass = $state('all');
  let recomputing = $state(false);
  let recomputeMsg = $state<string | null>(null);

  const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api') as string;

  // ---- Derived ----------------------------------------------------------------

  const filteredResults = $derived(
    selectedClass === 'all'
      ? results
      : results.filter((r) => r.class === selectedClass)
  );

  const isGlp = $derived(meta?.format === 'glp');
  const isTimed = $derived(meta?.format === 'sonderpruefung' || meta?.format === 'rundstrecke');

  const allClasses = $derived(meta?.classes ?? []);

  const computedAtLabel = $derived(
    meta?.computed_at
      ? new Date(meta.computed_at).toLocaleString('de-DE', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      : null
  );

  // ---- Data fetching ----------------------------------------------------------

  async function fetchResults() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_BASE}/events/${encodeURIComponent(slug)}/results`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      meta = data.meta ?? data.event ?? null;
      results = data.results ?? data.entries ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Fehler beim Laden der Ergebnisse';
    } finally {
      loading = false;
    }
  }

  async function recompute() {
    recomputing = true;
    recomputeMsg = null;
    try {
      const res = await fetch(`${API_BASE}/v1/events/${encodeURIComponent(slug)}/results/recompute`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      recomputeMsg = 'Ergebnisse neu berechnet.';
      await fetchResults();
    } catch (err) {
      recomputeMsg = err instanceof Error ? `Fehler: ${err.message}` : 'Neuberechnung fehlgeschlagen';
    } finally {
      recomputing = false;
      setTimeout(() => { recomputeMsg = null; }, 4000);
    }
  }

  // ---- CSV export -------------------------------------------------------------

  function buildCsv(): string {
    const cols: string[] = ['Rang', 'Nr.', 'Fahrer', 'Beifahrer', 'Klasse', 'Fahrzeug'];
    if (isGlp) cols.push('Strafpunkte', 'Abweichung');
    if (isTimed) cols.push('Gesamtzeit', 'Rückstand');
    cols.push('Status');

    const rows = [cols.join(';')];

    for (const r of filteredResults) {
      const status = r.dsq ? 'DSQ' : r.dnf ? 'DNF' : r.dns ? 'DNS' : 'OK';
      const car = [r.car_make, r.car_model].filter(Boolean).join(' ');
      const row: (string | number | null)[] = [
        r.rank ?? '—',
        r.startnummer,
        r.driver_name,
        r.co_driver_name ?? '',
        r.class,
        car
      ];
      if (isGlp) {
        row.push(r.penalty_points ?? '—');
        row.push(r.deviation_display ?? '—');
      }
      if (isTimed) {
        row.push(r.total_time_display ?? '—');
        row.push(r.gap_display ?? '—');
      }
      row.push(status);
      rows.push(row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));
    }

    return rows.join('\n');
  }

  function downloadCsv() {
    const csv = buildCsv();
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ergebnisse-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printResults() {
    window.print();
  }

  // ---- Helpers ----------------------------------------------------------------

  function rankClass(r: ResultEntry): string {
    if (r.dns || r.dnf || r.dsq) return '';
    if (r.rank === 1) return 'rank-gold';
    if (r.rank === 2) return 'rank-silver';
    if (r.rank === 3) return 'rank-bronze';
    return '';
  }

  function rowStatusClass(r: ResultEntry): string {
    if (r.dsq) return 'row-dsq';
    if (r.dnf) return 'row-dnf';
    if (r.dns) return 'row-dns';
    return '';
  }

  function displayRank(r: ResultEntry): string {
    if (r.dsq) return 'DSQ';
    if (r.dnf) return 'DNF';
    if (r.dns) return 'DNS';
    return String(r.rank ?? '—');
  }

  // ---- Lifecycle --------------------------------------------------------------

  onMount(fetchResults);
</script>

<svelte:head>
  <title>Ergebnisse{meta ? ' — ' + meta.event_name : ''} — Timing Hub</title>
</svelte:head>

<div class="results-page">

  <!-- Header bar -->
  <div class="results-header">
    <div class="header-left">
      <h2 class="page-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="18 20 18 10"/><polyline points="12 20 12 4"/><polyline points="6 20 6 14"/>
        </svg>
        Ergebnisse
        {#if meta}
          <span class="format-tag">{meta.format.toUpperCase()}</span>
        {/if}
      </h2>
      {#if computedAtLabel}
        <p class="computed-at">Berechnet: <time datetime={meta?.computed_at ?? ''}>{computedAtLabel}</time></p>
      {/if}
    </div>

    <div class="header-actions">
      {#if recomputeMsg}
        <span class="recompute-msg" class:error={recomputeMsg.startsWith('Fehler')} role="status">
          {recomputeMsg}
        </span>
      {/if}

      <button
        class="btn btn-ghost"
        onclick={recompute}
        disabled={recomputing || loading}
        title="Ergebnisse neu berechnen"
      >
        {#if recomputing}
          <span class="btn-spinner" aria-hidden="true"></span>
        {:else}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        {/if}
        Neu berechnen
      </button>

      <button class="btn btn-ghost" onclick={downloadCsv} disabled={results.length === 0} title="Als CSV herunterladen">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        CSV
      </button>

      <button class="btn btn-ghost" onclick={printResults} title="Drucken / PDF">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="6 9 6 2 18 2 18 9"/>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
          <rect x="6" y="14" width="12" height="8"/>
        </svg>
        Drucken
      </button>
    </div>
  </div>

  <!-- Class filter tabs -->
  {#if allClasses.length > 0}
    <div class="class-tabs" role="tablist" aria-label="Nach Klasse filtern">
      <button
        class="class-tab"
        class:active={selectedClass === 'all'}
        role="tab"
        aria-selected={selectedClass === 'all'}
        onclick={() => (selectedClass = 'all')}
      >
        Alle ({results.length})
      </button>
      {#each allClasses as cls}
        <button
          class="class-tab"
          class:active={selectedClass === cls}
          role="tab"
          aria-selected={selectedClass === cls}
          onclick={() => (selectedClass = cls)}
        >
          {cls} ({results.filter((r) => r.class === cls).length})
        </button>
      {/each}
    </div>
  {/if}

  <!-- Error -->
  {#if error}
    <div class="error-state" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      {error}
      <button class="btn btn-ghost btn-sm" onclick={fetchResults}>Erneut versuchen</button>
    </div>

  <!-- Loading skeleton -->
  {:else if loading}
    <div class="table-wrapper">
      <table class="results-table">
        <thead><tr>
          {#each ['#', 'Nr.', 'Fahrer', 'Klasse', 'Zeit', '+/−'] as col}
            <th>{col}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each { length: 8 } as _}
            <tr>
              {#each { length: 6 } as _}
                <td><div class="skeleton" style="height: 16px; width: {40 + Math.floor(Math.random() * 80)}px;"></div></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

  <!-- Results table -->
  {:else if filteredResults.length === 0}
    <div class="empty-state">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
        <polyline points="18 20 18 10"/><polyline points="12 20 12 4"/><polyline points="6 20 6 14"/>
      </svg>
      <p>Noch keine Ergebnisse für diese Klasse</p>
    </div>

  {:else}
    <div class="table-wrapper">
      <table class="results-table" aria-label="Ergebnisliste">
        <thead>
          <tr>
            <th class="col-rank" scope="col">#</th>
            <th class="col-nr" scope="col">Nr.</th>
            <th class="col-driver" scope="col">Fahrer / Beifahrer</th>
            <th class="col-class" scope="col">Klasse</th>
            <th class="col-car" scope="col">Fahrzeug</th>
            {#if isGlp}
              <th class="col-pts" scope="col">Pkt.</th>
              <th class="col-dev" scope="col">Abw.</th>
            {/if}
            {#if isTimed}
              <th class="col-time" scope="col">Gesamtzeit</th>
              <th class="col-gap" scope="col">Rückstand</th>
            {/if}
            <th class="col-runs" scope="col">Läufe</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredResults as r (r.startnummer)}
            <tr
              class="result-row {rankClass(r)} {rowStatusClass(r)}"
              aria-label="Rang {r.rank ?? 'k.A.'}, Nr. {r.startnummer}, {r.driver_name}"
            >
              <!-- Rank -->
              <td class="col-rank">
                {#if r.rank && r.rank <= 3 && !r.dns && !r.dnf && !r.dsq}
                  <span class="rank-badge rank-{r.rank}" aria-label="Rang {r.rank}">
                    {r.rank}
                  </span>
                {:else}
                  <span class="rank-plain">{displayRank(r)}</span>
                {/if}
              </td>

              <!-- Startnummer -->
              <td class="col-nr tabular">
                <strong>#{r.startnummer}</strong>
              </td>

              <!-- Driver -->
              <td class="col-driver">
                <div class="driver-main">{r.driver_name}</div>
                {#if r.co_driver_name}
                  <div class="driver-co">{r.co_driver_name}</div>
                {/if}
              </td>

              <!-- Class -->
              <td class="col-class">
                <span class="class-tag">{r.class}</span>
              </td>

              <!-- Car -->
              <td class="col-car">
                {#if r.car_make || r.car_model}
                  <span class="car-info">{[r.car_make, r.car_model].filter(Boolean).join(' ')}</span>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>

              <!-- GLP cols -->
              {#if isGlp}
                <td class="col-pts tabular">
                  {#if r.dns || r.dnf || r.dsq}
                    <span class="text-muted">—</span>
                  {:else}
                    <strong class:pts-zero={r.penalty_points === 0}>{r.penalty_points ?? '—'}</strong>
                  {/if}
                </td>
                <td class="col-dev tabular">
                  <span class:dev-fast={r.deviation_ms !== null && r.deviation_ms < 0}
                        class:dev-slow={r.deviation_ms !== null && r.deviation_ms > 0}>
                    {r.deviation_display || '—'}
                  </span>
                </td>
              {/if}

              <!-- SP/Runde cols -->
              {#if isTimed}
                <td class="col-time tabular">
                  {#if r.dns}
                    <span class="status-tag tag-dns">DNS</span>
                  {:else if r.dnf}
                    <span class="status-tag tag-dnf">DNF</span>
                  {:else if r.dsq}
                    <span class="status-tag tag-dsq">DSQ</span>
                  {:else}
                    <strong>{r.total_time_display || '—'}</strong>
                  {/if}
                </td>
                <td class="col-gap tabular">
                  {#if r.rank === 1 || r.dns || r.dnf || r.dsq}
                    <span class="text-muted">—</span>
                  {:else}
                    <span class="gap-val">+{r.gap_display || '—'}</span>
                  {/if}
                </td>
              {/if}

              <!-- Run count -->
              <td class="col-runs tabular text-muted">{r.run_count}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  /* ---- Page ---- */

  .results-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding-bottom: 2rem;
  }

  /* ---- Header ---- */

  .results-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .page-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.125rem;
    font-weight: 800;
    margin: 0 0 0.25rem;
    letter-spacing: -0.02em;
  }

  .format-tag {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 0.2rem 0.55rem;
    border-radius: 9999px;
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    vertical-align: middle;
  }

  .computed-at {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .recompute-msg {
    font-size: 0.8125rem;
    color: #4ade80;
    font-weight: 500;
  }

  .recompute-msg.error { color: var(--color-danger, #ef4444); }

  /* ---- Buttons ---- */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-md, 6px);
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 150ms;
    white-space: nowrap;
  }

  .btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  .btn-sm { padding: 0.35rem 0.7rem; font-size: 0.8125rem; }

  .btn-spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---- Class tabs ---- */

  .class-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .class-tabs::-webkit-scrollbar { display: none; }

  .class-tab {
    padding: 0.625rem 1.125rem;
    font-size: 0.875rem;
    font-weight: 500;
    font-family: inherit;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    white-space: nowrap;
    position: relative;
    top: 1px;
    transition: color 120ms, border-color 120ms;
  }

  .class-tab:hover { color: var(--color-text); }

  .class-tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary);
    font-weight: 600;
  }

  /* ---- Table ---- */

  .table-wrapper {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 10px);
    background: var(--color-surface);
  }

  .results-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .results-table thead {
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .results-table th {
    padding: 0.625rem 0.875rem;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    white-space: nowrap;
  }

  .results-table td {
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--color-border-subtle, rgba(255,255,255,0.04));
    vertical-align: middle;
  }

  .result-row:last-child td { border-bottom: none; }

  .result-row:hover td { background: var(--color-surface-2, rgba(255,255,255,0.02)); }

  .row-dns td, .row-dnf td, .row-dsq td { opacity: 0.6; }

  /* Rank badges */
  .rank-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-weight: 800;
    font-size: 0.875rem;
  }

  .rank-1 { background: #ffd700; color: #000; }
  .rank-2 { background: #c0c0c0; color: #000; }
  .rank-3 { background: #cd7f32; color: #fff; }

  .rank-plain {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Driver col */
  .driver-main { font-weight: 600; }
  .driver-co { font-size: 0.8125rem; color: var(--color-text-muted); margin-top: 0.1rem; }

  /* Class tag */
  .class-tag {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    white-space: nowrap;
  }

  /* Car */
  .car-info { font-size: 0.875rem; color: var(--color-text-muted); }

  /* GLP */
  .col-pts { text-align: right; }
  .col-dev { text-align: right; font-size: 0.875rem; }

  .pts-zero { color: #4ade80; }
  .dev-fast { color: #4ade80; }
  .dev-slow { color: var(--color-danger, #ef4444); }

  /* Timed */
  .col-time { text-align: right; }
  .col-gap  { text-align: right; font-size: 0.875rem; }
  .gap-val  { color: var(--color-text-muted); }

  /* Status tags */
  .status-tag {
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
  }

  .tag-dns { background: rgba(59,130,246,0.12); color: #60a5fa; border: 1px solid rgba(59,130,246,0.2); }
  .tag-dnf { background: rgba(234,179,8,0.12);  color: #fbbf24; border: 1px solid rgba(234,179,8,0.2); }
  .tag-dsq { background: rgba(239,68,68,0.12);  color: #f87171; border: 1px solid rgba(239,68,68,0.2); }

  /* Column widths */
  .col-rank  { width: 3.5rem; text-align: center; }
  .col-nr    { width: 4.5rem; }
  .col-class { width: 6rem; }
  .col-pts   { width: 5rem; }
  .col-dev   { width: 7rem; }
  .col-time  { width: 9rem; }
  .col-gap   { width: 7rem; }
  .col-runs  { width: 5rem; text-align: center; }

  .tabular { font-variant-numeric: tabular-nums; }
  .text-muted { color: var(--color-text-muted); }

  /* ---- States ---- */

  .error-state {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: var(--radius-md, 6px);
    color: #f87171;
    font-size: 0.875rem;
    flex-wrap: wrap;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
    padding: 3rem 1rem;
    color: var(--color-text-muted);
    text-align: center;
  }

  .empty-state svg { opacity: 0.3; }
  .empty-state p { margin: 0; font-size: 0.9375rem; }

  /* Skeleton */
  .skeleton {
    background: linear-gradient(90deg, var(--color-surface-2) 25%, var(--color-surface) 50%, var(--color-surface-2) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
    border-radius: 4px;
    display: inline-block;
  }

  @keyframes shimmer {
    from { background-position: 200% center; }
    to   { background-position: -200% center; }
  }

  /* ---- Print styles ---- */

  @media print {
    .results-header .header-actions,
    .class-tabs { display: none; }

    .table-wrapper {
      border: none;
      border-radius: 0;
    }

    .result-row:hover td { background: transparent; }
  }

  /* ---- Responsive ---- */

  @media (max-width: 768px) {
    .col-car, .col-runs { display: none; }

    .results-header {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      justify-content: flex-start;
    }
  }
</style>
