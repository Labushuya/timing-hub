/**
 * Typed API client for Timing Hub
 *
 * Features:
 *   - Automatic Authorization: Bearer header injection from authStore
 *   - 401 handling: try token refresh once, then redirect to /login
 *   - Typed APIError with status, code, message
 *   - Full coverage of all backend endpoints
 */

import type {
  User,
  Event,
  EventFormat,
  EventStatus,
  EventConfig,
  Posten,
  PostenInfo,
  Participant,
  RegistrationToken,
  UserRole
} from '@timing-hub/shared-types';
import { authStore } from '$lib/stores/auth.svelte.js';

// ---- Error type -------------------------------------------------------------

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'APIError';
  }
}

// ---- Pagination -------------------------------------------------------------

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ---- Event payloads ---------------------------------------------------------

export interface CreateEventPayload {
  name: string;
  description?: string | undefined;
  format: EventFormat;
  starts_at: string;
  ends_at?: string | undefined;
  timezone?: string | undefined;
  config?: Partial<EventConfig> | undefined;
}

export interface UpdateEventPayload extends Partial<CreateEventPayload> {}

// ---- Posten payloads --------------------------------------------------------

export interface CreatePostenPayload {
  code: string;
  name: string;
  sort_order?: number;
  role: 'start' | 'finish' | 'intermediate' | 'sector_split';
}

export interface PostenSessionResponse {
  posten_id: string;
  posten_name: string;
  posten_code: string;
  event_slug: string;
  event_name: string;
  mode: 'manual' | 'timy';
}

// ---- Participant payloads ---------------------------------------------------

export interface CreateParticipantPayload {
  startnummer: string;
  driver_name: string;
  co_driver_name?: string;
  car_make?: string;
  car_model?: string;
  car_year?: number;
  class?: string;
  target_time_ms?: number;
  seed_time_ms?: number;
  notes?: string;
}

export interface UpdateParticipantPayload extends Partial<CreateParticipantPayload> {}

export interface ImportParticipantsPayload {
  participants: CreateParticipantPayload[];
  mode: 'replace' | 'merge';
}

export interface ImportParticipantsResult {
  imported: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

// ---- Admin token payloads ---------------------------------------------------

export interface CreateTokenPayload {
  role: UserRole;
  issued_to_email?: string;
  expires_in: string;
}

// ---- Base request -----------------------------------------------------------

const API_BASE = (import.meta.env.PUBLIC_API_URL ?? import.meta.env.VITE_API_BASE ?? 'http://localhost:3001/v1') as string;

let refreshInProgress: Promise<boolean> | null = null;

async function redirectToLogin(): Promise<never> {
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
  // Never resolves after redirect — throw to satisfy TypeScript
  throw new APIError(401, 'unauthorized', 'Session abgelaufen. Bitte neu anmelden.');
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retryOnUnauthorized = true
): Promise<T> {
  const token = authStore.accessToken;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>)
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  // 401 — try refresh once, then redirect
  if (res.status === 401 && retryOnUnauthorized) {
    if (!refreshInProgress) {
      refreshInProgress = authStore.refresh().finally(() => {
        refreshInProgress = null;
      });
    }
    const refreshed = await refreshInProgress;
    if (refreshed) {
      return request<T>(path, options, false);
    }
    return redirectToLogin();
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    const b = body as Record<string, unknown>;
    const message = typeof b.message === 'string' ? b.message : `HTTP ${res.status}`;
    const code = typeof b.code === 'string' ? b.code : String(res.status);
    throw new APIError(res.status, code, message);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return res.json() as Promise<T>;
}

// ---- API surface ------------------------------------------------------------

export const api = {

  // ---- Auth -----------------------------------------------------------------

  auth: {
    me(): Promise<User> {
      return request<User>('/auth/me');
    },

    register(payload: {
      invite_token: string;
      email: string;
      password: string;
      display_name: string;
    }): Promise<{ user: User }> {
      return request('/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
  },

  // ---- Events ---------------------------------------------------------------

  events: {
    listEvents(params?: PaginationParams): Promise<{ events: Event[]; total: number }> {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request(`/events/my${qs}`);
    },

    getEvent(slug: string): Promise<{ event: Event }> {
      return request(`/events/${encodeURIComponent(slug)}`);
    },

    createEvent(payload: CreateEventPayload): Promise<{ event: Event }> {
      return request('/events', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },

    updateEvent(slug: string, payload: UpdateEventPayload): Promise<{ event: Event }> {
      return request(`/events/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
    },

    activateEvent(slug: string): Promise<{ event: Event }> {
      return request(`/events/${encodeURIComponent(slug)}/activate`, {
        method: 'POST'
      });
    },

    finishEvent(slug: string): Promise<{ event: Event }> {
      return request(`/events/${encodeURIComponent(slug)}/finish`, {
        method: 'POST'
      });
    }
  },

  // ---- Posten ---------------------------------------------------------------

  posten: {
    listPosten(eventSlug: string): Promise<{ posten: PostenInfo[] }> {
      return request(`/events/${encodeURIComponent(eventSlug)}/posten`);
    },

    createPosten(eventSlug: string, payload: CreatePostenPayload): Promise<{ posten: Posten }> {
      return request(`/events/${encodeURIComponent(eventSlug)}/posten`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },

    getPostenSession(accessToken: string): Promise<PostenSessionResponse> {
      return request(`/posten/${encodeURIComponent(accessToken)}/session`, {
        method: 'POST'
      });
    }
  },

  // ---- Participants ---------------------------------------------------------

  participants: {
    listParticipants(
      eventSlug: string,
      params?: PaginationParams
    ): Promise<{ participants: Participant[]; total: number }> {
      const base = `/events/${encodeURIComponent(eventSlug)}/participants`;
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request(`${base}${qs}`);
    },

    createParticipant(
      eventSlug: string,
      payload: CreateParticipantPayload
    ): Promise<{ participant: Participant }> {
      return request(`/events/${encodeURIComponent(eventSlug)}/participants`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },

    updateParticipant(
      eventSlug: string,
      participantId: string,
      payload: UpdateParticipantPayload
    ): Promise<{ participant: Participant }> {
      return request(
        `/events/${encodeURIComponent(eventSlug)}/participants/${encodeURIComponent(participantId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload)
        }
      );
    },

    deleteParticipant(eventSlug: string, participantId: string): Promise<void> {
      return request(
        `/events/${encodeURIComponent(eventSlug)}/participants/${encodeURIComponent(participantId)}`,
        { method: 'DELETE' }
      );
    },

    importParticipants(
      eventSlug: string,
      payload: ImportParticipantsPayload
    ): Promise<ImportParticipantsResult> {
      return request(`/events/${encodeURIComponent(eventSlug)}/participants/import`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
  },

  // ---- Admin ----------------------------------------------------------------

  admin: {
    adminCreateToken(payload: CreateTokenPayload): Promise<{ token: RegistrationToken }> {
      return request('/admin/tokens', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },

    adminListTokens(): Promise<{ tokens: RegistrationToken[] }> {
      return request('/admin/tokens');
    },

    adminRevokeToken(tokenId: string): Promise<void> {
      return request(`/admin/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE'
      });
    },

    adminListUsers(params?: PaginationParams): Promise<{ users: User[]; total: number }> {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request(`/admin/users${qs}`);
    }
  }
};

export default api;
