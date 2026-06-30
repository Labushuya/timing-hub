/**
 * Timing Hub — ALGE Timy 3 Bridge Simulator
 *
 * Simulates a Timy 3 hardware bridge WITHOUT real hardware.
 * Connects to the API as a bridge client (WebSocket, type=bridge) and sends
 * timy_impulse events every 3 seconds, logging ack latency.
 *
 * Usage:
 *   pnpm tsx scripts/test-timy-simulator.ts \
 *     --event-slug test-event \
 *     --bridge-token abc123 \
 *     [--url http://localhost:3000] \
 *     [--interval 3000] \
 *     [--channel 0] \
 *     [--count 0]       # 0 = run indefinitely
 *
 * Exit: Ctrl+C
 */

import WebSocket from "ws";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    "event-slug": { type: "string", default: "" },
    "bridge-token": { type: "string", default: "" },
    interval: { type: "string", default: "3000" },
    channel: { type: "string", default: "0" },
    count: { type: "string", default: "0" }, // 0 = unlimited
  },
});

const BASE_URL = (args.url as string).replace(/\/$/, "");
const WS_URL = BASE_URL.replace(/^http/, "ws");
const EVENT_SLUG = args["event-slug"] as string;
const BRIDGE_TOKEN = args["bridge-token"] as string;
const INTERVAL_MS = parseInt(args.interval as string, 10);
const CHANNEL_INDEX = parseInt(args.channel as string, 10);
const MAX_COUNT = parseInt(args.count as string, 10);

