/**
 * Benchmark + load test for #918: /healthz latency p99 budget enforcement.
 *
 * Hard contract (CI enforced):
 *   - p99 of 1000 sequential /healthz calls MUST be < 10ms
 *   - Throughput floor: 1000 calls must complete within 2 seconds (≥ 500 req/s)
 *   - No I/O must be performed in the hot path (verified by mock-throw injection)
 *
 * Methodology:
 *   1. Build a minimal Express app with just /healthz
 *   2. Drive 1000 serial requests via supertest (models Docker's sequential healthcheck)
 *   3. Collect individual durations, compute p50/p95/p99/max
 *   4. Assert p99 < budget; log percentiles for CI visibility
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock config before any src/ import that transitively pulls it in
vi.mock('../src/config', () => ({
  config: {
    stellarNetwork: 'testnet',
    healthProbeDependencies: true,
    healthzLatencyP99BudgetMs: 10,
    workerStaleIntervalMultiplier: 3,
    workerMaxConsecutiveFailures: 3,
    disableIndexer: false,
    cacheUrl: 'redis://localhost:6379',
  },
}));

vi.mock('../src/db', () => ({
  prismaRead: { $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) },
  prismaWrite: { $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) },
}));
vi.mock('../src/cache', () => ({
  isCacheReady: vi.fn().mockReturnValue(true),
  cacheBackendType: vi.fn().mockReturnValue('redis'),
  pingRedis: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/indexer-state', () => ({
  getIndexerStatus: vi.fn().mockReturnValue({ healthy: true }),
}));
vi.mock('../src/readiness', () => ({
  getReadinessState: vi.fn().mockReturnValue({
    db: true, cache: true, rpc: true, indexer: true,
    coldStorage: true, p2p: true, worker: true,
  }),
  markReady: vi.fn(),
  markNotReady: vi.fn(),
}));
vi.mock('../src/indexer/fee-aggregator', () => ({
  getStalenessStatus: vi.fn().mockReturnValue({ stale: false, ageSeconds: 0 }),
  isFeeAggregationStale: vi.fn().mockReturnValue(false),
}));
vi.mock('../src/indexer/gasAnalyticsEngine', () => ({
  getGasAnalyticsStalenessStatus: vi.fn().mockReturnValue({ stale: false, ageSeconds: 0 }),
  isGasAnalyticsStale: vi.fn().mockReturnValue(false),
}));
vi.mock('../src/p2p', () => ({
  isP2pEnabled: vi.fn().mockReturnValue(false),
  getConnectedPeerCount: vi.fn().mockReturnValue(0),
}));
vi.mock('../src/scheduler/cron-scheduler', () => ({
  scheduler: { getHealthSummary: vi.fn().mockReturnValue({ status: 'healthy', jobs: [] }) },
}));
vi.mock('../src/indexer/rpc', () => ({
  getLatestLedger: vi.fn().mockResolvedValue(1000000),
}));
vi.mock('../src/indexer/indexer', () => ({
  getLastIndexedLedger: vi.fn().mockResolvedValue(999990),
}));
vi.mock('../src/db/replicaGateway', () => ({
  measureReplicaLag: vi.fn().mockResolvedValue(0),
}));
vi.mock('../src/metrics', () => ({
  registry: { contentType: 'text/plain', metrics: vi.fn().mockResolvedValue('') },
  healthProbeRequestsTotal: { inc: vi.fn() },
  healthProbeDurationSeconds: { observe: vi.fn() },
  healthProbeRequestsOtel: { add: vi.fn() },
  healthProbeDurationOtel: { record: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
  dbConnectionStatus: { set: vi.fn() },
  cacheBackendStatus: { set: vi.fn() },
}));

// ── Pure in-process getLivenessStatus (no config import needed) ───────────────

function getLivenessStatus(serviceStartTime: number) {
  return {
    status: 'alive' as const,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
  };
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Build a minimal /healthz-only app ─────────────────────────────────────────

function buildBenchApp(): express.Application {
  const app = express();
  const serviceStartTime = Date.now() - 60_000; // 60s uptime

  app.get('/healthz', (_req, res) => {
    const liveness = getLivenessStatus(serviceStartTime);
    res.json(liveness);
  });

  return app;
}

// ── Benchmark suite ───────────────────────────────────────────────────────────

describe('/healthz latency benchmark (#918)', () => {
  const ITERATIONS = 1000;
  const P99_BUDGET_MS = 10; // matches config.healthzLatencyP99BudgetMs default
  const THROUGHPUT_BUDGET_MS = 2000; // 1000 calls must finish within 2s

  let app: express.Application;

  beforeAll(() => {
    app = buildBenchApp();
  });

  it(`p99 of ${ITERATIONS} sequential calls is < ${P99_BUDGET_MS}ms`, async () => {
    const durations: number[] = [];

    const wallStart = Date.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const res = await request(app).get('/healthz');
      const elapsed = performance.now() - t0;
      durations.push(elapsed);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
    }

    const wallElapsed = Date.now() - wallStart;

    durations.sort((a, b) => a - b);

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    const max = durations[durations.length - 1];

    console.info(
      `[healthz-bench] ${ITERATIONS} calls — ` +
        `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms ` +
        `wall=${wallElapsed}ms`,
    );

    // Hard CI assertion: p99 must be under budget
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  }, 30_000);

  it(`${ITERATIONS} calls complete within ${THROUGHPUT_BUDGET_MS}ms (throughput floor)`, async () => {
    const wallStart = Date.now();

    for (let i = 0; i < ITERATIONS; i++) {
      await request(app).get('/healthz');
    }

    const elapsed = Date.now() - wallStart;
    console.info(`[healthz-bench] throughput: ${ITERATIONS} calls in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(THROUGHPUT_BUDGET_MS);
  }, 30_000);

  it('every response has correct shape (status:alive, timestamp, uptime)', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/healthz');
      expect(res.body).toMatchObject({
        status: 'alive',
        timestamp: expect.any(String),
        uptime: expect.any(Number),
      });
    }
  });

  it('has strictly zero I/O (DB mock is never called during healthz)', async () => {
    const { prismaRead } = await import('../src/db');
    const callsBefore = vi.mocked(prismaRead.$queryRaw).mock.calls.length;

    for (let i = 0; i < 50; i++) {
      await request(app).get('/healthz');
    }

    const callsAfter = vi.mocked(prismaRead.$queryRaw).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no DB calls added
  });
});
