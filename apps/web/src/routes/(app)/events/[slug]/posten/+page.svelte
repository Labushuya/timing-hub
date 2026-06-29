<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api/client.js';
  import type { Posten, Event } from '@timing-hub/shared-types';
  import QRShareModal from '$lib/components/posten/QRShareModal.svelte';

  interface Props {
    data: { event: Event };
  }

  let { data }: Props = $props();

  const event = $derived(data.event);

  // ---- State ------------------------------------------------------------------

  let posten = $state<Posten[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // Add form
  let showAddForm = $state(false);
  let addName = $state('');
  let addCode = $state('');
  let addRole = $state<Posten['role']>('intermediate');
  let addSaving = $state(false);
  let addError = $state<string | null>(null);

  // QR modal
  let qrPosten = $state<Posten | null>(null);

  // Copy feedback
  let copiedId = $state<string | null>(null);

  // ---- Data -------------------------------------------------------------------

  async function loadPosten() {
    loading = true;
    loadError = null;
    try {
      const { posten: list } = await api.posten.listPosten(event.slug);
      posten = (list as Posten[]).sort((a, b) => a.sort_order - b.sort_order);
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Fehler beim Laden';
    } finally {
      loading = false;
    }
  }

  onMount(loadPosten);

  // ---- Add Posten -------------------------------------------------------------

  function openAddForm() {
    addName = '';
    addCode = '';
    addRole = 'intermediate';
    addError = null;
    showAddForm = true;
  }

  function cancelAdd() {
    showAddForm = false;
    addError = null;
  }

  async function submitAdd() {
    if (addSaving) return;
    if (!addName.trim() || !addCode.trim()) {
      addError = 'Name und Code sind Pflichtfelder';
      return;
    }
    addSaving = true;
    addError = null;
    try {
      const { posten: created } = await api.posten.createPosten(event.slug, {
        name: addName.trim(),
        code: addCode.trim().toUpperCase(),
        role: addRole,
        sort_order: posten.length + 1
      });
      posten = [...posten, created].sort((a, b) => a.sort_order - b.sort_order);
      showAddForm = false;
    } catch (err) {
      addError = err instanceof Error ? err.message : 'Fehler beim Hinzufügen';
    } finally {
      addSaving = false;
    }
  }

  // ---- Helpers ----------------------------------------------------------------

  const roleLabels: Record<Posten['role'], string> = {
    start: 'Start',
    finish: 'Ziel',
    intermediate: 'Zwischen',
    sector_split: 'Sektor'
  };

  const roleColors: Record<Posten['role'], string> = {
    start: 'role-start',
    finish: 'role-finish',
    intermediate: 'role-intermediate',
    sector_split: 'role-sector'
  };

  function zeitnehmerUrl(p: Posten): string {
    return `https://timinghub.de/p/${event.slug}/${p.access_token}`;
  }

  async function copyToken(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = id;
      setTimeout(() => { copiedId = null; }, 1500);
    } catch {
      // fallback: select text
    }
  }
</script>

<svelte:head>
  <title>Posten — {event.name} — Timing Hub</title>
</svelte:head>

