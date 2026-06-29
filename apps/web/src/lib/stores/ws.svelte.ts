/**
 * WebSocket manager store — Svelte 5 runes-based
 *
 * Features:
 *   - Exponential backoff reconnect (50ms → 30000ms cap)
 *   - Message handler registry (type-safe)
 *   - Outbound message queue (drains on reconnect)
 *   - Heartbeat ping every 30s
 *   - Event subscription management
 */

import { authStore } from './auth.svelte.js';

// ---- Types ------------------------------------------------------------------

export type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (message: WsMessage) => void;

// ---- Constants --------------------------------------------------------------

const WS_BASE = import.meta.env.VITE_WS_BASE ?? 'wss://api.timinghub.de/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 50;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MULTIPLIER = 2;

// ---- Store ------------------------------------------------------------------

function createWsStore() {
  let status = $state<WsStatus>('idle');
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Zeitnehmer mode: when set, connectAsZeitnehmer was used and reconnects use
  // these instead of the JWT from authStore.
  let zeitnehmerToken: string | null = null;
  let zeitnehmerPostenId: string | null = null;

  const messageHandlers = new Map<string, Set<MessageHandler>>();
  const messageQueue: WsMessage[] = [];
  const subscribedEvents = new Set<string>();

  // ---- Derived ---------------------------------------------------------------

  const isConnected = $derived(status === 'connected');
  const isOffline = $derived(status === 'offline');

  // ---- Internal helpers ------------------------------------------------------

  function getBackoffDelay(): number {
    const delay = RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempts);
    return Math.min(delay, RECONNECT_MAX_MS);
  }

  function clearTimers() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function flushQueue() {
    while (messageQueue.length > 0 && socket?.readyState === WebSocket.OPEN) {
      const msg = messageQueue.shift()!;
      socket.send(JSON.stringify(msg));
    }
  }

  function resubscribeAll() {
    for (const slug of subscribedEvents) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe_event', event_slug: slug }));
      }
    }
  }

  function dispatchMessage(message: WsMessage) {
    const handlers = messageHandlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message);
        } catch (err) {
          console.error('[ws] Handler error for type', message.type, err);
        }
      }
    }
    // Also dispatch to wildcard handlers
    const wildcardHandlers = messageHandlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(message);
      }
    }
  }

  function scheduleReconnect() {
    const delay = getBackoffDelay();
    reconnectAttempts++;
    status = reconnectAttempts === 1 ? 'reconnecting' : 'reconnecting';

    console.debug(`[ws] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      // If we've been offline too long without navigator.onLine, mark offline
      if (!navigator.onLine) {
        status = 'offline';
        return;
      }
      connect();
    }, delay);
  }

  // ---- Connection ------------------------------------------------------------

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    status = reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

    // Zeitnehmer mode takes precedence over JWT auth
    let url: string;
    if (zeitnehmerToken) {
      url = `${WS_BASE}?token=${encodeURIComponent(zeitnehmerToken)}&type=zeitnehmer`;
    } else {
      const token = authStore.accessToken;
      url = token ? `${WS_BASE}?token=${encodeURIComponent(token)}` : WS_BASE;
    }

    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error('[ws] Failed to create WebSocket:', err);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      status = 'connected';
      reconnectAttempts = 0;
      startHeartbeat();
      resubscribeAll();
      flushQueue();
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data as string) as WsMessage;
        if (message.type === 'pong') return; // ignore heartbeat responses
        dispatchMessage(message);
      } catch (err) {
        console.warn('[ws] Failed to parse message:', err);
      }
    });

    socket.addEventListener('close', (event) => {
      clearTimers();
      socket = null;

      if (event.code === 1000) {
        // Normal close
        status = 'idle';
      } else {
        scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      // 'close' event will follow — handle reconnect there
      clearTimers();
    });
  }

  function disconnect() {
    clearTimers();
    subscribedEvents.clear();
    messageQueue.length = 0;
    zeitnehmerToken = null;
    zeitnehmerPostenId = null;
    if (socket) {
      socket.close(1000, 'Client disconnected');
      socket = null;
    }
    status = 'idle';
  }

  // ---- Browser online/offline events -----------------------------------------

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (status === 'offline') {
        reconnectAttempts = 0;
        connect();
      }
    });
    window.addEventListener('offline', () => {
      status = 'offline';
    });
  }

  // ---- Public API ------------------------------------------------------------

  function subscribe(eventSlug: string) {
    subscribedEvents.add(eventSlug);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'subscribe_event', event_slug: eventSlug }));
    }
  }

  function unsubscribe(eventSlug: string) {
    subscribedEvents.delete(eventSlug);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'unsubscribe_event', event_slug: eventSlug }));
    }
  }

  function onMessage(type: string, handler: MessageHandler): () => void {
    if (!messageHandlers.has(type)) {
      messageHandlers.set(type, new Set());
    }
    messageHandlers.get(type)!.add(handler);
    // Return unsubscribe function
    return () => {
      messageHandlers.get(type)?.delete(handler);
    };
  }

  function send(message: WsMessage) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      messageQueue.push(message);
    }
  }

  /**
   * Connect as a Zeitnehmer (posten operator) using a session token.
   * The WS URL will include ?token=<sessionToken>&type=zeitnehmer.
   * Subsequent auto-reconnects will reuse the same token.
   *
   * Call disconnect() before switching back to a JWT-based connection.
   */
  function connectAsZeitnehmer(token: string, postenId: string) {
    // Tear down any existing connection first
    if (socket) {
      clearTimers();
      socket.close(1000, 'Switching to zeitnehmer mode');
      socket = null;
    }
    reconnectAttempts = 0;
    zeitnehmerToken = token;
    zeitnehmerPostenId = postenId;
    connect();
  }

  return {
    // State
    get status() { return status; },
    get isConnected() { return isConnected; },
    get isOffline() { return isOffline; },
    get queueLength() { return messageQueue.length; },
    get zeitnehmerPostenId() { return zeitnehmerPostenId; },

    // Actions
    connect,
    connectAsZeitnehmer,
    disconnect,
    subscribe,
    unsubscribe,
    onMessage,
    send
  };
}

export const wsStore = createWsStore();
