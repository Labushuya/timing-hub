<script lang="ts">
  import { toastStore } from '$lib/stores/toast.js';
  import Toast from './Toast.svelte';
</script>

{#if toastStore.toasts.length > 0}
  <div class="toast-stack" aria-label="Benachrichtigungen" role="region">
    {#each toastStore.toasts as toast (toast.id)}
      <Toast {toast} />
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    pointer-events: none;
  }

  .toast-stack > :global(*) {
    pointer-events: auto;
  }

  @media (max-width: 640px) {
    .toast-stack {
      bottom: 5rem; /* above bottom nav */
      right: 0.75rem;
      left: 0.75rem;
      align-items: stretch;
    }
  }
</style>
