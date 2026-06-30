<script lang="ts">
  import { onMount } from 'svelte';

  let showBanner = $state(false);
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  // BeforeInstallPromptEvent is not in standard TS lib
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }

  const DISMISS_KEY = 'pwa-install-dismissed';
  const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function isDismissed(): boolean {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      const ts = parseInt(raw, 10);
      return Date.now() - ts < DISMISS_DURATION_MS;
    } catch {
      return false;
    }
  }

  function dismiss() {
    showBanner = false;
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore storage errors
    }
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'accepted') {
      showBanner = false;
    }
  }

  onMount(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      if (!isDismissed()) {
        showBanner = true;
      }
    };

    window.addEventListener('beforeinstallprompt', handler);

    // Hide banner once the app is installed
    window.addEventListener('appinstalled', () => {
      showBanner = false;
      deferredPrompt = null;
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  });
</script>

{#if showBanner}
  <div class="install-banner" role="banner" aria-label="App installieren">
    <div class="install-banner__content">
      <span class="install-banner__icon" aria-hidden="true">⏱</span>
      <span class="install-banner__text">Timing Hub als App installieren</span>
    </div>
    <div class="install-banner__actions">
      <button class="install-banner__btn install-banner__btn--primary" onclick={install}>
        Installieren
      </button>
      <button
        class="install-banner__btn install-banner__btn--close"
        onclick={dismiss}
        aria-label="Schließen"
      >
        ×
      </button>
    </div>
  </div>
{/if}

<style>
  .install-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: #1a1a1a;
    border-top: 2px solid #e63012;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.6);
  }

  .install-banner__content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .install-banner__icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .install-banner__text {
    color: #f0f0f0;
    font-size: 0.9rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .install-banner__actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .install-banner__btn {
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1;
    padding: 0.5rem 0.875rem;
    transition: opacity 0.15s ease;
  }

  .install-banner__btn:hover {
    opacity: 0.85;
  }

  .install-banner__btn--primary {
    background: #e63012;
    color: #fff;
  }

  .install-banner__btn--close {
    background: transparent;
    color: #aaa;
    font-size: 1.25rem;
    padding: 0.25rem 0.5rem;
  }

  .install-banner__btn--close:hover {
    color: #fff;
  }

  /* Desktop: hide install prompt — native browser handles it */
  @media (min-width: 1024px) {
    .install-banner {
      display: none;
    }
  }
</style>
