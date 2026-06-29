<script lang="ts">
  import { page } from '$app/stores';
  import type { Event } from '@timing-hub/shared-types';

  interface Props {
    data: { event: Event };
    children: import('svelte').Snippet;
  }

  let { data, children }: Props = $props();

  const event = $derived(data.event);
  const currentPath = $derived($page.url.pathname);
  const slug = $derived(event.slug);

  const tabs = $derived([
    { href: `/events/${slug}`, label: 'Übersicht', exact: true },
    { href: `/events/${slug}/participants`, label: 'Teilnehmer' },
    { href: `/events/${slug}/posten`, label: 'Posten' },
    ...(event.status === 'active'
      ? [{ href: `/events/${slug}/live`, label: 'Live', highlight: true }]
      : []),
    { href: `/events/${slug}/ergebnisse`, label: 'Ergebnisse' }
  ]);

  function isTabActive(href: string, exact = false): boolean {
    if (exact) return currentPath === href;
    return currentPath === href || currentPath.startsWith(href + '/');
  }

  const statusColors: Record<string, string> = {
    draft: 'status-draft',
    active: 'status-active',
    finished: 'status-finished',
    archived: 'status-archived'
  };

  const statusLabels: Record<string, string> = {
    draft: 'Entwurf',
    active: 'Aktiv',
    finished: 'Beendet',
    archived: 'Archiviert'
  };
</script>

<div class="event-layout">
  <!-- Breadcrumb -->
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/dashboard" class="breadcrumb-link">Dashboard</a>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="breadcrumb-sep">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
    <span class="breadcrumb-current">{event.name}</span>
  </nav>

  <!-- Event header -->
  <div class="event-header">
    <div class="event-header-main">
      <h1 class="event-name">{event.name}</h1>
      <span class="status-badge {statusColors[event.status] ?? ''}">
        {#if event.status === 'active'}
          <span class="pulse-dot" aria-hidden="true"></span>
        {/if}
        {statusLabels[event.status] ?? event.status}
      </span>
    </div>
    {#if event.description}
      <p class="event-description">{event.description}</p>
    {/if}
  </div>

  <!-- Tab navigation -->
  <nav class="tab-nav" aria-label="Veranstaltungs-Navigation">
    <div class="tab-list" role="tablist">
      {#each tabs as tab}
        <a
          href={tab.href}
          class="tab-link"
          class:active={isTabActive(tab.href, tab.exact)}
          class:highlight={tab.highlight}
          role="tab"
          aria-selected={isTabActive(tab.href, tab.exact)}
        >
          {#if tab.highlight && event.status === 'active'}
            <span class="live-indicator" aria-hidden="true"></span>
          {/if}
          {tab.label}
        </a>
      {/each}
    </div>
  </nav>

  <!-- Page content -->
  <div class="event-content">
    {@render children()}
  </div>
</div>

<style>
  .event-layout {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 1.25rem;
  }

  .breadcrumb-link {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    text-decoration: none;
    transition: color 150ms;
  }
  .breadcrumb-link:hover { color: var(--color-text); }

  .breadcrumb-sep { color: var(--color-text-muted); opacity: 0.5; }

  .breadcrumb-current {
    font-size: 0.875rem;
    color: var(--color-text-subtle, var(--color-text-muted));
    font-weight: 500;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Event header */
  .event-header {
    margin-bottom: 1.5rem;
  }

  .event-header-main {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex-wrap: wrap;
  }

  .event-name {
    font-size: 1.625rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    margin: 0;
  }

  .event-description {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
    margin: 0.375rem 0 0;
  }

  /* Status badge */
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.25rem 0.65rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .status-draft {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .status-active {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.25);
  }

  .status-finished {
    background: rgba(59, 130, 246, 0.12);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.2);
  }

  .status-archived {
    background: var(--color-surface-2);
    color: var(--color-text-subtle, var(--color-text-muted));
    border: 1px solid var(--color-border);
    opacity: 0.7;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse-ring 1.5s ease-in-out infinite;
  }
  @keyframes pulse-ring {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.7); }
  }

  /* Tabs */
  .tab-nav {
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 2rem;
  }

  .tab-list {
    display: flex;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab-list::-webkit-scrollbar { display: none; }

  .tab-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.75rem 1.125rem;
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    transition: color 150ms, border-color 150ms;
    white-space: nowrap;
    position: relative;
    top: 1px;
  }

  .tab-link:hover { color: var(--color-text); }

  .tab-link.active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary);
    font-weight: 600;
  }

  .tab-link.highlight { color: #4ade80; }
  .tab-link.highlight.active { border-bottom-color: #4ade80; }

  .live-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse-ring 1.5s ease-in-out infinite;
  }

  .event-content {
    min-height: 0;
  }
</style>
