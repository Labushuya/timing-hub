<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { authStore } from '$lib/stores/auth.js';

  let { children } = $props();

  const isAuthenticated = $derived(authStore.isAuthenticated);
  const isLoading = $derived(authStore.isLoading);
  const user = $derived(authStore.user);
  const isAdmin = $derived((user as { role?: string } | null)?.role === 'admin');

  const currentPath = $derived($page.url.pathname);

  // Core nav items
  const navItems = [
    { href: '/dashboard', label: 'Meine Veranstaltungen', icon: 'home' },
    { href: '/events', label: 'Events', icon: 'calendar' },
  ];

  // Admin nav items — shown only for admin role
  const adminItems = [
    { href: '/admin/tokens', label: 'Tokens', icon: 'key' },
    { href: '/admin/users', label: 'Benutzer', icon: 'users' },
  ];

  // Redirect to login if not authenticated (after loading)
  $effect(() => {
    if (!isLoading && !isAuthenticated) {
      goto(`/login?redirect=${encodeURIComponent(currentPath)}`);
    }
  });

  async function handleLogout() {
    await authStore.logout();
    await goto('/login');
  }

  function isActive(href: string): boolean {
    return currentPath === href || currentPath.startsWith(href + '/');
  }

  function userInitial(): string {
    const u = user as { display_name?: string; email?: string } | null;
    return u?.display_name?.[0]?.toUpperCase() ?? u?.email?.[0]?.toUpperCase() ?? '?';
  }

  function userName(): string {
    const u = user as { display_name?: string; email?: string } | null;
    return u?.display_name ?? u?.email ?? 'Benutzer';
  }

  function userEmail(): string {
    const u = user as { email?: string } | null;
    return u?.email ?? '';
  }
</script>

