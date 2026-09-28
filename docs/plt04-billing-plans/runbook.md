# PLT04 — Billing Plans & Usage-Based Metering: Operations Runbook

## Prerequisites

- `psql` access to the PostgreSQL instance (`DATABASE_URL`)
- `redis-cli` access for cache/rate-limit checks
- Stripe Dashboard access (for subscription and invoice lookups)
- `STRIPE_SECRET_KEY` available in your shell for CLI operations

---

## 1. Manually Change a Developer's Plan

**When**: customer support escalation, trial extension, migration from legacy system.

```sql
-- 1. Find the developer record
SELECT id, email, plan_id FROM "_developers" WHERE email = 'user@example.com';

-- 2. Find the target plan id
SELECT id, name, price_monthly FROM "_billing_plans" WHERE name = 'pro';

-- 3. Apply the change
UPDATE "_developers"
SET plan_id = '<plan_id_from_step_2>',
    updated_at = NOW()
WHERE id = '<developer_id_from_step_1>';

-- 4. Record a billing event for audit trail
INSERT INTO "_billing_events"
  (id, developer_id, event_type, from_plan_id, to_plan_id, metadata, created_at)
VALUES
  (gen_random_uuid()::text, '<developer_id>', 'plan_changed',
   '<old_plan_id>', '<new_plan_id>',
   '{"source": "manual_ops", "operator": "your@email.com"}'::jsonb,
   NOW());
```

**After**: verify with `GET /developer/plan/current?developerId=<id>`.

---

## 2. Check Quota Status for a Developer

```sql
-- Current quota counters
SELECT
  d.email,
  p.name AS plan,
  p.requests_per_day,
  p.requests_per_month,
  q.daily_requests_used,
  q.monthly_requests_used,
  q.daily_reset_at,
  q.monthly_reset_at,
  q.is_quota_exceeded,
  q.last_quota_check_at
FROM "_developers" d
JOIN "_billing_plans" p ON p.id = d.plan_id
LEFT JOIN "_usage_quotas" q ON q.developer_id = d.id
WHERE d.email = 'user@example.com';
```

Via API:
```bash
curl "http://localhost:3000/developer/billing/quota?developerId=<id>"
```

---

## 3. Reset a Stuck Quota

Quotas reset automatically via the nightly cron (daily) or on the first request of each month (monthly).  If a quota is stuck incorrectly at exceeded:

```sql
-- Reset both counters for a specific developer
UPDATE "_usage_quotas"
SET daily_requests_used   = 0,
    monthly_requests_used = 0,
    daily_reset_at        = DATE_TRUNC('day', NOW()),
    monthly_reset_at      = DATE_TRUNC('month', NOW()),
    is_quota_exceeded     = false,
    updated_at            = NOW()
WHERE developer_id = '<developer_id>';
```

To bulk-reset all daily counters (same as the `resetDailyQuotas()` cron):
```sql
UPDATE "_usage_quotas"
SET daily_requests_used = 0,
    daily_reset_at      = DATE_TRUNC('day', NOW()),
    updated_at          = NOW()
WHERE daily_reset_at < DATE_TRUNC('day', NOW());
```

---

## 4. Replay a Failed Billing Event

Billing events are append-only and idempotent via `stripe_event_id`.  To replay a specific Stripe event:

```bash
# Retrieve the event from Stripe
stripe events retrieve evt_1ABC... --api-key $STRIPE_SECRET_KEY

# Re-send the webhook to the local handler
stripe trigger checkout.session.completed \
  --api-key $STRIPE_SECRET_KEY \
  -- metadata[developerId]=<id> metadata[tier]=pro
```

To manually insert a corrective billing event:
```sql
INSERT INTO "_billing_events"
  (id, developer_id, event_type, from_plan_id, to_plan_id,
   amount_cents, stripe_event_id, metadata, created_at)
VALUES
  (gen_random_uuid()::text, '<developer_id>', 'payment_succeeded',
   NULL, '<plan_id>', 5000, 'evt_replayed_<timestamp>',
   '{"note": "Manual replay after webhook delivery failure"}'::jsonb,
   NOW());
```

