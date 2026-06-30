/**
 * Timing Hub — Full Load Test
 *
 * Simulates a real race event:
 *   - 50 concurrent Zeitnehmer clients posting times at 1 time/5s each
 *   - 200 WS subscriber clients (Kommissar + public viewers)
 *   - Duration: 60 seconds
 *
 * Targets:
 *   - p99 time submission < 100ms
 *   - p99 WS fanout < 200ms
 *
 * Usage:
 *   pnpm tsx scripts/load-test.ts [--url http://localhost:3000] [--duration 60]
 */

import autocannon from "autocannon";
import WebSocket from "ws";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    duration: { type: "string", default: "60" },
    posters: { type: "string", default: "50" },
    subscribers: { type: "string", default: "200" },
  },
});

const BASE_URL = args.url as string;
const WS_URL = BASE_URL.replace(/^http/, "ws");
const DURATION_S = parseInt(args.duration as string, 10);
const POSTER_COUNT = parseInt(args.posters as string, 10);
const SUBSCRIBER_COUNT = parseInt(args.subscribers as string, 10);

// ---------------------------------------------------------------------------
// Shared latency store
// ---------------------------------------------------------------------------
interface LatencySample {
  postAckMs: number; // time from POST send → 200 OK
  wsFanoutMs: number; // time from POST 200 → WS broadcast received
}

const samples: LatencySample[] = [];
const pendingAcks = new Map<string, number>(); // correlationId → POST ack timestamp

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printHistogram(label: string, values: number[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: no data`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label}  p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms  p99=${percentile(sorted, 99)}ms  max=${sorted[sorted.length - 1]}ms  n=${sorted.length}`
  );
}

async function httpPost(
  url: string,
  body: unknown,
  token?: string
): Promise<{ ok: boolean; status: number; json: unknown; ms: number }> {
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - start;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, ms };
}

// ---------------------------------------------------------------------------
// 1. Setup — create event, sessions, tokens
// ---------------------------------------------------------------------------
interface SetupResult {
  eventId: string;
  eventSlug: string;
  posterTokens: string[];
  subscriberTokens: string[];
}

async function setup(): Promise<SetupResult> {
  console.log("[setup] Creating test event…");

  // Create admin/organizer — adjust endpoint to match actual API surface
  const eventSlug = `load-test-${Date.now()}`;

  const eventRes = await httpPost(`${BASE_URL}/v1/events`, {
    name: "Load Test Event",
    slug: eventSlug,
    discipline: "alpine",
  });

  if (!eventRes.ok) {
    throw new Error(
      `Failed to create event: ${eventRes.status} ${JSON.stringify(eventRes.json)}`
    );
  }

  const event = eventRes.json as { id: string; slug: string };
  console.log(`[setup] Event created: ${event.id} (${event.slug})`);

  // Create Zeitnehmer sessions (posters)
  console.log(`[setup] Creating ${POSTER_COUNT} Zeitnehmer sessions…`);
  const posterTokens: string[] = [];
  for (let i = 0; i < POSTER_COUNT; i++) {
    const res = await httpPost(`${BASE_URL}/v1/events/${event.id}/sessions`, {
      role: "zeitnehmer",
      label: `Zeitnehmer-${i + 1}`,
    });
    if (!res.ok) {
      throw new Error(`Failed to create poster session ${i}: ${res.status}`);
    }
    const s = res.json as { token: string };
    posterTokens.push(s.token);
  }

  // Create subscriber tokens (Kommissar + viewers)
  console.log(`[setup] Creating ${SUBSCRIBER_COUNT} subscriber tokens…`);
  const subscriberTokens: string[] = [];
  for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
    const role = i < 5 ? "kommissar" : "viewer";
    const res = await httpPost(`${BASE_URL}/v1/events/${event.id}/tokens`, {
      role,
      label: `${role}-${i}`,
    });
    if (!res.ok) {
      throw new Error(`Failed to create subscriber token ${i}: ${res.status}`);
    }
    const t = res.json as { token: string };
    subscriberTokens.push(t.token);
  }

  console.log("[setup] Setup complete.\n");
  return {
    eventId: event.id,
    eventSlug: event.slug,
    posterTokens,
    subscriberTokens,
  };
}

// ---------------------------------------------------------------------------
// 2. WS subscriber pool
// ---------------------------------------------------------------------------
interface WsStats {
  connected: number;
  errors: number;
  messages: number;
  latencies: number[]; // ms from correlation timestamp to WS receipt
}

