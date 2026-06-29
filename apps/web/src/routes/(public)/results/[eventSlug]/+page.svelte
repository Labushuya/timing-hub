<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { wsStore } from '$lib/stores/ws.js';
  import ConnectionStatus from '$lib/components/ui/ConnectionStatus.svelte';

  // ---- Types -----------------------------------------------------------------

  interface LeaderboardEntry {
    rank: number;
    startnummer: number;
    driver_name: string;
    class: string;
    best_time_ms: number | null;
    best_time_display: string;
    deviation_ms: number | null;
    deviation_display: string;
    run_count: number;
    dns: boolean;
    dnf: boolean;
  }

  interface EventInfo {
    name: string;
    slug: string;
    format: string;
    status: 'upcoming' | 'active' | 'finished';
    classes: string[];
  }

  // ---- State -----------------------------------------------------------------

  const eventSlug = $derived($page.params['eventSlug'] ?? '');

  let eventInfo = $state<EventInfo | null>(null);
  let entries = $state<LeaderboardEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedClass = $state<string>('all');
  let lastUpdated = $state<Date | null>(null);

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

  // ---- Data fetching ---------------------------------------------------------

  async function fetchLeaderboard() {
    try {
      loading = true;
      error = null;
      const res = await fetch(`${API_BASE}/events/${eventSlug}/leaderboard`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      eventInfo = data.event;
      entries = data.entries;
      lastUpdated = new Date();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load leaderboard';
    } finally {
      loading = false;
    }
  }

  // ---- WebSocket subscription ------------------------------------------------

  let unsubLeaderboard: (() => void) | null = null;

  function setupWsSubscription() {
    wsStore.subscribe(eventSlug);

    unsubLeaderboard = wsStore.onMessage('leaderboard_update', (msg) => {
      const update = msg as unknown as { entries: LeaderboardEntry[]; event: EventInfo };
      if (update.entries) {
        entries = update.entries;
        lastUpdated = new Date();
      }
      if (update.event) {
        eventInfo = update.event;
      }
    });
  }

  // ---- Lifecycle -------------------------------------------------------------

  onMount(() => {
    fetchLeaderboard();
    wsStore.connect();
    setupWsSubscription();
  });

  onDestroy(() => {
    unsubLeaderboard?.();
    wsStore.unsubscribe(eventSlug);
  });

  // ---- Helpers ---------------------------------------------------------------

  function formatTime(entry: LeaderboardEntry): string {
    if (entry.dns) return 'DNS';
    if (entry.dnf) return 'DNF';
    return entry.best_time_display ?? '—';
  }

  function deviationClass(entry: LeaderboardEntry): string {
    if (!entry.deviation_ms) return '';
    if (entry.deviation_ms < 0) return 'dev-faster';
    if (entry.deviation_ms > 0) return 'dev-slower';
    return '';
  }
</script>

<svelte:head>
  <title>{eventInfo?.name ?? 'Results'} — Timing Hub</title>
</svelte:head>

<div class="leaderboard-page">
  <!-- Header -->
  <div class="page-header">
    <div class="page-header-inner">
      <div class="event-info">
        {#if loading && !eventInfo}
          <div class="skeleton" style="width: 200px; height: 28px;"></div>
          <div class="skeleton" style="width: 120px; height: 20px; margin-top: 4px;"></div>
        {:else if eventInfo}
          <h1 class="event-name">{eventInfo.name}</h1>
          <div class="event-meta">
            <span class="format-badge">{eventInfo.format}</span>
            <span class="status-badge status-{eventInfo.status}">{eventInfo.status}</span>
          </div>
        {/if}
      </div>

      <div class="header-status">
        {#if isLive && eventInfo?.status === 'active'}
          <div class="live-indicator" aria-label="Live updates active">
            <span class="live-dot" aria-hidden="true"></span>
            <span>LIVE</span>
          </div>
        {/if}
        <ConnectionStatus status={wsStatus} />
        {#if lastUpdated}
          <time class="last-updated" datetime={lastUpdated.toISOString()}>
            {lastUpdated.toLocaleTimeString()}
          </time>
        {/if}
      </div>
    </div>
  </div>

  <!-- Class filter pills -->
  {#if allClasses.length > 0}
    <div class="class-filter" role="tablist" aria-label="Filter by class">
      <button
        class="class-pill"
        class:active={selectedClass === 'all'}
        role="tab"
        aria-selected={selectedClass === 'all'}
        onclick={() => selectedClass = 'all'}
      >
        All
      </button>
      {#each allClasses as cls}
        <button
          class="class-pill"
          class:active={selectedClass === cls}
          role="tab"
          aria-selected={selectedClass === cls}
          onclick={() => selectedClass = cls}
        >
          {cls}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Error state -->
  {#if error}
    <div class="error-state" role="alert">
      <p>{error}</p>
      <button onclick={fetchLeaderboard} class="retry-btn">Retry</button>
    </div>

  <!-- Loading skeleton -->
  {:else if loading && entries.length === 0}
    <div class="table-wrapper">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Nr.</th>
            <th>Driver</th>
            <th>Class</th>
            <th>Best Time</th>
            <th>+/−</th>
          </tr>
        </thead>
        <tbody>
          {#each { length: 8 } as _, i}
            <tr>
              <td><div class="skeleton" style="width: 24px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: 40px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: {120 + Math.random() * 80}px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: 60px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: 80px; height: 16px;"></div></td>
              <td><div class="skeleton" style="width: 60px; height: 16px;"></div></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

  <!-- Leaderboard table -->
  {:else}
    <div class="table-wrapper">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th class="col-nr">Nr.</th>
            <th class="col-driver">Driver</th>
            <th class="col-class">Class</th>
            <th class="col-time">Best Time</th>
            <th class="col-dev">+/−</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredEntries as entry (entry.startnummer)}
            <tr class="entry-row" class:dns={entry.dns} class:dnf={entry.dnf}>
              <td class="col-rank">
                {#if entry.rank <= 3 && !entry.dns && !entry.dnf}
                  <span class="rank rank-{entry.rank}">{entry.rank}</span>
                {:else}
                  <span class="rank">{entry.dns || entry.dnf ? '—' : entry.rank}</span>
                {/if}
              </td>
              <td class="col-nr tabular-nums">
                <strong>{entry.startnummer}</strong>
              </td>
              <td class="col-driver">{entry.driver_name}</td>
              <td class="col-class">
                <span class="class-tag">{entry.class}</span>
              </td>
              <td class="col-time tabular-nums">{formatTime(entry)}</td>
              <td class="col-dev tabular-nums {deviationClass(entry)}">
                {entry.deviation_display ?? ''}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if filteredEntries.length === 0}
        <div class="empty-state">
          <p>No results yet for this class.</p>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .leaderboard-page {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 0 2rem;
  }

  .page-header {
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 1rem;
    margin-bottom: 1rem;
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
  }

  .event-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .format-badge, .status-badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .format-badge {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .status-active { background: var(--color-success-bg); color: var(--color-success); }
  .status-upcoming { background: var(--color-info-bg); color: var(--color-info); }
  .status-finished { background: var(--color-surface-2); color: var(--color-text-muted); }

  .header-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--color-live);
    letter-spacing: 0.1em;
  }

  .last-updated {
    font-size: 0.75rem;
    color: var(--color-text-subtle);
  }

  /* Class filter pills */
  .class-filter {
    display: flex;
    gap: 0.5rem;
    padding: 0 1rem 1rem;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .class-filter::-webkit-scrollbar { display: none; }

  .class-pill {
    flex-shrink: 0;
    padding: 0.375rem 1rem;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.875rem;
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
    color: white;
  }

  /* Table */
  .table-wrapper {
    overflow-x: auto;
    padding: 0 1rem;
  }

  .leaderboard-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .leaderboard-table thead {
    position: sticky;
    top: 56px;
    z-index: 10;
  }

  .leaderboard-table th {
    padding: 0.625rem 0.75rem;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    white-space: nowrap;
  }

  .leaderboard-table td {
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .entry-row:hover td {
    background-color: var(--color-surface);
  }

  .entry-row.dns td, .entry-row.dnf td {
    color: var(--color-text-subtle);
  }

  .col-rank { width: 3rem; text-align: center; }
  .col-nr { width: 4rem; }
  .col-time { text-align: right; font-weight: 600; }
  .col-dev { text-align: right; font-size: 0.875rem; }

  .rank {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-weight: 700;
    font-size: 0.875rem;
  }

  .rank-1 { background: #ffd700; color: #000; }
  .rank-2 { background: #c0c0c0; color: #000; }
  .rank-3 { background: #cd7f32; color: #fff; }

  .class-tag {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .dev-faster { color: var(--color-success); }
  .dev-slower { color: var(--color-danger); }

  /* Error / empty states */
  .error-state {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--color-danger);
  }

  .retry-btn {
    margin-top: 0.75rem;
    padding: 0.5rem 1.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    cursor: pointer;
  }

  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--color-text-muted);
  }

  /* Skeleton rows */
  .leaderboard-table tbody td {
    vertical-align: middle;
  }
</style>
