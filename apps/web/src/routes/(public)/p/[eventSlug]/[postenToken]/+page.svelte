<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { wsStore } from '$lib/stores/ws.js';
  import { offlineStore } from '$lib/stores/offline.js';
  import StampButton from '$lib/components/zeitnehmer/StampButton.svelte';
  import StartnummerInput from '$lib/components/zeitnehmer/StartnummerInput.svelte';
  import TimeQueue from '$lib/components/zeitnehmer/TimeQueue.svelte';
  import ConnectionStatus from '$lib/components/ui/ConnectionStatus.svelte';

  // ---- Types -----------------------------------------------------------------

  interface PostenSession {
    posten_id: string;
    posten_name: string;
    event_slug: string;
    event_name: string;
    mode: 'manual' | 'timy';
    timy_port?: string;
  }

  interface TimyStatus {
    connected: boolean;
    port: string;
    last_seen_ms: number;
  }

  interface PendingEntry {
    entry_id: string;
    time_display: string;
    raw_time_ms: number;
    startnummer: number | null;
    client_seq: number;
  }

  // ---- State -----------------------------------------------------------------

  const postenToken = $derived($page.params['postenToken'] ?? '');
  const eventSlug = $derived($page.params['eventSlug'] ?? '');

  let session = $state<PostenSession | null>(null);
  let loading = $state(true);
  let sessionError = $state<string | null>(null);
  let startnummer = $state<number | null>(null);
  let pendingEntries = $state<PendingEntry[]>([]);
  let timyStatus = $state<TimyStatus | null>(null);
  let timyPollInterval: ReturnType<typeof setInterval> | null = null;
  let stamping = $state(false);

  const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

  const wsStatus = $derived(wsStore.status);
  const isConnected = $derived(wsStatus === 'connected');
  const pendingCount = $derived(offlineStore.pending);

  // ---- Session init ----------------------------------------------------------

  async function initSession() {
    try {
      loading = true;
      sessionError = null;
      const res = await fetch(`${API_BASE}/posten/${postenToken}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      session = await res.json();
    } catch (err) {
      sessionError = err instanceof Error ? err.message : 'Failed to start session';
    } finally {
      loading = false;
    }
  }

  // ---- Timy polling ----------------------------------------------------------

  async function pollTimyStatus() {
    try {
      const res = await fetch('http://localhost:7272/status', { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        timyStatus = await res.json();
      } else {
        timyStatus = { connected: false, port: '', last_seen_ms: 0 };
      }
    } catch {
      timyStatus = { connected: false, port: '', last_seen_ms: 0 };
    }
  }

  function startTimyPolling() {
    pollTimyStatus();
    timyPollInterval = setInterval(pollTimyStatus, 2000);
  }

  function stopTimyPolling() {
    if (timyPollInterval !== null) {
      clearInterval(timyPollInterval);
      timyPollInterval = null;
    }
  }

  // ---- Stamp action ----------------------------------------------------------

  async function handleStamp(event: CustomEvent<{ timestamp: number }>) {
    if (stamping) return;
    stamping = true;

    const rawTimeMs = event.detail.timestamp;
    const now = new Date(rawTimeMs);
    const timeDisplay = now.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 2
    });

    const entryId = crypto.randomUUID();
    const entry: PendingEntry = {
      entry_id: entryId,
      time_display: timeDisplay,
      raw_time_ms: rawTimeMs,
      startnummer,
      client_seq: rawTimeMs
    };

    // Add to local pending queue immediately
    pendingEntries = [entry, ...pendingEntries];

    // Also enqueue in offline store for resilience
    if (session) {
      await offlineStore.enqueue({
        posten_token: postenToken,
        event_slug: session.event_slug,
        startnummer,
        raw_time_ms: rawTimeMs,
        client_ts: now.toISOString()
      });
    }

    // Try live submit
    if (isConnected && session) {
      wsStore.send({
        type: 'time_entry',
        entry_id: entryId,
        posten_token: postenToken,
        event_slug: session.event_slug,
        startnummer,
        raw_time_ms: rawTimeMs,
        client_ts: now.toISOString()
      });
    }

    stamping = false;
  }

  // ---- WS Timy messages -------------------------------------------------------

  let unsubTimyTime: (() => void) | null = null;

  function setupTimyWsHandler() {
    unsubTimyTime = wsStore.onMessage('timy_time', (msg) => {
      // Timy bridge pushes time events via WS
      const synthetic = new CustomEvent('stamp', {
        detail: { timestamp: msg.raw_time_ms as number }
      });
      handleStamp(synthetic as CustomEvent<{ timestamp: number }>);
    });
  }

  // ---- Confirm/remove pending entry ------------------------------------------

  async function confirmEntry(entry: PendingEntry, confirmedStartnummer: number) {
    try {
      if (isConnected && session) {
        wsStore.send({
          type: 'confirm_entry',
          entry_id: entry.entry_id,
          startnummer: confirmedStartnummer
        });
      }
      // Remove from pending queue
      pendingEntries = pendingEntries.filter((e) => e.entry_id !== entry.entry_id);
    } catch (err) {
      console.error('Failed to confirm entry:', err);
    }
  }

  function removeEntry(entryId: string) {
    pendingEntries = pendingEntries.filter((e) => e.entry_id !== entryId);
  }

  // ---- Timy status color ------------------------------------------------------

  const timyStatusColor = $derived(() => {
    if (!session || session.mode !== 'timy') return null;
    if (!timyStatus) return 'yellow';
    if (timyStatus.connected) return 'green';
    return 'red';
  });

  // ---- Lifecycle -------------------------------------------------------------

  onMount(() => {
    initSession().then(() => {
      if (session?.mode === 'timy') {
        startTimyPolling();
      }
      wsStore.connect();
      setupTimyWsHandler();

      // Sync offline queue if connected
      if (isConnected) {
        offlineStore.sync().catch(console.warn);
      }
    });
  });

  onDestroy(() => {
    stopTimyPolling();
    unsubTimyTime?.();
  });
</script>

<svelte:head>
  <title>
    {session ? `${session.posten_name} — ${session.event_name}` : 'Zeitnehmer'} — Timing Hub
  </title>
</svelte:head>

<!-- Full-height layout, bottom-anchored key actions -->
<div class="zeitnehmer-page">

  <!-- Top bar -->
  <header class="zt-header">
    <div class="zt-header-inner">
      {#if loading}
        <div class="skeleton" style="width: 160px; height: 20px;"></div>
      {:else if session}
        <div class="session-info">
          <span class="posten-name">{session.posten_name}</span>
          <span class="event-name-small">{session.event_name}</span>
        </div>
      {:else if sessionError}
        <span class="error-text">{sessionError}</span>
      {/if}

      <div class="header-right">
        {#if session?.mode === 'timy'}
          <div class="timy-indicator timy-{timyStatusColor()}" title="Timy status">
            <span class="timy-dot"></span>
            <span class="timy-label">Timy</span>
          </div>
        {/if}
        <ConnectionStatus status={wsStatus} compact />
      </div>
    </div>
  </header>

  <!-- Main content area -->
  <main class="zt-main">
    {#if loading}
      <div class="loading-state">
        <div class="spinner" aria-label="Loading..."></div>
        <p>Initializing session…</p>
      </div>

    {:else if sessionError}
      <div class="error-state">
        <p class="error-message">{sessionError}</p>
        <button class="retry-btn" onclick={initSession}>Retry</button>
      </div>

    {:else if session}
      <!-- Stamp button — centered, dominant -->
      <div class="stamp-area">
        <StampButton
          disabled={session.mode === 'timy'}
          title={session.mode === 'timy' ? 'Timy controls timing' : 'Tap to stamp'}
          onstamp={handleStamp}
        />
        {#if session.mode === 'timy'}
          <p class="timy-hint">Timy is controlling timing. Manual stamps disabled.</p>
        {/if}
      </div>

      <!-- Startnummer input -->
      <div class="startnummer-area">
        <StartnummerInput
          bind:value={startnummer}
          label="Startnummer"
        />
      </div>

      <!-- Time queue -->
      {#if pendingEntries.length > 0}
        <div class="queue-area">
          <TimeQueue
            entries={pendingEntries}
            onconfirm={confirmEntry}
            onremove={(id) => removeEntry(id)}
          />
        </div>
      {/if}
    {/if}
  </main>

  <!-- Offline banner — sticky bottom -->
  {#if !isConnected || pendingCount > 0}
    <div class="offline-banner" role="status">
      <div class="offline-banner-inner">
        <div class="offline-status">
          <span class="offline-dot" aria-hidden="true"></span>
          {#if wsStatus === 'offline'}
            <span>Offline — entries queued locally</span>
          {:else if wsStatus === 'reconnecting'}
            <span>Reconnecting…</span>
          {:else if wsStatus === 'connecting'}
            <span>Connecting…</span>
          {:else}
            <span>Syncing…</span>
          {/if}
        </div>
        {#if pendingCount > 0}
          <span class="pending-badge">{pendingCount} pending</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .zeitnehmer-page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
    background-color: var(--color-bg);
  }

  /* Header */
  .zt-header {
    flex-shrink: 0;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 0.75rem 1rem;
    padding-top: calc(0.75rem + env(safe-area-inset-top, 0));
  }

  .zt-header-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .session-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .posten-name {
    font-weight: 700;
    font-size: 1rem;
    color: var(--color-text);
  }

  .event-name-small {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  /* Timy status indicator */
  .timy-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .timy-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .timy-green .timy-dot { background: var(--color-success); }
  .timy-yellow .timy-dot { background: var(--color-warning); }
  .timy-red .timy-dot { background: var(--color-danger); }
  .timy-green { color: var(--color-success); }
  .timy-yellow { color: var(--color-warning); }
  .timy-red { color: var(--color-danger); }

  /* Main */
  .zt-main {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0));
  }

  /* Loading */
  .loading-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--color-text-muted);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Error */
  .error-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  .error-message {
    color: var(--color-danger);
    font-size: 0.9375rem;
  }

  .error-text {
    color: var(--color-danger);
    font-size: 0.875rem;
  }

  .retry-btn {
    padding: 0.625rem 1.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.9375rem;
    cursor: pointer;
    min-height: 48px;
  }

  /* Stamp area */
  .stamp-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .timy-hint {
    font-size: 0.75rem;
    color: var(--color-text-subtle);
    text-align: center;
  }

  /* Startnummer area */
  .startnummer-area {
    /* Takes remaining space, pushes to natural position */
  }

  /* Queue area */
  .queue-area {
    /* Time queue list */
  }

  /* Offline banner */
  .offline-banner {
    flex-shrink: 0;
    background: var(--color-warning-bg);
    border-top: 1px solid var(--color-warning);
    padding: 0.625rem 1rem;
    padding-bottom: calc(0.625rem + env(safe-area-inset-bottom, 0));
  }

  .offline-banner-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .offline-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-warning);
    font-weight: 500;
  }

  .offline-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-warning);
    animation: live-pulse 1.5s ease-in-out infinite;
  }

  .pending-badge {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    background: var(--color-warning);
    color: #000;
    border-radius: 9999px;
  }
</style>
