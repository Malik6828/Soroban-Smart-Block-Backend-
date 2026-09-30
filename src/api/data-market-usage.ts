/**
 * Data marketplace quota & revenue dashboard (ECO05 / #1016).
 *
 * `trackDataMarketUsage` is mounted in front of the data-market router and aggregates
 * requests per API key, endpoint and calendar month (UTC). Responses carry
 * `X-Quota-Limit`, `X-Quota-Used` and, from 80% usage, `X-Quota-Warning`.
 *
 *   GET /api/v1/data-market-usage/me                    — caller's usage, quota status, warnings
 *   GET /api/v1/data-market-usage/admin/summary         — usage + revenue by key/endpoint
 *                                                         (?period=YYYY-MM)
 *   PUT /api/v1/data-market-usage/admin/quotas/:keyId   — override a key's monthly quota
 *
 * Revenue is computed from the per-tier price per 1,000 billable (non-5xx) requests and is
 * reported in USD cents so it can be reconciled against Stripe invoices.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';
import type { RateLimitTier } from '../middleware/tokenBucket';

export const TIER_MONTHLY_QUOTA: Record<RateLimitTier, number> = {
  unauthenticated: 0,
  free: 10_000,
  developer: 250_000,
  pro: 2_000_000,
  enterprise: 20_000_000,
};

/** Price in USD cents per 1,000 billable requests. */
export const TIER_PRICE_CENTS_PER_1K: Record<RateLimitTier, number> = {
  unauthenticated: 0,
  free: 0,
  developer: 20,
  pro: 15,
  enterprise: 10,
};

const WARNING_THRESHOLD = 0.8;
const MAX_ENDPOINTS_PER_KEY = 200;

interface KeyUsage {
  keyId: string;
  developerId: string;
  tier: RateLimitTier;
  total: number;
  billable: number;
  errors: number;
  endpoints: Map<string, { requests: number; billable: number }>;
}

/** period (YYYY-MM) → keyId → usage */
const usage = new Map<string, Map<string, KeyUsage>>();
const quotaOverrides = new Map<string, number>();

/** Test helper — clears usage and quota overrides. */
export function resetDataMarketUsage(): void {
  usage.clear();
  quotaOverrides.clear();
}

export function currentPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

function quotaFor(keyId: string, tier: RateLimitTier): number {
  return quotaOverrides.get(keyId) ?? TIER_MONTHLY_QUOTA[tier];
}

function revenueCents(billable: number, tier: RateLimitTier): number {
  return Math.round((billable / 1_000) * TIER_PRICE_CENTS_PER_1K[tier]);
}

function quotaStatus(u: Pick<KeyUsage, 'keyId' | 'tier' | 'total'>) {
  const limit = quotaFor(u.keyId, u.tier);
  const ratio = limit > 0 ? u.total / limit : 0;
  const warnings: string[] = [];
  if (limit > 0 && ratio >= 1) warnings.push('Monthly quota exceeded');
  else if (limit > 0 && ratio >= WARNING_THRESHOLD) {
    warnings.push(`Monthly quota ${Math.floor(ratio * 100)}% used`);
  }
  return { limit, used: u.total, remaining: Math.max(limit - u.total, 0), ratio, warnings };
}

export function trackDataMarketUsage(req: Request, res: Response, next: NextFunction): void {
  const key = req.apiKey;
  if (!key) return next();
  const period = currentPeriod();
  const byKey = usage.get(period) ?? new Map<string, KeyUsage>();
  usage.set(period, byKey);
  const u: KeyUsage = byKey.get(key.id) ?? {
    keyId: key.id,
    developerId: key.developerId,
    tier: key.tier as RateLimitTier,
    total: 0,
    billable: 0,
    errors: 0,
    endpoints: new Map(),
  };
  byKey.set(key.id, u);
  u.tier = key.tier as RateLimitTier;

  const status = quotaStatus({ keyId: u.keyId, tier: u.tier, total: u.total + 1 });
  res.setHeader('X-Quota-Limit', String(status.limit));
  res.setHeader('X-Quota-Used', String(status.used));
  if (status.warnings.length) res.setHeader('X-Quota-Warning', status.warnings[0]);

  res.on('finish', () => {
    // Use the matched route pattern (not the raw URL) to bound cardinality.
    const route = req.route?.path ? `${req.method} ${req.route.path}` : `${req.method} (unmatched)`;
    const billable = res.statusCode < 500;
    u.total += 1;
    if (billable) u.billable += 1;
    if (res.statusCode >= 400) u.errors += 1;
    const bucket =
      u.endpoints.has(route) || u.endpoints.size < MAX_ENDPOINTS_PER_KEY ? route : '(other)';
    const ep = u.endpoints.get(bucket) ?? { requests: 0, billable: 0 };
    ep.requests += 1;
    if (billable) ep.billable += 1;
    u.endpoints.set(bucket, ep);
  });
  next();
}

