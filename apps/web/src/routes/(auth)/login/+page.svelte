<script lang="ts">
  import { authStore } from '$lib/stores/auth.svelte.js';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';

  let email = $state('');
  let password = $state('');
  let error = $state<string | null>(null);

  const isLoading = $derived(authStore.isLoading);

  function getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes('401') || msg.includes('invalid') || msg.includes('credentials') || msg.includes('unauthorized')) {
        return 'E-Mail-Adresse oder Passwort ist falsch.';
      }
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed')) {
        return 'Verbindungsfehler. Bitte prüfe deine Internetverbindung.';
      }
      return err.message;
    }
    return 'Anmeldung fehlgeschlagen. Bitte versuche es erneut.';
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      await authStore.login(email, password);
      await goto('/dashboard');
    } catch (err) {
      error = getErrorMessage(err);
    }
  }
</script>

<svelte:head>
  <title>Anmelden — Timing Hub</title>
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
      <p class="auth-subtitle">Anmelden</p>
    </header>

    <!-- Form -->
    <form class="auth-form" onsubmit={handleSubmit} novalidate>
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

      <div class="form-group">
        <label for="email" class="form-label">E-Mail-Adresse</label>
        <input
          id="email"
          type="email"
          class="form-input"
          bind:value={email}
          autocomplete="email"
          required
          placeholder="du@beispiel.de"
          disabled={isLoading}
        />
      </div>

      <div class="form-group">
        <label for="password" class="form-label">Passwort</label>
        <input
          id="password"
          type="password"
          class="form-input"
          bind:value={password}
          autocomplete="current-password"
          required
          placeholder="••••••••"
          disabled={isLoading}
        />
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={isLoading}
        fullWidth
      >
        Anmelden
      </Button>
    </form>

    <!-- Footer -->
    <footer class="auth-footer">
      <p>
        Noch kein Konto?
        <a href="/register" class="link">Mit Einladungs-Token registrieren</a>
      </p>
    </footer>
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
    max-width: 400px;
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
