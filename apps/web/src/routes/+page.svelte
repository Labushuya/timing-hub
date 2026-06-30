<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { authStore } from '$lib/stores/auth.svelte';

  onMount(async () => {
    // Attempt to restore session from stored refresh token
    await authStore.restoreFromStorage();

    if (authStore.isAuthenticated) {
      goto('/dashboard', { replaceState: true });
    } else {
      goto('/login', { replaceState: true });
    }
  });
</script>