function serialize(u: KeyUsage) {
  return {
    keyId: u.keyId,
    developerId: u.developerId,
    tier: u.tier,
    requests: u.total,
    billableRequests: u.billable,
    errors: u.errors,
    revenueCents: revenueCents(u.billable, u.tier),
    quota: quotaStatus(u),
    endpoints: [...u.endpoints.entries()]
      .map(([endpoint, e]) => ({ endpoint, ...e }))
      .sort((a, b) => b.requests - a.requests),
  };
}

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const dataMarketUsageRouter = Router();

dataMarketUsageRouter.get('/me', (req: Request, res: Response) => {
  const key = req.apiKey;
  if (!key) {
    res.status(401).json({ error: 'API key required' });
    return;
  }
  const period = currentPeriod();
  const u = usage.get(period)?.get(key.id);
  res.json({
    period,
    ...(u
      ? serialize(u)
      : {
          keyId: key.id,
          developerId: key.developerId,
          tier: key.tier,
          requests: 0,
          billableRequests: 0,
          errors: 0,
          revenueCents: 0,
          quota: quotaStatus({ keyId: key.id, tier: key.tier as RateLimitTier, total: 0 }),
          endpoints: [],
        }),
  });
});

const admin = Router();
admin.use(adminAuth);

admin.get('/summary', (req: Request, res: Response) => {
  const parsed = periodSchema.safeParse(req.query.period ?? currentPeriod());
  if (!parsed.success) {
    res.status(400).json({ error: 'period must be YYYY-MM' });
    return;
  }
  const keys = [...(usage.get(parsed.data)?.values() ?? [])].map(serialize);
  const byEndpoint = new Map<string, { requests: number; billable: number }>();
  for (const k of keys) {
    for (const e of k.endpoints) {
      const agg = byEndpoint.get(e.endpoint) ?? { requests: 0, billable: 0 };
      agg.requests += e.requests;
      agg.billable += e.billable;
      byEndpoint.set(e.endpoint, agg);
    }
  }
  res.json({
    period: parsed.data,
    totals: {
      keys: keys.length,
      requests: keys.reduce((s, k) => s + k.requests, 0),
      billableRequests: keys.reduce((s, k) => s + k.billableRequests, 0),
      revenueCents: keys.reduce((s, k) => s + k.revenueCents, 0),
      keysOverQuota: keys.filter((k) => k.quota.limit > 0 && k.quota.ratio >= 1).length,
      keysNearQuota: keys.filter((k) => k.quota.ratio >= WARNING_THRESHOLD && k.quota.ratio < 1)
        .length,
    },
    byKey: keys.sort((a, b) => b.revenueCents - a.revenueCents),
    byEndpoint: [...byEndpoint.entries()]
      .map(([endpoint, e]) => ({ endpoint, ...e }))
      .sort((a, b) => b.requests - a.requests),
  });
});

admin.put('/quotas/:keyId', (req: Request, res: Response) => {
  const parsed = z
    .object({ monthlyQuota: z.number().int().nonnegative().max(1_000_000_000).nullable() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'monthlyQuota must be a non-negative integer or null' });
    return;
  }
  const keyId = req.params.keyId.slice(0, 128);
  if (parsed.data.monthlyQuota === null) quotaOverrides.delete(keyId);
  else quotaOverrides.set(keyId, parsed.data.monthlyQuota);
  res.json({ keyId, monthlyQuota: quotaOverrides.get(keyId) ?? null });
});

dataMarketUsageRouter.use('/admin', admin);