function startSubscribers(
  eventId: string,
  tokens: string[],
  stats: WsStats,
  stopSignal: { stop: boolean }
): WebSocket[] {
  const sockets: WebSocket[] = [];

  for (const token of tokens) {
    const url = `${WS_URL}/v1/events/${eventId}/stream?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);

    ws.on("open", () => {
      stats.connected++;
      // Subscribe message (adjust to actual protocol)
      ws.send(JSON.stringify({ type: "subscribe", eventId }));
    });

    ws.on("message", (raw) => {
      stats.messages++;
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          correlationId?: string;
          serverTs?: number;
        };

        // Measure fanout latency when we have a correlationId matching a pending POST ack
        if (msg.correlationId && pendingAcks.has(msg.correlationId)) {
          const ackTs = pendingAcks.get(msg.correlationId)!;
          const fanoutMs = Date.now() - ackTs;
          stats.latencies.push(fanoutMs);
          // Only delete after a short window so multiple subscribers can record it
          setTimeout(() => pendingAcks.delete(msg.correlationId!), 2000);
        }
      } catch {
        // non-JSON or unexpected shape — ignore for latency tracking
      }
    });

    ws.on("error", () => {
      stats.errors++;
    });

    ws.on("close", () => {
      if (!stopSignal.stop) stats.errors++;
    });

    sockets.push(ws);
  }

  return sockets;
}

// ---------------------------------------------------------------------------
// 3. Time posters using autocannon
// ---------------------------------------------------------------------------
interface PostStats {
  requests: number;
  errors: number;
  latencies: number[];
  throughput: number; // req/s
}

async function runPosters(
  eventId: string,
  posterTokens: string[],
  postStats: PostStats
): Promise<void> {
  // autocannon handles the HTTP load; we also track WS correlation via a
  // custom onResponse callback that records the correlationId from the response body.

  const instanceCount = Math.min(POSTER_COUNT, posterTokens.length);

  const instances = posterTokens.slice(0, instanceCount).map((token, i) => {
    // Stagger start slightly to avoid thundering herd
    return new Promise<autocannon.Result>((resolve) => {
      setTimeout(() => {
        const instance = autocannon(
          {
            url: `${BASE_URL}/v1/events/${eventId}/times`,
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              bib: (i % 200) + 1,
              channelIndex: 0,
              rawMs: 90000 + Math.floor(Math.random() * 60000),
            }),
            duration: DURATION_S,
            // 1 time per 5 seconds = rate 0.2/s per connection
            // autocannon rate is per second across all connections in the instance
            connections: 1,
            amount: undefined,
            // pipelining: 1 means one in-flight request at a time per connection
            pipelining: 1,
            // Use customized rate-limiting via overallRate (req/s for this instance)
            // We want 1 req / 5s = 0.2/s; autocannon min is 1, so we set connections=1
            // and rely on duration + realistic think-time via setupRequest
          },
          (err, result) => {
            if (err) {
              postStats.errors++;
            } else {
              postStats.requests += result.requests.total;
              postStats.errors += result.errors;
              postStats.throughput += result.requests.total / DURATION_S;
              // Collect latency histogram buckets
              const hist = result.latency;
              if (hist.p99) postStats.latencies.push(hist.p99);
            }
            resolve(result);
          }
        );

        // Track correlation IDs from responses
        instance.on("response", (_client, statusCode, resBytes, responseTime) => {
          if (statusCode >= 200 && statusCode < 300) {
            // responseTime is the round-trip in ms
            postStats.latencies.push(responseTime);
            // We can't easily parse body here; correlationId tracking
            // is best-effort via a manual fetch loop (see runCorrelatedPosters).
          } else {
            postStats.errors++;
          }
        });
      }, i * 20); // 20ms stagger per poster
    });
  });

  await Promise.all(instances);
}

// ---------------------------------------------------------------------------
// 4. Correlated poster (manual fetch) for WS fanout measurement
// ---------------------------------------------------------------------------
async function runCorrelatedPosters(
  eventId: string,
  posterTokens: string[],
  stopSignal: { stop: boolean }
): Promise<void> {
  const postInterval = 5000; // 1 time per 5 seconds per poster

  async function posterLoop(token: string, bibNumber: number): Promise<void> {
    while (!stopSignal.stop) {
      const correlationId = `lt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const start = Date.now();

      try {
        const res = await fetch(`${BASE_URL}/v1/events/${eventId}/times`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Correlation-Id": correlationId,
          },
          body: JSON.stringify({
            bib: bibNumber,
            channelIndex: 0,
            rawMs: 90000 + Math.floor(Math.random() * 60000),
            correlationId,
          }),
        });

        const postMs = Date.now() - start;
        samples.push({ postAckMs: postMs, wsFanoutMs: 0 }); // wsFanoutMs updated via WS

        if (res.ok) {
          // Register ack timestamp so WS listener can compute fanout latency
          pendingAcks.set(correlationId, Date.now());
        }
      } catch {
        // network error — record but continue
        samples.push({ postAckMs: Date.now() - start, wsFanoutMs: -1 });
      }

      // Wait remainder of interval
      const elapsed = Date.now() - start;
      const wait = Math.max(0, postInterval - elapsed);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const loops = posterTokens.map((token, i) => posterLoop(token, (i % 200) + 1));
  await Promise.all(loops);
}

