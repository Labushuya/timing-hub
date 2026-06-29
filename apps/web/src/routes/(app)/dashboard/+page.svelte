<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { authStore } from '$lib/stores/auth.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';

  // ---- Types -----------------------------------------------------------------

  interface EventCard {
    id: string;
    slug: string;
    name: string;
    format: 'autocross' | 'hillclimb' | 'rallyesprint' | 'custom';
    status: 'upcoming' | 'active' | 'finished';
    date: string;
    location?: string;
    posten_count: number;
    participant_count: number;
  }

  // ---- State -----------------------------------------------------------------

  let events = $state<EventCard[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

  const formatLabels: Record<string, string> = {
    autocross: 'Autocross',
    hillclimb: 'Hill Climb',
    rallyesprint: 'Rallye Sprint',
    custom: 'Custom'
  };

  // ---- Data fetching ---------------------------------------------------------

  async function fetchEvents() {
    loading = true;
    error = null;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/events/my`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      events = data.events;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load events';
    } finally {
      loading = false;
    }
  }

  onMount(fetchEvents);

  // ---- Helpers ---------------------------------------------------------------

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  function statusColor(status: string): string {
    switch (status) {
      case 'active': return 'status-active';
      case 'upcoming': return 'status-upcoming';
      case 'finished': return 'status-finished';
      default: return '';
    }
  }
</script>

<svelte:head>
  <title>Dashboard — Timing Hub</title>
</svelte:head>

<div class="dashboard-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">My Events</h1>
      <p class="page-subtitle">Manage your timing events</p>
    </div>
    <Button variant="primary" size="md" onclick={() => goto('/events/new')}>
      New Event
    </Button>
  </div>

  {#if loading}
    <!-- Skeleton cards -->
    <div class="event-grid">
      {#each { length: 4 } as _}
        <div class="event-card skeleton-card" aria-hidden="true">
          <div class="skeleton" style="width: 60%; height: 22px; margin-bottom: 8px;"></div>
          <div class="skeleton" style="width: 80px; height: 18px; margin-bottom: 16px;"></div>
          <div class="skeleton" style="width: 100px; height: 16px;"></div>
        </div>
      {/each}
    </div>

  {:else if error}
    <div class="error-state" role="alert">
      <p>{error}</p>
      <Button variant="secondary" size="sm" onclick={fetchEvents}>Retry</Button>
    </div>

  {:else if events.length === 0}
    <!-- Empty state -->
    <div class="empty-state">
      <div class="empty-illustration" aria-hidden="true">
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
          <circle cx="40" cy="40" r="40" fill="var(--color-surface-2)"/>
          <text x="40" y="52" text-anchor="middle" font-size="32" fill="var(--color-text-subtle)">⏱</text>
        </svg>
      </div>
      <h2 class="empty-title">No events yet</h2>
      <p class="empty-subtitle">Create your first timing event to get started.</p>
      <Button variant="primary" size="md" onclick={() => goto('/events/new')}>
        Create Event
      </Button>
    </div>

  {:else}
    <!-- Event grid -->
    <div class="event-grid">
      {#each events as event (event.id)}
        <a href="/events/{event.slug}" class="event-card event-card-link">
          <div class="card-header">
            <h2 class="card-title">{event.name}</h2>
            <span class="status-badge {statusColor(event.status)}">{event.status}</span>
          </div>

          <div class="card-meta">
            <span class="format-badge">{formatLabels[event.format] ?? event.format}</span>
            {#if event.location}
              <span class="meta-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
                {event.location}
              </span>
            {/if}
          </div>

          <div class="card-footer">
            <time class="card-date" datetime={event.date}>
              {formatDate(event.date)}
            </time>
            <div class="card-stats">
              <span class="stat">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                {event.participant_count}
              </span>
              <span class="stat">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                {event.posten_count} posts
              </span>
            </div>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dashboard-page {
    max-width: 1200px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 2rem;
    flex-wrap: wrap;
  }

  .page-title {
    font-size: 1.75rem;
    font-weight: 800;
    margin: 0 0 0.25rem;
    letter-spacing: -0.03em;
  }

  .page-subtitle {
    color: var(--color-text-muted);
    margin: 0;
    font-size: 0.9375rem;
  }

  /* Event grid */
  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  /* Event card */
  .event-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .event-card-link {
    text-decoration: none;
    color: inherit;
    transition: border-color 150ms, box-shadow 150ms;
  }

  .event-card-link:hover {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary);
  }

  .skeleton-card {
    padding: 1.25rem;
    min-height: 130px;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-title {
    font-size: 1.0625rem;
    font-weight: 700;
    margin: 0;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  .card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: auto;
  }

  .card-date {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .card-stats {
    display: flex;
    gap: 0.75rem;
  }

  .stat {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  /* Badges */
  .status-badge, .format-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .format-badge {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .status-active { background: var(--color-success-bg); color: var(--color-success); }
  .status-upcoming { background: var(--color-info-bg); color: var(--color-info); }
  .status-finished { background: var(--color-surface-2); color: var(--color-text-subtle); }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 4rem 2rem;
    text-align: center;
  }

  .empty-illustration {
    opacity: 0.7;
  }

  .empty-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
  }

  .empty-subtitle {
    color: var(--color-text-muted);
    margin: 0;
    font-size: 0.9375rem;
  }

  /* Error state */
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 3rem;
    text-align: center;
    color: var(--color-danger);
  }
</style>
