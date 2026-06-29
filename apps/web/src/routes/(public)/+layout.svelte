<script lang="ts">
  let { children } = $props();
</script>

<div class="public-layout">
  <header class="public-header">
    <div class="header-inner">
      <a href="/" class="logo-link">
        <span class="logo-icon" aria-hidden="true">⏱</span>
        <span class="logo-text">Timing Hub</span>
      </a>

      <nav class="header-nav">
        <!-- Language switcher placeholder -->
        <button class="lang-btn" aria-label="Switch language">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <span>EN</span>
        </button>
      </nav>
    </div>
  </header>

  <main class="public-main">
    {@render children()}
  </main>
</div>

<style>
  .public-layout {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background-color: var(--color-bg);
  }

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

  .logo-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text);
  }

  .logo-icon {
    font-size: 1.25rem;
  }

  .logo-text {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .logo-text :global(span) {
    color: var(--color-primary);
  }

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
    font-size: 0.875rem;
    cursor: pointer;
    transition: color 150ms, border-color 150ms;
  }

  .lang-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .public-main {
    flex: 1;
  }
</style>
