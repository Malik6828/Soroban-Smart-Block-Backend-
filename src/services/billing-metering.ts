/**
 * Billing Metering Service — PLT04
 *
 * Provides plan entitlement resolution, quota checking and increments,
 * usage summaries, billing event persistence, and daily quota reset utilities.
 *
 * All new-table operations use raw SQL via Prisma.sql because the generated
 * Prisma client does not yet reflect the PLT04 migration tables at compile
 * time.  Once `prisma generate` has been run against the updated schema the
 * models will be available on `prismaRead` / `prismaWrite` directly.
 */

import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PlanEntitlements {
  maxRequestsPerDay: number;
  maxRequestsPerMonth: number;
  maxConcurrentKeys: number;
  historyCutoffDays: number;
  maxWebhooks: number;
  overageRatePer1k: number;
  hasAnalytics: boolean;
  hasPrioritySupport: boolean;
}

export interface UsageSummary {
  developerId: string;
  planName: string;
  requestsToday: number;
  requestsThisMonth: number;
  dailyQuota: number;
  monthlyQuota: number;
  dailyUsagePct: number;
  monthlyUsagePct: number;
  isOverDaily: boolean;
  isOverMonthly: boolean;
  estimatedMonthlyCost: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface BillingEventRow {
  id: string;
  developerId: string;
  eventType: string;
  fromPlanId: string | null;
  toPlanId: string | null;
  amountCents: number | null;
  currency: string;
  stripeEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ─── Raw-row shapes returned by $queryRaw ────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  requests_per_day: number;
  requests_per_month: number;
  price_monthly: number;
  max_concurrent_keys: number;
  history_cutoff_days: number;
  max_webhooks: number;
  overage_rate_per_1k: number | string;
  features: unknown;
}

interface QuotaRow {
  daily_requests_used: number;
  monthly_requests_used: number;
  is_quota_exceeded: boolean;
  daily_reset_at: Date;
  monthly_reset_at: Date;
  last_quota_check_at: Date | null;
}

interface DeveloperPlanRow {
  developer_id: string;
  plan_id: string | null;
  plan_name: string | null;
  requests_per_day: number | null;
  requests_per_month: number | null;
  price_monthly: number | null;
  max_concurrent_keys: number | null;
  history_cutoff_days: number | null;
  max_webhooks: number | null;
  overage_rate_per_1k: number | string | null;
  features: unknown;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
}

interface BillingEventDbRow {
  id: string;
  developer_id: string;
  event_type: string;
  from_plan_id: string | null;
  to_plan_id: string | null;
  amount_cents: number | null;
  currency: string;
  stripe_event_id: string | null;
  metadata: unknown;
  created_at: Date;
}

// ─── Free-tier fallback entitlements ─────────────────────────────────────────

const FREE_TIER_ENTITLEMENTS: PlanEntitlements = {
  maxRequestsPerDay: 100,
  maxRequestsPerMonth: 3000,
  maxConcurrentKeys: 3,
  historyCutoffDays: 7,
  maxWebhooks: 1,
  overageRatePer1k: 0.2,
  hasAnalytics: false,
  hasPrioritySupport: false,
};

// ─── getPlanEntitlements ──────────────────────────────────────────────────────

/**
 * Returns the entitlements for a billing plan.
 * Falls back to free-tier defaults if the plan is not found or planId is null.
 */
export async function getPlanEntitlements(planId: string | null): Promise<PlanEntitlements> {
  if (!planId) return FREE_TIER_ENTITLEMENTS;

  try {
    const rows = await prismaRead.$queryRaw<PlanRow[]>(
      Prisma.sql`
        SELECT id, name, requests_per_day, requests_per_month,
               price_monthly, max_concurrent_keys, history_cutoff_days,
               max_webhooks, overage_rate_per_1k, features
        FROM "_billing_plans"
        WHERE id = ${planId}
        LIMIT 1
      `,
    );

    if (rows.length === 0) {
      logger.warn('[billing-metering] Plan not found, falling back to free tier', { planId });
      return FREE_TIER_ENTITLEMENTS;
    }

    const row = rows[0];
    const features =
      typeof row.features === 'object' && row.features !== null
        ? (row.features as Record<string, unknown>)
        : {};

    return {
      maxRequestsPerDay: row.requests_per_day,
      maxRequestsPerMonth: row.requests_per_month,
      maxConcurrentKeys: row.max_concurrent_keys ?? FREE_TIER_ENTITLEMENTS.maxConcurrentKeys,
      historyCutoffDays: row.history_cutoff_days ?? FREE_TIER_ENTITLEMENTS.historyCutoffDays,
      maxWebhooks: row.max_webhooks ?? FREE_TIER_ENTITLEMENTS.maxWebhooks,
      overageRatePer1k: Number(row.overage_rate_per_1k ?? FREE_TIER_ENTITLEMENTS.overageRatePer1k),
      hasAnalytics:
        features.analytics === true ||
        ['pro', 'enterprise'].includes(String(row.name ?? '').toLowerCase()),
      hasPrioritySupport:
        features.support === 'priority' ||
        features.support === 'dedicated' ||
        ['pro', 'enterprise'].includes(String(row.name ?? '').toLowerCase()),
    };
  } catch (err) {
    logger.error('[billing-metering] getPlanEntitlements error, using fallback', {
      planId,
      err: String(err),
    });
    return FREE_TIER_ENTITLEMENTS;
  }
}

// ─── checkQuota ───────────────────────────────────────────────────────────────

/**
 * Checks whether a developer is within their quota limits.
 * Returns allowed=false with a reason string if the monthly quota is exceeded.
 * On any DB error, returns allowed=true (graceful degradation).
 */
export async function checkQuota(
  developerId: string,
): Promise<{ allowed: boolean; reason?: string; usagePct: number }> {
  try {
    // Fetch developer + plan in one query
    const devRows = await prismaRead.$queryRaw<DeveloperPlanRow[]>(
      Prisma.sql`
        SELECT d.id AS developer_id, d.plan_id,
               p.name AS plan_name,
               p.requests_per_day, p.requests_per_month, p.price_monthly,
               p.max_concurrent_keys, p.history_cutoff_days,
               p.max_webhooks, p.overage_rate_per_1k, p.features,
               d.stripe_customer_id, d.stripe_subscription_id,
               d.subscription_status, d.current_period_start, d.current_period_end
        FROM "_developers" d
        LEFT JOIN "_billing_plans" p ON p.id = d.plan_id
        WHERE d.id = ${developerId}
        LIMIT 1
      `,
    );

    const monthlyQuota =
      devRows.length > 0 && devRows[0].requests_per_month !== null
        ? devRows[0].requests_per_month
        : FREE_TIER_ENTITLEMENTS.maxRequestsPerMonth;

    const dailyQuota =
      devRows.length > 0 && devRows[0].requests_per_day !== null
        ? devRows[0].requests_per_day
        : FREE_TIER_ENTITLEMENTS.maxRequestsPerDay;

    // Fetch or lazily initialise quota row
    const now = new Date();
    const quotaRows = await prismaRead.$queryRaw<QuotaRow[]>(
      Prisma.sql`
        SELECT daily_requests_used, monthly_requests_used,
               is_quota_exceeded, daily_reset_at, monthly_reset_at,
               last_quota_check_at
        FROM "_usage_quotas"
        WHERE developer_id = ${developerId}
        LIMIT 1
      `,
    );

    if (quotaRows.length === 0) {
      // No quota row yet — developer has never been metered; allow.
      return { allowed: true, usagePct: 0 };
    }

    const quota = quotaRows[0];

    // Determine whether the period has rolled over since last reset
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const dailyUsed = new Date(quota.daily_reset_at) < dayStart ? 0 : quota.daily_requests_used;
    const monthlyUsed =
      new Date(quota.monthly_reset_at) < monthStart ? 0 : quota.monthly_requests_used;

    const monthlyPct = monthlyQuota > 0 ? Math.round((monthlyUsed / monthlyQuota) * 100) : 0;
    const dailyPct = dailyQuota > 0 ? Math.round((dailyUsed / dailyQuota) * 100) : 0;
    const usagePct = Math.max(monthlyPct, dailyPct);

    if (monthlyUsed >= monthlyQuota) {
      return {
        allowed: false,
        reason: `Monthly quota of ${monthlyQuota.toLocaleString()} requests exceeded (used ${monthlyUsed.toLocaleString()})`,
        usagePct: Math.min(100, monthlyPct),
      };
    }

    if (dailyUsed >= dailyQuota) {
      return {
        allowed: false,
        reason: `Daily quota of ${dailyQuota.toLocaleString()} requests exceeded (used ${dailyUsed.toLocaleString()})`,
        usagePct: Math.min(100, dailyPct),
      };
    }

    return { allowed: true, usagePct };
  } catch (err) {
    logger.warn('[billing-metering] checkQuota error — allowing request', {
      developerId,
      err: String(err),
    });
    return { allowed: true, usagePct: 0 };
  }
}

// ─── recordUsage ─────────────────────────────────────────────────────────────

/**
 * Records a single API request and atomically increments the developer's
 * quota counters via an UPSERT with period-aware resets.
 */
export async function recordUsage(
  developerId: string,
  apiKeyId: string | null,
  endpoint: string,
  method: string,
  statusCode: number,
  latencyMs: number,
  ip: string | null,
): Promise<void> {
  try {
    // Insert usage record via raw SQL to avoid Prisma relation constraint issues
    // when apiKeyId is null (the generated type requires a connect object).
    await prismaWrite.$executeRaw(
      Prisma.sql`
        INSERT INTO "_usage_records"
          (id, developer_id, api_key_id, endpoint, method, status_code, latency_ms, ip_address, created_at)
        VALUES
          (gen_random_uuid()::text, ${developerId}, ${apiKeyId}, ${endpoint}, ${method},
           ${statusCode}, ${latencyMs}, ${ip}, NOW())
      `,
    );

    // Upsert quota row with atomic counter increment.
    // When a reset period has passed, reset the counter to 1 (this request).
    const now = new Date();
    await prismaWrite.$executeRaw(
      Prisma.sql`
        INSERT INTO "_usage_quotas" (
          id, developer_id,
          daily_requests_used,  monthly_requests_used,
          daily_reset_at,       monthly_reset_at,
          is_quota_exceeded,    last_quota_check_at,
          updated_at
        ) VALUES (
          gen_random_uuid()::text,
          ${developerId},
          1, 1,
          DATE_TRUNC('day', ${now}::timestamptz),
          DATE_TRUNC('month', ${now}::timestamptz),
          false,
          ${now}::timestamptz,
          ${now}::timestamptz
        )
        ON CONFLICT (developer_id) DO UPDATE SET
          daily_requests_used = CASE
            WHEN "_usage_quotas".daily_reset_at < DATE_TRUNC('day', ${now}::timestamptz)
            THEN 1
            ELSE "_usage_quotas".daily_requests_used + 1
          END,
          monthly_requests_used = CASE
            WHEN "_usage_quotas".monthly_reset_at < DATE_TRUNC('month', ${now}::timestamptz)
            THEN 1
            ELSE "_usage_quotas".monthly_requests_used + 1
          END,
          daily_reset_at = CASE
            WHEN "_usage_quotas".daily_reset_at < DATE_TRUNC('day', ${now}::timestamptz)
            THEN DATE_TRUNC('day', ${now}::timestamptz)
            ELSE "_usage_quotas".daily_reset_at
          END,
          monthly_reset_at = CASE
            WHEN "_usage_quotas".monthly_reset_at < DATE_TRUNC('month', ${now}::timestamptz)
            THEN DATE_TRUNC('month', ${now}::timestamptz)
            ELSE "_usage_quotas".monthly_reset_at
          END,
          last_quota_check_at = ${now}::timestamptz,
          updated_at          = ${now}::timestamptz
      `,
    );
  } catch (err) {
    // Non-fatal: log and continue so the actual API request is not blocked.
    logger.error('[billing-metering] recordUsage error', {
      developerId,
      endpoint,
      err: String(err),
    });
  }
}

// ─── getUsageSummary ─────────────────────────────────────────────────────────

/**
 * Returns a complete usage summary for a developer including quota percentages
 * and an estimated monthly cost.
 */
export async function getUsageSummary(developerId: string): Promise<UsageSummary> {
  const devRows = await prismaRead.$queryRaw<DeveloperPlanRow[]>(
    Prisma.sql`
      SELECT d.id AS developer_id, d.plan_id,
             p.name AS plan_name,
             p.requests_per_day, p.requests_per_month, p.price_monthly,
             p.max_concurrent_keys, p.history_cutoff_days,
             p.max_webhooks, p.overage_rate_per_1k, p.features,
             d.stripe_customer_id, d.stripe_subscription_id,
             d.subscription_status, d.current_period_start, d.current_period_end
      FROM "_developers" d
      LEFT JOIN "_billing_plans" p ON p.id = d.plan_id
      WHERE d.id = ${developerId}
      LIMIT 1
    `,
  );

  if (devRows.length === 0) {
    throw Object.assign(new Error('Developer not found'), { statusCode: 404 });
  }

  const dev = devRows[0];
  const dailyQuota = dev.requests_per_day ?? FREE_TIER_ENTITLEMENTS.maxRequestsPerDay;
  const monthlyQuota = dev.requests_per_month ?? FREE_TIER_ENTITLEMENTS.maxRequestsPerMonth;
  const priceMonthly = dev.price_monthly ?? 0;
  const overageRate = Number(dev.overage_rate_per_1k ?? FREE_TIER_ENTITLEMENTS.overageRatePer1k);

  const quotaRows = await prismaRead.$queryRaw<QuotaRow[]>(
    Prisma.sql`
      SELECT daily_requests_used, monthly_requests_used,
             is_quota_exceeded, daily_reset_at, monthly_reset_at,
             last_quota_check_at
      FROM "_usage_quotas"
      WHERE developer_id = ${developerId}
      LIMIT 1
    `,
  );

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let requestsToday = 0;
  let requestsThisMonth = 0;

  if (quotaRows.length > 0) {
    const q = quotaRows[0];
    requestsToday = new Date(q.daily_reset_at) < dayStart ? 0 : q.daily_requests_used;
    requestsThisMonth = new Date(q.monthly_reset_at) < monthStart ? 0 : q.monthly_requests_used;
  }

  const dailyUsagePct = dailyQuota > 0 ? Math.round((requestsToday / dailyQuota) * 100) : 0;
  const monthlyUsagePct =
    monthlyQuota > 0 ? Math.round((requestsThisMonth / monthlyQuota) * 100) : 0;

  const overageRequests = Math.max(0, requestsThisMonth - monthlyQuota);
  const overageCharge = (overageRequests / 1000) * overageRate;
  const estimatedMonthlyCost = priceMonthly + overageCharge;

  return {
    developerId,
    planName: dev.plan_name ?? 'free',
    requestsToday,
    requestsThisMonth,
    dailyQuota,
    monthlyQuota,
    dailyUsagePct,
    monthlyUsagePct,
    isOverDaily: requestsToday >= dailyQuota,
    isOverMonthly: requestsThisMonth >= monthlyQuota,
    estimatedMonthlyCost,
    currentPeriodStart: dev.current_period_start ? new Date(dev.current_period_start) : null,
    currentPeriodEnd: dev.current_period_end ? new Date(dev.current_period_end) : null,
  };
}

// ─── enforceEntitlements ─────────────────────────────────────────────────────

/**
 * Checks whether a developer's current plan grants access to a named feature.
 *
 * Supported feature keys:
 *  - 'webhooks'          — maxWebhooks > 0
 *  - 'analytics'         — hasAnalytics
 *  - 'priority_support'  — hasPrioritySupport
 *  - 'extended_history'  — historyCutoffDays > 7
 */
export async function enforceEntitlements(
  developerId: string,
  feature: string,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const devRows = await prismaRead.$queryRaw<Array<{ plan_id: string | null }>>(
      Prisma.sql`
        SELECT plan_id FROM "_developers" WHERE id = ${developerId} LIMIT 1
      `,
    );

    if (devRows.length === 0) {
      return { allowed: false, reason: 'Developer not found' };
    }

    const entitlements = await getPlanEntitlements(devRows[0].plan_id);

    switch (feature) {
      case 'webhooks':
        if (entitlements.maxWebhooks === 0) {
          return { allowed: false, reason: 'Webhooks are not available on your current plan' };
        }
        return { allowed: true };

      case 'analytics':
        if (!entitlements.hasAnalytics) {
          return {
            allowed: false,
            reason: 'Analytics access requires a Pro or Enterprise plan',
          };
        }
        return { allowed: true };

      case 'priority_support':
        if (!entitlements.hasPrioritySupport) {
          return {
            allowed: false,
            reason: 'Priority support requires a Pro or Enterprise plan',
          };
        }
        return { allowed: true };

      case 'extended_history':
        if (entitlements.historyCutoffDays <= 7) {
          return {
            allowed: false,
            reason: `Extended history requires a paid plan (current cutoff: ${entitlements.historyCutoffDays} days)`,
          };
        }
        return { allowed: true };

      default:
        logger.warn('[billing-metering] Unknown feature key', { feature, developerId });
        return { allowed: false, reason: `Unknown feature: ${feature}` };
    }
  } catch (err) {
    logger.error('[billing-metering] enforceEntitlements error', {
      developerId,
      feature,
      err: String(err),
    });
    // Fail closed for entitlement checks
    return { allowed: false, reason: 'Unable to verify entitlements' };
  }
}

