<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { authStore } from '$lib/stores/auth.svelte.js';
  import { wsStore } from '$lib/stores/ws.svelte.js';
  import { offlineStore } from '$lib/stores/offline.svelte.js';
  import ToastStack from '$lib/components/ui/ToastStack.svelte';
  import InstallPrompt from '$lib/components/ui/InstallPrompt.svelte';
  import { initLocale, locale, setLocale, type Locale } from '$i18n/index.js';

  let { children } = $props();

  // Reactive locale value for the switcher button
  const currentLocale = $derived($locale as Locale | undefined);

  onMount(() => {
    // Initialize locale from localStorage / navigator.language
    initLocale();

    // Restore auth session from storage / refresh cookie
    authStore.restoreFromStorage().then(() => {
      if (authStore.isAuthenticated) {
        // Initialize WebSocket connection
        wsStore.connect();

        // Sync any offline queue entries on WS connect
        const unsub = wsStore.isConnected
          ? offlineStore.sync().catch(console.warn)
          : null;
        void unsub;
      }
    });

    // When WS reconnects, drain offline queue
    const unsubWs = wsStore.onMessage('connected', () => {
      if (offlineStore.pending > 0) {
        offlineStore.sync().catch(console.warn);
      }
    });

    return () => {
      unsubWs();
      wsStore.disconnect();
    };
  });

  function toggleLocale() {
    setLocale(currentLocale === 'de' ? 'en' : 'de');
  }
</script>

{@render children()}
<ToastStack />
<InstallPrompt />

<!-- Locale switcher: fixed top-right, unobtrusive -->
<div class="locale-switcher" aria-label="Language">
  <button
    class="locale-btn"
    onclick={toggleLocale}
    title={currentLocale === 'de' ? 'Switch to English' : 'Zu Deutsch wechseln'}
    aria-label={currentLocale === 'de' ? 'Switch to English' : 'Zu Deutsch wechseln'}
  >
    {currentLocale === 'de' ? 'EN' : 'DE'}
  </button>
</div>

<style>
  .locale-switcher {
    position: fixed;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 9999;
    pointer-events: auto;
  }

  .locale-btn {
    padding: 0.25rem 0.5rem;
    background: var(--color-surface-2, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
    border-radius: var(--radius-sm, 4px);
    color: var(--color-text-muted, rgba(255, 255, 255, 0.55));
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: color 120ms, border-color 120ms, background 120ms;
    min-width: 32px;
    text-align: center;
  }

  .locale-btn:hover {
    color: var(--color-text, #fff);
    border-color: var(--color-primary, #e63012);
    background: var(--color-surface-2, rgba(255, 255, 255, 0.12));
  }
</style>