---

## 5. Rollback Procedure

### Roll back the PLT04 migration

```bash
# 1. Drop new columns from _billing_plans
psql $DATABASE_URL -c "
  ALTER TABLE \"_billing_plans\"
    DROP COLUMN IF EXISTS stripe_price_id,
    DROP COLUMN IF EXISTS stripe_product_id,
    DROP COLUMN IF EXISTS max_concurrent_keys,
    DROP COLUMN IF EXISTS history_cutoff_days,
    DROP COLUMN IF EXISTS max_webhooks,
    DROP COLUMN IF EXISTS overage_rate_per_1k,
    DROP COLUMN IF EXISTS trial_days,
    DROP COLUMN IF EXISTS is_active,
    DROP COLUMN IF EXISTS sort_order;
"

# 2. Drop new columns from _developers
psql $DATABASE_URL -c "
  ALTER TABLE \"_developers\"
    DROP COLUMN IF EXISTS stripe_customer_id,
    DROP COLUMN IF EXISTS stripe_subscription_id,
    DROP COLUMN IF EXISTS subscription_status,
    DROP COLUMN IF EXISTS trial_ends_at,
    DROP COLUMN IF EXISTS current_period_start,
    DROP COLUMN IF EXISTS current_period_end,
    DROP COLUMN IF EXISTS usage_alert_threshold;
"

# 3. Drop new tables
psql $DATABASE_URL -c "DROP TABLE IF EXISTS \"_billing_events\";"
psql $DATABASE_URL -c "DROP TABLE IF EXISTS \"_usage_quotas\";"
```

> **Warning**: Dropping `_billing_events` destroys the audit trail.  Back it up first:
> ```bash
> pg_dump $DATABASE_URL -t '"_billing_events"' > billing_events_backup.sql
> ```

### Roll back the migration record in Prisma

```bash
# Remove the migration entry so Prisma doesn't think it was applied
psql $DATABASE_URL -c "
  DELETE FROM \"_prisma_migrations\"
  WHERE migration_name = '20260928000002_plt04_billing_metering';
"
```

---

## 6. Monitoring — Alerts to Watch

### Quota exceeded rate
```sql
SELECT COUNT(DISTINCT developer_id) AS devs_hit_quota
FROM "_billing_events"
WHERE event_type = 'payment_failed'
  AND created_at > NOW() - INTERVAL '24 hours';
```

Alert threshold: > 5% of active developers hitting quota in 24h → investigate plan limit settings.

### Payment failures
```sql
SELECT developer_id, COUNT(*) AS failures, MAX(created_at) AS last_failure
FROM "_billing_events"
WHERE event_type = 'payment_failed'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY developer_id
ORDER BY failures DESC
LIMIT 20;
```

Alert threshold: any developer with 3+ failures in 7 days → send dunning email.

### Subscription cancellations
```sql
SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS cancellations
FROM "_billing_events"
WHERE event_type = 'subscription_canceled'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1;
```

### Quota table staleness (daily cron health)
```sql
SELECT COUNT(*) AS stale_quotas
FROM "_usage_quotas"
WHERE daily_reset_at < DATE_TRUNC('day', NOW());
```

Alert threshold: > 0 stale quotas after 00:05 UTC → the cron job may have failed.

### Stripe webhook delivery failures

In Stripe Dashboard → Developers → Webhooks → select the endpoint → check the "Attempts" tab.  Set up a Stripe webhook alert for failure rates > 1% over 1 hour.

### Prometheus metrics (future)

Expose the following counters from the metering service:
- `billing_quota_exceeded_total{developerId}` — incremented by `checkQuota`.
- `billing_event_created_total{eventType}` — incremented by `createBillingEvent`.
- `billing_usage_recorded_total` — incremented by `recordUsage`.
