# PLT04 — Billing Plans & Usage-Based Metering: Design Document

## Overview

PLT04 adds a production-grade billing and usage metering layer to the Soroban Smart Block Explorer backend.  It replaces the placeholder billing endpoints in `src/api/developer/billing.ts` with a Stripe-integrated subscription model, an atomic quota-tracking system, and a persistent billing event log.

---

## Architecture

```
API Request
    │
    ▼
┌──────────────────────────────┐
│  apiKeyAuth middleware        │  populates req.apiKey.developerId
└──────────────┬───────────────┘
               │
    ▼
┌──────────────────────────────┐
│  quotaEnforcementMiddleware   │  calls billing-metering.checkQuota()
│  (src/middleware/quota...)    │  → 429 if exceeded, else next()
└──────────────┬───────────────┘
               │
    ▼
┌──────────────────────────────┐
│  Route Handler                │
└──────────────┬───────────────┘
               │
    ▼
┌──────────────────────────────┐
│  billing-metering.ts service  │  pure TypeScript, no framework deps
│  ─────────────────────────── │
│  getPlanEntitlements()        │  reads _billing_plans via raw SQL
│  checkQuota()                 │  reads _usage_quotas via raw SQL
│  recordUsage()                │  writes _usage_records + _usage_quotas
│  getUsageSummary()            │  aggregates plan + quota + cost
│  enforceEntitlements()        │  feature-gate checks
│  createBillingEvent()         │  appends to _billing_events
│  getBillingHistory()          │  paginates _billing_events
│  resetDailyQuotas()           │  cron-reset (midnight)
└──────────────┬───────────────┘
               │
    ▼
┌──────────────────────────────┐
│  PostgreSQL                   │
│  _billing_plans (extended)    │
│  _developers (extended)       │
│  _billing_events (new)        │
│  _usage_quotas (new)          │
└──────────────────────────────┘
               │
    ▼
┌──────────────────────────────┐
│  Stripe                       │
│  Checkout Sessions            │
│  Subscription Webhooks        │
└──────────────────────────────┘
```

---

## Plan Catalog

| Plan       | Req/Day   | Req/Month  | Price/mo | Keys | History | Webhooks | Overage/1k |
|------------|-----------|------------|----------|------|---------|----------|------------|
| free       | 100       | 3,000      | $0       | 3    | 7 days  | 1        | $0.20      |
| developer  | 10,000    | 300,000    | $10      | 10   | 30 days | 5        | $0.10      |
| pro        | 100,000   | 3,000,000  | $50      | 50   | 90 days | 20       | $0.05      |
| enterprise | 9,999,999 | 99,999,999 | Custom   | 999  | 365 days| 100      | $0.00      |

### Plan Entitlement Resolution

