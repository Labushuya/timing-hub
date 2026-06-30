<script lang="ts">
  import { page } from '$app/stores';
</script>

<svelte:head>
  <title>{$page.status} — Timing Hub</title>
</svelte:head>

<div class="error-page">
  <div class="error-card">
    <div class="error-stripe"></div>

    <div class="error-body">
      <span class="error-code">{$page.status}</span>

      <h1 class="error-title">
        {#if $page.status === 404}
          Seite nicht gefunden
        {:else if $page.status >= 500}
          Serverfehler
        {:else}
          Fehler aufgetreten
        {/if}
      </h1>

      <p class="error-message">
        {$page.error?.message ?? 'Ein unbekannter Fehler ist aufgetreten.'}
      </p>

      <a href="/dashboard" class="btn-back">
        Zurück zum Dashboard
      </a>
    </div>
  </div>
</div>

<style>
  .error-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-bg);
    padding: 1.5rem;
  }

  .error-card {
    width: 100%;
    max-width: 480px;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .error-stripe {
    height: 4px;
    background: repeating-linear-gradient(
      90deg,
      var(--color-primary) 0px,
      var(--color-primary) 24px,
      transparent 24px,
      transparent 32px
    );
  }

  .error-body {
    padding: 2.5rem 2rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .error-code {
    font-size: 4rem;
    font-weight: 700;
    line-height: 1;
    color: var(--color-primary);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .error-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.3;
  }

  .error-message {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .btn-back {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1rem;
    padding: 0.6rem 1.25rem;
    background-color: var(--color-primary);
    color: #ffffff;
    text-decoration: none;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    font-weight: 500;
    transition: background-color 150ms ease;
    align-self: flex-start;
  }

  .btn-back:hover {
    background-color: var(--color-primary-hover);
  }

  .btn-back:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
