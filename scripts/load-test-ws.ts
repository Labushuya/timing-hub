/**
 * Timing Hub — Pure WebSocket Load Test
 *
 * Establishes 500 concurrent WS connections, each subscribing to an event.
 * The server broadcasts 10 messages/second.
 * Measures how many clients receive each broadcast within 100ms / 200ms / 500ms.
 *
 * Usage:
 *   pnpm tsx scripts/load-test-ws.ts [--url http://localhost:3000] [--connections 500]
 */

import WebSocket from "ws";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    connections: { type: "string", default: "500" },
    duration: { type: "string", default: "60" },
    "event-id": { type: "string", default: "" },
    token: { type: "string", default: "test-token" },
    "msg-rate": { type: "string", default: "10" }, // messages/second server should broadcast
  },
});

const BASE_URL = args.url as string;
const WS_URL = BASE_URL.replace(/^http/, "ws");
const CONNECTION_COUNT = parseInt(args.connections as string, 10);
const DURATION_S = parseInt(args.duration as string, 10);
const EVENT_ID = args["event-id"] as string;
const AUTH_TOKEN = args.token as string;
const MSG_RATE = parseInt(args["msg-rate"] as string, 10);

// ---------------------------------------------------------------------------
// Per-broadcast delivery tracking
// ---------------------------------------------------------------------------
interface BroadcastRecord {
  id: string;
  serverTs: number; // timestamp the server says it sent the message
  clientReceiptTs: Map<number, number>; // clientIndex → local receipt timestamp
}

const broadcasts = new Map<string, BroadcastRecord>();
let broadcastSeq = 0;

// ---------------------------------------------------------------------------
// Aggregated stats
// ---------------------------------------------------------------------------
interface DeliveryBucket {
  within100: number;
  within200: number;
  within500: number;
  over500: number;
  total: number;
}

const delivery: DeliveryBucket = {
  within100: 0,
  within200: 0,
  within500: 0,
  over500: 0,
  total: 0,
};

const connectionErrors: number[] = [];
const reconnectCount = { value: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function createTestEvent(): Promise<string> {
  if (EVENT_ID) return EVENT_ID;

  console.log("[setup] Creating ephemeral test event…");
  const res = await fetch(`${BASE_URL}/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `WS Load Test ${Date.now()}`,
      slug: `ws-load-${Date.now()}`,
      discipline: "alpine",
    }),
  });
  if (!res.ok) {
    throw new Error(`Could not create test event: ${res.status}`);
  }
  const body = (await res.json()) as { id: string };
  console.log(`[setup] Event id: ${body.id}`);
  return body.id;
}

// ---------------------------------------------------------------------------
// Broadcaster — simulates server pushing 10 messages/second
// In a real test the server does this; this helper can drive it via a
// dedicated "broadcast trigger" endpoint if the server exposes one.
// ---------------------------------------------------------------------------
async function startBroadcaster(
  eventId: string,
  stopSignal: { stop: boolean }
): Promise<void> {
  const intervalMs = Math.floor(1000 / MSG_RATE);

  async function tick(): Promise<void> {
    const id = `bc-${++broadcastSeq}`;
    const serverTs = Date.now();

    broadcasts.set(id, { id, serverTs, clientReceiptTs: new Map() });

    // Trigger broadcast via API (adjust endpoint to match actual implementation)
    try {
      await fetch(`${BASE_URL}/v1/events/${eventId}/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ type: "ping", id, ts: serverTs }),
      });
    } catch {
      // broadcast trigger failed — record but continue
    }
  }

  while (!stopSignal.stop) {
    const start = Date.now();
    await tick();
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - elapsed)));
  }
}

// ---------------------------------------------------------------------------
// WS client pool
// ---------------------------------------------------------------------------
interface ClientStats {
  connected: number;
  disconnected: number;
  errors: number;
  messagesReceived: number;
  allLatencies: number[];
}

