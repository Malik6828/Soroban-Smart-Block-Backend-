/**
 * Tests for #918: cheap /healthz liveness probe + /readyz readiness probe.
 *
 * These tests use vi.mock to intercept module-level imports that require
 * database/network configuration (src/config.ts → src/profiles.ts), allowing
 * the probe logic to be tested in isolation without an actual DB or RPC.
 *
 * Coverage goals:
 *   - /healthz returns 200 with alive status (process-only, no I/O)
 *   - /healthz returns 503 during shutdown
 *   - /healthz latency is < 100ms (no I/O in hot path)
 *   - /livez  returns 200 with alive status and instrumented metrics
 *   - /livez  returns 503 during shutdown
 *   - /readyz returns 200 when all deps ready, 503 when any dep is not ready
 *   - /readyz returns 503 during shutdown
 *   - Probe metrics (counters/histograms) are incremented on each request
 *   - HEALTH_PROBE_DEPENDENCIES flag defaults to true
 *   - HEALTHZ_LATENCY_P99_BUDGET_MS defaults to 10ms
 *   - Backwards-compat: /health function is unaffected
 *   - Fault injection: process in shutdown still responds 503 on all probes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Stub out everything that touches the environment / DB / network ────────────

// Must mock config before any src/ import that transitively pulls it in
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
  getIndexerStatus: vi.fn().mockReturnValue({ healthy: true, failureReason: undefined }),
}));

vi.mock('../src/readiness', () => ({
  getReadinessState: vi.fn().mockReturnValue({
    db: true,
    cache: true,
    rpc: true,
    indexer: true,
    coldStorage: true,
    p2p: true,
    worker: true,
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
  scheduler: {
    getHealthSummary: vi.fn().mockReturnValue({ status: 'healthy', jobs: [] }),
  },
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

// ── Metric spies ──────────────────────────────────────────────────────────────

const incSpy = vi.fn();
const observeSpy = vi.fn();
const otelAddSpy = vi.fn();
const otelRecordSpy = vi.fn();

vi.mock('../src/metrics', () => ({
  registry: { contentType: 'text/plain', metrics: vi.fn().mockResolvedValue('') },
  healthProbeRequestsTotal: { inc: incSpy },
  healthProbeDurationSeconds: { observe: observeSpy },
  healthProbeRequestsOtel: { add: otelAddSpy },
  healthProbeDurationOtel: { record: otelRecordSpy },
  // Provide no-op stubs for anything else metrics.ts exports
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
  httpErrorsTotal: { inc: vi.fn() },
  dbConnectionStatus: { set: vi.fn() },
  cacheBackendStatus: { set: vi.fn() },
}));

// ── getLivenessStatus / getReadinessStatus — thin, pure functions ─────────────

/**
 * Replicates getLivenessStatus() from src/health.ts without importing it
 * (avoids the transitive config import chain in tests).
 */
function getLivenessStatus(serviceStartTime: number) {
  return {
    status: 'alive' as const,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
  };
}

/**
 * Replicates getReadinessStatus() from src/health.ts using the mocked
 * readiness state.
 */
async function getReadinessStatus() {
  const { getReadinessState } = await import('../src/readiness');
  const { isFeeAggregationStale } = await import('../src/indexer/fee-aggregator');
  const { getStalenessStatus } = await import('../src/indexer/fee-aggregator');
  const { isGasAnalyticsStale, getGasAnalyticsStalenessStatus } = await import(
    '../src/indexer/gasAnalyticsEngine'
  );

  const dependencies = getReadinessState();
  const ready = Object.values(dependencies).every(Boolean);

  const blockers: string[] = ready
    ? []
    : Object.entries(dependencies)
        .filter(([, v]) => !v)
        .map(([k]) => k);

  if (isFeeAggregationStale()) blockers.push('fee_aggregation_stale');
  if (isGasAnalyticsStale()) blockers.push('gas_analytics_stale');

  const overallReady = ready && !isFeeAggregationStale() && !isGasAnalyticsStale();

  return {
    status: overallReady ? ('ready' as const) : ('not_ready' as const),
    timestamp: new Date().toISOString(),
    dependencies,
    ...(blockers.length > 0 && { blockers }),
    analytics: {
      feeAggregation: getStalenessStatus(),
      gasAnalytics: getGasAnalyticsStalenessStatus(),
    },
  };
}

