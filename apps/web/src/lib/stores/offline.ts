/**
 * Offline queue store — Svelte 5 runes-based
 *
 * Uses idb-keyval for persistent IndexedDB storage.
 * Entries survive page reloads and are synced on WS reconnect.
 */

import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import { authStore } from './auth.js';

// ---- Types ------------------------------------------------------------------

export interface OfflineEntry {
  client_seq: number;
  posten_token: string;
  event_slug: string;
  startnummer: number | null;
  raw_time_ms: number;
  client_ts: string; // ISO 8601
}

// ---- Constants --------------------------------------------------------------

const IDB_PREFIX = 'th_offline_';
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

// ---- Sequence counter (in-memory, reset on reload) --------------------------

let seqCounter = Date.now(); // start from epoch ms to avoid collisions

function nextSeq(): number {
  return ++seqCounter;
}

function entryKey(seq: number): string {
  return `${IDB_PREFIX}${seq}`;
}

// ---- Store ------------------------------------------------------------------

function createOfflineStore() {
  let pending = $state(0);
  let syncing = $state(false);

  // Count pending entries on init
  async function init() {
    try {
      const allKeys = (await idbKeys()) as string[];
      pending = allKeys.filter((k) => k.startsWith(IDB_PREFIX)).length;
    } catch (err) {
      console.warn('[offline] Failed to count pending entries:', err);
    }
  }

  // ---- Actions ---------------------------------------------------------------

  async function enqueue(
    entry: Omit<OfflineEntry, 'client_seq'>
  ): Promise<number> {
    const seq = nextSeq();
    const fullEntry: OfflineEntry = { ...entry, client_seq: seq };
    try {
      await idbSet(entryKey(seq), fullEntry);
      pending++;
    } catch (err) {
      console.error('[offline] Failed to enqueue entry:', err);
      throw err;
    }
    return seq;
  }

  async function sync(): Promise<void> {
    if (syncing || pending === 0) return;

    const token = authStore.accessToken;
    if (!token) return;

    syncing = true;
    try {
      // Load all pending entries
      const allKeys = (await idbKeys()) as string[];
      const offlineKeys = allKeys.filter((k) => k.startsWith(IDB_PREFIX));
      if (offlineKeys.length === 0) {
        pending = 0;
        return;
      }

      const entries: OfflineEntry[] = [];
      for (const key of offlineKeys) {
        const entry = await idbGet<OfflineEntry>(key);
        if (entry) entries.push(entry);
      }

      // Sort by client_seq for ordering guarantee
      entries.sort((a, b) => a.client_seq - b.client_seq);

      // POST to batch endpoint
      const res = await fetch(`${API_BASE}/times/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ entries })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Batch sync failed: HTTP ${res.status}`);
      }

      const result = await res.json() as { accepted: number[]; rejected: { seq: number; reason: string }[] };

      // Delete successfully synced entries
      const acceptedSeqs = new Set(result.accepted);
      for (const entry of entries) {
        if (acceptedSeqs.has(entry.client_seq)) {
          await idbDel(entryKey(entry.client_seq));
        }
      }

      // Recalculate pending count
      const remainingKeys = (await idbKeys()) as string[];
      pending = remainingKeys.filter((k) => k.startsWith(IDB_PREFIX)).length;

      if (result.rejected?.length > 0) {
        console.warn('[offline] Rejected entries:', result.rejected);
      }
    } catch (err) {
      console.error('[offline] Sync failed:', err);
      throw err;
    } finally {
      syncing = false;
    }
  }

  async function clearAll(): Promise<void> {
    try {
      const allKeys = (await idbKeys()) as string[];
      const offlineKeys = allKeys.filter((k) => k.startsWith(IDB_PREFIX));
      for (const key of offlineKeys) {
        await idbDel(key);
      }
      pending = 0;
    } catch (err) {
      console.error('[offline] Failed to clear entries:', err);
    }
  }

  // Initialize count
  if (typeof window !== 'undefined') {
    init();
  }

  return {
    get pending() { return pending; },
    get syncing() { return syncing; },
    enqueue,
    sync,
    clearAll
  };
}

export const offlineStore = createOfflineStore();
