<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { authStore } from '$lib/stores/auth.js';
  import { wsStore } from '$lib/stores/ws.js';
  import { offlineStore } from '$lib/stores/offline.js';
  import ToastStack from '$lib/components/ui/ToastStack.svelte';

  let { children } = $props();

  onMount(() => {
    // Restore auth session from storage / refresh cookie
    authStore.restoreFromStorage().then(() => {
      if (authStore.isAuthenticated) {
        // Initialize WebSocket connection
        wsStore.connect();

        // Sync any offline queue entries on WS connect
        const unsub = wsStore.isConnected
          ? offlineStore.sync().catch(console.warn)
          : null;
        void unsub;
      }
    });

    // When WS reconnects, drain offline queue
    const unsubWs = wsStore.onMessage('connected', () => {
      if (offlineStore.pending > 0) {
        offlineStore.sync().catch(console.warn);
      }
    });

    return () => {
      unsubWs();
      wsStore.disconnect();
    };
  });
</script>

{@render children()}
<ToastStack />
