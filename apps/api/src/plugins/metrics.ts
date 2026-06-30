/**
 * plugins/metrics.ts — In-memory application metrics
 *
 * Exposes a simple key/value store for counters, gauges, and histograms.
 * No Prometheus dependency — values are served as JSON via GET /metrics.
 *
 * Secured by METRICS_TOKEN header.  Set the env var to enable the endpoint;
 * if the var is absent the endpoint still exists but always returns 401.
 *
 * Metric names (all accessible via app.metrics.*):
 *
 *   Gauges
 *     ws.connected_clients    — currently open WebSocket connections
 *     ws.active_rooms         — distinct event slugs with at least one subscriber
 *     scoring.active_events   — events with a pending/running scoring job
 *
 *   Counters  (monotonically increasing, reset on restart)
 *     ws.messages_total       — total WS messages received, by type
 *     time_entries.total      — total time entries written via WS
 *
 *   Histograms  (rolling window: last 1000 samples)
 *     ws.fanout_latency_ms    — ms from DB write to all local clients notified
 *     scoring.compute_ms      — ms from job enqueue to results saved
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  gauges: Record<string, number>;
  counters: Record<string, number>;
  counters_by_label: Record<string, Record<string, number>>;
  histograms: Record<string, HistogramStats>;
}

// ---------------------------------------------------------------------------
// Rolling histogram (fixed-size ring buffer)
// ---------------------------------------------------------------------------

const HISTOGRAM_WINDOW = 1000;

class Histogram {
  private samples: number[] = [];
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;

  record(value: number): void {
    if (this.samples.length >= HISTOGRAM_WINDOW) {
      const evicted = this.samples.shift()!;
      this.sum -= evicted;
    }
    this.samples.push(value);
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  snapshot(): HistogramStats {
    const count = this.samples.length;
    if (count === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.floor(pct * count)] ?? sorted[count - 1]!;
    return {
      count,
      sum: this.sum,
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity ? 0 : this.max,
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
    };
  }
}

// ---------------------------------------------------------------------------
// MetricsStore
// ---------------------------------------------------------------------------

class MetricsStore {
  private gauges = new Map<string, number>();
  private counters = new Map<string, number>();
  private countersByLabel = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Histogram>();

  // --- Gauge ---

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  incGauge(name: string, delta = 1): void {
    this.gauges.set(name, (this.gauges.get(name) ?? 0) + delta);
  }

  decGauge(name: string, delta = 1): void {
    this.gauges.set(name, Math.max(0, (this.gauges.get(name) ?? 0) - delta));
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  // --- Counter ---

  incCounter(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  incCounterWithLabel(name: string, label: string, delta = 1): void {
    const labels = this.countersByLabel.get(name) ?? new Map<string, number>();
    labels.set(label, (labels.get(label) ?? 0) + delta);
    this.countersByLabel.set(name, labels);
    // Also bump the total
    this.incCounter(name, delta);
  }

  // --- Histogram ---

  recordHistogram(name: string, value: number): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    h.record(value);
  }

  // --- Snapshot ---

  snapshot(): MetricsSnapshot {
    const gaugesObj: Record<string, number> = {};
    for (const [k, v] of this.gauges) gaugesObj[k] = v;

    const countersObj: Record<string, number> = {};
    for (const [k, v] of this.counters) countersObj[k] = v;

    const byLabelObj: Record<string, Record<string, number>> = {};
    for (const [name, labels] of this.countersByLabel) {
      const labelObj: Record<string, number> = {};
      for (const [label, count] of labels) labelObj[label] = count;
      byLabelObj[name] = labelObj;
    }

    const histObj: Record<string, HistogramStats> = {};
    for (const [k, h] of this.histograms) histObj[k] = h.snapshot();

    return {
      timestamp: new Date().toISOString(),
      gauges: gaugesObj,
      counters: countersObj,
      counters_by_label: byLabelObj,
      histograms: histObj,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton so ws/hub and scoring can import it directly
// ---------------------------------------------------------------------------

export const metrics = new MetricsStore();

// Initialise known gauges at 0 so they appear even before any connections
metrics.setGauge('ws.connected_clients', 0);
metrics.setGauge('ws.active_rooms', 0);
metrics.setGauge('scoring.active_events', 0);

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

const METRICS_TOKEN = process.env.METRICS_TOKEN;

async function metricsPluginFn(app: FastifyInstance): Promise<void> {
  // Decorate so routes can reference app.metrics if needed
  app.decorate('metrics', metrics);

  app.get(
    '/metrics',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers['x-metrics-token'];
      if (!METRICS_TOKEN || token !== METRICS_TOKEN) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      return reply.status(200).send(metrics.snapshot());
    },
  );
}

export const metricsPlugin = fp(metricsPluginFn, {
  name: 'metrics',
  fastify: '5.x',
});

// ---------------------------------------------------------------------------
// Fastify type augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricsStore;
  }
}
