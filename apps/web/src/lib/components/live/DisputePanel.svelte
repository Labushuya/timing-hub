<script lang="ts">
  import type { TimeEntry } from './TimeEntryRow.svelte';

  interface Props {
    entry: TimeEntry | null;
    onVoid: (id: string, reason: string) => Promise<void>;
    onReassign: (id: string, startnummer: string) => Promise<void>;
    onClose: () => void;
  }

  let { entry, onVoid, onReassign, onClose }: Props = $props();

  // ---- Tab state --------------------------------------------------------------

  type Tab = 'void' | 'reassign';
  let activeTab = $state<Tab>('void');

  // ---- Void form --------------------------------------------------------------

  let voidReason = $state('');
  let voidLoading = $state(false);
  let voidError = $state<string | null>(null);

  const voidValid = $derived(voidReason.trim().length >= 5);

  async function handleVoid() {
    if (!entry || !voidValid) return;
    voidLoading = true;
    voidError = null;
    try {
      await onVoid(entry.id, voidReason.trim());
      voidReason = '';
    } catch (err) {
      voidError = err instanceof Error ? err.message : 'Fehler beim Ungültig-Markieren';
    } finally {
      voidLoading = false;
    }
  }

  // ---- Reassign form ----------------------------------------------------------

  let reassignNr = $state('');
  let reassignLoading = $state(false);
  let reassignError = $state<string | null>(null);

  const reassignValid = $derived(reassignNr.trim().length >= 1);

  async function handleReassign() {
    if (!entry || !reassignValid) return;
    reassignLoading = true;
    reassignError = null;
    try {
      await onReassign(entry.id, reassignNr.trim());
      reassignNr = '';
    } catch (err) {
      reassignError = err instanceof Error ? err.message : 'Fehler beim Neu-Zuweisen';
    } finally {
      reassignLoading = false;
    }
  }

  // ---- Reset on entry change --------------------------------------------------

  $effect(() => {
    if (entry) {
      // reset forms when a new entry is selected
      voidReason = '';
      voidError = null;
      reassignNr = entry.startnummer ?? '';
      reassignError = null;
      activeTab = 'void';
    }
  });
</script>

