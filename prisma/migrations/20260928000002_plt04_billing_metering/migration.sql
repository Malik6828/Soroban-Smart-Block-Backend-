-- PLT04: Billing plans & usage-based metering
-- Adds Stripe integration fields, quota tracking, billing event log, and usage quota table.

-- ─── Extend _billing_plans ────────────────────────────────────────────────────
ALTER TABLE "_billing_plans"
  ADD COLUMN IF NOT EXISTS "stripe_price_id"       TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "stripe_product_id"     TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "max_concurrent_keys"   INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "history_cutoff_days"   INT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "max_webhooks"          INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "overage_rate_per_1k"   DECIMAL(10,6) NOT NULL DEFAULT 0.1,
  ADD COLUMN IF NOT EXISTS "trial_days"            INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "is_active"             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sort_order"            INT NOT NULL DEFAULT 0;

-- ─── Extend _developers ───────────────────────────────────────────────────────
ALTER TABLE "_developers"
  ADD COLUMN IF NOT EXISTS "stripe_customer_id"      TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id"  TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "subscription_status"     VARCHAR(32) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "trial_ends_at"           TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "current_period_start"    TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "current_period_end"      TIMESTAMP DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "usage_alert_threshold"   INT DEFAULT 80;

-- ─── Create _billing_events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "_billing_events" (
  id              TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  developer_id    TEXT NOT NULL,
  event_type      VARCHAR(64) NOT NULL,
  from_plan_id    TEXT DEFAULT NULL,
  to_plan_id      TEXT DEFAULT NULL,
  amount_cents    INT DEFAULT NULL,
  currency        VARCHAR(8) DEFAULT 'USD',
  stripe_event_id TEXT DEFAULT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_developer ON "_billing_events"(developer_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_type      ON "_billing_events"(event_type);
CREATE INDEX IF NOT EXISTS idx_billing_events_created   ON "_billing_events"(created_at DESC);

-- ─── Create _usage_quotas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "_usage_quotas" (
  id                    TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  developer_id          TEXT NOT NULL UNIQUE,
  daily_requests_used   INT NOT NULL DEFAULT 0,
  monthly_requests_used INT NOT NULL DEFAULT 0,
  daily_reset_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  monthly_reset_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_quota_exceeded     BOOLEAN NOT NULL DEFAULT false,
  last_quota_check_at   TIMESTAMPTZ DEFAULT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_quotas_developer ON "_usage_quotas"(developer_id);

-- ─── Seed plan-level entitlements ────────────────────────────────────────────
UPDATE "_billing_plans"
SET max_concurrent_keys = 3,
    history_cutoff_days = 7,
    max_webhooks        = 1,
    overage_rate_per_1k = 0.2,
    sort_order          = 0,
    is_active           = true
WHERE name = 'free';

UPDATE "_billing_plans"
SET max_concurrent_keys = 10,
    history_cutoff_days = 30,
    max_webhooks        = 5,
    overage_rate_per_1k = 0.1,
    sort_order          = 1,
    is_active           = true
WHERE name = 'developer';

UPDATE "_billing_plans"
SET max_concurrent_keys = 50,
    history_cutoff_days = 90,
    max_webhooks        = 20,
    overage_rate_per_1k = 0.05,
    sort_order          = 2,
    is_active           = true
WHERE name = 'pro';

UPDATE "_billing_plans"
SET max_concurrent_keys = 999,
    history_cutoff_days = 365,
    max_webhooks        = 100,
    overage_rate_per_1k = 0,
    sort_order          = 3,
    is_active           = true
WHERE name = 'enterprise';
