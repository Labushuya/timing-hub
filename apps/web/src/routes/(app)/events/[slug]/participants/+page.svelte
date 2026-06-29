<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { api, APIError } from '$lib/api/client.js';
  import type { CreateParticipantPayload } from '$lib/api/client.js';
  import type { Participant, Event as TimingEvent } from '@timing-hub/shared-types';
  import ParticipantForm from '$lib/components/participants/ParticipantForm.svelte';
  import CSVImporter from '$lib/components/participants/CSVImporter.svelte';

  interface Props {
    data: { event: TimingEvent };
  }

  let { data }: Props = $props();
  const event = $derived(data.event);
  const slug = $derived(event.slug);
  const isGlp = $derived(event.format === 'glp');

  // ---- Fetch participants -----------------------------------------------------

  let participants = $state<Participant[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let fetchError = $state<string | null>(null);

  // ---- Pagination & filtering -------------------------------------------------

  const PAGE_SIZE = 50;
  let currentPage = $state(1);
  let searchQuery = $state('');
  let selectedClass = $state<string>('');

  // Debounced search
  let searchDebounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);
  let debouncedSearch = $state('');

  function onSearchInput(e: globalThis.Event) {
    searchQuery = (e.currentTarget as HTMLInputElement).value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      debouncedSearch = searchQuery;
      currentPage = 1;
    }, 300);
  }

  // ---- Sorting ----------------------------------------------------------------

  type SortField = 'startnummer' | 'driver_name' | 'co_driver_name' | 'car_make' | 'class' | 'target_time_ms';
  let sortField = $state<SortField>('startnummer');
  let sortAsc = $state(true);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      sortAsc = !sortAsc;
    } else {
      sortField = field;
      sortAsc = true;
    }
  }

  // ---- Derived class list (pills) ---------------------------------------------

  const allClasses = $derived(
    [...new Set(participants.map((p) => p.class).filter(Boolean) as string[])].sort()
  );

  // ---- Filtered + sorted list -------------------------------------------------

  const filteredParticipants = $derived.by(() => {
    let list = participants;

    if (selectedClass) {
      list = list.filter((p) => p.class === selectedClass);
    }

    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (p) =>
          p.startnummer.toLowerCase().includes(q) ||
          p.driver_name.toLowerCase().includes(q) ||
          (p.co_driver_name ?? '').toLowerCase().includes(q) ||
          (p.car_make ?? '').toLowerCase().includes(q) ||
          (p.car_model ?? '').toLowerCase().includes(q) ||
          (p.class ?? '').toLowerCase().includes(q)
      );
    }

    list = [...list].sort((a, b) => {
      let va: string | number = '';
      let vb: string | number = '';

      if (sortField === 'startnummer') {
        // Natural sort: try numeric first
        const na = parseFloat(a.startnummer);
        const nb = parseFloat(b.startnummer);
        if (!isNaN(na) && !isNaN(nb)) {
          va = na; vb = nb;
        } else {
          va = a.startnummer; vb = b.startnummer;
        }
      } else if (sortField === 'target_time_ms') {
        va = a.target_time_ms ?? Infinity;
        vb = b.target_time_ms ?? Infinity;
      } else {
        va = (a[sortField] ?? '') as string;
        vb = (b[sortField] ?? '') as string;
      }

      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    return list;
  });

  const totalPages = $derived(Math.max(1, Math.ceil(filteredParticipants.length / PAGE_SIZE)));

  const pagedParticipants = $derived(
    filteredParticipants.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  );

  // ---- Load -------------------------------------------------------------------

  async function loadParticipants() {
    loading = true;
    fetchError = null;
    try {
      const res = await api.participants.listParticipants(slug, { limit: 1000 });
      participants = res.participants;
      total = res.total;
    } catch (err) {
      fetchError = err instanceof APIError ? err.message : 'Teilnehmer konnten nicht geladen werden';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (slug) {
      loadParticipants();
    }
  });

  // ---- Add row form -----------------------------------------------------------

  let showAddForm = $state(false);
  let addSaving = $state(false);
  let addError = $state<string | null>(null);

  async function handleAdd(payload: CreateParticipantPayload) {
    addSaving = true;
    addError = null;
    try {
      await api.participants.createParticipant(slug, payload);
      showAddForm = false;
      await loadParticipants();
    } catch (err) {
      addError = err instanceof APIError ? err.message : 'Fehler beim Hinzufügen';
    } finally {
      addSaving = false;
    }
  }

  // ---- Inline edit ------------------------------------------------------------

  let editingId = $state<string | null>(null);
  let editSaving = $state(false);
  let editError = $state<string | null>(null);

  function startEdit(p: Participant) {
    editingId = p.id;
    editError = null;
    showAddForm = false;
  }

  function cancelEdit() {
    editingId = null;
    editError = null;
  }

  async function handleEdit(participantId: string, payload: CreateParticipantPayload) {
    editSaving = true;
    editError = null;
    try {
      await api.participants.updateParticipant(slug, participantId, payload);
      editingId = null;
      await loadParticipants();
    } catch (err) {
      editError = err instanceof APIError ? err.message : 'Fehler beim Speichern';
    } finally {
      editSaving = false;
    }
  }

  // ---- Delete -----------------------------------------------------------------

  let deletingId = $state<string | null>(null);

  async function handleDelete(p: Participant) {
    const confirmed = window.confirm(
      `Teilnehmer "${p.driver_name}" (Nr. ${p.startnummer}) wirklich löschen?`
    );
    if (!confirmed) return;

    deletingId = p.id;
    try {
      await api.participants.deleteParticipant(slug, p.id);
      await loadParticipants();
    } catch (err) {
      window.alert(err instanceof APIError ? err.message : 'Löschen fehlgeschlagen');
    } finally {
      deletingId = null;
    }
  }

  // ---- CSV Importer modal -----------------------------------------------------

  let showImporter = $state(false);
  let importBannerMsg = $state<string | null>(null);

  function handleImported(result: { imported: number; skipped: number }) {
    importBannerMsg = `${result.imported} Teilnehmer importiert${result.skipped > 0 ? `, ${result.skipped} übersprungen` : ''}.`;
    showImporter = false;
    loadParticipants();
    setTimeout(() => (importBannerMsg = null), 6000);
  }

  // ---- Helpers ----------------------------------------------------------------

  const existingStartnummern = $derived(participants.map((p) => p.startnummer));

  function msToDisplay(ms: number | undefined | null): string {
    if (ms == null) return '—';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const millis = ms % 1000;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function sortIcon(field: SortField) {
    if (sortField !== field) return 'none';
    return sortAsc ? 'asc' : 'desc';
  }
</script>

<svelte:head>
  <title>Teilnehmer — {event.name} — Timing Hub</title>
</svelte:head>

<!-- CSV Importer modal overlay -->
{#if showImporter}
  <div
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="CSV-Importer"
    onclick={(e) => { if (e.target === e.currentTarget) showImporter = false; }}
    onkeydown={(e) => e.key === 'Escape' && (showImporter = false)}
    tabindex="-1"
  >
    <CSVImporter
      eventSlug={slug}
      onImported={handleImported}
      onClose={() => (showImporter = false)}
    />
  </div>
{/if}

<div class="participants-page">
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="search-wrap">
        <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="search"
          class="search-input"
          placeholder="Suchen…"
          value={searchQuery}
          oninput={(e) => onSearchInput(e)}
          aria-label="Teilnehmer suchen"
        />
      </div>

      {#if allClasses.length > 0}
        <div class="class-pills" role="group" aria-label="Klasse filtern">
          <button
            class="pill"
            class:active={selectedClass === ''}
            onclick={() => { selectedClass = ''; currentPage = 1; }}
          >
            Alle
          </button>
          {#each allClasses as cls}
            <button
              class="pill"
              class:active={selectedClass === cls}
              onclick={() => { selectedClass = selectedClass === cls ? '' : cls; currentPage = 1; }}
            >
              {cls}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="toolbar-right">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        onclick={() => { showImporter = true; }}
        title="CSV importieren"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        CSV importieren
      </button>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        onclick={() => { showAddForm = !showAddForm; editingId = null; }}
        aria-expanded={showAddForm}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Teilnehmer hinzufügen
      </button>
    </div>
  </div>

  <!-- Import success banner -->
  {#if importBannerMsg}
    <div class="banner banner-success" role="status" aria-live="polite">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      {importBannerMsg}
    </div>
  {/if}

  <!-- Add participant inline form -->
  {#if showAddForm}
    <div class="inline-form-card">
      <div class="inline-form-header">
        <h3 class="inline-form-title">Neuen Teilnehmer hinzufügen</h3>
      </div>
      <ParticipantForm
        existingStartnummern={existingStartnummern}
        isGlp={isGlp}
        saving={addSaving}
        error={addError}
        onSave={handleAdd}
        onCancel={() => { showAddForm = false; addError = null; }}
      />
    </div>
  {/if}

  <!-- Fetch error -->
  {#if fetchError}
    <div class="alert-error" role="alert">
      {fetchError}
      <button type="button" class="retry-btn" onclick={loadParticipants}>Erneut versuchen</button>
    </div>
  {/if}

  <!-- Loading skeleton -->
  {#if loading && participants.length === 0}
    <div class="skeleton-table" aria-busy="true" aria-label="Lade Teilnehmer…">
      {#each [1, 2, 3, 4, 5] as _}
        <div class="skeleton-row">
          <div class="skeleton-cell w-16"></div>
          <div class="skeleton-cell w-40"></div>
          <div class="skeleton-cell w-32"></div>
          <div class="skeleton-cell w-28"></div>
          <div class="skeleton-cell w-20"></div>
        </div>
      {/each}
    </div>

  <!-- Empty state -->
  {:else if !loading && filteredParticipants.length === 0 && !searchQuery && !selectedClass}
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </div>
      <h3 class="empty-title">Noch keine Teilnehmer</h3>
      <p class="empty-hint">Füge Teilnehmer einzeln hinzu oder importiere sie per CSV.</p>
      <div class="empty-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showImporter = true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          CSV importieren
        </button>
        <button type="button" class="btn btn-primary btn-sm" onclick={() => (showAddForm = true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Teilnehmer hinzufügen
        </button>
      </div>
    </div>

  <!-- Empty search result -->
  {:else if !loading && filteredParticipants.length === 0}
    <div class="empty-state empty-state-sm">
      <p class="empty-hint">Keine Teilnehmer für die aktuelle Suche / Filter.</p>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        onclick={() => { searchQuery = ''; debouncedSearch = ''; selectedClass = ''; }}
      >
        Filter zurücksetzen
      </button>
    </div>

  <!-- Participants table -->
  {:else}
    <div class="table-container">
      <table class="participants-table" aria-label="Teilnehmerliste">
        <thead>
          <tr>
            <th scope="col">
              <button class="sort-btn" onclick={() => toggleSort('startnummer')} aria-sort={sortIcon('startnummer') === 'none' ? undefined : sortIcon('startnummer') === 'asc' ? 'ascending' : 'descending'}>
                Startnr.
                {@render SortIndicator({ field: 'startnummer', sortField, sortAsc })}
              </button>
            </th>
            <th scope="col">
              <button class="sort-btn" onclick={() => toggleSort('driver_name')} aria-sort={sortIcon('driver_name') === 'none' ? undefined : sortIcon('driver_name') === 'asc' ? 'ascending' : 'descending'}>
                Fahrer
                {@render SortIndicator({ field: 'driver_name', sortField, sortAsc })}
              </button>
            </th>
            <th scope="col">
              <button class="sort-btn" onclick={() => toggleSort('co_driver_name')}>
                Beifahrer
                {@render SortIndicator({ field: 'co_driver_name', sortField, sortAsc })}
              </button>
            </th>
            <th scope="col">
              <button class="sort-btn" onclick={() => toggleSort('car_make')}>
                Fahrzeug
                {@render SortIndicator({ field: 'car_make', sortField, sortAsc })}
              </button>
            </th>
            <th scope="col">
              <button class="sort-btn" onclick={() => toggleSort('class')}>
                Klasse
                {@render SortIndicator({ field: 'class', sortField, sortAsc })}
              </button>
            </th>
            {#if isGlp}
              <th scope="col">
                <button class="sort-btn" onclick={() => toggleSort('target_time_ms')}>
                  Sollzeit
                  {@render SortIndicator({ field: 'target_time_ms', sortField, sortAsc })}
                </button>
              </th>
            {/if}
            <th scope="col" class="col-actions">Aktionen</th>
          </tr>
        </thead>
        <tbody>
          {#each pagedParticipants as participant (participant.id)}
            {#if editingId === participant.id}
              <!-- Inline edit row -->
              <tr class="edit-row">
                <td colspan={isGlp ? 7 : 6} class="edit-cell">
                  <ParticipantForm
                    participant={participant}
                    existingStartnummern={existingStartnummern}
                    isGlp={isGlp}
                    saving={editSaving}
                    error={editError}
                    onSave={(payload) => handleEdit(participant.id, payload)}
                    onCancel={cancelEdit}
                  />
                </td>
              </tr>
            {:else}
              <tr class:deleting={deletingId === participant.id}>
                <td class="col-startnr col-mono">{participant.startnummer}</td>
                <td class="col-driver">
                  <span class="driver-name">{participant.driver_name}</span>
                </td>
                <td class="col-muted">{participant.co_driver_name ?? ''}</td>
                <td class="col-muted">
                  {#if participant.car_make || participant.car_model}
                    {[participant.car_make, participant.car_model, participant.car_year ? String(participant.car_year) : null].filter(Boolean).join(' ')}
                  {:else}
                    <span class="empty-cell">—</span>
                  {/if}
                </td>
                <td>
                  {#if participant.class}
                    <span class="class-tag">{participant.class}</span>
                  {:else}
                    <span class="empty-cell">—</span>
                  {/if}
                </td>
                {#if isGlp}
                  <td class="col-mono col-muted">{msToDisplay(participant.target_time_ms)}</td>
                {/if}
                <td class="col-actions">
                  <div class="action-buttons">
                    <button
                      type="button"
                      class="action-btn"
                      title="Bearbeiten"
                      onclick={() => startEdit(participant)}
                      disabled={deletingId === participant.id}
                      aria-label="Teilnehmer {participant.driver_name} bearbeiten"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="action-btn action-btn-danger"
                      title="Löschen"
                      onclick={() => handleDelete(participant)}
                      disabled={deletingId === participant.id}
                      aria-label="Teilnehmer {participant.driver_name} löschen"
                    >
                      {#if deletingId === participant.id}
                        <span class="mini-spinner" aria-hidden="true"></span>
                      {:else}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6"/>
                          <path d="M14 11v6"/>
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      {/if}
                    </button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="pagination" role="navigation" aria-label="Seitennavigation">
        <span class="pagination-info">
          {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredParticipants.length)} von {filteredParticipants.length}
        </span>
        <div class="pagination-buttons">
          <button
            type="button"
            class="page-btn"
            onclick={() => (currentPage = 1)}
            disabled={currentPage === 1}
            aria-label="Erste Seite"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
            </svg>
          </button>
          <button
            type="button"
            class="page-btn"
            onclick={() => currentPage > 1 && (currentPage -= 1)}
            disabled={currentPage === 1}
            aria-label="Vorherige Seite"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>

          {#each Array.from({ length: totalPages }, (_, i) => i + 1).filter(
            (p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2
          ) as pageNum, idx}
            {#if idx > 0}
              {#if (Array.from({ length: totalPages }, (_, i) => i + 1).filter(
                (p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2
              ))[idx]! - (Array.from({ length: totalPages }, (_, i) => i + 1).filter(
                (p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2
              ))[idx - 1]! > 1}
                <span class="page-ellipsis">…</span>
              {/if}
            {/if}
            <button
              type="button"
              class="page-btn"
              class:active={pageNum === currentPage}
              onclick={() => (currentPage = pageNum)}
              aria-label="Seite {pageNum}"
              aria-current={pageNum === currentPage ? 'page' : undefined}
            >
              {pageNum}
            </button>
          {/each}

          <button
            type="button"
            class="page-btn"
            onclick={() => currentPage < totalPages && (currentPage += 1)}
            disabled={currentPage === totalPages}
            aria-label="Nächste Seite"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          <button
            type="button"
            class="page-btn"
            onclick={() => (currentPage = totalPages)}
            disabled={currentPage === totalPages}
            aria-label="Letzte Seite"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>
            </svg>
          </button>
        </div>
      </div>
    {:else if filteredParticipants.length > 0}
      <div class="results-count" aria-live="polite">
        {filteredParticipants.length} Teilnehmer{filteredParticipants.length !== 1 ? '' : ''}
      </div>
    {/if}
  {/if}
</div>

<!-- Sort indicator snippet -->
{#snippet SortIndicator({ field, sortField: sf, sortAsc: sa }: { field: SortField; sortField: SortField; sortAsc: boolean })}
  {#if sf === field}
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true" class="sort-arrow">
      {#if sa}
        <polyline points="18 15 12 9 6 15"/>
      {:else}
        <polyline points="6 9 12 15 18 9"/>
      {/if}
    </svg>
  {:else}
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" class="sort-arrow sort-arrow-inactive">
      <polyline points="8 9 12 5 16 9"/><polyline points="16 15 12 19 8 15"/>
    </svg>
  {/if}
{/snippet}

<style>
  .participants-page {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* Search */
  .search-wrap {
    position: relative;
    flex: 0 1 260px;
  }

  .search-icon {
    position: absolute;
    left: 0.625rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-text-muted);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.425rem 0.75rem 0.425rem 2rem;
    font-size: 0.9rem;
    color: var(--color-text);
    font-family: inherit;
    min-height: 34px;
    box-sizing: border-box;
    transition: border-color 150ms, box-shadow 150ms;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 99,102,241), 0.2);
  }

  /* Class pills */
  .class-pills {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    white-space: nowrap;
    user-select: none;
  }

  .pill:hover { color: var(--color-text); border-color: var(--color-text-muted); }

  .pill.active {
    background: rgba(var(--color-primary-rgb, 99,102,241), 0.12);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  /* Inline form card */
  .inline-form-card {
    background: var(--color-surface);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-lg);
    padding: 1.125rem 1.25rem;
  }

  .inline-form-header {
    margin-bottom: 0.25rem;
  }

  .inline-form-title {
    font-size: 0.9375rem;
    font-weight: 700;
    margin: 0;
  }

  /* Alert */
  .alert-error {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    color: var(--color-danger, #ef4444);
  }

  .retry-btn {
    margin-left: auto;
    background: none;
    border: 1px solid currentColor;
    color: inherit;
    font-size: 0.8125rem;
    font-family: inherit;
    padding: 0.2rem 0.6rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 150ms;
  }
  .retry-btn:hover { background: rgba(239, 68, 68, 0.1); }

  /* Banner */
  .banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .banner-success {
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #4ade80;
  }

  /* Skeleton */
  .skeleton-table {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .skeleton-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .skeleton-row:last-child { border-bottom: none; }

  .skeleton-cell {
    height: 14px;
    border-radius: 4px;
    background: var(--color-surface-2);
    animation: shimmer 1.5s ease-in-out infinite alternate;
  }

  .w-16 { width: 3.5rem; }
  .w-20 { width: 5rem; }
  .w-28 { width: 7rem; }
  .w-32 { width: 8rem; }
  .w-40 { width: 10rem; }

  @keyframes shimmer {
    from { opacity: 0.5; }
    to { opacity: 1; }
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.875rem;
    padding: 4rem 2rem;
    text-align: center;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
  }

  .empty-state-sm {
    padding: 2.5rem 2rem;
  }

  .empty-icon {
    color: var(--color-text-muted);
    opacity: 0.4;
  }

  .empty-title {
    font-size: 1.0625rem;
    font-weight: 700;
    margin: 0;
  }

  .empty-hint {
    font-size: 0.9rem;
    color: var(--color-text-muted);
    margin: 0;
    max-width: 360px;
  }

  .empty-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 0.25rem;
  }

  /* Table */
  .table-container {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    overflow-x: auto;
  }

  .participants-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    min-width: 600px;
  }

  .participants-table thead tr {
    background: var(--color-surface-2);
    border-bottom: 1px solid var(--color-border);
  }

  .participants-table th {
    padding: 0;
    font-weight: 600;
    text-align: left;
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  .participants-table th.col-actions {
    padding: 0.625rem 1rem;
    text-align: right;
  }

  .sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.625rem 1rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: inherit;
    font-weight: inherit;
    font-family: inherit;
    color: inherit;
    white-space: nowrap;
    transition: color 120ms;
    width: 100%;
  }

  .sort-btn:hover { color: var(--color-text); }

  .sort-arrow { flex-shrink: 0; }
  .sort-arrow-inactive { opacity: 0.35; }

  .participants-table tbody tr {
    border-bottom: 1px solid var(--color-border);
    transition: background 120ms;
  }
  .participants-table tbody tr:last-child { border-bottom: none; }
  .participants-table tbody tr:hover { background: var(--color-surface-2); }
  .participants-table tbody tr.deleting { opacity: 0.5; pointer-events: none; }

  .participants-table td {
    padding: 0.75rem 1rem;
    color: var(--color-text);
    vertical-align: middle;
  }

  .col-startnr {
    font-weight: 700;
    width: 80px;
  }

  .col-driver .driver-name {
    font-weight: 600;
  }

  .col-mono {
    font-family: var(--font-mono, monospace);
    font-size: 0.875rem;
  }

  .col-muted {
    color: var(--color-text-muted);
  }

  .col-actions {
    width: 90px;
    text-align: right;
  }

  .class-tag {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.55rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .empty-cell {
    color: var(--color-text-muted);
    opacity: 0.4;
  }

  /* Inline edit row */
  .edit-row td.edit-cell {
    padding: 0;
    background: rgba(var(--color-primary-rgb, 99,102,241), 0.03);
    border-left: 3px solid var(--color-primary);
  }

  .edit-row td.edit-cell > :global(.participant-form) {
    padding: 0.875rem 1rem;
  }

  /* Action buttons */
  .action-buttons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
  }

  .action-btn {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--color-text-muted);
    transition: all 120ms;
    flex-shrink: 0;
  }

  .action-btn:hover {
    background: var(--color-surface-2);
    border-color: var(--color-border);
    color: var(--color-text);
  }

  .action-btn-danger:hover {
    color: var(--color-danger, #ef4444);
    background: rgba(239, 68, 68, 0.08);
    border-color: rgba(239, 68, 68, 0.25);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }

  .mini-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Pagination */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
  }

  .pagination-info {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .pagination-buttons {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .page-btn {
    min-width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.35rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    user-select: none;
  }

  .page-btn:hover:not(:disabled) {
    background: var(--color-surface-3, var(--color-surface-2));
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .page-btn.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
  }

  .page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
  }

  .page-ellipsis {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    padding: 0 0.25rem;
    user-select: none;
  }

  .results-count {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    text-align: right;
    padding: 0.25rem 0;
  }

  /* Modal backdrop */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border-radius: var(--radius-md);
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    white-space: nowrap;
    user-select: none;
    text-decoration: none;
  }

  .btn-sm { padding: 0.375rem 0.875rem; font-size: 0.875rem; min-height: 32px; }

  .btn-primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-foreground, white);
  }
  .btn-primary:hover { filter: brightness(1.1); }

  .btn-ghost {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-text-muted);
  }
  .btn-ghost:hover {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  @media (max-width: 640px) {
    .toolbar { flex-direction: column; align-items: stretch; }
    .toolbar-right { justify-content: flex-end; }
    .pagination { flex-direction: column; align-items: center; }
  }
</style>
