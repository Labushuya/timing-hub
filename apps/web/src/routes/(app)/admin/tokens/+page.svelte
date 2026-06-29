<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '$lib/stores/auth.svelte.js';
  import { toastStore } from '$lib/stores/toast.svelte.js';
  import Button from '$lib/components/ui/Button.svelte';

  // ---- Types -----------------------------------------------------------------

  interface Token {
    id: string;
    token: string;
    role: 'organizer' | 'komissar';
    email: string | null;
    expires_at: string;
    used_at: string | null;
    used_by: string | null;
    used_by_email: string | null;
    status: 'active' | 'used' | 'expired';
    created_at: string;
  }

  // ---- State -----------------------------------------------------------------

  let tokens = $state<Token[]>([]);
  let loading = $state(true);
  let creating = $state(false);
  let error = $state<string | null>(null);
  let accessDenied = $state(false);

  // Form state
  let formRole = $state<'organizer' | 'komissar'>('organizer');
  let formEmail = $state('');
  let formExpiry = $state<'7d' | '30d' | '90d'>('30d');
  let newTokenValue = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

  const user = $derived(authStore.user);
  const isAdmin = $derived((user as { role?: string } | null)?.role === 'admin');

  // ---- Data fetching ---------------------------------------------------------

  async function fetchTokens() {
    loading = true;
    error = null;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/tokens`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (res.status === 403) {
        accessDenied = true;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      tokens = data.tokens ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Fehler beim Laden der Tokens';
    } finally {
      loading = false;
    }
  }

  async function createToken() {
    creating = true;
    newTokenValue = null;
    error = null;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          role: formRole,
          email: formEmail.trim() || null,
          expires_in: formExpiry
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      newTokenValue = data.token;
      formEmail = '';
      await fetchTokens();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Fehler beim Erstellen des Tokens';
      toastStore.error(error);
    } finally {
      creating = false;
    }
  }

  async function revokeToken(tokenId: string) {
    const confirmed = confirm('Token wirklich widerrufen? Diese Aktion kann nicht rückgängig gemacht werden.');
    if (!confirmed) return;
    revoking = tokenId;
    try {
      const token = authStore.accessToken;
      const res = await fetch(`${API_BASE}/admin/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTokens();
      toastStore.success('Token wurde widerrufen');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fehler beim Widerrufen';
      toastStore.error(msg);
    } finally {
      revoking = null;
    }
  }

  async function copyToClipboard(value: string, successMsg: string = 'In die Zwischenablage kopiert') {
    try {
      await navigator.clipboard.writeText(value);
      toastStore.success(successMsg);
    } catch {
      toastStore.error('Kopieren fehlgeschlagen');
    }
  }

  function copyNewToken() {
    if (newTokenValue) {
      copyToClipboard(newTokenValue, 'Token wurde in die Zwischenablage kopiert');
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

  function isExpiringSoon(dateStr: string): boolean {
    try {
      const diff = new Date(dateStr).getTime() - Date.now();
      return diff > 0 && diff < 3 * 24 * 60 * 60 * 1000; // within 3 days
    } catch {
      return false;
    }
  }

  onMount(fetchTokens);
</script>

<svelte:head>
  <title>Registrierungs-Tokens — Timing Hub</title>
</svelte:head>

<div class="tokens-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Registrierungs-Tokens</h1>
      <p class="page-subtitle">Einladungs-Tokens für neue Benutzer verwalten</p>
    </div>
  </div>

  {#if accessDenied}
    <div class="access-denied" role="alert">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
      <h2>Zugriff verweigert</h2>
      <p>Du hast keine Berechtigung, Tokens zu verwalten. Admin-Rolle erforderlich.</p>
    </div>

  {:else}
    <!-- Generate token form -->
    <div class="section">
      <h2 class="section-title">Token generieren</h2>

      {#if error}
        <div class="error-alert" role="alert">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {error}
        </div>
      {/if}

      {#if newTokenValue}
        <div class="new-token-box" role="status">
          <div class="new-token-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <p class="new-token-label">Token erfolgreich erstellt — jetzt kopieren:</p>
          </div>
          <div class="token-copy-row">
            <code class="token-value" title={newTokenValue}>{newTokenValue}</code>
            <button class="copy-token-btn" onclick={copyNewToken} aria-label="Token kopieren">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              Kopieren
            </button>
          </div>
          <p class="new-token-hint">Dieser Token wird nicht erneut angezeigt.</p>
        </div>
      {/if}

      <form class="create-form" onsubmit={(e) => { e.preventDefault(); createToken(); }}>
        <!-- Role selection — large radio cards -->
        <div class="form-group">
          <span class="form-label">Rolle</span>
          <div class="role-cards">
            <label class="role-card" class:role-card-selected={formRole === 'organizer'}>
              <input type="radio" name="role" value="organizer" bind:group={formRole} class="sr-only" />
              <div class="role-card-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
              </div>
              <div class="role-card-content">
                <span class="role-card-title">Veranstalter</span>
                <span class="role-card-desc">Kann Veranstaltungen erstellen und verwalten</span>
              </div>
              <div class="role-card-check" aria-hidden="true">
                {#if formRole === 'organizer'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                {/if}
              </div>
            </label>

            <label class="role-card" class:role-card-selected={formRole === 'komissar'}>
              <input type="radio" name="role" value="komissar" bind:group={formRole} class="sr-only" />
              <div class="role-card-icon role-card-icon-komissar">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
              </div>
              <div class="role-card-content">
                <span class="role-card-title">Kommissar</span>
                <span class="role-card-desc">Zeitnehmer — erfasst Zeiten bei Veranstaltungen</span>
              </div>
              <div class="role-card-check" aria-hidden="true">
                {#if formRole === 'komissar'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                {/if}
              </div>
            </label>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group form-group-wide">
            <label for="email" class="form-label">E-Mail vorausfüllen (optional)</label>
            <input
              id="email"
              type="email"
              class="form-input"
              bind:value={formEmail}
              placeholder="Token auf bestimmte E-Mail beschränken"
              autocomplete="off"
            />
          </div>

          <div class="form-group">
            <label for="expiry" class="form-label">Gültigkeit</label>
            <select id="expiry" class="form-select" bind:value={formExpiry}>
              <option value="7d">7 Tage</option>
              <option value="30d">30 Tage</option>
              <option value="90d">90 Tage</option>
            </select>
          </div>
        </div>

        <div class="form-actions">
          <Button type="submit" variant="primary" size="md" loading={creating}>
            Token generieren
          </Button>
        </div>
      </form>
    </div>

    <!-- Token list -->
    <div class="section">
      <div class="section-header">
        <h2 class="section-title">Alle Tokens</h2>
        {#if !loading}
          <span class="token-count">{tokens.length} Token{tokens.length !== 1 ? 's' : ''}</span>
        {/if}
      </div>

      {#if loading}
        <div class="skeleton-rows" aria-busy="true" aria-label="Tokens werden geladen">
          {#each { length: 4 } as _}
            <div class="skeleton-row">
              <div class="skeleton" style="width: 140px; height: 14px;"></div>
              <div class="skeleton" style="width: 80px; height: 20px; border-radius: 9999px;"></div>
              <div class="skeleton" style="width: 90px; height: 14px;"></div>
              <div class="skeleton" style="width: 90px; height: 14px;"></div>
              <div class="skeleton" style="width: 60px; height: 24px; border-radius: 9999px;"></div>
              <div class="skeleton" style="width: 70px; height: 30px; border-radius: 6px;"></div>
            </div>
          {/each}
        </div>

      {:else if tokens.length === 0}
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-subtle)" stroke-width="1.5" aria-hidden="true">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
          </svg>
          <p>Noch keine Tokens erstellt</p>
          <span>Generiere oben einen Token, um loszulegen.</span>
        </div>

      {:else}
        <div class="token-table-wrapper">
          <table class="token-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Rolle</th>
                <th>Erstellt</th>
                <th>Läuft ab</th>
                <th>Status</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {#each tokens as tok (tok.id)}
                <tr class="token-row" class:token-row-expired={tok.status === 'expired'}>
                  <td class="token-code-cell">
                    <code class="token-code-value">{tok.token.slice(0, 14)}…</code>
                    <button
                      class="icon-btn"
                      onclick={() => copyToClipboard(tok.token, 'Token kopiert')}
                      title="Token kopieren"
                      aria-label="Token kopieren"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </button>
                    {#if tok.email}
                      <span class="token-email-hint" title={tok.email}>{tok.email}</span>
                    {/if}
                  </td>
                  <td>
                    <span class="role-badge role-{tok.role}">
                      {tok.role === 'organizer' ? 'Veranstalter' : 'Kommissar'}
                    </span>
                  </td>
                  <td class="date-cell">{formatDate(tok.created_at)}</td>
                  <td class="date-cell" class:expiring-soon={tok.status === 'active' && isExpiringSoon(tok.expires_at)}>
                    {formatDate(tok.expires_at)}
                    {#if tok.status === 'active' && isExpiringSoon(tok.expires_at)}
                      <span class="expiry-warning" title="Läuft bald ab">!</span>
                    {/if}
                  </td>
                  <td>
                    {#if tok.status === 'active'}
                      <span class="status-badge status-active">Aktiv</span>
                    {:else if tok.status === 'used'}
                      <div class="status-used-wrapper">
                        <span class="status-badge status-used">Verwendet</span>
                        {#if tok.used_by_email}
                          <span class="used-by-email" title={tok.used_by_email}>{tok.used_by_email}</span>
                        {/if}
                      </div>
                    {:else}
                      <span class="status-badge status-expired">Abgelaufen</span>
                    {/if}
                  </td>
                  <td>
                    {#if tok.status === 'active'}
                      <Button
                        variant="danger"
                        size="sm"
                        loading={revoking === tok.id}
                        onclick={() => revokeToken(tok.id)}
                      >
                        Widerrufen
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
  .tokens-page {
    max-width: 960px;
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

  /* Sections */
  .section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .section-title {
    font-size: 1.0625rem;
    font-weight: 700;
    margin: 0;
  }

  .token-count {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    padding: 0.2rem 0.625rem;
    border-radius: 9999px;
    font-weight: 600;
  }

  /* Role cards */
  .role-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .role-card {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 1rem 1.125rem;
    border: 2px solid var(--color-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    background: var(--color-surface-2);
    transition: border-color 150ms, background 150ms;
    position: relative;
  }

  .role-card:hover {
    border-color: var(--color-text-muted);
    background: var(--color-surface-3);
  }

  .role-card-selected {
    border-color: var(--color-primary);
    background: rgba(230, 48, 18, 0.06);
  }

  .role-card-icon {
    width: 40px;
    height: 40px;
    background: var(--color-surface-3);
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-warning);
    flex-shrink: 0;
  }

  .role-card-icon-komissar {
    color: var(--color-info);
  }

  .role-card-content {
    flex: 1;
    min-width: 0;
  }

  .role-card-title {
    display: block;
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--color-text);
    margin-bottom: 0.25rem;
  }

  .role-card-desc {
    display: block;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .role-card-check {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 150ms;
    margin-top: 0.125rem;
  }

  .role-card-selected .role-card-check {
    opacity: 1;
  }

  /* Form */
  .create-form {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }

  .form-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex: 1;
    min-width: 140px;
  }

  .form-group-wide {
    flex: 2;
    min-width: 200px;
  }

  .form-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    letter-spacing: 0.01em;
  }

  .form-input, .form-select {
    padding: 0.5625rem 0.875rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.9375rem;
    font-family: inherit;
    min-height: 42px;
    transition: border-color 120ms;
  }

  .form-input:focus, .form-select:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .form-input::placeholder {
    color: var(--color-text-subtle);
  }

  .form-actions {
    padding-top: 0.25rem;
  }

  /* New token result box */
  .new-token-box {
    background: rgba(34, 197, 94, 0.06);
    border: 1px solid var(--color-success);
    border-radius: var(--radius-md);
    padding: 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .new-token-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-success);
  }

  .new-token-label {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-success);
    margin: 0;
  }

  .token-copy-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .token-value {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    padding: 0.5rem 0.875rem;
    border-radius: var(--radius-sm);
    word-break: break-all;
    flex: 1;
    min-width: 200px;
    color: var(--color-text);
    line-height: 1.6;
  }

  .copy-token-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--color-success);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 120ms;
    font-family: inherit;
  }

  .copy-token-btn:hover {
    opacity: 0.85;
  }

  .new-token-hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  /* Token table */
  .token-table-wrapper {
    overflow-x: auto;
    margin: 0 -1.5rem;
    padding: 0 1.5rem;
  }

  .token-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    min-width: 640px;
  }

  .token-table th {
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

  .token-table td {
    padding: 0.75rem 0.875rem;
    border-bottom: 1px solid var(--color-border-subtle);
    vertical-align: middle;
  }

  .token-row:last-child td {
    border-bottom: none;
  }

  .token-row:hover td {
    background: var(--color-surface-2);
  }

  .token-row-expired {
    opacity: 0.55;
  }

  .token-code-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .token-code-value {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    background: var(--color-surface-2);
    padding: 0.2rem 0.5rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .token-email-hint {
    font-size: 0.75rem;
    color: var(--color-text-subtle);
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-btn {
    background: transparent;
    border: none;
    color: var(--color-text-subtle);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    transition: color 120ms;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .icon-btn:hover { color: var(--color-text); }

  .date-cell {
    color: var(--color-text-muted);
    white-space: nowrap;
    font-size: 0.8125rem;
  }

  .expiring-soon {
    color: var(--color-warning);
  }

  .expiry-warning {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: var(--color-warning);
    color: #000;
    border-radius: 50%;
    font-size: 0.625rem;
    font-weight: 900;
    margin-left: 4px;
    vertical-align: middle;
  }

  /* Badges */
  .role-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.2rem 0.625rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .role-organizer {
    background: var(--color-warning-bg);
    color: var(--color-warning);
  }

  .role-komissar {
    background: var(--color-info-bg);
    color: var(--color-info);
  }

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
  .status-used { background: var(--color-surface-3); color: var(--color-text-subtle); }
  .status-expired { background: var(--color-danger-bg); color: var(--color-danger); }

  .status-used-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .used-by-email {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Error alert */
  .error-alert {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: 0.875rem;
  }

  /* Skeleton */
  .skeleton-rows {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .skeleton-row {
    display: flex;
    gap: 1.5rem;
    align-items: center;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--color-border-subtle);
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

  /* Screen reader only */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  @media (max-width: 600px) {
    .role-cards {
      grid-template-columns: 1fr;
    }

    .token-table-wrapper {
      margin: 0 -1rem;
      padding: 0 1rem;
    }
  }
</style>
