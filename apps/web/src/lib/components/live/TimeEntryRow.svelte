<script lang="ts">
  // ---- Types ------------------------------------------------------------------

  export interface TimeEntry {
    id: string;
    posten_id: string;
    posten_name: string;
    recorded_at: string;          // ISO-8601
    time_display: string;         // HH:MM:SS.ff
    startnummer: string | null;
    status: 'pending' | 'confirmed' | 'void';
    source: 'manual' | 'timy';
    void_reason?: string;
  }

  interface Props {
    entry: TimeEntry;
    onConfirm: (id: string, startnummer: string) => Promise<void>;
    onVoid: (entry: TimeEntry) => void;
  }

  let { entry, onConfirm, onVoid }: Props = $props();

  // ---- Local state ------------------------------------------------------------

  let confirmOpen = $state(false);
  let confirmNr = $state(entry.startnummer ?? '');
  let confirmLoading = $state(false);
  let confirmError = $state<string | null>(null);
  let menuOpen = $state(false);

  // ---- Derived ----------------------------------------------------------------

  const isUnconfirmed = $derived(entry.status === 'pending');
  const isVoid = $derived(entry.status === 'void');

  const postenRole = $derived((): 'start' | 'finish' | 'intermediate' | 'unknown' => {
    const n = entry.posten_name.toLowerCase();
    if (n.includes('start') || n.includes('ziel') === false && n.startsWith('s')) return 'start';
    if (n.includes('ziel') || n.includes('finish')) return 'finish';
    if (n.includes('zwischen') || n.includes('wp') || n.includes('sektor')) return 'intermediate';
    return 'unknown';
  });

  // ---- Actions ----------------------------------------------------------------

  async function handleConfirm() {
    const nr = confirmNr.trim();
    if (!nr) {
      confirmError = 'Startnummer eingeben';
      return;
    }
    confirmLoading = true;
    confirmError = null;
    try {
      await onConfirm(entry.id, nr);
      confirmOpen = false;
      confirmNr = '';
    } catch (err) {
      confirmError = err instanceof Error ? err.message : 'Fehler';
    } finally {
      confirmLoading = false;
    }
  }

  function handleVoidClick() {
    menuOpen = false;
    onVoid(entry);
  }

  function handleConfirmKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') { confirmOpen = false; confirmError = null; }
  }
</script>

<div
  class="entry-row"
  class:unconfirmed={isUnconfirmed}
  class:void={isVoid}
  role="row"
  aria-label="Zeiteintrag {entry.posten_name}"
