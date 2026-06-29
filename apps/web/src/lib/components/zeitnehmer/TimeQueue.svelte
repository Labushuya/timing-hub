<script lang="ts">
  // ---- Types -----------------------------------------------------------------

  interface QueueEntry {
    entry_id: string;
    time_display: string;
    raw_time_ms: number;
    startnummer: number | null;
    client_seq: number;
  }

  // ---- Props -----------------------------------------------------------------

  interface Props {
    entries?: QueueEntry[];
    onconfirm?: (entry: QueueEntry, startnummer: number) => void;
    onremove?: (entryId: string) => void;
  }

  let { entries = [], onconfirm, onremove }: Props = $props();

  // ---- Per-row state ---------------------------------------------------------

  // Map: entry_id → startnummer input string
  let inputValues = $state<Record<string, string>>({});

  function getInput(entryId: string): string {
    return inputValues[entryId] ?? '';
  }

  function setInput(entryId: string, val: string) {
    inputValues = { ...inputValues, [entryId]: val };
  }

  function handleConfirm(entry: QueueEntry) {
    const raw = getInput(entry.entry_id) || (entry.startnummer !== null ? String(entry.startnummer) : '');
    const num = parseInt(raw, 10);
    if (isNaN(num) || num <= 0) return;
    if ('vibrate' in navigator) navigator.vibrate(30);
    onconfirm?.(entry, num);
  }

  function handleRemove(entryId: string) {
    onremove?.(entryId);
  }

  // Touch swipe-to-delete
  let touchStartX = $state<Record<string, number>>({});
  let swipeOffsets = $state<Record<string, number>>({});
  const SWIPE_THRESHOLD = 80;

  function onTouchStart(entryId: string, e: TouchEvent) {
    touchStartX = { ...touchStartX, [entryId]: e.touches[0]!.clientX };
  }

  function onTouchMove(entryId: string, e: TouchEvent) {
    const start = touchStartX[entryId];
    if (start === undefined) return;
    const delta = e.touches[0]!.clientX - start;
    if (delta < 0) {
      swipeOffsets = { ...swipeOffsets, [entryId]: delta };
    }
  }

  function onTouchEnd(entryId: string) {
    const offset = swipeOffsets[entryId] ?? 0;
    if (Math.abs(offset) >= SWIPE_THRESHOLD) {
      handleRemove(entryId);
    } else {
      swipeOffsets = { ...swipeOffsets, [entryId]: 0 };
    }
    touchStartX = { ...touchStartX, [entryId]: 0 };
  }
</script>

<div class="time-queue">
  <h3 class="queue-title">
    Unconfirmed Times
    <span class="queue-count" aria-label="{entries.length} entries">{entries.length}</span>
  </h3>

  {#if entries.length === 0}
    <p class="queue-empty">No unconfirmed entries</p>
  {:else}
    <ul class="queue-list" role="list">
      {#each entries as entry (entry.entry_id)}
        {@const offset = swipeOffsets[entry.entry_id] ?? 0}
        <li
          class="queue-item"
          style="transform: translateX({offset}px); opacity: {1 + offset / 200}"
          ontouchstart={(e) => onTouchStart(entry.entry_id, e)}
          ontouchmove={(e) => onTouchMove(entry.entry_id, e)}
          ontouchend={() => onTouchEnd(entry.entry_id)}
          role="listitem"
        >
          <!-- Time display -->
          <div class="entry-time">
            <span class="time-value tabular-nums">{entry.time_display}</span>
          </div>

          <!-- Startnummer input -->
          <div class="entry-nr">
            <label for="nr-{entry.entry_id}" class="entry-nr-label">Nr.</label>
            <input
              id="nr-{entry.entry_id}"
              type="number"
              class="entry-nr-input"
              inputmode="numeric"
              pattern="[0-9]*"
              min="1"
              max="9999"
              placeholder={entry.startnummer !== null ? String(entry.startnummer) : '?'}
              value={getInput(entry.entry_id) || (entry.startnummer !== null ? String(entry.startnummer) : '')}
              oninput={(e) => setInput(entry.entry_id, (e.target as HTMLInputElement).value)}
              aria-label="Startnummer for time {entry.time_display}"
            />
          </div>

          <!-- Confirm button -->
          <button
            class="confirm-btn"
            onclick={() => handleConfirm(entry)}
            type="button"
            aria-label="Confirm entry for time {entry.time_display}"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>

          <!-- Remove button -->
          <button
            class="remove-btn"
            onclick={() => handleRemove(entry.entry_id)}
            type="button"
            aria-label="Remove unconfirmed entry for time {entry.time_display}"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </li>
      {/each}
    </ul>

    <p class="swipe-hint" aria-hidden="true">
      ← Swipe left to remove
    </p>
  {/if}
</div>

<style>
  .time-queue {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .queue-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
    margin: 0;
  }

  .queue-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--color-primary);
    color: white;
    border-radius: 9999px;
    font-size: 0.6875rem;
    font-weight: 800;
  }

  .queue-empty {
    font-size: 0.875rem;
    color: var(--color-text-subtle);
    margin: 0;
    padding: 0.5rem 0;
  }

  .queue-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow: hidden;
  }

  .queue-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.75rem;
    transition: transform 150ms ease-out, opacity 150ms ease-out;
    will-change: transform;
  }

  /* Time display */
  .entry-time {
    flex: 1;
    min-width: 0;
  }

  .time-value {
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-text);
  }

  /* Startnummer input */
  .entry-nr {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;
  }

  .entry-nr-label {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-subtle);
  }

  .entry-nr-input {
    width: 64px;
    padding: 0.375rem 0.5rem;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 700;
    text-align: center;
    font-variant-numeric: tabular-nums;
    /* Remove browser number spinners */
    -moz-appearance: textfield;
  }

  .entry-nr-input::-webkit-outer-spin-button,
  .entry-nr-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .entry-nr-input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  /* Buttons */
  .confirm-btn, .remove-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background-color 120ms, color 120ms;
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
  }

  .confirm-btn {
    background: var(--color-success-bg);
    color: var(--color-success);
    border: 1px solid var(--color-success);
  }

  .confirm-btn:hover {
    background: var(--color-success);
    color: white;
  }

  .confirm-btn:active {
    transform: scale(0.95);
  }

  .remove-btn {
    background: transparent;
    color: var(--color-text-subtle);
  }

  .remove-btn:hover {
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }

  /* Swipe hint */
  .swipe-hint {
    font-size: 0.6875rem;
    color: var(--color-text-subtle);
    text-align: center;
    margin: 0;
    padding-top: 0.25rem;
  }

  /* Only show swipe hint on touch devices */
  @media (hover: hover) {
    .swipe-hint { display: none; }
  }
</style>
