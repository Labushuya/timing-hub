/**
 * Toast store — Svelte 5 runes-based
 *
 * Usage:
 *   import { toastStore } from '$lib/stores/toast';
 *   toastStore.add({ type: 'success', message: 'Gespeichert' });
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
}

function createToastStore() {
  let toasts = $state<Toast[]>([]);
  let counter = 0;

  function add(toast: { type: ToastType; message: string }): string {
    const id = `toast-${++counter}-${Date.now()}`;
    const entry: Toast = {
      id,
      type: toast.type,
      message: toast.message,
      createdAt: Date.now()
    };
    // Keep max 3 toasts — remove oldest if needed
    if (toasts.length >= 3) {
      toasts = [...toasts.slice(toasts.length - 2), entry];
    } else {
      toasts = [...toasts, entry];
    }
    // Auto-dismiss after 4 seconds
    setTimeout(() => remove(id), 4000);
    return id;
  }

  function remove(id: string): void {
    toasts = toasts.filter((t) => t.id !== id);
  }

  function success(message: string): string {
    return add({ type: 'success', message });
  }

  function error(message: string): string {
    return add({ type: 'error', message });
  }

  function info(message: string): string {
    return add({ type: 'info', message });
  }

  function warning(message: string): string {
    return add({ type: 'warning', message });
  }

  return {
    get toasts() { return toasts; },
    add,
    remove,
    success,
    error,
    info,
    warning
  };
}

export const toastStore = createToastStore();
