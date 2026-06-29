<script lang="ts">
  import { goto } from '$app/navigation';
  import { authStore } from '$lib/stores/auth.svelte.js';
  import { api } from '$lib/api/client.js';
  import Button from '$lib/components/ui/Button.svelte';

  let inviteToken = $state('');
  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);

  // ---- Inline token validation -----------------------------------------------

  // Token format: alphanumeric segments separated by dashes (e.g. abc12-xyz99-def00)
  const TOKEN_PATTERN = /^[a-zA-Z0-9]{4,}(-[a-zA-Z0-9]{4,})*$/;

  const tokenError = $derived(
    inviteToken.length > 0 && !TOKEN_PATTERN.test(inviteToken.trim())
      ? 'Ungültiges Token-Format (z.B. abc12-xyz99-def00)'
      : null
  );

  const isFormValid = $derived(
    inviteToken.trim().length > 0 &&
    TOKEN_PATTERN.test(inviteToken.trim()) &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    displayName.trim().length > 0
  );

  // ---- Submit ----------------------------------------------------------------

  function getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes('token') && (msg.includes('invalid') || msg.includes('expired') || msg.includes('used'))) {
        return 'Der Einladungs-Token ist ungültig oder bereits verwendet.';
      }
      if (msg.includes('email') && msg.includes('exist')) {
        return 'Diese E-Mail-Adresse ist bereits registriert.';
      }
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed')) {
        return 'Verbindungsfehler. Bitte prüfe deine Internetverbindung.';
      }
      return err.message;
    }
    return 'Registrierung fehlgeschlagen. Bitte versuche es erneut.';
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!isFormValid) return;

    error = null;
    isLoading = true;

    try {
      await api.auth.register({
        invite_token: inviteToken.trim(),
        email: email.trim(),
        password,
        display_name: displayName.trim()
      });

      // Auto-login after successful registration
      await authStore.login(email.trim(), password);
      success = true;
      await goto('/dashboard');
    } catch (err) {
      error = getErrorMessage(err);
    } finally {
      isLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Registrieren — Timing Hub</title>
</svelte:head>

<div class="auth-page">
  <div class="auth-card">

    <!-- Logo / Wordmark -->
    <header class="auth-header">
      <div class="logo-wrap" aria-hidden="true">
        <svg class="logo-icon" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="20" cy="22" r="14" stroke="currentColor" stroke-width="2.5"/>
          <path d="M20 22 L20 11" stroke="var(--color-primary)" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M20 22 L27 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
          <path d="M16 3 L24 3" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="20" cy="22" r="2" fill="var(--color-primary)"/>
        </svg>
      </div>
      <h1 class="wordmark">Timing Hub</h1>
      <p class="auth-subtitle">Konto erstellen</p>
    </header>

    {#if success}
      <!-- Success state -->
      <div class="success-state" role="status">
        <div class="success-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2>Konto erstellt!</h2>
        <p>Du wirst weitergeleitet…</p>
      </div>
    {:else}
      <form class="auth-form" onsubmit={handleSubmit} novalidate>

        <!-- Global error -->
        {#if error}
          <div class="error-alert" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{error}</span>
          </div>
        {/if}

        <!-- Invite token — top, prominent -->
        <div class="token-section">
          <div class="token-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Einladungs-Token erforderlich
          </div>
          <div class="form-group">
            <label for="invite-token" class="form-label">
              Bitte gib deinen Einladungs-Token ein
            </label>
            <input
              id="invite-token"
              type="text"
              class="form-input token-input"
              class:input-error={tokenError !== null}
              bind:value={inviteToken}
              required
              placeholder="abc12-xyz99-def00"
              autocomplete="off"
              spellcheck="false"
              autocorrect="off"
              autocapitalize="none"
              disabled={isLoading}
            />
            {#if tokenError}
              <span class="field-error" role="alert">{tokenError}</span>
            {:else}
              <span class="form-hint">Du erhältst diesen Token von deinem Veranstalter.</span>
            {/if}
          </div>
        </div>

        <div class="form-divider">
          <span>Deine Angaben</span>
        </div>

        <!-- Display name -->
        <div class="form-group">
          <label for="display-name" class="form-label">Anzeigename</label>
          <input
            id="display-name"
            type="text"
            class="form-input"
            bind:value={displayName}
            required
            placeholder="Max Mustermann"
            autocomplete="name"
            disabled={isLoading}
          />
        </div>

        <!-- Email -->
        <div class="form-group">
          <label for="email" class="form-label">E-Mail-Adresse</label>
          <input
            id="email"
            type="email"
            class="form-input"
            bind:value={email}
            required
            placeholder="du@beispiel.de"
            autocomplete="email"
            disabled={isLoading}
          />
        </div>

        <!-- Password -->
        <div class="form-group">
          <label for="password" class="form-label">Passwort</label>
          <input
            id="password"
            type="password"
            class="form-input"
            class:input-error={password.length > 0 && password.length < 8}
            bind:value={password}
            required
            placeholder="Mindestens 8 Zeichen"
            autocomplete="new-password"
            minlength="8"
            disabled={isLoading}
          />
          {#if password.length > 0 && password.length < 8}
            <span class="field-error" role="alert">
              Passwort muss mindestens 8 Zeichen lang sein ({password.length}/8)
            </span>
          {/if}
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={isLoading}
          disabled={!isFormValid}
          fullWidth
        >
          Registrieren
        </Button>
      </form>

      <footer class="auth-footer">
        <p>
          Bereits registriert?
          <a href="/login" class="link">Anmelden</a>
        </p>
      </footer>
    {/if}
  </div>
</div>

<style>
  .auth-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--color-bg);
    background-image:
      radial-gradient(ellipse 80% 50% at 50% -10%, rgba(230, 48, 18, 0.08) 0%, transparent 60%);
  }

  .auth-card {
    width: 100%;
    max-width: 440px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    padding: 2.5rem 2rem 2rem;
    box-shadow: 0 4px 32px rgba(0, 0, 0, 0.3);
  }

  /* Header */
  .auth-header {
    text-align: center;
    margin-bottom: 2rem;
  }

  .logo-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    margin-bottom: 0.875rem;
    color: var(--color-text-muted);
  }

  .logo-icon {
    width: 32px;
    height: 32px;
    filter: drop-shadow(0 0 8px rgba(230, 48, 18, 0.35));
  }

  .wordmark {
    font-size: 1.625rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    margin: 0 0 0.25rem;
    background: linear-gradient(135deg, var(--color-text) 60%, var(--color-primary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .auth-subtitle {
    color: var(--color-text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  /* Token section */
  .token-section {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .token-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-primary);
  }

  /* Form */
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .error-alert {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    background: var(--color-danger-bg, rgba(230, 48, 18, 0.08));
    border: 1px solid var(--color-danger, #e63012);
    border-radius: var(--radius-md);
    color: var(--color-danger, #e63012);
    font-size: 0.875rem;
    line-height: 1.4;
  }

  .error-alert svg {
    flex-shrink: 0;
    margin-top: 1px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
    letter-spacing: 0.01em;
  }

  .form-input {
    padding: 0.625rem 0.875rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 1rem;
    font-family: inherit;
    transition: border-color 150ms, box-shadow 150ms;
    min-height: 48px;
    width: 100%;
    box-sizing: border-box;
  }

  .form-input::placeholder {
    color: var(--color-text-subtle, rgba(255, 255, 255, 0.25));
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(230, 48, 18, 0.15);
  }

  .form-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .form-input.input-error {
    border-color: var(--color-danger, #e63012);
  }

  .form-input.input-error:focus {
    box-shadow: 0 0 0 3px rgba(230, 48, 18, 0.2);
  }

  .token-input {
    font-family: var(--font-mono, 'Fira Code', 'JetBrains Mono', monospace);
    letter-spacing: 0.04em;
  }

  .form-hint {
    font-size: 0.75rem;
    color: var(--color-text-subtle, rgba(255, 255, 255, 0.35));
    line-height: 1.4;
  }

  .field-error {
    font-size: 0.75rem;
    color: var(--color-danger, #e63012);
    line-height: 1.4;
  }

  .form-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--color-text-subtle, rgba(255, 255, 255, 0.35));
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .form-divider::before,
  .form-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  /* Success state */
  .success-state {
    text-align: center;
    padding: 2.5rem 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .success-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 50%;
    color: var(--color-success, #22c55e);
  }

  .success-state h2 {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-success, #22c55e);
    margin: 0;
  }

  .success-state p {
    color: var(--color-text-muted);
    margin: 0;
    font-size: 0.9375rem;
  }

  /* Footer */
  .auth-footer {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .auth-footer p {
    margin: 0;
  }

  .link {
    color: var(--color-primary);
    text-decoration: none;
    font-weight: 500;
  }

  .link:hover {
    text-decoration: underline;
  }
</style>
