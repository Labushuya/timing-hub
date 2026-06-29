<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '$lib/stores/auth.svelte.js';
  import { toastStore } from '$lib/stores/toast.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';

  // ---- Types -----------------------------------------------------------------

  type UserRole = 'admin' | 'organizer' | 'komissar';
  type UserStatus = 'active' | 'inactive';

  interface ManagedUser {
    id: string;
    display_name: string | null;
    email: string;
    role: UserRole;
    status: UserStatus;
    created_at: string;
  }

  // ---- State -----------------------------------------------------------------

  let users = $state<ManagedUser[]>([]);
  let loading = $state(true);
  let accessDenied = $state(false);
  let searchQuery = $state('');
  let updatingRole = $state<string | null>(null);
  let togglingStatus = $state<string | null>(null);

  const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

  const currentUser = $derived(authStore.user);
  const currentUserId = $derived((currentUser as { id?: string } | null)?.id ?? '');

  const filteredUsers = $derived(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase().trim();
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.display_name?.toLowerCase().includes(q) ?? false)
    );
  });

  // ---- Data fetching ---------------------------------------------------------

  async function fetchUsers() {
    loading = true;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/users`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (res.status === 403) {
        accessDenied = true;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      users = data.users ?? [];
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Fehler beim Laden der Benutzer');
    } finally {
      loading = false;
    }
  }

  async function updateRole(userId: string, newRole: UserRole) {
    updatingRole = userId;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ role: newRole })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      // Update local state optimistically
      users = users.map((u) => (u.id === userId ? { ...u, role: newRole } : u));
      toastStore.success('Rolle wurde aktualisiert');
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Fehler beim Aktualisieren der Rolle');
      await fetchUsers(); // Re-fetch to restore correct state
    } finally {
      updatingRole = null;
    }
  }

  async function toggleStatus(user: ManagedUser) {
    const newStatus: UserStatus = user.status === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'inactive' ? 'deaktivieren' : 'aktivieren';
    const confirmed = confirm(
      `Benutzer "${user.display_name ?? user.email}" wirklich ${action}?`
    );
    if (!confirmed) return;

    togglingStatus = user.id;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      users = users.map((u) => (u.id === user.id ? { ...u, status: newStatus } : u));
      toastStore.success(
        newStatus === 'active' ? 'Benutzer aktiviert' : 'Benutzer deaktiviert'
      );
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Fehler beim Aktualisieren des Status');
      await fetchUsers();
    } finally {
      togglingStatus = null;
    }
  }

  // ---- Helpers ---------------------------------------------------------------

  function formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleDateString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  function userDisplayName(u: ManagedUser): string {
    return u.display_name?.trim() || '–';
  }

  function isSelf(userId: string): boolean {
    return userId === currentUserId;
  }

  const roleLabels: Record<UserRole, string> = {
    admin: 'Admin',
    organizer: 'Veranstalter',
    komissar: 'Kommissar'
  };

  onMount(fetchUsers);
</script>

<svelte:head>
  <title>Benutzerverwaltung — Timing Hub</title>
</svelte:head>

<div class="users-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Benutzerverwaltung</h1>
      <p class="page-subtitle">Rollen und Zugriff für alle registrierten Benutzer verwalten</p>
    </div>
  </div>

  {#if accessDenied}
    <div class="access-denied" role="alert">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
      <h2>Zugriff verweigert</h2>
      <p>Du hast keine Berechtigung, Benutzer zu verwalten. Admin-Rolle erforderlich.</p>
    </div>

  {:else}
    <div class="section">
      <div class="section-controls">
        <div class="search-wrapper">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="search"
            class="search-input"
            bind:value={searchQuery}
            placeholder="Nach Name oder E-Mail suchen…"
            aria-label="Benutzer suchen"
          />
          {#if searchQuery}
            <button class="search-clear" onclick={() => { searchQuery = ''; }} aria-label="Suche zurücksetzen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          {/if}
        </div>
        {#if !loading}
          <span class="user-count">{filteredUsers().length} Benutzer</span>
        {/if}
      </div>

      {#if loading}
        <div class="skeleton-rows" aria-busy="true" aria-label="Benutzer werden geladen">
          {#each { length: 5 } as _}
            <div class="skeleton-row">
              <div class="skeleton-avatar"></div>
              <div style="flex:1; display:flex; flex-direction:column; gap:6px;">
                <div class="skeleton" style="width: 140px; height: 14px;"></div>
                <div class="skeleton" style="width: 180px; height: 12px;"></div>
              </div>
              <div class="skeleton" style="width: 90px; height: 22px; border-radius: 9999px;"></div>
              <div class="skeleton" style="width: 80px; height: 14px;"></div>
              <div class="skeleton" style="width: 60px; height: 22px; border-radius: 9999px;"></div>
              <div class="skeleton" style="width: 120px; height: 32px; border-radius: 6px;"></div>
            </div>
          {/each}
        </div>

      {:else if filteredUsers().length === 0}
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-subtle)" stroke-width="1.5" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          {#if searchQuery}
            <p>Keine Benutzer gefunden für "{searchQuery}"</p>
            <span>Versuche einen anderen Suchbegriff.</span>
          {:else}
            <p>Noch keine Benutzer registriert</p>
          {/if}
        </div>

      {:else}
        <div class="table-wrapper">
          <table class="users-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Rolle</th>
                <th>Erstellt</th>
                <th>Status</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredUsers() as u (u.id)}
                {@const self = isSelf(u.id)}
                <tr class="user-row" class:user-row-self={self} class:user-row-inactive={u.status === 'inactive'}>
                  <td class="name-cell">
                    <div class="user-avatar" aria-hidden="true">
                      {(u.display_name?.[0] ?? u.email[0] ?? '').toUpperCase()}
                    </div>
                    <span class="user-display-name">
                      {userDisplayName(u)}
                      {#if self}
                        <span class="self-badge">Du</span>
                      {/if}
                    </span>
                  </td>
                  <td class="email-cell">{u.email}</td>
                  <td>
                    {#if self}
                      <span class="role-badge role-{u.role}">{roleLabels[u.role]}</span>
                    {:else}
                      <select
                        class="role-select"
                        value={u.role}
                        disabled={updatingRole === u.id}
                        onchange={(e) => {
                          const val = (e.currentTarget as HTMLSelectElement).value as UserRole;
                          updateRole(u.id, val);
                        }}
                        aria-label="Rolle für {u.display_name ?? u.email}"
                      >
                        <option value="admin">Admin</option>
                        <option value="organizer">Veranstalter</option>
                        <option value="komissar">Kommissar</option>
                      </select>
                    {/if}
                  </td>
                  <td class="date-cell">{formatDate(u.created_at)}</td>
                  <td>
                    {#if u.status === 'active'}
                      <span class="status-badge status-active">Aktiv</span>
                    {:else}
                      <span class="status-badge status-inactive">Inaktiv</span>
                    {/if}
                  </td>
                  <td class="actions-cell">
                    {#if self}
                      <span class="self-note">Eigenes Konto</span>
                    {:else}
                      <Button
                        variant={u.status === 'active' ? 'danger' : 'secondary'}
                        size="sm"
                        loading={togglingStatus === u.id}
                        onclick={() => toggleStatus(u)}
                      >
                        {u.status === 'active' ? 'Deaktivieren' : 'Aktivieren'}
                      </Button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .users-page {
    max-width: 1040px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .page-header {
    margin-bottom: 0;
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

  /* Section */
  .section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* Controls */
  .section-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .search-wrapper {
    position: relative;
    flex: 1;
    min-width: 200px;
    max-width: 400px;
  }

  .search-icon {
    position: absolute;
    left: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-text-subtle);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 0.5625rem 2.25rem 0.5625rem 2.25rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.9375rem;
    font-family: inherit;
    min-height: 42px;
    transition: border-color 120ms;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .search-input::placeholder {
    color: var(--color-text-subtle);
  }

  /* Hide native search clear button */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .search-clear {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: var(--color-text-subtle);
    cursor: pointer;
    padding: 3px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms;
  }

  .search-clear:hover {
    color: var(--color-text);
  }

  .user-count {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    padding: 0.2rem 0.625rem;
    border-radius: 9999px;
    font-weight: 600;
    white-space: nowrap;
  }

  /* Table */
  .table-wrapper {
    overflow-x: auto;
    margin: 0 -1.5rem;
    padding: 0 1.5rem;
  }

  .users-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    min-width: 700px;
  }

  .users-table th {
    padding: 0.5rem 0.875rem;
    text-align: left;
    font-size: 0.6875rem;
    font-weight: 700;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 2px solid var(--color-border);
    white-space: nowrap;
  }

  .users-table td {
    padding: 0.75rem 0.875rem;
    border-bottom: 1px solid var(--color-border-subtle);
    vertical-align: middle;
  }

  .user-row:last-child td {
    border-bottom: none;
  }

  .user-row:hover td {
    background: var(--color-surface-2);
  }

  .user-row-self {
    background: rgba(59, 130, 246, 0.03);
  }

  .user-row-inactive {
    opacity: 0.55;
  }

  /* Name cell */
  .name-cell {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .user-avatar {
    width: 32px;
    height: 32px;
    background: var(--color-surface-3);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--color-text-muted);
    flex-shrink: 0;
    border: 1px solid var(--color-border);
  }

  .user-display-name {
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .self-badge {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    background: var(--color-info-bg);
    color: var(--color-info);
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .email-cell {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .date-cell {
    color: var(--color-text-muted);
    white-space: nowrap;
    font-size: 0.8125rem;
  }

  /* Role select */
  .role-select {
    padding: 0.3rem 0.625rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.8125rem;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 120ms;
    min-height: 32px;
  }

  .role-select:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .role-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Role badges (readonly for self) */
  .role-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.625rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .role-admin { background: var(--color-danger-bg); color: var(--color-danger); }
  .role-organizer { background: var(--color-info-bg); color: var(--color-info); }
  .role-komissar { background: var(--color-warning-bg); color: var(--color-warning); }

  /* Status badges */
  .status-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.625rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .status-active { background: var(--color-success-bg); color: var(--color-success); }
  .status-inactive { background: var(--color-surface-3); color: var(--color-text-subtle); }

  /* Actions */
  .actions-cell {
    white-space: nowrap;
  }

  .self-note {
    font-size: 0.8125rem;
    color: var(--color-text-subtle);
    font-style: italic;
  }

  /* Skeleton */
  .skeleton-rows {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .skeleton-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .skeleton-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--color-surface-2);
    animation: shimmer 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  .skeleton {
    background: var(--color-surface-2);
    border-radius: 4px;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    padding: 3rem 2rem;
    text-align: center;
  }

  .empty-state p {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    margin: 0.5rem 0 0;
  }

  .empty-state span {
    font-size: 0.875rem;
    color: var(--color-text-subtle);
  }

  /* Access denied */
  .access-denied {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 4rem 2rem;
    text-align: center;
  }

  .access-denied h2 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-danger);
    margin: 0;
  }

  .access-denied p {
    color: var(--color-text-muted);
    margin: 0;
  }

  @media (max-width: 600px) {
    .table-wrapper {
      margin: 0 -1rem;
      padding: 0 1rem;
    }
  }
</style>
