/**
 * Authentication store — Svelte 5 runes-based
 *
 * State:
 *   - user: User | null              — current authenticated user
 *   - accessToken: string | null     — JWT, kept in memory only
 *   - isLoading: boolean
 *
 * Persistence:
 *   - Refresh token stored in sessionStorage under REFRESH_KEY
 *   - Access token is never persisted to storage (memory only)
 */

import type { User } from '@timing-hub/shared-types';

// ---- Types ------------------------------------------------------------------

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: User;
}

export interface RefreshResponse {
  access_token: string;
  user: User;
}

// ---- Constants --------------------------------------------------------------

const REFRESH_KEY = 'th_refresh_token';
const API_BASE = (import.meta.env.PUBLIC_API_URL ?? import.meta.env.VITE_API_BASE ?? '/api') as string;

// ---- Store ------------------------------------------------------------------

function createAuthStore() {
  // Reactive state — Svelte 5 runes
  let user = $state<User | null>(null);
  let accessToken = $state<string | null>(null);
  let isLoading = $state(false);

  // ---- Derived ---------------------------------------------------------------

  const isAuthenticated = $derived(user !== null && accessToken !== null);

  // ---- Internal helpers ------------------------------------------------------

  function storeRefreshToken(token: string) {
    try {
      sessionStorage.setItem(REFRESH_KEY, token);
    } catch {
      // sessionStorage may be unavailable in some environments
    }
  }

  function getRefreshToken(): string | null {
    try {
      return sessionStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  }

  function clearRefreshToken() {
    try {
      sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      // ignore
    }
  }

  function applyTokens(newAccessToken: string, newRefreshToken: string | null, userData: User) {
    accessToken = newAccessToken;
    user = userData;
    if (newRefreshToken) {
      storeRefreshToken(newRefreshToken);
    }
  }

  function clearState() {
    accessToken = null;
    user = null;
    clearRefreshToken();
  }

  // ---- Actions ---------------------------------------------------------------

  async function login(email: string, password: string): Promise<User> {
    isLoading = true;
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = (body as { message?: string }).message ?? `HTTP ${res.status}`;
        throw new Error(message);
      }

      const data: LoginResponse = await res.json();
      applyTokens(data.access_token, data.refresh_token, data.user);
      return data.user;
    } finally {
      isLoading = false;
    }
  }

  async function logout(): Promise<void> {
    isLoading = true;
    const refreshToken = getRefreshToken();
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
    } catch {
      // Always clear local state even if the server call fails
    } finally {
      clearState();
      isLoading = false;
    }
  }

  async function refresh(): Promise<boolean> {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      clearState();
      return false;
    }

    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      });

      if (!res.ok) {
        clearState();
        return false;
      }

      const data: RefreshResponse = await res.json();
      accessToken = data.access_token;
      user = data.user;
      return true;
    } catch {
      clearState();
      return false;
    }
  }

  async function restoreFromStorage(): Promise<void> {
    isLoading = true;
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) {
        return;
      }
      await refresh();
    } finally {
      isLoading = false;
    }
  }

  // ---- Public API ------------------------------------------------------------

  return {
    get user() { return user; },
    get accessToken() { return accessToken; },
    get isLoading() { return isLoading; },
    get isAuthenticated() { return isAuthenticated; },

    login,
    logout,
    refresh,
    restoreFromStorage
  };
}

export const authStore = createAuthStore();
