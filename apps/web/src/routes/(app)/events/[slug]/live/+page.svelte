<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { page } from '$app/stores';
  import { wsStore } from '$lib/stores/ws.svelte.js';
  import { api } from '$lib/api/client.js';
  import ConnectionStatus from '$lib/components/ui/ConnectionStatus.svelte';
  import TimeEntryRow from '$lib/components/live/TimeEntryRow.svelte';
  import DisputePanel from '$lib/components/live/DisputePanel.svelte';
  import type { TimeEntry } from '$lib/components/live/TimeEntryRow.svelte';

  // ---- Types ------------------------------------------------------------------

  interface LeaderboardEntry {
    rank: number;
    startnummer: string;
    driver_name: string;
    class: string;
    best_time_display: string;
    gap_display?: string;
    dns: boolean;
    dnf: boolean;
  }

  interface AuditEntry {
    id: string;
    ts: string;
    action: string;
    detail: string;
    user?: string;
  }

  // ---- State ------------------------------------------------------------------

  const slug = $derived($page.params['slug'] ?? '');

  let entries = $state<TimeEntry[]>([]);
  let leaderboard = $state<LeaderboardEntry[]>([]);
  let auditLog = $state<AuditEntry[]>([]);

  let totalEntries = $state(0);
  let confirmedCount = $state(0);
  let activePosten = $state(0);

  let autoScroll = $state(true);
  let pauseLabel = $state('Pause');

  let selectedEntry = $state<TimeEntry | null>(null);
  let disputePanelOpen = $state(false);
  let bottomPanelOpen = $state(true);

  let feedEl = $state<HTMLElement | null>(null);

  const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api') as string;

  // ---- Derived ----------------------------------------------------------------

  const wsStatus = $derived(wsStore.status);
  const confirmedPct = $derived(
    totalEntries > 0 ? Math.round((confirmedCount / totalEntries) * 100) : 0
  );

  // ---- Feed helpers -----------------------------------------------------------

  const MAX_FEED = 200;

  function prependEntry(e: TimeEntry) {
    entries = [e, ...entries].slice(0, MAX_FEED);
    totalEntries++;
    if (e.status === 'confirmed') confirmedCount++;
    if (autoScroll && feedEl) {
      tick().then(() => {
        feedEl?.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  function updateEntry(id: string, patch: Partial<TimeEntry>) {
    entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
  }

  function addAudit(action: string, detail: string) {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toLocaleTimeString('de-DE'),
      action,
      detail
    };
    auditLog = [entry, ...auditLog].slice(0, 20);
  }

  // ---- WebSocket handlers -----------------------------------------------------

  let unsubHandlers: Array<() => void> = [];

  function setupWs() {
    wsStore.connect();
    wsStore.subscribe(slug);

    unsubHandlers.push(
      wsStore.onMessage('time_entry', (msg) => {
        const e = msg as unknown as TimeEntry & { posten_name: string };
        prependEntry(e);
      }),

      wsStore.onMessage('results_update', (msg) => {
        const u = msg as unknown as { entries: LeaderboardEntry[] };
        if (u.entries) leaderboard = u.entries.slice(0, 10);
      }),

      wsStore.onMessage('participant_confirmed', (msg) => {
        const u = msg as unknown as { time_id: string; startnummer: string };
        if (u.time_id) {
          updateEntry(u.time_id, { startnummer: u.startnummer, status: 'confirmed' });
          confirmedCount++;
        }
      }),

      wsStore.onMessage('posten_status', (msg) => {
        const u = msg as unknown as { active_count: number };
        if (typeof u.active_count === 'number') activePosten = u.active_count;
      })
    );
  }

  // ---- Initial data load ------------------------------------------------------

  async function loadLiveData() {
    try {
      const res = await fetch(`${API_BASE}/events/${encodeURIComponent(slug)}/live/feed`, {
        headers: { Authorization: `Bearer ${(await import('$lib/stores/auth.svelte.js')).authStore.accessToken ?? ''}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      entries = (data.entries ?? []).slice(0, MAX_FEED);
      totalEntries = data.total ?? entries.length;
      confirmedCount = data.confirmed ?? entries.filter((e: TimeEntry) => e.status === 'confirmed').length;
    } catch {
      // Non-critical — live feed is primarily WS driven
    }

    try {
      const res2 = await fetch(`${API_BASE}/events/${encodeURIComponent(slug)}/leaderboard`);
      if (res2.ok) {
        const data2 = await res2.json();
        leaderboard = (data2.entries ?? []).slice(0, 10);
      }
    } catch {
      // ignore
    }
  }

  // ---- Actions (REST) ---------------------------------------------------------

  async function confirmEntry(id: string, startnummer: string) {
    const res = await fetch(`${API_BASE}/v1/times/${encodeURIComponent(id)}/confirm`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startnummer })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
    }
    updateEntry(id, { startnummer, status: 'confirmed' });
    confirmedCount++;
    addAudit('Bestätigt', `Eintrag #${id.slice(-6)} → Nr. ${startnummer}`);
  }

  async function voidEntry(id: string, reason: string) {
    const res = await fetch(`${API_BASE}/v1/times/${encodeURIComponent(id)}/void`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
    }
    updateEntry(id, { status: 'void', void_reason: reason });
    addAudit('Ungültig', `Eintrag #${id.slice(-6)}: ${reason}`);
    if (selectedEntry?.id === id) {
      selectedEntry = null;
      disputePanelOpen = false;
    }
  }

  async function reassignEntry(id: string, startnummer: string) {
    const res = await fetch(`${API_BASE}/v1/times/${encodeURIComponent(id)}/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startnummer })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
    }
    updateEntry(id, { startnummer, status: 'confirmed' });
    addAudit('Neu zugewiesen', `Eintrag #${id.slice(-6)} → Nr. ${startnummer}`);
    if (selectedEntry?.id === id) {
      selectedEntry = null;
      disputePanelOpen = false;
    }
  }

  // ---- Dispute helpers --------------------------------------------------------

  function openDispute(entry: TimeEntry) {
    selectedEntry = entry;
    disputePanelOpen = true;
    bottomPanelOpen = true;
  }

  function selectEntryFromFeed(entry: TimeEntry) {
    openDispute(entry);
  }

  // ---- Lifecycle --------------------------------------------------------------

  onMount(() => {
    loadLiveData();
    setupWs();
  });

  onDestroy(() => {
    unsubHandlers.forEach((fn) => fn());
    wsStore.unsubscribe(slug);
  });

  // ---- Formatting -------------------------------------------------------------

  function rankMedal(rank: number): string {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return String(rank);
  }

  function rankClass(rank: number): string {
    if (rank === 1) return 'rank-gold';
    if (rank === 2) return 'rank-silver';
    if (rank === 3) return 'rank-bronze';
    return '';
  }
</script>

<svelte:head>
  <title>Live-Ansicht — Timing Hub</title>
</svelte:head>

<!-- Connection status banner (only when not connected) -->
{#if wsStatus !== 'connected'}
  <div
    class="connection-banner"
    class:banner-warn={wsStatus === 'connecting' || wsStatus === 'reconnecting'}
    class:banner-error={wsStatus === 'offline'}
    role="alert"
    aria-live="polite"
  >
    <ConnectionStatus status={wsStatus} />
    {#if wsStatus === 'connecting' || wsStatus === 'reconnecting'}
      Verbindung wird hergestellt…
    {:else if wsStatus === 'offline'}
      Keine Verbindung — Live-Updates pausiert
    {:else}
      Verbindung getrennt
    {/if}
  </div>
{/if}

<div class="live-page">

  <!-- ===== Main 2-column grid ===== -->
  <div class="main-grid">

    <!-- ======= LEFT: Alle Posten Feed ======= -->
    <section class="feed-section" aria-label="Zeiteinträge-Feed">
      <div class="section-header">
        <h2 class="section-title">
          Alle Posten
          <span class="live-badge" aria-label="Live">
            {#if wsStatus === 'connected'}
              <span class="live-dot" aria-hidden="true"></span>
            {/if}
            LIVE
          </span>
        </h2>
        <div class="feed-controls">
          <span class="entry-count">{totalEntries} Einträge</span>
          <button
            class="btn-toggle"
            class:paused={!autoScroll}
            onclick={() => { autoScroll = !autoScroll; pauseLabel = autoScroll ? 'Pause' : 'Weiter'; }}
            title={autoScroll ? 'Auto-Scroll pausieren' : 'Auto-Scroll aktivieren'}
            aria-pressed={autoScroll}
          >
            {#if autoScroll}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>
              Pause
            {:else}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              Weiter
            {/if}
          </button>
        </div>
      </div>

      <div class="feed-list" bind:this={feedEl} role="feed" aria-label="Zeiteinträge" aria-live="polite">
        {#if entries.length === 0}
          <div class="feed-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true" class="feed-empty-icon">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <p>Warte auf Zeiteinträge…</p>
          </div>
        {:else}
          {#each entries as entry (entry.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              onclick={() => selectEntryFromFeed(entry)}
              class:selected={selectedEntry?.id === entry.id}
            >
              <TimeEntryRow
                {entry}
                onConfirm={confirmEntry}
                onVoid={() => openDispute(entry)}
              />
            </div>
          {/each}
        {/if}
      </div>
    </section>

    <!-- ======= RIGHT: Leaderboard + Stats ======= -->
    <aside class="side-column" aria-label="Rangliste und Statistiken">

      <!-- Mini leaderboard -->
      <section class="card leaderboard-card" aria-label="Live-Rangliste">
        <h3 class="card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="18 20 18 10"/><polyline points="12 20 12 4"/><polyline points="6 20 6 14"/>
          </svg>
          Rangliste (Top 10)
        </h3>

        {#if leaderboard.length === 0}
          <p class="card-empty">Noch keine Ergebnisse</p>
        {:else}
          <ol class="leaderboard-list" aria-label="Top 10 Rangliste">
            {#each leaderboard as lb (lb.startnummer)}
              <li class="lb-entry {rankClass(lb.rank)}" class:dns={lb.dns} class:dnf={lb.dnf}>
                <span class="lb-rank" aria-label="Rang {lb.rank}">
                  {#if lb.rank <= 3 && !lb.dns && !lb.dnf}
                    {rankMedal(lb.rank)}
                  {:else}
                    {lb.dns || lb.dnf ? '—' : lb.rank}
                  {/if}
                </span>
                <span class="lb-nr tabular">#{lb.startnummer}</span>
                <span class="lb-name">{lb.driver_name}</span>
                <span class="lb-time tabular">
                  {#if lb.dns}DNS{:else if lb.dnf}DNF{:else}{lb.best_time_display}{/if}
                </span>
                {#if lb.gap_display && lb.rank > 1 && !lb.dns && !lb.dnf}
                  <span class="lb-gap tabular">+{lb.gap_display}</span>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <!-- Event stats -->
      <section class="card stats-card" aria-label="Veranstaltungsstatistiken">
        <h3 class="card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          Statistiken
        </h3>

        <dl class="stats-grid">
          <div class="stat-item">
            <dt>Einträge gesamt</dt>
            <dd class="tabular">{totalEntries}</dd>
          </div>
          <div class="stat-item">
            <dt>Bestätigt</dt>
            <dd class="tabular">
              <span class="pct-bar" aria-hidden="true">
                <span class="pct-fill" style="width:{confirmedPct}%"></span>
              </span>
              {confirmedCount} <span class="stat-pct">({confirmedPct}%)</span>
            </dd>
          </div>
          <div class="stat-item">
            <dt>Aktive Posten</dt>
            <dd class="tabular">{activePosten}</dd>
          </div>
          <div class="stat-item">
            <dt>WS-Status</dt>
            <dd><ConnectionStatus status={wsStatus} /></dd>
          </div>
        </dl>
      </section>

    </aside>
  </div>

  <!-- ===== Bottom panel (collapsible) ===== -->
  <div class="bottom-panel" class:collapsed={!bottomPanelOpen}>
    <button
      class="panel-toggle"
      onclick={() => (bottomPanelOpen = !bottomPanelOpen)}
      aria-expanded={bottomPanelOpen}
      aria-controls="bottom-panel-content"
    >
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
        class:rotated={bottomPanelOpen}
        aria-hidden="true"
      >
        <polyline points="18 15 12 9 6 15"/>
      </svg>
      {#if bottomPanelOpen}Panel ausblenden{:else}Korrektur & Protokoll{/if}
    </button>

    {#if bottomPanelOpen}
      <div id="bottom-panel-content" class="panel-content">
        <!-- Dispute panel -->
        <div class="panel-dispute">
          <DisputePanel
            entry={selectedEntry}
            onVoid={voidEntry}
            onReassign={reassignEntry}
            onClose={() => { selectedEntry = null; disputePanelOpen = false; }}
          />
        </div>

        <!-- Audit log -->
        <section class="panel-audit" aria-label="Aktionsprotokoll">
          <h3 class="audit-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            Aktionsprotokoll
          </h3>

          {#if auditLog.length === 0}
            <p class="audit-empty">Noch keine Aktionen</p>
          {:else}
            <ul class="audit-list" aria-label="Letzte 20 Aktionen">
              {#each auditLog as log (log.id)}
                <li class="audit-entry">
                  <time class="audit-time tabular">{log.ts}</time>
                  <span class="audit-action">{log.action}</span>
                  <span class="audit-detail">{log.detail}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ---- Page layout ---- */

  .live-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    min-height: 0;
  }

  /* ---- Connection banner ---- */

  .connection-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-radius: var(--radius-md, 6px);
    font-size: 0.875rem;
    font-weight: 500;
    margin-bottom: -0.25rem;
  }

  .banner-warn {
    background: rgba(234,179,8,0.12);
    border: 1px solid rgba(234,179,8,0.25);
    color: #fbbf24;
  }

  .banner-error {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.22);
    color: #f87171;
  }

  /* ---- Main grid ---- */

  .main-grid {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 1.25rem;
    align-items: start;
    min-height: 0;
  }

  /* ---- Feed section ---- */

  .feed-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 10px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2, rgba(255,255,255,0.03));
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .section-title {
    font-size: 0.9375rem;
    font-weight: 700;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #4ade80;
    background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.25);
    border-radius: 9999px;
    padding: 0.15rem 0.5rem;
  }

  .live-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #4ade80;
    animation: live-pulse 1.2s ease-in-out infinite;
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.4; transform: scale(0.7); }
  }

  .feed-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .entry-count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .btn-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 120ms;
    white-space: nowrap;
  }

  .btn-toggle:hover { color: var(--color-text); background: var(--color-surface-2); }
  .btn-toggle.paused { color: #fb923c; border-color: rgba(249,115,22,0.3); background: rgba(249,115,22,0.08); }

  .feed-list {
    overflow-y: auto;
    max-height: 60vh;
    min-height: 200px;
    scroll-behavior: smooth;
  }

  div.selected > :global(.entry-row) {
    background: rgba(99,102,241,0.08);
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .feed-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 3rem 1rem;
    color: var(--color-text-muted);
    font-size: 0.875rem;
    text-align: center;
  }

  .feed-empty-icon { opacity: 0.35; }

  .feed-empty p { margin: 0; }

  /* ---- Side column ---- */

  .side-column {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 10px);
    padding: 1rem;
  }

  .card-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.875rem;
    font-weight: 700;
    margin: 0 0 0.875rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .card-empty {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
    padding: 0.5rem 0;
  }

  /* Leaderboard */
  .leaderboard-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .lb-entry {
    display: grid;
    grid-template-columns: 2ch 4ch 1fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.25rem;
    border-radius: var(--radius-sm, 4px);
    font-size: 0.8125rem;
    transition: background 120ms;
  }

  .lb-entry:hover { background: var(--color-surface-2); }
  .lb-entry.dns, .lb-entry.dnf { opacity: 0.5; }

  .lb-entry.rank-gold   .lb-rank { color: #ffd700; font-weight: 800; }
  .lb-entry.rank-silver .lb-rank { color: #c0c0c0; font-weight: 800; }
  .lb-entry.rank-bronze .lb-rank { color: #cd7f32; font-weight: 800; }

  .lb-rank { font-size: 0.875rem; text-align: center; }
  .lb-nr   { font-family: var(--font-mono, monospace); font-weight: 700; font-size: 0.8rem; color: var(--color-text-muted); }
  .lb-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .lb-time { font-family: var(--font-mono, monospace); font-weight: 600; font-size: 0.8rem; text-align: right; white-space: nowrap; }
  .lb-gap  { font-size: 0.7rem; color: var(--color-text-muted); font-family: var(--font-mono, monospace); text-align: right; }

  .tabular { font-variant-numeric: tabular-nums; }

  /* Stats */
  .stats-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
  }

  .stat-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .stat-item dt {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .stat-item dd {
    font-size: 0.875rem;
    font-weight: 700;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-variant-numeric: tabular-nums;
  }

  .stat-pct { font-size: 0.75rem; color: var(--color-text-muted); font-weight: 400; }

  .pct-bar {
    display: inline-block;
    width: 48px;
    height: 5px;
    background: var(--color-surface-2, rgba(255,255,255,0.08));
    border-radius: 9999px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .pct-fill {
    display: block;
    height: 100%;
    background: #4ade80;
    border-radius: 9999px;
    transition: width 400ms ease;
  }

  /* ---- Bottom panel ---- */

  .bottom-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 10px);
    overflow: hidden;
  }

  .panel-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--color-surface-2, rgba(255,255,255,0.03));
    border: none;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-muted);
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: color 120ms;
  }

  .panel-toggle:hover { color: var(--color-text); }

  .collapsed .panel-toggle { border-bottom: none; }

  .panel-toggle svg.rotated {
    transform: rotate(180deg);
  }

  .panel-content {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    padding: 1.25rem;
  }

  /* Audit log */
  .audit-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.875rem;
  }

  .audit-empty {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .audit-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 220px;
    overflow-y: auto;
  }

  .audit-entry {
    display: grid;
    grid-template-columns: 7ch auto 1fr;
    gap: 0.5rem 0.625rem;
    align-items: baseline;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--color-border-subtle, rgba(255,255,255,0.04));
    font-size: 0.8125rem;
  }

  .audit-time { font-family: var(--font-mono, monospace); color: var(--color-text-muted); font-size: 0.75rem; }
  .audit-action { font-weight: 700; white-space: nowrap; color: var(--color-text); }
  .audit-detail { color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- Responsive ---- */

  @media (max-width: 900px) {
    .main-grid {
      grid-template-columns: 1fr;
    }

    .side-column {
      flex-direction: row;
      flex-wrap: wrap;
    }

    .leaderboard-card, .stats-card {
      flex: 1 1 280px;
    }

    .panel-content {
      grid-template-columns: 1fr;
    }

    .feed-list {
      max-height: 50vh;
    }
  }

  @media (max-width: 480px) {
    .side-column {
      flex-direction: column;
    }

    .panel-content {
      padding: 1rem;
    }
  }
</style>