if (!EVENT_SLUG) {
  console.error("Error: --event-slug is required");
  process.exit(1);
}
if (!BRIDGE_TOKEN) {
  console.error("Error: --bridge-token is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
interface SimStats {
  sent: number;
  acked: number;
  errors: number;
  timeouts: number;
  latencies: number[];
}

const stats: SimStats = {
  sent: 0,
  acked: 0,
  errors: 0,
  timeouts: 0,
  latencies: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  return `${ms}ms`;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Resolve event ID from slug
// ---------------------------------------------------------------------------
async function resolveEventId(slug: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/events/${slug}`);
  if (!res.ok) {
    throw new Error(
      `Could not resolve event slug "${slug}": HTTP ${res.status}`
    );
  }
  const body = (await res.json()) as { id: string; slug: string };
  return body.id;
}

// ---------------------------------------------------------------------------
// Build the Timy impulse payload
// Matches ALGE Timy 3 bridge protocol (adjust to actual schema as needed)
// ---------------------------------------------------------------------------
function buildImpulse(seq: number): {
  type: "timy_impulse";
  seq: number;
  channelIndex: number;
  timyTs: string; // HH:MM:SS.ssssss as Timy reports
  clientTs: number; // Unix ms at send time
  correlationId: string;
} {
  // Simulate a Timy timestamp (wall-clock hours + random sub-second)
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const sub = String(Math.floor(Math.random() * 999999)).padStart(6, "0");
  const timyTs = `${hh}:${mm}:${ss}.${sub}`;

  return {
    type: "timy_impulse",
    seq,
    channelIndex: CHANNEL_INDEX,
    timyTs,
    clientTs: Date.now(),
    correlationId: `sim-${seq}-${Date.now()}`,
  };
}

// ---------------------------------------------------------------------------
// Simulator core
// ---------------------------------------------------------------------------
async function runSimulator(): Promise<void> {
  const eventId = await resolveEventId(EVENT_SLUG);
  console.log(`[sim] Resolved event: slug=${EVENT_SLUG}  id=${eventId}`);

  const wsUrl = `${WS_URL}/v1/events/${eventId}/bridge?token=${encodeURIComponent(BRIDGE_TOKEN)}&type=bridge`;
  console.log(`[sim] Connecting to ${wsUrl}`);

  let ws: WebSocket;
  let connected = false;
  let stopRequested = false;
  let seq = 0;

  // Pending ack map: correlationId → send timestamp
  const pending = new Map<string, number>();
  const ACK_TIMEOUT_MS = 5000;

  function connect(): void {
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      connected = true;
      console.log(`[sim] ${now()} — Connected to bridge endpoint.`);

      // Announce ourselves as a simulator
      ws.send(
        JSON.stringify({
          type: "bridge_hello",
          clientType: "timy-simulator",
          eventId,
          channelIndex: CHANNEL_INDEX,
        })
      );

      // Start impulse loop
      scheduleNext();
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          correlationId?: string;
          status?: string;
          error?: string;
          serverTs?: number;
        };

        if (msg.type === "ack" || msg.type === "timy_impulse_ack") {
          const cid = msg.correlationId;
          if (cid && pending.has(cid)) {
            const sendTs = pending.get(cid)!;
            const latencyMs = Date.now() - sendTs;
            pending.delete(cid);
            stats.acked++;
            stats.latencies.push(latencyMs);

            const status = msg.status === "ok" || !msg.error ? "OK" : `ERROR: ${msg.error}`;
            console.log(
              `[sim] ${now()} — ACK  seq=${seq}  corr=${cid}  latency=${formatMs(latencyMs)}  status=${status}`
            );
          }
        } else if (msg.type === "error") {
          stats.errors++;
          console.error(`[sim] ${now()} — Server error: ${msg.error}`);
        }
      } catch {
        // non-JSON from server
        console.warn(`[sim] ${now()} — Received non-JSON message: ${raw.toString().slice(0, 100)}`);
      }
    });

    ws.on("error", (err) => {
      stats.errors++;
      console.error(`[sim] ${now()} — WS error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      connected = false;
      if (!stopRequested) {
        console.log(
          `[sim] ${now()} — Disconnected (code=${code} reason=${reason.toString() || "—"}). Reconnecting in 2s…`
        );
        setTimeout(connect, 2000);
      } else {
        console.log(`[sim] ${now()} — Connection closed.`);
      }
    });
  }

  function sendImpulse(): void {
    if (!connected || stopRequested) return;

    seq++;
    const impulse = buildImpulse(seq);
    const sendTs = Date.now();

    try {
      ws.send(JSON.stringify(impulse));
      stats.sent++;
      pending.set(impulse.correlationId, sendTs);

      console.log(
        `[sim] ${now()} — SENT impulse  seq=${seq}  ch=${CHANNEL_INDEX}  timyTs=${impulse.timyTs}  corr=${impulse.correlationId}`
      );

      // Timeout watchdog
      setTimeout(() => {
        if (pending.has(impulse.correlationId)) {
          pending.delete(impulse.correlationId);
          stats.timeouts++;
          console.warn(
            `[sim] ${now()} — TIMEOUT seq=${seq}  corr=${impulse.correlationId} (no ack within ${ACK_TIMEOUT_MS}ms)`
          );
        }
      }, ACK_TIMEOUT_MS);
    } catch (err) {
      stats.errors++;
      console.error(`[sim] ${now()} — Send error: ${(err as Error).message}`);
    }
  }

  function scheduleNext(): void {
    if (stopRequested) return;
    if (MAX_COUNT > 0 && seq >= MAX_COUNT) {
      console.log(`[sim] Reached count limit (${MAX_COUNT}). Stopping…`);
      printFinalStats();
      ws.close(1000, "count limit reached");
      return;
    }

    setTimeout(() => {
      sendImpulse();
      scheduleNext();
    }, INTERVAL_MS);
  }

  // Graceful shutdown
  function shutdown(): void {
    stopRequested = true;
    console.log(`\n[sim] Shutting down…`);
    printFinalStats();
    try {
      ws.close(1000, "simulator stopped");
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 500);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  connect();
}

// ---------------------------------------------------------------------------
// Final stats
// ---------------------------------------------------------------------------
function printFinalStats(): void {
  console.log("\n========================================");
  console.log("   Timy Simulator — Session Summary     ");
  console.log("========================================");
  console.log(`  Sent:      ${stats.sent}`);
  console.log(`  Acked:     ${stats.acked}`);
  console.log(`  Timeouts:  ${stats.timeouts}`);
  console.log(`  Errors:    ${stats.errors}`);

  if (stats.latencies.length > 0) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    console.log("\n  Ack latency (ms):");
    console.log(`    p50  = ${percentile(sorted, 50)}`);
    console.log(`    p95  = ${percentile(sorted, 95)}`);
    console.log(`    p99  = ${percentile(sorted, 99)}`);
    console.log(`    max  = ${sorted[sorted.length - 1]}`);
    console.log(`    min  = ${sorted[0]}`);
  }

  const successRate =
    stats.sent > 0
      ? (((stats.acked) / stats.sent) * 100).toFixed(1)
      : "0.0";
  console.log(`\n  Ack rate:  ${successRate}%`);
  console.log("========================================\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("Timing Hub — ALGE Timy 3 Bridge Simulator");
console.log(`  Server:      ${BASE_URL}`);
console.log(`  Event slug:  ${EVENT_SLUG}`);
console.log(`  Channel:     ${CHANNEL_INDEX}`);
console.log(`  Interval:    ${INTERVAL_MS}ms`);
console.log(`  Count limit: ${MAX_COUNT === 0 ? "unlimited" : MAX_COUNT}`);
console.log("  Press Ctrl+C to stop.\n");

runSimulator().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
