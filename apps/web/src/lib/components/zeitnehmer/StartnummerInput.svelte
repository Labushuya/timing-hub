<script lang="ts">
  import { onMount } from 'svelte';

  // ---- Props -----------------------------------------------------------------

  interface Props {
    value?: number | null;
    label?: string;
    onconfirm?: (value: number) => void;
  }

  let { value = $bindable(null), label = 'Startnummer', onconfirm }: Props = $props();

  // ---- State -----------------------------------------------------------------

  let inputStr = $state('');
  let containerRef: HTMLDivElement | undefined;

  // Sync inputStr with value prop
  $effect(() => {
    if (value !== null) {
      inputStr = String(value);
    }
  });

  // ---- Keypad actions --------------------------------------------------------

  function pressDigit(digit: number) {
    if (inputStr.length >= 4) return; // max 4-digit startnummer
    inputStr = inputStr + String(digit);
    updateValue();
    haptic();
  }

  function pressBackspace() {
    if (inputStr.length === 0) return;
    inputStr = inputStr.slice(0, -1);
    updateValue();
    haptic();
  }

  function pressOK() {
    const num = parseInt(inputStr, 10);
    if (!isNaN(num) && num > 0) {
      value = num;
      onconfirm?.(num);
      haptic(100);
    }
  }

  function updateValue() {
    const num = parseInt(inputStr, 10);
    value = isNaN(num) ? null : num;
  }

  function haptic(duration = 30) {
    if ('vibrate' in navigator) navigator.vibrate(duration);
  }

  // Focus on mount for immediate input
  onMount(() => {
    // Do not auto-focus — interferes with stamp button on mobile
  });

  // Keypad layout
  const digits = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9]
  ];
</script>

<div class="startnummer-input" bind:this={containerRef}>
  <!-- Display -->
  <div class="display" aria-label="{label}: {inputStr || 'none'}">
    <span class="display-label">{label}</span>
    <div class="display-value" role="status" aria-live="polite">
      {#if inputStr}
        <span class="value-text">{inputStr}</span>
      {:else}
        <span class="value-placeholder">—</span>
      {/if}
    </div>
  </div>

  <!-- Keypad -->
  <div class="keypad" role="group" aria-label="Number keypad">
    {#each digits as row}
      <div class="keypad-row">
        {#each row as digit}
          <button
            class="key key-digit"
            onclick={() => pressDigit(digit)}
            aria-label="{String(digit)}"
            type="button"
          >
            {digit}
          </button>
        {/each}
      </div>
    {/each}

    <!-- Bottom row: backspace + 0 + OK -->
    <div class="keypad-row">
      <button
        class="key key-action key-backspace"
        onclick={pressBackspace}
        aria-label="Backspace"
        type="button"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
          <line x1="18" y1="9" x2="12" y2="15"/>
          <line x1="12" y1="9" x2="18" y2="15"/>
        </svg>
      </button>

      <button
        class="key key-digit"
        onclick={() => pressDigit(0)}
        aria-label="0"
        type="button"
      >
        0
      </button>

      <button
        class="key key-action key-ok"
        onclick={pressOK}
        aria-label="Confirm startnummer"
        disabled={inputStr.length === 0}
        type="button"
      >
        OK
      </button>
    </div>
  </div>
</div>

<style>
  .startnummer-input {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 1rem;
  }

  /* Display */
  .display {
    text-align: center;
    padding: 0.5rem 0;
  }

  .display-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
    margin-bottom: 0.375rem;
  }

  .display-value {
    min-height: 3rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .value-text {
    font-size: 2.5rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }

  .value-placeholder {
    font-size: 2.5rem;
    color: var(--color-text-subtle);
  }

  /* Keypad */
  .keypad {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .keypad-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  /* Keys */
  .key {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 56px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text);
    font-family: inherit;
    cursor: pointer;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    transition: background-color 100ms, transform 80ms;
  }

  .key:active {
    background: var(--color-surface-3);
    transform: scale(0.96);
  }

  .key-digit {
    font-size: 1.375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .key-action {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--color-text-muted);
  }

  .key-backspace:active {
    background: var(--color-danger-bg);
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .key-ok {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
    letter-spacing: 0.05em;
  }

  .key-ok:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .key-ok:active:not(:disabled) {
    background: var(--color-primary-active);
  }

  .key-ok:disabled {
    background: var(--color-surface-3);
    border-color: var(--color-border);
    color: var(--color-text-subtle);
    cursor: not-allowed;
  }
</style>
