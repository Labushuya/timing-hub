<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { api, APIError } from '$lib/api/client.js';
  import type { Event, EventFormat } from '@timing-hub/shared-types';

  interface Props {
    data: { event: Event };
  }

  let { data }: Props = $props();

  const event = $derived(data.event);

  // ---- Status actions ---------------------------------------------------------

  let actionLoading = $state(false);
  let actionError = $state<string | null>(null);

  async function activateEvent() {
    if (actionLoading) return;
    actionLoading = true;
    actionError = null;
    try {
      await api.events.activateEvent(event.slug);
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Fehler beim Aktivieren';
    } finally {
      actionLoading = false;
    }
  }

  async function finishEvent() {
    if (actionLoading) return;
    const confirmed = window.confirm(`Veranstaltung "${event.name}" wirklich beenden?`);
    if (!confirmed) return;
    actionLoading = true;
    actionError = null;
    try {
      await api.events.finishEvent(event.slug);
      await invalidateAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : 'Fehler beim Beenden';
    } finally {
      actionLoading = false;
    }
  }

  // ---- Edit mode --------------------------------------------------------------

  let editMode = $state(false);
  let editName = $state('');
  let editDescription = $state('');
  let editStartsAt = $state('');
  let editEndsAt = $state('');
  let editSaving = $state(false);
  let editError = $state<string | null>(null);

  function startEdit() {
    editName = event.name;
    editDescription = event.description ?? '';
    editStartsAt = event.starts_at ? toLocalDatetimeValue(event.starts_at) : '';
    editEndsAt = event.ends_at ? toLocalDatetimeValue(event.ends_at) : '';
    editMode = true;
    editError = null;
  }

  function cancelEdit() {
    editMode = false;
    editError = null;
  }

  async function saveEdit() {
    if (editSaving) return;
    editSaving = true;
    editError = null;
    try {
      await api.events.updateEvent(event.slug, {
        ...(editName.trim() ? { name: editName.trim() } : {}),
        ...(editDescription.trim() ? { description: editDescription.trim() } : {}),
        ...(editStartsAt ? { starts_at: new Date(editStartsAt).toISOString() } : {}),
        ...(editEndsAt ? { ends_at: new Date(editEndsAt).toISOString() } : {})
      });
      editMode = false;
      await invalidateAll();
    } catch (err) {
      editError = err instanceof Error ? err.message : 'Fehler beim Speichern';
    } finally {
      editSaving = false;
    }
  }

  // ---- QR state ---------------------------------------------------------------

  let qrVisible = $state(false);

  // ---- Helpers ----------------------------------------------------------------

  const formatLabels: Record<EventFormat, string> = {
    glp: 'GLP — Gleichmäßigkeitsprüfung',
    sonderpruefung: 'SP — Sonderprüfung',
    rundstrecke: 'Rundstreckenrennen',
    orientierung: 'Orientierungsfahrt'
  };

  function formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleString('de-DE', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch { return dateStr; }
  }

  function toLocalDatetimeValue(isoStr: string): string {
    try {
      const d = new Date(isoStr);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  }

  function configSummary(ev: Event): string {
    const c = ev.config;
    switch (c.format) {
      case 'glp':
        return `${c.scoring === 'absolute_deviation' ? 'Abweichung' : 'Prozent'} · ${c.penalty_per_second} Pkt/Sek${c.max_penalty != null ? ` · Max ${c.max_penalty}` : ''}`;
      case 'sonderpruefung':
        return `${c.sectors.length} Sektor${c.sectors.length !== 1 ? 'en' : ''} · Gleichstand: ${c.ties_broken_by === 'earliest_start' ? 'Frühester Start' : 'Seed-Zeit'}`;
      case 'rundstrecke': {
        const parts: string[] = [];
        if (c.total_laps) parts.push(`${c.total_laps} Runden`);
        if (c.duration_ms) parts.push(`${Math.round(c.duration_ms/60000)} Min`);
        if (c.standing_start) parts.push('Standing Start');
        return parts.join(' · ') || '—';
      }
      case 'orientierung':
        return `${c.sections.length} Sektion${c.sections.length !== 1 ? 'en' : ''} · Spät ${c.late_penalty_per_second}/Sek · Früh ${c.early_penalty_per_second}/Sek`;
      default:
        return '—';
    }
  }

  const publicResultsUrl = $derived(`https://timinghub.de/results/${event.slug}`);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(publicResultsUrl);
    } catch {
      // ignore
    }
  }