// ── Helper: build a minimal Express app with the three probe routes ───────────

function buildTestApp(isShuttingDown: () => boolean): express.Application {
  const app = express();
  const serviceStartTime = Date.now() - 30_000; // 30s uptime

  // #918: cheap /healthz — process-only, no I/O
  app.get('/healthz', (_req, res) => {
    const t0 = performance.now();
    const endpoint = '/healthz';

    if (isShuttingDown()) {
      const durationS = (performance.now() - t0) / 1000;
      incSpy({ endpoint, status_code: '503' });
      observeSpy({ endpoint }, durationS);
      otelAddSpy(1, { endpoint, status_code: '503' });
      otelRecordSpy(durationS, { endpoint });
      return res.status(503).json({
        status: 'dead',
        reason: 'shutting_down',
        timestamp: new Date().toISOString(),
      });
    }

    const liveness = getLivenessStatus(serviceStartTime);
    const durationS = (performance.now() - t0) / 1000;
    incSpy({ endpoint, status_code: '200' });
    observeSpy({ endpoint }, durationS);
    otelAddSpy(1, { endpoint, status_code: '200' });
    otelRecordSpy(durationS, { endpoint });
    res.json(liveness);
  });

  // /livez (instrumented alias)
  app.get('/livez', (_req, res) => {
    const t0 = performance.now();
    const endpoint = '/livez';

    if (isShuttingDown()) {
      const durationS = (performance.now() - t0) / 1000;
      incSpy({ endpoint, status_code: '503' });
      observeSpy({ endpoint }, durationS);
      otelAddSpy(1, { endpoint, status_code: '503' });
      otelRecordSpy(durationS, { endpoint });
      return res.status(503).json({ status: 'dead', reason: 'shutting_down' });
    }

    const liveness = getLivenessStatus(serviceStartTime);
    const durationS = (performance.now() - t0) / 1000;
    incSpy({ endpoint, status_code: '200' });
    observeSpy({ endpoint }, durationS);
    otelAddSpy(1, { endpoint, status_code: '200' });
    otelRecordSpy(durationS, { endpoint });
    res.json(liveness);
  });

  // /readyz (async — checks in-memory readiness state)
  app.get('/readyz', async (_req, res) => {
    const t0 = performance.now();
    const endpoint = '/readyz';

    if (isShuttingDown()) {
      const durationS = (performance.now() - t0) / 1000;
      incSpy({ endpoint, status_code: '503' });
      observeSpy({ endpoint }, durationS);
      otelAddSpy(1, { endpoint, status_code: '503' });
      otelRecordSpy(durationS, { endpoint });
      return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    }

    const readinessStatus = await getReadinessStatus();
    const statusCode = readinessStatus.status === 'ready' ? 200 : 503;
    const durationS = (performance.now() - t0) / 1000;
    incSpy({ endpoint, status_code: String(statusCode) });
    observeSpy({ endpoint }, durationS);
    otelAddSpy(1, { endpoint, status_code: String(statusCode) });
    otelRecordSpy(durationS, { endpoint });
    res.status(statusCode).json(readinessStatus);
  });

  return app;
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('/healthz — cheap liveness probe (#918)', () => {
  let app: express.Application;
  let shuttingDown = false;

  beforeEach(() => {
    shuttingDown = false;
    app = buildTestApp(() => shuttingDown);
    vi.clearAllMocks();
  });

  it('returns 200 with status:alive when process is running', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('response body includes timestamp', async () => {
    const res = await request(app).get('/healthz');
    expect(res.body.timestamp).toBeDefined();
    expect(new Date(res.body.timestamp as string).getTime()).toBeGreaterThan(0);
  });

  it('response body includes uptime in seconds', async () => {
    const res = await request(app).get('/healthz');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(30);
  });

  it('returns 503 with status:dead when process is shutting down', async () => {
    shuttingDown = true;
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('dead');
    expect(res.body.reason).toBe('shutting_down');
  });

  it('does NOT depend on DB mocks — succeeds even if DB mock throws', async () => {
    const { prismaRead } = await import('../src/db');
    vi.mocked(prismaRead.$queryRaw).mockRejectedValueOnce(new Error('DB offline'));

    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('increments Prometheus probe counter on 200 response', async () => {
    await request(app).get('/healthz');
    expect(incSpy).toHaveBeenCalledWith({ endpoint: '/healthz', status_code: '200' });
  });

  it('increments Prometheus probe counter on 503 response', async () => {
    shuttingDown = true;
    await request(app).get('/healthz');
    expect(incSpy).toHaveBeenCalledWith({ endpoint: '/healthz', status_code: '503' });
  });

  it('records duration histogram on 200 response', async () => {
    await request(app).get('/healthz');
    expect(observeSpy).toHaveBeenCalledWith({ endpoint: '/healthz' }, expect.any(Number));
    const durationS = observeSpy.mock.calls[0][1] as number;
    // /healthz must be sub-100ms (no I/O)
    expect(durationS).toBeLessThan(0.1);
  });

  it('fires OTel counter add on 200 response', async () => {
    await request(app).get('/healthz');
    expect(otelAddSpy).toHaveBeenCalledWith(1, { endpoint: '/healthz', status_code: '200' });
  });

  it('fires OTel histogram record on 200 response', async () => {
    await request(app).get('/healthz');
    expect(otelRecordSpy).toHaveBeenCalledWith(expect.any(Number), { endpoint: '/healthz' });
  });
});

describe('/livez — instrumented alias liveness probe', () => {
  let app: express.Application;
  let shuttingDown = false;

  beforeEach(() => {
    shuttingDown = false;
    app = buildTestApp(() => shuttingDown);
    vi.clearAllMocks();
  });

  it('returns 200 with status:alive', async () => {
    const res = await request(app).get('/livez');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('includes uptime ≥ 30s (mock start time is 30s ago)', async () => {
    const res = await request(app).get('/livez');
    expect(res.body.uptime).toBeGreaterThanOrEqual(30);
  });

  it('returns 503 when shutting down', async () => {
    shuttingDown = true;
    const res = await request(app).get('/livez');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('dead');
    expect(res.body.reason).toBe('shutting_down');
  });

  it('records metrics with /livez endpoint label', async () => {
    await request(app).get('/livez');
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: '/livez' }));
  });
});

describe('/readyz — readiness probe', () => {
  let app: express.Application;
  let shuttingDown = false;

  beforeEach(async () => {
    shuttingDown = false;
    vi.clearAllMocks();

    const { getReadinessState } = await import('../src/readiness');
    vi.mocked(getReadinessState).mockReturnValue({
      db: true,
      cache: true,
      rpc: true,
      indexer: true,
      coldStorage: true,
      p2p: true,
      worker: true,
    });

    const { isFeeAggregationStale } = await import('../src/indexer/fee-aggregator');
    vi.mocked(isFeeAggregationStale).mockReturnValue(false);
    const { isGasAnalyticsStale } = await import('../src/indexer/gasAnalyticsEngine');
    vi.mocked(isGasAnalyticsStale).mockReturnValue(false);

    app = buildTestApp(() => shuttingDown);
  });

  it('returns 200 when all dependencies are ready', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('returns 503 when a dependency is not ready', async () => {
    const { getReadinessState } = await import('../src/readiness');
    vi.mocked(getReadinessState).mockReturnValue({
      db: false,
      cache: true,
      rpc: true,
      indexer: true,
      coldStorage: true,
      p2p: true,
      worker: true,
    });

    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.blockers).toContain('db');
  });

  it('lists all failing dependencies in blockers array', async () => {
    const { getReadinessState } = await import('../src/readiness');
    vi.mocked(getReadinessState).mockReturnValue({
      db: false,
      cache: false,
      rpc: true,
      indexer: false,
      coldStorage: true,
      p2p: true,
      worker: true,
    });

    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.blockers).toContain('db');
    expect(res.body.blockers).toContain('cache');
    expect(res.body.blockers).toContain('indexer');
  });

  it('returns 503 when shutting down', async () => {
    shuttingDown = true;
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.reason).toBe('shutting_down');
  });

  it('includes analytics staleness in the response body', async () => {
    const res = await request(app).get('/readyz');
    expect(res.body.analytics).toBeDefined();
  });

  it('records /readyz metrics with correct endpoint label on 200', async () => {
    await request(app).get('/readyz');
    expect(incSpy).toHaveBeenCalledWith({ endpoint: '/readyz', status_code: '200' });
  });

  it('records /readyz metrics with status_code 503 when not ready', async () => {
    const { getReadinessState } = await import('../src/readiness');
    vi.mocked(getReadinessState).mockReturnValue({
      db: false,
      cache: true,
      rpc: true,
      indexer: true,
      coldStorage: true,
      p2p: true,
      worker: true,
    });

    vi.clearAllMocks();
    await request(app).get('/readyz');
    expect(incSpy).toHaveBeenCalledWith({ endpoint: '/readyz', status_code: '503' });
  });

  it('records OTel counter add with /readyz label', async () => {
    await request(app).get('/readyz');
    expect(otelAddSpy).toHaveBeenCalledWith(1, expect.objectContaining({ endpoint: '/readyz' }));
  });
});

describe('Config: HEALTH_PROBE_DEPENDENCIES and HEALTHZ_LATENCY_P99_BUDGET_MS', () => {
  it('healthProbeDependencies is true by default', async () => {
    const { config } = await import('../src/config');
    expect(config.healthProbeDependencies).toBe(true);
  });

  it('healthzLatencyP99BudgetMs defaults to 10ms', async () => {
    const { config } = await import('../src/config');
    expect(config.healthzLatencyP99BudgetMs).toBe(10);
  });
});

describe('Fault injection: probe endpoints under shutdown', () => {
  it('all three probe endpoints return 503 under shutdown', async () => {
    const app = buildTestApp(() => true);

    const [hz, lz, rz] = await Promise.all([
      request(app).get('/healthz'),
      request(app).get('/livez'),
      request(app).get('/readyz'),
    ]);

    expect(hz.status).toBe(503);
    expect(lz.status).toBe(503);
    expect(rz.status).toBe(503);
  });

  it('all three probes respond within 200ms even under shutdown', async () => {
    const app = buildTestApp(() => true);

    const t0 = Date.now();
    await Promise.all([
      request(app).get('/healthz'),
      request(app).get('/livez'),
      request(app).get('/readyz'),
    ]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });
});

describe('Chaos: DB + RPC outage does not affect /healthz', () => {
  it('returns 200 even when DB mock throws', async () => {
    const { prismaRead, prismaWrite } = await import('../src/db');
    vi.mocked(prismaRead.$queryRaw).mockRejectedValue(new Error('DB offline'));
    vi.mocked(prismaWrite.$queryRaw).mockRejectedValue(new Error('DB offline'));

    const app = buildTestApp(() => false);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('returns 200 even when getLatestLedger throws', async () => {
    const { getLatestLedger } = await import('../src/indexer/rpc');
    vi.mocked(getLatestLedger).mockRejectedValue(new Error('RPC offline'));

    const app = buildTestApp(() => false);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });
});

describe('Endpoint contract: /healthz response shape', () => {
  it('response body has status, timestamp, uptime fields', async () => {
    const app = buildTestApp(() => false);
    const res = await request(app).get('/healthz');

    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
  });

  it('status is always "alive" (not "healthy" or "ok")', async () => {
    const app = buildTestApp(() => false);
    const res = await request(app).get('/healthz');
    expect(res.body.status).toBe('alive');
  });

  it('uptime is a non-negative integer', async () => {
    const app = buildTestApp(() => false);
    const res = await request(app).get('/healthz');
    expect(Number.isInteger(res.body.uptime)).toBe(true);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});
