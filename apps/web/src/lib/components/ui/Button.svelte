<script lang="ts">
  // ---- Props -----------------------------------------------------------------

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  interface ButtonProps {
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    disabled?: boolean;
    fullWidth?: boolean;
    type?: 'button' | 'submit' | 'reset';
    onclick?: (e: MouseEvent) => void;
    children?: import('svelte').Snippet;
    'icon-left'?: import('svelte').Snippet;
    'icon-right'?: import('svelte').Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    fullWidth = false,
    type = 'button',
    onclick,
    children,
    'icon-left': iconLeft,
    'icon-right': iconRight
  }: ButtonProps = $props();

  const isDisabled = $derived(disabled || loading);
</script>

<button
  {type}
  class="btn btn-{variant} btn-{size}"
  class:btn-full={fullWidth}
  class:btn-loading={loading}
  disabled={isDisabled}
  onclick={onclick}
  aria-busy={loading}
>
  {#if loading}
    <span class="btn-spinner" aria-hidden="true"></span>
  {:else if iconLeft}
    <span class="btn-icon-left" aria-hidden="true">
      {@render iconLeft()}
    </span>
  {/if}

  {#if children}
    <span class="btn-label">
      {@render children()}
    </span>
  {/if}

  {#if iconRight && !loading}
    <span class="btn-icon-right" aria-hidden="true">
      {@render iconRight()}
    </span>
  {/if}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition: background-color 120ms, border-color 120ms, color 120ms, opacity 120ms;
    white-space: nowrap;
    text-decoration: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }

  /* Sizes */
  .btn-sm {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    min-height: 32px;
  }

  .btn-md {
    padding: 0.5rem 1.125rem;
    font-size: 0.9375rem;
    min-height: 40px;
  }

  .btn-lg {
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    min-height: 48px;
  }

  .btn-full { width: 100%; }

  /* Variants */
  .btn-primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-foreground);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .btn-primary:active:not(:disabled) {
    background: var(--color-primary-active);
    transform: scale(0.99);
  }

  .btn-secondary {
    background: var(--color-surface-2);
    border-color: var(--color-border);
    color: var(--color-text);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-3);
    border-color: var(--color-text-muted);
  }

  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--color-text-muted);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  .btn-danger {
    background: var(--color-danger-bg);
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-danger);
    color: #fff;
  }

  /* Disabled state */
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  /* Loading spinner */
  .btn-spinner {
    display: inline-block;
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: btn-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes btn-spin {
    to { transform: rotate(360deg); }
  }

  /* Icons */
  .btn-icon-left,
  .btn-icon-right {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .btn-label {
    /* ensures text inherits correct styling */
  }
</style>
