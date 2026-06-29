<script lang="ts">
  // ---- Props -----------------------------------------------------------------

  interface Props {
    disabled?: boolean;
    title?: string;
    onstamp?: (e: CustomEvent<{ timestamp: number }>) => void;
  }

  let { disabled = false, title = 'Stamp', onstamp }: Props = $props();

  // ---- State -----------------------------------------------------------------

  let processing = $state(false);
  let lastStampTime = $state<number | null>(null);
  let pressing = $state(false);

  const DEBOUNCE_MS = 500;

  // ---- Stamp action ----------------------------------------------------------

  function doStamp() {
    if (disabled || processing) return;

    const now = Date.now();

    // Debounce: ignore rapid double-taps
    if (lastStampTime !== null && now - lastStampTime < DEBOUNCE_MS) return;
    lastStampTime = now;

    // Haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    // Visual press feedback
    pressing = true;
    setTimeout(() => { pressing = false; }, 150);

    processing = true;

    // Dispatch event with timestamp
    const event = new CustomEvent('stamp', { detail: { timestamp: now } });
    onstamp?.(event as CustomEvent<{ timestamp: number }>);

    // Brief processing indicator
    setTimeout(() => { processing = false; }, 200);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      doStamp();
    }
  }
</script>

<button
  class="stamp-btn"
  class:pressing
  class:disabled
  {disabled}
  onclick={doStamp}
  onkeydown={handleKeydown}
  aria-label="{title} — tap to record time"
  aria-busy={processing}
  aria-disabled={disabled}
  type="button"
>
  <div class="stamp-inner">
    {#if processing}
      <span class="stamp-spinner" aria-hidden="true"></span>
    {:else}
      <span class="stamp-icon" aria-hidden="true">
        <!-- Stopwatch icon -->
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="12" cy="13" r="8"/>
          <polyline points="12 9 12 13 14.5 15.5"/>
          <line x1="10" y1="3" x2="14" y2="3"/>
          <line x1="12" y1="3" x2="12" y2="5"/>
          <line x1="19.07" y1="5.93" x2="17.66" y2="7.34"/>
        </svg>
      </span>
      <span class="stamp-label">{title}</span>
    {/if}
  </div>

  <!-- Press ripple -->
  {#if pressing}
    <span class="stamp-ripple" aria-hidden="true"></span>
  {/if}
</button>

<style>
  .stamp-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 200px;
    max-width: 400px;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-xl);
    color: white;
    cursor: pointer;
    overflow: hidden;
    touch-action: manipulation;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms;
    /* Subtle shadow for depth */
    box-shadow:
      0 4px 16px rgba(230, 48, 18, 0.4),
      0 1px 3px rgba(0, 0, 0, 0.3);
  }

  .stamp-btn:hover:not(.disabled) {
    background: var(--color-primary-hover);
  }

  .stamp-btn:active:not(.disabled),
  .stamp-btn.pressing {
    background: var(--color-primary-active);
    transform: scale(0.98);
    box-shadow:
      0 2px 8px rgba(230, 48, 18, 0.3),
      0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .stamp-btn.disabled {
    background: var(--color-surface-3);
    box-shadow: none;
    cursor: not-allowed;
    color: var(--color-text-subtle);
  }

  .stamp-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    pointer-events: none;
  }

  .stamp-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.9;
  }

  .stamp-label {
    font-size: 1.5rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* Spinner */
  .stamp-spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Ripple */
  .stamp-ripple {
    position: absolute;
    inset: 0;
    background: rgba(255, 255, 255, 0.2);
    animation: ripple-fade 300ms ease-out forwards;
    pointer-events: none;
    border-radius: inherit;
  }

  @keyframes ripple-fade {
    from { opacity: 1; transform: scale(0.95); }
    to { opacity: 0; transform: scale(1.05); }
  }
</style>