function buildClientPool(
  eventId: string,
  clientStats: ClientStats,
  stopSignal: { stop: boolean }
): WebSocket[] {
  const sockets: WebSocket[] = [];

  for (let i = 0; i < CONNECTION_COUNT; i++) {
    const url = `${WS_URL}/v1/events/${eventId}/stream?token=${encodeURIComponent(AUTH_TOKEN)}&clientIndex=${i}`;
    const ws = new WebSocket(url);

    const clientIndex = i;

    ws.on("open", () => {
      clientStats.connected++;
      ws.send(JSON.stringify({ type: "subscribe", eventId }));
    });

    ws.on("message", (raw) => {
      const receiptTs = Date.now();
      clientStats.messagesReceived++;

      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          id?: string;
          ts?: number;
          serverTs?: number;
        };

        const broadcastId = msg.id;
        const serverTs = msg.ts ?? msg.serverTs;

        if (broadcastId && broadcasts.has(broadcastId) && serverTs) {
          const record = broadcasts.get(broadcastId)!;
          record.clientReceiptTs.set(clientIndex, receiptTs);

          const latencyMs = receiptTs - serverTs;
          clientStats.allLatencies.push(latencyMs);
          delivery.total++;

          if (latencyMs <= 100) {
            delivery.within100++;
          } else if (latencyMs <= 200) {
            delivery.within200++;
          } else if (latencyMs <= 500) {
            delivery.within500++;
          } else {
            delivery.over500++;
          }
        }
      } catch {
        // non-JSON — ignore for latency tracking
      }
    });

    ws.on("error", (err) => {
      clientStats.errors++;
      connectionErrors.push(Date.now());
    });

    ws.on("close", (code) => {
      clientStats.disconnected++;
      if (!stopSignal.stop && code !== 1000) {
        // Unexpected disconnect — attempt reconnect once
        reconnectCount.value++;
        setTimeout(() => {
          if (!stopSignal.stop) {
            const newWs = new WebSocket(url);
            newWs.on("open", () => {
              newWs.send(JSON.stringify({ type: "subscribe", eventId }));
            });
            newWs.on("message", ws.listeners("message")[0] as () => void);
            newWs.on("error", ws.listeners("error")[0] as () => void);
          }
        }, 500);
      }
    });

    sockets.push(ws);
  }

  return sockets;
}

