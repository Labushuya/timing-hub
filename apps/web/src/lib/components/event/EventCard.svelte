<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Event } from '@timing-hub/shared-types';

  interface Props {
    event: Event;
  }

  let { event }: Props = $props();

  const formatLabels: Record<string, string> = {
    glp: 'GLP',
    sonderpruefung: 'SP',
    rundstrecke: 'Rundstrecke',
    orientierung: 'Orientierung'
  };

  function formatBadgeClass(format: string): string {
    switch (format) {
      case 'glp': return 'badge-format badge-glp';
      case 'sonderpruefung': return 'badge-format badge-sp';
      case 'rundstrecke': return 'badge-format badge-rundstrecke';
      case 'orientierung': return 'badge-format badge-orientierung';
      default: return 'badge-format';
    }
  }

  function statusBadgeClass(status: string): string {
    switch (status) {
      case 'draft': return 'badge-status badge-draft';
      case 'active': return 'badge-status badge-active';
      case 'finished': return 'badge-status badge-finished';
      case 'archived': return 'badge-status badge-archived';
      default: return 'badge-status';
    }
  }

  const statusLabels: Record<string, string> = {
    draft: 'Entwurf',
    active: 'Aktiv',
    finished: 'Beendet',
    archived: 'Archiviert'
  };

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString('de-DE', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  function handleClick() {
    goto(`/events/${event.slug}`);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }
</script>

<article
  class="event-card"
  role="button"
  tabindex="0"
  onclick={handleClick}
  onkeydown={handleKeydown}
  aria-label="Event {event.name} öffnen"
>
  <div class="card-header">
    <h2 class="card-title">{event.name}</h2>
    <div class="card-badges">
      <span class={formatBadgeClass(event.format)}>
        {formatLabels[event.format] ?? event.format}
      </span>
      <span class={statusBadgeClass(event.status)}>
        {#if event.status === 'active'}
          <span class="pulse-dot" aria-hidden="true"></span>
        {/if}
        {statusLabels[event.status] ?? event.status}
      </span>
    </div>
  </div>

  {#if event.description}
    <p class="card-description">{event.description}</p>
  {/if}

  <div class="card-footer">
    <time class="card-date" datetime={event.starts_at}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      {formatDate(event.starts_at)}
    </time>

    <div class="card-stats">
      <span class="stat" title="Teilnehmer">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span class="stat-value">—</span>
      </span>
      <span class="stat" title="Posten">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="stat-value">—</span>
      </span>
    </div>
  </div>
</article>

<style>
  .event-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    cursor: pointer;
    transition: border-color 150ms, box-shadow 150ms, transform 100ms;
    text-align: left;
    outline: none;
    position: relative;
    overflow: hidden;
  }

  .event-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, transparent 60%, rgba(255,255,255,0.02));
    pointer-events: none;
  }

  .event-card:hover {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary), 0 4px 16px rgba(0,0,0,0.3);
    transform: translateY(-1px);
  }

  .event-card:focus-visible {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-primary);
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .card-title {
    font-size: 1.0625rem;
    font-weight: 700;
    margin: 0;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: var(--color-text);
  }

  .card-badges {
    display: flex;
    gap: 0.375rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .badge-format,
  .badge-status {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.2rem 0.55rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    white-space: nowrap;
  }

  /* Format colors */
  .badge-glp {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .badge-sp {
    background: rgba(251, 146, 60, 0.15);
    color: #fb923c;
    border: 1px solid rgba(251, 146, 60, 0.3);
  }

  .badge-rundstrecke {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.25);
  }

  .badge-orientierung {
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    border: 1px solid rgba(168, 85, 247, 0.3);
  }

  /* Status colors */
  .badge-draft {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .badge-active {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.25);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .badge-finished {
    background: rgba(59, 130, 246, 0.12);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.2);
  }

  .badge-archived {
    background: var(--color-surface-2);
    color: var(--color-text-subtle);
    border: 1px solid var(--color-border);
    opacity: 0.7;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse-ring 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse-ring {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.7); }
  }

  .card-description {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: auto;
    padding-top: 0.25rem;
    border-top: 1px solid var(--color-border);
  }

  .card-date {
    display: flex;
    align-items: center;
    gap: 0.35rem;
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
    gap: 0.3rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .stat-value {
    font-variant-numeric: tabular-nums;
  }
</style>