{#if isLoading}
  <div class="app-loading" aria-busy="true" aria-label="Laden...">
    <div class="app-spinner"></div>
  </div>

{:else if isAuthenticated}
  <div class="app-shell">
    <!-- Sidebar (desktop) -->
    <nav class="sidebar" aria-label="Hauptnavigation">
      <div class="sidebar-header">
        <a href="/dashboard" class="sidebar-logo">
          <span aria-hidden="true">⏱</span>
          <span>Timing Hub</span>
        </a>
      </div>

      <div class="sidebar-nav-wrapper">
        <ul class="sidebar-nav" role="list">
          {#each navItems as item}
            <li>
              <a
                href={item.href}
                class="sidebar-link"
                class:active={isActive(item.href)}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {@render SidebarIcon({ name: item.icon })}
                <span>{item.label}</span>
              </a>
            </li>
          {/each}
        </ul>

        {#if isAdmin}
          <div class="sidebar-section">
            <span class="sidebar-section-label">Admin</span>
            <ul class="sidebar-nav" role="list">
              {#each adminItems as item}
                <li>
                  <a
                    href={item.href}
                    class="sidebar-link sidebar-link-admin"
                    class:active={isActive(item.href)}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                  >
                    {@render SidebarIcon({ name: item.icon })}
                    <span>{item.label}</span>
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>

      <div class="sidebar-footer">
        <div class="user-info">
          <div class="avatar" aria-hidden="true">{userInitial()}</div>
          <div class="user-details">
            <span class="user-name">{userName()}</span>
            <span class="user-email">{userEmail()}</span>
          </div>
        </div>
        <button class="logout-btn" onclick={handleLogout} title="Abmelden" aria-label="Abmelden">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>
    </nav>

    <!-- Main content -->
    <div class="app-content">
      <!-- Mobile header -->
      <header class="mobile-header">
        <span class="mobile-logo">⏱ Timing Hub</span>
        <div class="mobile-header-right">
          <span class="mobile-user-name">{userName()}</span>
          <div class="avatar-sm" aria-hidden="true">{userInitial()}</div>
        </div>
      </header>

      <main class="main-content">
        {@render children()}
      </main>
    </div>

    <!-- Bottom nav (mobile) -->
    <nav class="bottom-nav" aria-label="Mobile Navigation">
      {#each navItems as item}
        <a
          href={item.href}
          class="bottom-nav-item"
          class:active={isActive(item.href)}
          aria-current={isActive(item.href) ? 'page' : undefined}
        >
          {@render BottomNavIcon({ name: item.icon })}
          <span class="bottom-nav-label">{item.label === 'Meine Veranstaltungen' ? 'Veranstaltungen' : item.label}</span>
        </a>
      {/each}
      {#if isAdmin}
        <a
          href="/admin/tokens"
          class="bottom-nav-item"
          class:active={isActive('/admin')}
          aria-current={isActive('/admin') ? 'page' : undefined}
        >
          {@render BottomNavIcon({ name: 'shield' })}
          <span class="bottom-nav-label">Admin</span>
        </a>
      {/if}
      <button class="bottom-nav-item" onclick={handleLogout} aria-label="Abmelden">
        {@render BottomNavIcon({ name: 'logout' })}
        <span class="bottom-nav-label">Abmelden</span>
      </button>
    </nav>
  </div>
{/if}

<!-- Inline icon helpers (no external dep) -->
{#snippet SidebarIcon({ name }: { name: string })}
  {#if name === 'home'}
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  {:else if name === 'calendar'}
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  {:else if name === 'key'}
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  {:else if name === 'users'}
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  {:else if name === 'shield'}
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  {/if}
{/snippet}

{#snippet BottomNavIcon({ name }: { name: string })}
  {#if name === 'home'}
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  {:else if name === 'calendar'}
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  {:else if name === 'shield'}
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  {:else if name === 'logout'}
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  {/if}
{/snippet}

<style>
  /* Loading state */
  .app-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100dvh;
    background: var(--color-bg);
  }

  .app-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Shell layout */
  .app-shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    grid-template-rows: 1fr auto;
    height: 100dvh;
    overflow: hidden;
  }

  /* Sidebar */
  .sidebar {
    grid-row: 1 / -1;
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    overflow-y: auto;
  }

  .sidebar-header {
    padding: 1.25rem 1rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .sidebar-logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text);
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .sidebar-nav-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .sidebar-nav {
    padding: 0.25rem 0.5rem;
    list-style: none;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .sidebar-section {
    margin-top: 0.5rem;
    border-top: 1px solid var(--color-border);
    padding-top: 0.5rem;
  }

  .sidebar-section-label {
    display: block;
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-subtle);
    padding: 0.375rem 0.75rem 0.25rem;
  }

  .sidebar-link {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-md);
    text-decoration: none;
    color: var(--color-text-muted);
    font-size: 0.9375rem;
    font-weight: 500;
    transition: all 150ms;
  }

  .sidebar-link:hover {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  .sidebar-link.active {
    color: var(--color-text);
    background: var(--color-surface-2);
    font-weight: 600;
  }

  .sidebar-link.active :global(svg) {
    color: var(--color-primary);
  }

  .sidebar-link-admin:hover {
    color: var(--color-warning);
  }

  .sidebar-link-admin.active {
    color: var(--color-warning);
  }

  .sidebar-link-admin.active :global(svg) {
    color: var(--color-warning);
  }

  .sidebar-footer {
    padding: 1rem;
    border-top: 1px solid var(--color-border);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .user-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
  }

  .avatar {
    width: 32px;
    height: 32px;
    background: var(--color-primary);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.875rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .avatar-sm {
    width: 28px;
    height: 28px;
    background: var(--color-primary);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .user-details {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .user-name {
    font-size: 0.875rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-email {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .logout-btn {
    padding: 0.375rem;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: color 150ms;
    flex-shrink: 0;
    min-width: 36px;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .logout-btn:hover { color: var(--color-danger); }

  /* App content */
  .app-content {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .mobile-header {
    display: none;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .mobile-logo {
    font-weight: 700;
    font-size: 1rem;
  }

  .mobile-header-right {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .mobile-user-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
  }

  /* Bottom nav (mobile only) */
  .bottom-nav {
    display: none;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .bottom-nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.625rem 0;
    flex: 1;
    text-decoration: none;
    color: var(--color-text-muted);
    font-size: 0.625rem;
    border: none;
    background: transparent;
    cursor: pointer;
    min-height: 56px;
    transition: color 120ms;
  }

  .bottom-nav-item.active {
    color: var(--color-primary);
  }

  .bottom-nav-label {
    font-size: 0.625rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Responsive: mobile */
  @media (max-width: 768px) {
    .app-shell {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr auto;
    }

    .sidebar { display: none; }

    .mobile-header { display: flex; }

    .bottom-nav {
      display: flex;
    }

    .main-content {
      padding: 1rem;
    }
  }
</style>
