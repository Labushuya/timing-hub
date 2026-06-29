<script lang="ts">
  let { children } = $props();
</script>

<div class="public-layout">
  <header class="public-header">
    <div class="header-inner">
      <!-- Logo / Branding -->
      <a href="/" class="logo-link" aria-label="Timing Hub — Startseite">
        <svg class="logo-svg" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <!-- Stopwatch body -->
          <circle cx="14" cy="16" r="10" stroke="currentColor" stroke-width="2"/>
          <!-- Crown -->
          <path d="M10 6.5 L14 4 L18 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          <!-- Button on top -->
          <rect x="12.5" y="2" width="3" height="2.5" rx="1" fill="currentColor"/>
          <!-- Clock hands -->
          <line x1="14" y1="16" x2="14" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="14" y1="16" x2="18" y2="16" stroke="var(--color-primary, #f97316)" stroke-width="2" stroke-linecap="round"/>
          <!-- Center dot -->
          <circle cx="14" cy="16" r="1.5" fill="currentColor"/>
        </svg>
        <span class="logo-text">
          Timing<span class="logo-accent">Hub</span>
        </span>
      </a>

      <nav class="header-nav" aria-label="Seitenavigation">
        <!-- Language switcher placeholder -->
        <button class="lang-btn" aria-label="Sprache wechseln">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <span>DE</span>
        </button>
      </nav>
    </div>
  </header>

  <main class="public-main">
    {@render children()}
  </main>

  <footer class="public-footer">
    <div class="footer-inner">
      <span class="footer-brand">
        <svg width="14" height="14" viewBox="0 0 28 28" fill="none" aria-hidden="true" style="vertical-align: -2px;">
          <circle cx="14" cy="16" r="10" stroke="currentColor" stroke-width="2.5"/>
          <line x1="14" y1="16" x2="14" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="14" y1="16" x2="18" y2="16" stroke="var(--color-primary, #f97316)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="14" cy="16" r="1.5" fill="currentColor"/>
        </svg>
        &nbsp;Timing Hub
      </span>
      <span class="footer-sep" aria-hidden="true">·</span>
      <a href="https://timinghub.de" class="footer-link" target="_blank" rel="noopener noreferrer">
        timinghub.de
      </a>
      <span class="footer-sep" aria-hidden="true">·</span>
      <span class="footer-copy">&copy; {new Date().getFullYear()}</span>
    </div>
  </footer>
</div>

<style>
  .public-layout {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background-color: var(--color-bg);
  }

  /* ---- Header ---- */
  .public-header {
    border-bottom: 1px solid var(--color-border);
    background-color: var(--color-surface);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .header-inner {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 1rem;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  /* ---- Logo ---- */
  .logo-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text);
    transition: opacity 150ms;
  }

  .logo-link:hover { opacity: 0.8; }

  .logo-svg {
    flex-shrink: 0;
    color: var(--color-text);
  }

  .logo-text {
    font-size: 1.125rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--color-text);
  }

  .logo-accent {
    color: var(--color-primary, #f97316);
  }

  /* ---- Nav ---- */
  .header-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .lang-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 150ms, border-color 150ms;
  }

  .lang-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  /* ---- Main ---- */
  .public-main {
    flex: 1;
  }

  /* ---- Footer ---- */
  .public-footer {
    border-top: 1px solid var(--color-border);
    background-color: var(--color-surface);
    padding: 0.875rem 1rem;
    padding-bottom: calc(0.875rem + env(safe-area-inset-bottom, 0));
  }

  .footer-inner {
    max-width: 1280px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    font-size: 0.8125rem;
    color: var(--color-text-subtle, var(--color-text-muted));
    flex-wrap: wrap;
  }

  .footer-brand {
    font-weight: 600;
    color: var(--color-text-muted);
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .footer-sep {
    color: var(--color-border);
    user-select: none;
  }

  .footer-link {
    color: var(--color-primary, #f97316);
    text-decoration: none;
    font-weight: 500;
    transition: opacity 150ms;
  }

  .footer-link:hover { opacity: 0.75; }

  .footer-copy {
    color: var(--color-text-subtle, var(--color-text-muted));
  }
</style>