// ---------------------------------------------------------------------------
// 5. Teardown
// ---------------------------------------------------------------------------
async function teardown(eventId: string, sockets: WebSocket[]): Promise<void> {
  console.log("\n[teardown] Closing WS connections…");
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  // Optionally delete the test event
  try {
    await fetch(`${BASE_URL}/v1/events/${eventId}`, { method: "DELETE" });
    console.log("[teardown] Test event deleted.");
  } catch {
    console.log("[teardown] Could not delete test event (manual cleanup may be needed).");
  }
}

// ---------------------------------------------------------------------------
// 6. Report
// ---------------------------------------------------------------------------
function printReport(wsStats: WsStats, postStats: PostStats): void {
  console.log("\n========================================");
  console.log("       Timing Hub — Load Test Report    ");
  console.log("========================================\n");

  console.log(`Duration:        ${DURATION_S}s`);
  console.log(`Posters:         ${POSTER_COUNT}`);
  console.log(`Subscribers:     ${SUBSCRIBER_COUNT}\n`);

  console.log("HTTP POST /times:");
  console.log(`  Total requests: ${postStats.requests}`);
  console.log(`  Errors:         ${postStats.errors}`);
  console.log(
    `  Error rate:     ${postStats.requests > 0 ? ((postStats.errors / postStats.requests) * 100).toFixed(2) : 0}%`
  );
  console.log(`  Throughput:     ${postStats.throughput.toFixed(1)} req/s`);
  printHistogram("Latency (ms)", postStats.latencies);

  const postAckLatencies = samples
    .filter((s) => s.wsFanoutMs >= 0)
    .map((s) => s.postAckMs);
  printHistogram("POST ack latency", postAckLatencies);

  console.log("\nWebSocket fanout:");
  console.log(`  Connected clients:  ${wsStats.connected}`);
  console.log(`  Messages received:  ${wsStats.messages}`);
  console.log(`  WS errors:          ${wsStats.errors}`);
  printHistogram("Fanout latency (correlation-tracked)", wsStats.latencies);

  console.log("\nSLA check:");
  const sortedPost = [...postAckLatencies].sort((a, b) => a - b);
  const sortedFanout = [...wsStats.latencies].sort((a, b) => a - b);
  const p99Post = percentile(sortedPost, 99);
  const p99Fanout = percentile(sortedFanout, 99);
  console.log(
    `  p99 POST < 100ms:    ${p99Post <= 100 ? "PASS" : "FAIL"} (${p99Post}ms)`
  );
  console.log(
    `  p99 WS fanout < 200ms: ${p99Fanout <= 200 ? "PASS" : "FAIL"} (${p99Fanout}ms)`
  );
  console.log("\n========================================\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`Timing Hub Load Test`);
  console.log(`  Target:      ${BASE_URL}`);
  console.log(`  Duration:    ${DURATION_S}s`);
  console.log(`  Posters:     ${POSTER_COUNT}`);
  console.log(`  Subscribers: ${SUBSCRIBER_COUNT}\n`);

  let eventId = "";
  let sockets: WebSocket[] = [];
  const stopSignal = { stop: false };

  const wsStats: WsStats = { connected: 0, errors: 0, messages: 0, latencies: [] };
  const postStats: PostStats = { requests: 0, errors: 0, latencies: [], throughput: 0 };

  try {
    const setup_ = await setup();
    eventId = setup_.eventId;

    console.log("[run] Starting WS subscribers…");
    sockets = startSubscribers(eventId, setup_.subscriberTokens, wsStats, stopSignal);

    // Allow subscribers to connect before flood begins
    await new Promise((r) => setTimeout(r, 1500));

    console.log("[run] Starting correlated time posters…");
    const posterPromise = runCorrelatedPosters(
      eventId,
      setup_.posterTokens,
      stopSignal
    );

    // Run for DURATION_S seconds then stop
    await new Promise((r) => setTimeout(r, DURATION_S * 1000));
    stopSignal.stop = true;
    await posterPromise;

    printReport(wsStats, postStats);
  } finally {
    stopSignal.stop = true;
    await teardown(eventId, sockets);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