// ─── createBillingEvent ───────────────────────────────────────────────────────

/**
 * Persists a billing lifecycle event (plan change, payment, trial start, etc.)
 * to the _billing_events table via raw SQL.
 */
export async function createBillingEvent(params: {
  developerId: string;
  eventType: string;
  fromPlanId?: string;
  toPlanId?: string;
  amountCents?: number;
  stripeEventId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const {
    developerId,
    eventType,
    fromPlanId = null,
    toPlanId = null,
    amountCents = null,
    stripeEventId = null,
    metadata = {},
  } = params;

  try {
    const metadataJson = JSON.stringify(metadata);
    await prismaWrite.$executeRaw(
      Prisma.sql`
        INSERT INTO "_billing_events" (
          id, developer_id, event_type, from_plan_id, to_plan_id,
          amount_cents, currency, stripe_event_id, metadata, created_at
        ) VALUES (
          gen_random_uuid()::text,
          ${developerId},
          ${eventType},
          ${fromPlanId},
          ${toPlanId},
          ${amountCents},
          'USD',
          ${stripeEventId},
          ${metadataJson}::jsonb,
          NOW()
        )
      `,
    );

    logger.info('[billing-metering] Billing event recorded', {
      developerId,
      eventType,
      fromPlanId: fromPlanId ?? undefined,
      toPlanId: toPlanId ?? undefined,
    });
  } catch (err) {
    logger.error('[billing-metering] createBillingEvent error', {
      params,
      err: String(err),
    });
    throw err;
  }
}

// ─── getBillingHistory ────────────────────────────────────────────────────────

/**
 * Returns paginated billing events for a developer, most recent first.
 */
export async function getBillingHistory(
  developerId: string,
  limit: number,
): Promise<BillingEventRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);

  const rows = await prismaRead.$queryRaw<BillingEventDbRow[]>(
    Prisma.sql`
      SELECT id, developer_id, event_type, from_plan_id, to_plan_id,
             amount_cents, currency, stripe_event_id, metadata, created_at
      FROM "_billing_events"
      WHERE developer_id = ${developerId}
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    developerId: r.developer_id,
    eventType: r.event_type,
    fromPlanId: r.from_plan_id,
    toPlanId: r.to_plan_id,
    amountCents: r.amount_cents,
    currency: r.currency,
    stripeEventId: r.stripe_event_id,
    metadata:
      typeof r.metadata === 'object' && r.metadata !== null
        ? (r.metadata as Record<string, unknown>)
        : {},
    createdAt: new Date(r.created_at),
  }));
}

// ─── resetDailyQuotas ────────────────────────────────────────────────────────

/**
 * Resets daily quota counters for all developers whose daily_reset_at is
 * before the start of today.  Intended to be called by a cron job at midnight.
 *
 * @returns The number of quota rows reset.
 */
export async function resetDailyQuotas(): Promise<number> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  try {
    const result = await prismaWrite.$executeRaw(
      Prisma.sql`
        UPDATE "_usage_quotas"
        SET daily_requests_used = 0,
            daily_reset_at      = ${dayStart}::timestamptz,
            updated_at          = NOW()
        WHERE daily_reset_at < ${dayStart}::timestamptz
      `,
    );

    logger.info('[billing-metering] Daily quotas reset', { count: result });
    return result;
  } catch (err) {
    logger.error('[billing-metering] resetDailyQuotas error', { err: String(err) });
    throw err;
  }
}