// ---------------------------------------------------------------------------
// Progress reporter (live)
// ---------------------------------------------------------------------------
function startProgressReporter(
  clientStats: ClientStats,
  stopSignal: { stop: boolean }
): NodeJS.Timeout {
  return setInterval(() => {
    if (stopSignal.stop) return;
    const pct =
      delivery.total > 0
        ? (((delivery.within100 + delivery.within200) / delivery.total) * 100).toFixed(1)
        : "0.0";
    process.stdout.write(
      `\r[live] connected=${clientStats.connected}  msgs=${clientStats.messagesReceived}` +
        `  broadcasts=${broadcastSeq}  within200ms=${pct}%  errors=${clientStats.errors}   `
    );
  }, 1000);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function printReport(clientStats: ClientStats): void {
  process.stdout.write("\n");
  console.log("\n========================================");
  console.log("   Timing Hub — WS Load Test Report     ");
  console.log("========================================\n");

  console.log(`Target:           ${WS_URL}`);
  console.log(`Connections:      ${CONNECTION_COUNT}`);
  console.log(`Duration:         ${DURATION_S}s`);
  console.log(`Broadcast rate:   ${MSG_RATE} msg/s\n`);

  console.log("Connection stats:");
  console.log(`  Peak connected:     ${clientStats.connected}`);
  console.log(`  Disconnects:        ${clientStats.disconnected}`);
  console.log(`  Reconnects:         ${reconnectCount.value}`);
  console.log(`  Errors:             ${clientStats.errors}`);
  console.log(`  Total msgs received:${clientStats.messagesReceived}\n`);

  console.log("Broadcast delivery (latency = client receipt − server send ts):");
  console.log(`  Total samples:      ${delivery.total}`);
  if (delivery.total > 0) {
    const pct = (n: number) => ((n / delivery.total) * 100).toFixed(2);
    console.log(`  ≤ 100ms:  ${delivery.within100} (${pct(delivery.within100)}%)`);
    console.log(
      `  ≤ 200ms:  ${delivery.within200} (${pct(delivery.within200)}%)  [cumulative: ${pct(delivery.within100 + delivery.within200)}%]`
    );
    console.log(
      `  ≤ 500ms:  ${delivery.within500} (${pct(delivery.within500)}%)  [cumulative: ${pct(delivery.within100 + delivery.within200 + delivery.within500)}%]`
    );
    console.log(`  > 500ms:  ${delivery.over500} (${pct(delivery.over500)}%)`);
  }

  if (clientStats.allLatencies.length > 0) {
    const sorted = [...clientStats.allLatencies].sort((a, b) => a - b);
    console.log("\nLatency percentiles (ms):");
    console.log(`  p50  = ${percentile(sorted, 50)}`);
    console.log(`  p75  = ${percentile(sorted, 75)}`);
    console.log(`  p95  = ${percentile(sorted, 95)}`);
    console.log(`  p99  = ${percentile(sorted, 99)}`);
    console.log(`  max  = ${sorted[sorted.length - 1]}`);
  }

  // Per-broadcast delivery rate
  const broadcastEntries = Array.from(broadcasts.values());
  if (broadcastEntries.length > 0) {
    const deliveryRates = broadcastEntries
      .filter((b) => b.clientReceiptTs.size > 0)
      .map((b) => b.clientReceiptTs.size / CONNECTION_COUNT);
    const avgDeliveryRate =
      deliveryRates.reduce((a, b) => a + b, 0) / deliveryRates.length;
    console.log(`\nAvg per-broadcast delivery rate: ${(avgDeliveryRate * 100).toFixed(1)}%`);
    console.log(
      `Broadcasts with ≥ 95% delivery: ${deliveryRates.filter((r) => r >= 0.95).length} / ${deliveryRates.length}`
    );
  }

  // SLA
  const sorted = [...clientStats.allLatencies].sort((a, b) => a - b);
  const p99 = percentile(sorted, 99);
  console.log("\nSLA check:");
  console.log(
    `  p99 WS delivery < 200ms: ${p99 <= 200 ? "PASS" : "FAIL"} (${p99}ms)`
  );
  console.log("\n========================================\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Timing Hub — Pure WebSocket Load Test");
  console.log(`  Target:      ${WS_URL}`);
  console.log(`  Connections: ${CONNECTION_COUNT}`);
  console.log(`  Duration:    ${DURATION_S}s`);
  console.log(`  Msg rate:    ${MSG_RATE}/s\n`);

  const stopSignal = { stop: false };
  const clientStats: ClientStats = {
    connected: 0,
    disconnected: 0,
    errors: 0,
    messagesReceived: 0,
    allLatencies: [],
  };

  const eventId = await createTestEvent();

  console.log(`[run] Opening ${CONNECTION_COUNT} WebSocket connections…`);
  const sockets = buildClientPool(eventId, clientStats, stopSignal);

  // Wait for connections to establish
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`[run] ${clientStats.connected} clients connected. Starting broadcaster…\n`);

  const progressTimer = startProgressReporter(clientStats, stopSignal);

  const broadcasterPromise = startBroadcaster(eventId, stopSignal);

  // Run for DURATION_S seconds
  await new Promise((r) => setTimeout(r, DURATION_S * 1000));

  stopSignal.stop = true;
  clearInterval(progressTimer);
  await broadcasterPromise;

  // Allow any in-flight messages to arrive
  await new Promise((r) => setTimeout(r, 1000));

  for (const ws of sockets) {
    try {
      ws.close(1000, "load test complete");
    } catch {
      // ignore
    }
  }

  printReport(clientStats);

  if (!EVENT_ID) {
    try {
      await fetch(`${BASE_URL}/v1/events/${eventId}`, { method: "DELETE" });
      console.log("[teardown] Test event deleted.");
    } catch {
      console.log("[teardown] Could not delete test event.");
    }
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
