<script lang="ts">
  import { toastStore } from '$lib/stores/toast.svelte.js';
  import type { Toast } from '$lib/stores/toast.svelte.js';

  interface ToastProps {
    toast: Toast;
  }

  let { toast }: ToastProps = $props();

  let visible = $state(true);

  function dismiss() {
    visible = false;
    setTimeout(() => toastStore.remove(toast.id), 300);
  }

  // Icons per type
  const icons: Record<string, string> = {
    success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
    warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
  };
</script>

<div
  class="toast toast-{toast.type}"
  class:toast-hidden={!visible}
  role="alert"
  aria-live="polite"
>
  <svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d={icons[toast.type] ?? icons.info} />
  </svg>
  <span class="toast-message">{toast.message}</span>
  <button class="toast-close" onclick={dismiss} aria-label="Schliessen">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  </button>
</div>

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    min-width: 280px;
    max-width: 420px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    animation: toast-in 250ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
    transition: opacity 250ms, transform 250ms;
  }

  .toast-hidden {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
    pointer-events: none;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.95);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .toast-success {
    background: #0d2b1a;
    border-color: var(--color-success);
    color: var(--color-success);
  }

  .toast-error {
    background: #2b0d0d;
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .toast-warning {
    background: #2b1e00;
    border-color: var(--color-warning);
    color: var(--color-warning);
  }

  .toast-info {
    background: #0d1a2b;
    border-color: var(--color-info);
    color: var(--color-info);
  }

  .toast-icon {
    flex-shrink: 0;
  }

  .toast-message {
    flex: 1;
    font-size: 0.9375rem;
    font-weight: 500;
    line-height: 1.4;
    color: var(--color-text);
  }

  .toast-close {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 2px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms;
  }

  .toast-close:hover {
    color: var(--color-text);
  }
</style>
