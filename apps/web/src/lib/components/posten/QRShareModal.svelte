<script lang="ts">
  import { onMount, tick } from 'svelte';
  import QRCode from 'qrcode-svg';

  interface Props {
    url: string;
    postenName: string;
    onclose: () => void;
  }

  let { url, postenName, onclose }: Props = $props();

  let qrSvg = $state('');
  let copied = $state(false);
  let dialogEl = $state<HTMLDialogElement | null>(null);

  onMount(async () => {
    // Generate QR SVG
    const qr = new QRCode({
      content: url,
      padding: 4,
      width: 320,
      height: 320,
      color: '#ffffff',
      background: '#1a1a2e',
      ecl: 'M'
    });
    qrSvg = qr.svg();

    await tick();
    dialogEl?.showModal();
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === dialogEl) {
      onclose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch {
      // ignore
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  class="qr-modal"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  aria-label="QR-Code für {postenName}"
>
  <div class="modal-content">
    <!-- Close button -->
    <button class="close-btn" onclick={onclose} aria-label="Schließen">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>

    <!-- Header -->
    <div class="modal-header">
      <div class="modal-label">Zeitnehmer-Zugang</div>
      <h2 class="modal-title">{postenName}</h2>
    </div>

    <!-- QR code -->
    <div class="qr-wrapper" aria-label="QR-Code für URL: {url}">
      {#if qrSvg}
        {@html qrSvg}
      {:else}
        <div class="qr-placeholder" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
        </div>
      {/if}
    </div>

    <!-- URL display -->
    <div class="url-section">
      <div class="url-box">
        <span class="url-text">{url}</span>
      </div>
      <button class="copy-btn" onclick={copyUrl} class:copied>
        {#if copied}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Kopiert!
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          URL kopieren
        {/if}
      </button>
    </div>

    <!-- Instructions -->
    <p class="modal-hint">
      Diesen QR-Code dem Zeitnehmer zeigen oder ausdrucken. Mit dem Smartphone scannen öffnet die Zeitnahme-Seite direkt.
    </p>

    <button class="btn-close-bottom" onclick={onclose}>Schließen</button>
  </div>
</dialog>

<style>
  .qr-modal {
    border: none;
    border-radius: var(--radius-lg);
    background: var(--color-surface, #1a1a2e);
    color: var(--color-text);
    padding: 0;
    max-width: 420px;
    width: calc(100vw - 2rem);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255,255,255,0.08);
    position: fixed;
    inset: 0;
    margin: auto;
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
  }

  .qr-modal::backdrop {
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
  }

  .modal-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    padding: 2rem 2rem 1.75rem;
    position: relative;
  }

  .close-btn {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface-2, rgba(255,255,255,0.06));
    border: 1px solid var(--color-border, rgba(255,255,255,0.1));
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    cursor: pointer;
    transition: color 150ms, background 150ms;
  }
  .close-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-3, rgba(255,255,255,0.1));
  }

  .modal-header {
    text-align: center;
    padding-top: 0.5rem;
  }

  .modal-label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
    margin-bottom: 0.375rem;
  }

  .modal-title {
    font-size: 1.25rem;
    font-weight: 800;
    margin: 0;
    letter-spacing: -0.02em;
  }

  /* QR code container */
  .qr-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a1a2e;
    border: 1px solid var(--color-border, rgba(255,255,255,0.1));
    border-radius: var(--radius-lg);
    overflow: hidden;
    width: 320px;
    height: 320px;
    flex-shrink: 0;
  }

  .qr-wrapper :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .qr-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  /* URL section */
  .url-section {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: stretch;
  }

  .url-box {
    background: var(--color-surface-2, rgba(255,255,255,0.06));
    border: 1px solid var(--color-border, rgba(255,255,255,0.1));
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
    overflow: hidden;
  }

  .url-text {
    font-size: 0.8125rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted);
    word-break: break-all;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem;
    background: var(--color-surface-2, rgba(255,255,255,0.06));
    border: 1px solid var(--color-border, rgba(255,255,255,0.12));
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    width: 100%;
  }

  .copy-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-3, rgba(255,255,255,0.1));
  }

  .copy-btn.copied {
    color: #4ade80;
    border-color: rgba(74, 222, 128, 0.3);
    background: rgba(74, 222, 128, 0.08);
  }

  .modal-hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    text-align: center;
    margin: 0;
    line-height: 1.5;
    max-width: 320px;
  }

  .btn-close-bottom {
    padding: 0.625rem 2rem;
    background: transparent;
    border: 1px solid var(--color-border, rgba(255,255,255,0.12));
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 150ms;
    font-family: inherit;
    width: 100%;
  }
  .btn-close-bottom:hover {
    color: var(--color-text);
    background: var(--color-surface-2, rgba(255,255,255,0.06));
  }
</style>
