<script lang="ts">
  import type { WsStatus } from '$lib/stores/ws.svelte.js';

  interface Props {
    status: WsStatus;
    compact?: boolean;
  }

  let { status, compact = false }: Props = $props();

  const config = $derived(() => {
    switch (status) {
      case 'connected':
        return { color: 'green', label: 'Connected', dotClass: 'dot-green' };
      case 'connecting':
        return { color: 'yellow', label: 'Connecting', dotClass: 'dot-yellow dot-pulse' };
      case 'reconnecting':
        return { color: 'yellow', label: 'Reconnecting', dotClass: 'dot-yellow dot-pulse' };
      case 'offline':
        return { color: 'red', label: 'Offline', dotClass: 'dot-red' };
      case 'idle':
      default:
        return { color: 'gray', label: 'Idle', dotClass: 'dot-gray' };
    }
  });
</script>

<div
  class="connection-status"
  class:compact
  role="status"
  aria-label="Connection status: {config().label}"
  title="Connection: {config().label}"
>
  <span class="status-dot {config().dotClass}" aria-hidden="true"></span>
  {#if !compact}
    <span class="status-label">{config().label}</span>
  {/if}
</div>

<style>
  .connection-status {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .connection-status.compact {
    gap: 0;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background-color 300ms;
  }

  .dot-green { background-color: var(--color-success); }
  .dot-yellow { background-color: var(--color-warning); }
  .dot-red { background-color: var(--color-danger); }
  .dot-gray { background-color: var(--color-text-subtle); }

  @keyframes status-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .dot-pulse {
    animation: status-pulse 1s ease-in-out infinite;
  }

  .status-label {
    font-weight: 500;
  }
</style>