>
  <!-- Time display -->
  <div class="col-time">
    <span class="time-mono" aria-label="Zeit">{entry.time_display}</span>
  </div>

  <!-- Posten badge -->
  <div class="col-posten">
    <span class="posten-badge posten-{postenRole()}" title="Posten: {entry.posten_name}">
      {entry.posten_name}
    </span>
  </div>

  <!-- Startnummer badge -->
  <div class="col-nr">
    {#if entry.startnummer}
      <span class="nr-badge confirmed" title="Startnummer {entry.startnummer}">
        #{entry.startnummer}
      </span>
    {:else}
      <span class="nr-badge unconfirmed" title="Startnummer unbekannt">?</span>
    {/if}
  </div>

  <!-- Source icon -->
  <div class="col-source">
    {#if entry.source === 'timy'}
      <!-- Lightning bolt = Timy -->
      <svg class="source-icon timy" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-label="Timy">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    {:else}
      <!-- Stopwatch = manual -->
      <svg class="source-icon manual" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Manuell">
        <circle cx="12" cy="13" r="8"/>
        <polyline points="12 9 12 13 14.5 15.5"/>
        <path d="M9 3h6"/>
        <line x1="12" y1="3" x2="12" y2="5"/>
      </svg>
    {/if}
  </div>

  <!-- Actions -->
  <div class="col-actions">
    {#if !isVoid}
      {#if confirmOpen}
        <!-- Inline confirm form -->
        <div class="confirm-inline" role="group" aria-label="Startnummer bestätigen">
          <input
            class="confirm-input"
            type="text"
            placeholder="Nr."
            bind:value={confirmNr}
            onkeydown={handleConfirmKeydown}
            maxlength="6"
            autofocus
            aria-label="Startnummer"
            aria-invalid={confirmError ? 'true' : undefined}
          />
          <button
            class="btn-confirm"
            onclick={handleConfirm}
            disabled={confirmLoading}
            aria-label="Bestätigen"
          >
            {#if confirmLoading}
              <span class="spinner" aria-hidden="true"></span>
            {:else}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            {/if}
          </button>
          <button
            class="btn-cancel"
            onclick={() => { confirmOpen = false; confirmError = null; }}
            aria-label="Abbrechen"
            disabled={confirmLoading}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        {#if confirmError}
          <div class="confirm-error" role="alert">{confirmError}</div>
        {/if}
      {:else}
        <button
          class="btn-action btn-ok"
          onclick={() => { confirmNr = entry.startnummer ?? ''; confirmOpen = true; }}
          title="Bestätigen"
          aria-label="Zeiteintrag bestätigen"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Bestätigen
        </button>
      {/if}
    {/if}

    <!-- More menu -->
    {#if !isVoid}
      <div class="menu-wrapper">
        <button
          class="btn-action btn-more"
          onclick={() => (menuOpen = !menuOpen)}
          aria-label="Weitere Aktionen"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.5"/>
            <circle cx="12" cy="12" r="1.5"/>
            <circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {#if menuOpen}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="dropdown-menu"
            role="menu"
            onmouseleave={() => (menuOpen = false)}
          >
            <button class="dropdown-item danger" role="menuitem" onclick={handleVoidClick}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
              </svg>
              Ungültig markieren
            </button>
          </div>
        {/if}
      </div>
    {/if}

    {#if isVoid}
      <span class="void-label" title={entry.void_reason ?? ''}>Ungültig</span>
    {/if}
  </div>
</div>

<style>
  .entry-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border-subtle, rgba(255,255,255,0.06));
    transition: background-color 150ms;
    position: relative;
  }

  .entry-row:hover {
    background: var(--color-surface-2, rgba(255,255,255,0.03));
  }

  .entry-row.unconfirmed {
    border-left: 3px solid #f97316;
    padding-left: calc(0.75rem - 3px);
  }

  .entry-row.void {
    opacity: 0.45;
    background: repeating-linear-gradient(
      135deg,
      transparent,
      transparent 4px,
      rgba(255,255,255,0.02) 4px,
      rgba(255,255,255,0.02) 8px
    );
  }

  /* Time */
  .time-mono {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    white-space: nowrap;
    color: var(--color-text);
  }

  /* Posten badge */
  .posten-badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm, 4px);
    white-space: nowrap;
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .posten-start    { background: rgba(34,197,94,0.15);  color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
  .posten-finish   { background: rgba(239,68,68,0.15);  color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .posten-intermediate { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
  .posten-unknown  { background: var(--color-surface-2); color: var(--color-text-muted); border: 1px solid var(--color-border); }

  /* Startnummer badge */
  .nr-badge {
    font-family: var(--font-mono, monospace);
    font-size: 0.875rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    white-space: nowrap;
  }

  .nr-badge.confirmed  { background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border); }
  .nr-badge.unconfirmed { background: rgba(249,115,22,0.15); color: #fb923c; border: 1px solid rgba(249,115,22,0.35); font-weight: 800; }

  /* Source icons */
  .source-icon { flex-shrink: 0; }
  .source-icon.timy   { color: #a78bfa; }
  .source-icon.manual { color: var(--color-text-muted); }

  /* Action buttons */
  .col-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .btn-action {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.625rem;
    border-radius: var(--radius-sm, 4px);
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 120ms;
    white-space: nowrap;
    font-family: inherit;
    background: transparent;
  }

  .btn-ok {
    color: #4ade80;
    border-color: rgba(34,197,94,0.3);
    background: rgba(34,197,94,0.08);
  }
  .btn-ok:hover { background: rgba(34,197,94,0.16); }

  .btn-more {
    color: var(--color-text-muted);
    border-color: var(--color-border);
    padding: 0.3rem 0.4rem;
  }
  .btn-more:hover { color: var(--color-text); background: var(--color-surface-2); }

  /* Confirm inline */
  .confirm-inline {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .confirm-input {
    width: 5rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-surface-2);
    color: var(--color-text);
    font-family: var(--font-mono, monospace);
    font-size: 0.875rem;
    font-weight: 600;
    text-align: center;
  }
  .confirm-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(99,102,241,0.25);
  }

  .btn-confirm, .btn-cancel {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid transparent;
    cursor: pointer;
    font-size: 0;
    transition: all 120ms;
    flex-shrink: 0;
  }

  .btn-confirm {
    background: rgba(34,197,94,0.15);
    color: #4ade80;
    border-color: rgba(34,197,94,0.3);
  }
  .btn-confirm:hover:not(:disabled) { background: rgba(34,197,94,0.25); }
  .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-cancel {
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }
  .btn-cancel:hover:not(:disabled) { color: var(--color-danger, #ef4444); }

  .confirm-error {
    font-size: 0.7rem;
    color: var(--color-danger, #ef4444);
    position: absolute;
    bottom: 2px;
    right: 0.75rem;
  }

  /* Dropdown menu */
  .menu-wrapper {
    position: relative;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    min-width: 160px;
    z-index: 50;
    overflow: hidden;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    font-family: inherit;
    background: transparent;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
    color: var(--color-text);
    transition: background 120ms;
  }

  .dropdown-item:hover { background: var(--color-surface-2); }
  .dropdown-item.danger { color: var(--color-danger, #ef4444); }
  .dropdown-item.danger:hover { background: rgba(239,68,68,0.08); }

  /* Void label */
  .void-label {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--color-danger, #ef4444);
    opacity: 0.7;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(74,222,128,0.4);
    border-top-color: #4ade80;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 600px) {
    .entry-row {
      grid-template-columns: auto auto 1fr auto;
      grid-template-rows: auto auto;
    }

    .col-source { display: none; }

    .col-actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
      padding-top: 0.25rem;
    }
  }
</style>