`getPlanEntitlements(planId)` fetches the plan row from `_billing_plans` via raw SQL (since the Prisma client generated before PLT04 migration doesn't expose the new columns as typed fields).  When `planId` is null or the plan record is missing, the function returns safe free-tier defaults without throwing.

---

## Quota Enforcement

### At the API Layer

`quotaEnforcementMiddleware` runs after API key authentication on every keyed request:

1. Reads `req.apiKey.developerId` (set by upstream auth middleware).
2. Calls `checkQuota(developerId)`.
3. Returns `429 Quota exceeded` with an `upgradeUrl` if the developer is over their monthly or daily limit.
4. On any quota-service error, logs a warning and **passes through** (fail-open).  This prevents a billing service outage from becoming a full API outage.

### At the Data Layer

`_usage_quotas` stores per-developer counters:

- `daily_requests_used` — reset to 0 at midnight (by `resetDailyQuotas()` cron).
- `monthly_requests_used` — reset to 0 at month-start via UPSERT reset logic.

The `recordUsage()` function performs a single `INSERT ... ON CONFLICT DO UPDATE` that:

- Increments `daily_requests_used` unless `daily_reset_at` is before today (in which case it resets to 1).
- Increments `monthly_requests_used` unless `monthly_reset_at` is before this month's start.

This is fully atomic — no separate SELECT + UPDATE race condition.

---

## Overage Calculation

Monthly cost = `plan.priceMonthly + max(0, monthlyUsed - monthlyQuota) / 1000 * overage_rate_per_1k`

The `overage_rate_per_1k` field is stored as `DECIMAL(10,6)` to avoid floating-point rounding errors in the database.  The application converts it to `Number` for display purposes only.  Actual billing uses Stripe Metered Billing (future work; current release does a server-side estimate only).

---

## Billing Events

Every plan change, payment, trial start/end, and overage charge is recorded in `_billing_events` with:

- `event_type` — machine-readable label (e.g. `plan_changed`, `payment_succeeded`).
- `from_plan_id` / `to_plan_id` — foreign keys into `_billing_plans` for change tracking.
- `stripe_event_id` — Stripe event idempotency key, used to deduplicate webhook retries.
- `metadata` — JSONB blob for event-specific context.

The table is append-only.  Events are never updated or deleted.

---

## Stripe Integration

### Checkout Flow

1. Client calls `POST /developer/billing/plan/upgrade` with `{ developerId, targetPlan, successUrl, cancelUrl }`.
2. Server creates a billing event of type `upgrade_initiated`.
3. Server calls `createCheckoutSession()` from `stripe-billing.ts`.
4. Client is redirected to the Stripe-hosted checkout page.
5. On completion, Stripe calls `POST /developer/billing/webhook/stripe`.
6. Webhook handler updates the developer's `planId` and appends a `plan_changed` event.

### Webhook Events Handled

| Stripe Event                         | Action                                             |
|--------------------------------------|----------------------------------------------------|
| `checkout.session.completed`         | Promote plan, record `payment_succeeded` + `plan_changed` |
| `customer.subscription.deleted`      | Demote to free, record `subscription_canceled`     |
| `customer.subscription.paused`       | Same as deleted                                    |
| `customer.subscription.updated`      | Update `subscription_status` on developer row      |
| `invoice.payment_succeeded`          | Record `payment_succeeded` with amount             |
| `invoice.payment_failed`             | Record `payment_failed` with amount                |

All webhook processing is idempotent via `stripe_event_id`.  Unhandled event types are logged at DEBUG level and acknowledged with `{ received: true }`.

---

## Trade-offs

### Stripe vs. Crypto Payments

The existing `billing.ts` has a stub for XLM/USDC payments.  PLT04 opts for Stripe because:

- Stripe provides hosted checkout, invoice management, and chargeback handling out of the box.
- Crypto payment settlement requires on-chain monitoring and introduces irreversibility risk.
- Most developer-tool buyers expect card payments.

Crypto payments remain available via the existing `/developer/billing/pay` stub and can be wired to an on-chain verifier in a follow-up issue.

### Server-side vs. Client-side Quota

Quota enforcement is server-side only.  Client-side rate limiting (e.g. SDK-level throttle) would improve UX but cannot be trusted for billing.  The middleware design ensures that quota state is the authoritative source.

### Raw SQL vs. Prisma Client

New tables (`_billing_events`, `_usage_quotas`) and new columns (`max_concurrent_keys`, etc.) are accessed via `$queryRaw` / `$executeRaw` with `Prisma.sql` tagged templates.  This avoids requiring a new `prisma generate` run in CI before the service files compile.  Once the migration is applied and the client is regenerated, the raw SQL can be replaced with typed Prisma client calls.

---

## Rejected Alternatives

1. **Separate metering microservice** — adds network overhead and operational complexity without benefit at current scale.  Embedding in the API process is correct until throughput demands a dedicated service.

2. **Redis-only quota counters** — faster but lossy.  A Redis restart would reset counters mid-period.  PostgreSQL atomicity is worth the ~1 ms overhead per request.

3. **Usage-based Stripe Metered Billing** — ideal long-term but requires Stripe Meter API and adds complexity.  Current release uses server-side cost estimates with Stripe Subscription billing for the plan base price.

4. **Per-endpoint quota** — too granular for the current product.  Per-developer daily/monthly limits cover all endpoints uniformly.