<div class="dispute-panel" role="complementary" aria-label="Eintragskorrektur">
  {#if !entry}
    <div class="empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="empty-icon">
        <circle cx="12" cy="12" r="10"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <p>Eintrag auswählen, um Korrektur vorzunehmen</p>
    </div>
  {:else}
    <!-- Selected entry details -->
    <div class="entry-preview">
      <div class="preview-label">Ausgewählter Eintrag</div>
      <div class="preview-row">
        <span class="preview-time">{entry.time_display}</span>
        <span class="preview-posten">{entry.posten_name}</span>
        {#if entry.startnummer}
          <span class="preview-nr">#{entry.startnummer}</span>
        {:else}
          <span class="preview-nr unknown">?</span>
        {/if}
        <span class="preview-source">{entry.source === 'timy' ? 'Timy' : 'Manuell'}</span>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tab-bar" role="tablist">
      <button
        class="tab-btn"
        class:active={activeTab === 'void'}
        role="tab"
        aria-selected={activeTab === 'void'}
        onclick={() => (activeTab = 'void')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        Ungültig markieren
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === 'reassign'}
        role="tab"
        aria-selected={activeTab === 'reassign'}
        onclick={() => (activeTab = 'reassign')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="17 1 21 5 17 9"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7 23 3 19 7 15"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
        Neu zuweisen
      </button>
    </div>

    <!-- Void form -->
    {#if activeTab === 'void'}
      <div class="form-section" role="tabpanel">
        <div class="form-group">
          <label class="form-label" for="void-reason">
            Grund für Ungültig-Markierung
            <span class="required" aria-hidden="true">*</span>
          </label>
          <textarea
            id="void-reason"
            class="form-textarea"
            class:invalid={voidReason.length > 0 && voidReason.trim().length < 5}
            placeholder="Begründung (min. 5 Zeichen)…"
            bind:value={voidReason}
            rows={3}
            maxlength={500}
            disabled={voidLoading}
          ></textarea>
          <div class="char-count" class:low={voidReason.trim().length < 5 && voidReason.length > 0}>
            {voidReason.trim().length}/500
          </div>
        </div>

        {#if voidError}
          <div class="form-error" role="alert">{voidError}</div>
        {/if}

        <div class="form-actions">
          <button class="btn btn-ghost" onclick={onClose} disabled={voidLoading}>
            Abbrechen
          </button>
          <button
            class="btn btn-danger"
            onclick={handleVoid}
            disabled={!voidValid || voidLoading}
            aria-disabled={!voidValid || voidLoading}
          >
            {#if voidLoading}
              <span class="btn-spinner" aria-hidden="true"></span>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
              </svg>
            {/if}
            Ungültig markieren
          </button>
        </div>
      </div>

    <!-- Reassign form -->
    {:else}
      <div class="form-section" role="tabpanel">
        <div class="form-group">
          <label class="form-label" for="reassign-nr">Neue Startnummer</label>
          <input
            id="reassign-nr"
            class="form-input"
            type="text"
            placeholder="z.B. 42"
            bind:value={reassignNr}
            maxlength="6"
            disabled={reassignLoading}
          />
        </div>

        {#if reassignError}
          <div class="form-error" role="alert">{reassignError}</div>
        {/if}

        <div class="form-actions">
          <button class="btn btn-ghost" onclick={onClose} disabled={reassignLoading}>
            Abbrechen
          </button>
          <button
            class="btn btn-primary"
            onclick={handleReassign}
            disabled={!reassignValid || reassignLoading}
          >
            {#if reassignLoading}
              <span class="btn-spinner" aria-hidden="true"></span>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            {/if}
            Neu zuweisen
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .dispute-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 10px);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.5rem 0;
    color: var(--color-text-muted);
    font-size: 0.875rem;
    text-align: center;
  }

  .empty-icon { opacity: 0.4; }

  .empty-state p { margin: 0; }

  /* Entry preview */
  .entry-preview {
    background: var(--color-surface-2, rgba(255,255,255,0.04));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    padding: 0.75rem 1rem;
  }

  .preview-label {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
    margin-bottom: 0.5rem;
  }

  .preview-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .preview-time {
    font-family: var(--font-mono, monospace);
    font-size: 0.9375rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }

  .preview-posten {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .preview-nr {
    font-family: var(--font-mono, monospace);
    font-size: 0.8125rem;
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }

  .preview-nr.unknown {
    color: #fb923c;
    border-color: rgba(249,115,22,0.3);
    background: rgba(249,115,22,0.1);
  }

  .preview-source {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  /* Tabs */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--color-border);
    gap: 0;
  }

  .tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    font-family: inherit;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    position: relative;
    top: 1px;
    transition: color 120ms, border-color 120ms;
    white-space: nowrap;
  }

  .tab-btn:hover { color: var(--color-text); }

  .tab-btn.active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary);
    font-weight: 600;
  }

  /* Form */
  .form-section {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    position: relative;
  }

  .form-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
  }

  .required { color: var(--color-danger, #ef4444); margin-left: 2px; }

  .form-input, .form-textarea {
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    padding: 0.5rem 0.75rem;
    font-size: 0.9375rem;
    color: var(--color-text);
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
    transition: border-color 150ms, box-shadow 150ms;
  }

  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
  }

  .form-input:disabled, .form-textarea:disabled { opacity: 0.55; }

  .form-textarea { resize: vertical; min-height: 72px; }

  .form-textarea.invalid {
    border-color: var(--color-danger, #ef4444);
  }

  .char-count {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    text-align: right;
  }

  .char-count.low { color: var(--color-danger, #ef4444); }

  .form-error {
    font-size: 0.8125rem;
    color: var(--color-danger, #ef4444);
    padding: 0.5rem 0.75rem;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: var(--radius-sm, 4px);
  }

  /* Actions */
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md, 6px);
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 150ms;
    white-space: nowrap;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-primary {
    background: var(--color-primary);
    color: white;
    border-color: transparent;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }

  .btn-danger {
    background: rgba(239,68,68,0.12);
    color: #f87171;
    border-color: rgba(239,68,68,0.25);
  }
  .btn-danger:hover:not(:disabled) {
    background: rgba(239,68,68,0.2);
  }

  .btn-ghost {
    background: transparent;
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }
  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  .btn-spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