</script>

<svelte:head>
  <title>{event.name} — Timing Hub</title>
</svelte:head>

<div class="overview-page">
  <!-- Top row: status card + quick stats -->
  <div class="top-grid">
    <!-- Status card -->
    <div class="card status-card">
      <div class="card-label">Status</div>
      <div class="status-display">
        {#if event.status === 'active'}
          <span class="status-dot active" aria-hidden="true"></span>
          <span class="status-text active">Aktiv</span>
        {:else if event.status === 'draft'}
          <span class="status-dot draft" aria-hidden="true"></span>
          <span class="status-text">Entwurf</span>
        {:else if event.status === 'finished'}
          <span class="status-dot finished" aria-hidden="true"></span>
          <span class="status-text finished">Beendet</span>
        {:else}
          <span class="status-dot archived" aria-hidden="true"></span>
          <span class="status-text muted">Archiviert</span>
        {/if}
      </div>

      {#if event.status === 'draft'}
        <button class="btn btn-primary" onclick={activateEvent} disabled={actionLoading}>
          {#if actionLoading}
            <span class="btn-spinner" aria-hidden="true"></span>
          {/if}
          Veranstaltung aktivieren
        </button>
      {:else if event.status === 'active'}
        <button class="btn btn-danger" onclick={finishEvent} disabled={actionLoading}>
          {#if actionLoading}
            <span class="btn-spinner" aria-hidden="true"></span>
          {/if}
          Veranstaltung beenden
        </button>
      {/if}

      {#if actionError}
        <div class="error-msg" role="alert">{actionError}</div>
      {/if}
    </div>

    <!-- Quick stats -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="stat-body">
          <div class="stat-value">—</div>
          <div class="stat-label">Teilnehmer</div>
        </div>
        <a href="/events/{event.slug}/participants" class="stat-link" aria-label="Teilnehmer verwalten">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </a>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div class="stat-body">
          <div class="stat-value">—</div>
          <div class="stat-label">Posten</div>
        </div>
        <a href="/events/{event.slug}/posten" class="stat-link" aria-label="Posten verwalten">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </a>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </div>
        <div class="stat-body">
          <div class="stat-value">—</div>
          <div class="stat-label">Zeiteinträge</div>
        </div>
        <a href="/events/{event.slug}/ergebnisse" class="stat-link" aria-label="Ergebnisse ansehen">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </a>
      </div>
    </div>
  </div>

  <!-- Event details card -->
  <div class="card details-card">
    <div class="card-header-row">
      <h2 class="card-title">Veranstaltungsdetails</h2>
      {#if !editMode && event.status !== 'finished' && event.status !== 'archived'}
        <button class="btn btn-ghost btn-sm" onclick={startEdit}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Bearbeiten
        </button>
      {/if}
    </div>

    {#if editMode}
      <div class="edit-form">
        <div class="form-group">
          <label class="form-label" for="edit-name">Name</label>
          <input id="edit-name" type="text" class="form-input" bind:value={editName} maxlength="120" />
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-desc">Beschreibung</label>
          <textarea id="edit-desc" class="form-textarea" bind:value={editDescription} rows={3}></textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="edit-starts">Startzeit</label>
            <input id="edit-starts" type="datetime-local" class="form-input" bind:value={editStartsAt} />
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-ends">Endzeit</label>
            <input id="edit-ends" type="datetime-local" class="form-input" bind:value={editEndsAt} />
          </div>
        </div>
        {#if editError}
          <div class="error-msg" role="alert">{editError}</div>
        {/if}
        <div class="edit-actions">
          <button class="btn btn-ghost btn-sm" onclick={cancelEdit} disabled={editSaving}>Abbrechen</button>
          <button class="btn btn-primary btn-sm" onclick={saveEdit} disabled={editSaving}>
            {#if editSaving}
              <span class="btn-spinner sm" aria-hidden="true"></span>
            {/if}
            Speichern
          </button>
        </div>
      </div>
    {:else}
      <dl class="details-grid">
        <div class="detail-item">
          <dt>Format</dt>
          <dd>{formatLabels[event.format] ?? event.format}</dd>
        </div>
        <div class="detail-item">
          <dt>Startzeit</dt>
          <dd>{formatDate(event.starts_at)}</dd>
        </div>
        {#if event.ends_at}
          <div class="detail-item">
            <dt>Endzeit</dt>
            <dd>{formatDate(event.ends_at)}</dd>
          </div>
        {/if}
        <div class="detail-item">
          <dt>Zeitzone</dt>
          <dd>{event.timezone}</dd>
        </div>
        <div class="detail-item detail-item-full">
          <dt>Konfiguration</dt>
          <dd class="config-summary">{configSummary(event)}</dd>
        </div>
        {#if event.description}
          <div class="detail-item detail-item-full">
            <dt>Beschreibung</dt>
            <dd>{event.description}</dd>
          </div>
        {/if}
      </dl>
    {/if}
  </div>

  <!-- Public results QR / link -->
  <div class="card qr-card">
    <div class="card-header-row">
      <div>
        <h2 class="card-title">Öffentliche Ergebnisseite</h2>
        <p class="card-subtitle">Diesen Link an Fahrer und Zuschauer weitergeben</p>
      </div>
    </div>

    <div class="qr-row">
      <div class="url-display">
        <span class="url-text">{publicResultsUrl}</span>
        <button class="btn btn-ghost btn-sm" onclick={copyUrl} title="URL kopieren">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Kopieren
        </button>
        <a href={publicResultsUrl} target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Öffnen
        </a>
      </div>

      <button class="btn btn-ghost btn-sm qr-btn" onclick={() => (qrVisible = !qrVisible)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
        QR-Code
      </button>
    </div>

    {#if qrVisible}
      <div class="qr-inline">
        <p class="qr-placeholder">QR-Code wird in der Posten-Ansicht generiert.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .overview-page {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .top-grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 1.25rem;
    align-items: start;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
  }

  .card-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
    margin-bottom: 0.875rem;
  }

  .card-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }

  .card-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
  }

  /* Status card */
  .status-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .status-display {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.active {
    background: #4ade80;
    animation: pulse-ring 1.5s ease-in-out infinite;
    box-shadow: 0 0 6px #4ade80;
  }
  .status-dot.draft { background: var(--color-text-muted); }
  .status-dot.finished { background: #60a5fa; }
  .status-dot.archived { background: var(--color-border); }

  @keyframes pulse-ring {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .status-text {
    font-size: 1.0625rem;
    font-weight: 700;
  }
  .status-text.active { color: #4ade80; }
  .status-text.finished { color: #60a5fa; }
  .status-text.muted { color: var(--color-text-muted); }

  /* Stats row */
  .stats-row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1rem 1.25rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .stat-icon {
    width: 40px;
    height: 40px;
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .stat-body { flex: 1; }

  .stat-value {
    font-size: 1.375rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-top: 0.1rem;
  }

  .stat-link {
    color: var(--color-text-muted);
    display: flex;
    align-items: center;
    text-decoration: none;
    transition: color 150ms;
    padding: 0.25rem;
  }
  .stat-link:hover { color: var(--color-primary); }

  /* Details grid */
  .details-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem 1.5rem;
    margin: 0;
  }

  .detail-item { display: flex; flex-direction: column; gap: 0.25rem; }
  .detail-item-full { grid-column: 1 / -1; }

  .detail-item dt {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .detail-item dd {
    font-size: 0.9375rem;
    color: var(--color-text);
    margin: 0;
    font-weight: 500;
  }

  .config-summary {
    font-size: 0.875rem !important;
    color: var(--color-text-muted) !important;
    font-weight: 400 !important;
    font-family: var(--font-mono, monospace);
  }

  /* Edit form */
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group { display: flex; flex-direction: column; gap: 0.375rem; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .form-label { font-size: 0.875rem; font-weight: 600; color: var(--color-text-muted); }

  .form-input, .form-textarea {
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
  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 99,102,241), 0.25);
  }
  .form-textarea { resize: vertical; min-height: 80px; }

  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* QR card */
  .qr-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .url-display {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-surface-2, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.875rem;
    min-width: 0;
    flex-wrap: wrap;
  }

  .url-text {
    font-size: 0.875rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .qr-inline {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
    display: flex;
    justify-content: center;
  }

  .qr-placeholder {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
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

  .btn-danger { background: var(--color-danger, #ef4444); color: white; }
  .btn-danger:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

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
  .btn-spinner.sm { width: 12px; height: 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-msg {
    font-size: 0.875rem;
    color: var(--color-danger, #ef4444);
  }

  @media (max-width: 768px) {
    .top-grid { grid-template-columns: 1fr; }
    .details-grid { grid-template-columns: 1fr; }
    .form-row { grid-template-columns: 1fr; }
  }
</style>