<div class="posten-page">
  <div class="page-header">
    <div>
      <h2 class="page-title">Posten</h2>
      <p class="page-subtitle">Zeitnahmestellen der Veranstaltung</p>
    </div>
    <button class="btn btn-primary" onclick={openAddForm} disabled={showAddForm}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Posten hinzufügen
    </button>
  </div>

  <!-- Add form (inline) -->
  {#if showAddForm}
    <div class="add-form-card">
      <h3 class="add-form-title">Neuer Posten</h3>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="add-name">Name *</label>
          <input id="add-name" type="text" class="form-input" bind:value={addName} placeholder="z.B. Startlinie" autofocus />
        </div>
        <div class="form-group">
          <label class="form-label" for="add-code">Code *</label>
          <input id="add-code" type="text" class="form-input code-input" bind:value={addCode} placeholder="z.B. S1" maxlength="8" />
        </div>
      </div>
      <div class="form-group">
        <div class="form-label">Rolle</div>
        <div class="role-grid">
          {#each Object.entries(roleLabels) as [val, label]}
            <button
              type="button"
              class="role-btn"
              class:selected={addRole === val}
              onclick={() => (addRole = val as Posten['role'])}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>
      {#if addError}
        <div class="error-msg" role="alert">{addError}</div>
      {/if}
      <div class="add-form-actions">
        <button class="btn btn-ghost" onclick={cancelAdd} disabled={addSaving}>Abbrechen</button>
        <button class="btn btn-primary" onclick={submitAdd} disabled={addSaving}>
          {#if addSaving}
            <span class="btn-spinner" aria-hidden="true"></span>
          {/if}
          Hinzufügen
        </button>
      </div>
    </div>
  {/if}

  <!-- Loading state -->
  {#if loading}
    <div class="posten-list">
      {#each { length: 3 } as _}
        <div class="posten-card skeleton-card" aria-hidden="true">
          <div class="skeleton" style="width:120px;height:18px;margin-bottom:6px"></div>
          <div class="skeleton" style="width:80px;height:14px"></div>
        </div>
      {/each}
    </div>

  {:else if loadError}
    <div class="error-state" role="alert">
      <p>{loadError}</p>
      <button class="btn btn-ghost" onclick={loadPosten}>Erneut laden</button>
    </div>

  {:else if posten.length === 0 && !showAddForm}
    <div class="empty-state">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true" style="opacity:.35">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      <p class="empty-text">Noch keine Posten angelegt. Füge den ersten Posten hinzu.</p>
      <button class="btn btn-primary" onclick={openAddForm}>Posten hinzufügen</button>
    </div>

  {:else}
    <div class="posten-list" role="list">
      {#each posten as p (p.id)}
        <div class="posten-card" role="listitem">
          <div class="posten-header">
            <div class="posten-identity">
              <span class="posten-code">{p.code}</span>
              <h3 class="posten-name">{p.name}</h3>
            </div>
            <span class="role-badge {roleColors[p.role]}">{roleLabels[p.role]}</span>
          </div>

          <div class="posten-tokens">
            <!-- Zeitnehmer URL -->
            <div class="token-row">
              <span class="token-label">Zeitnehmer-URL</span>
              <div class="token-value-wrap">
                <code class="token-value">{zeitnehmerUrl(p)}</code>
                <button
                  class="copy-btn"
                  onclick={() => copyToken(zeitnehmerUrl(p), p.id + '-url')}
                  title="URL kopieren"
                  aria-label="Zeitnehmer-URL kopieren"
                >
                  {#if copiedId === p.id + '-url'}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  {:else}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  {/if}
                </button>
              </div>
            </div>

            <!-- Bridge token (if present) -->
            {#if p.bridge_token}
              <div class="token-row">
                <span class="token-label">Bridge-Token</span>
                <div class="token-value-wrap">
                  <code class="token-value token-mono">{p.bridge_token}</code>
                  <button
                    class="copy-btn"
                    onclick={() => copyToken(p.bridge_token!, p.id + '-bridge')}
                    title="Bridge-Token kopieren"
                    aria-label="Bridge-Token kopieren"
                  >
                    {#if copiedId === p.id + '-bridge'}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                    {:else}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    {/if}
                  </button>
                </div>
              </div>
            {/if}
          </div>

          <div class="posten-actions">
            <button
              class="btn btn-ghost btn-sm qr-trigger"
              onclick={() => (qrPosten = p)}
              title="QR-Code anzeigen"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
              QR-Code
            </button>
            <a
              href={zeitnehmerUrl(p)}
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost btn-sm"
              title="Zeitnehmer-Seite öffnen"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Öffnen
            </a>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- QR Share Modal -->
{#if qrPosten}
  <QRShareModal
    url={zeitnehmerUrl(qrPosten)}
    postenName={qrPosten.name}
    onclose={() => (qrPosten = null)}
  />
{/if}

<style>
  .posten-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .page-title {
    font-size: 1.25rem;
    font-weight: 800;
    margin: 0 0 0.25rem;
    letter-spacing: -0.02em;
  }

  .page-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  /* Add form card */
  .add-form-card {
    background: var(--color-surface);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 0 0 1px var(--color-primary);
  }

  .add-form-title {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }

  .add-form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* Form elements */
  .form-group { display: flex; flex-direction: column; gap: 0.375rem; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .form-label { font-size: 0.875rem; font-weight: 600; color: var(--color-text-muted); }

  .form-input {
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.75rem;
    font-size: 0.9375rem;
    color: var(--color-text);
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
    transition: border-color 150ms, box-shadow 150ms;
  }
  .form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 99,102,241), 0.25);
  }
  .code-input { font-family: var(--font-mono, monospace); text-transform: uppercase; }

  /* Role grid */
  .role-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }

  .role-btn {
    padding: 0.5rem 0.75rem;
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
  }
  .role-btn:hover { border-color: var(--color-primary); color: var(--color-text); }
  .role-btn.selected {
    border-color: var(--color-primary);
    background: rgba(var(--color-primary-rgb, 99,102,241), 0.1);
    color: var(--color-primary);
  }

  /* Posten list */
  .posten-list {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .posten-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    transition: border-color 150ms;
  }

  .posten-card:hover { border-color: var(--color-border-hover, var(--color-primary)); }

  .posten-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .posten-identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .posten-code {
    font-size: 0.75rem;
    font-weight: 700;
    font-family: var(--font-mono, monospace);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.2rem 0.5rem;
    color: var(--color-text-muted);
    white-space: nowrap;
    letter-spacing: 0.05em;
  }

  .posten-name {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Role badge */
  .role-badge {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.2rem 0.55rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .role-start {
    background: rgba(34, 197, 94, 0.12);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.25);
  }

  .role-finish {
    background: rgba(239, 68, 68, 0.12);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.25);
  }

  .role-intermediate {
    background: rgba(251, 191, 36, 0.12);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.25);
  }

  .role-sector {
    background: rgba(168, 85, 247, 0.12);
    color: #c084fc;
    border: 1px solid rgba(168, 85, 247, 0.25);
  }

  /* Tokens */
  .posten-tokens {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
  }

  .token-row {
    display: grid;
    grid-template-columns: 120px 1fr;
    align-items: center;
    gap: 0.75rem;
    min-height: 28px;
  }

  .token-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .token-value-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .token-value {
    font-size: 0.8125rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .token-mono {
    letter-spacing: 0.06em;
  }

  .copy-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
  }
  .copy-btn:hover {
    background: var(--color-surface);
    border-color: var(--color-border);
    color: var(--color-text);
  }

  /* Actions row */
  .posten-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.625rem 1.25rem;
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    text-decoration: none;
    white-space: nowrap;
  }
  .btn-primary { background: var(--color-primary); color: white; }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }
  .btn-ghost:hover { color: var(--color-text); background: var(--color-surface-2); }
  .btn-sm { padding: 0.375rem 0.875rem; font-size: 0.875rem; }

  .btn-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-msg {
    font-size: 0.875rem;
    color: var(--color-danger, #ef4444);
  }

  /* Empty / error states */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 3rem 1.5rem;
    text-align: center;
  }

  .empty-text {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
    margin: 0;
    max-width: 360px;
  }

  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 3rem;
    text-align: center;
    color: var(--color-danger, #ef4444);
  }

  /* Skeleton */
  .skeleton-card { min-height: 120px; }

  .skeleton {
    background: var(--color-surface-2);
    border-radius: var(--radius-sm);
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }

  @media (max-width: 600px) {
    .role-grid { grid-template-columns: repeat(2, 1fr); }
    .form-row { grid-template-columns: 1fr; }
    .token-row { grid-template-columns: 1fr; }
    .token-label { display: none; }
  }
</style>
