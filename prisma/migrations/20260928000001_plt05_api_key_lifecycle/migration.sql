-- PLT05: API key lifecycle management portal
-- Adds scope, environment, tags, rotation policy, and audit actor fields.
-- Creates the _key_scope_presets lookup table and seeds built-in presets.

-- ── DevApiKey lifecycle columns ─────────────────────────────────────────────
ALTER TABLE "_dev_api_keies"
  ADD COLUMN IF NOT EXISTS "scope"                VARCHAR(1024) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "last_seen_ip"         VARCHAR(64)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "description"          TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "environment"          VARCHAR(32)   NOT NULL DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS "tags"                 JSONB         NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "rotation_policy_days" INT           DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "last_rotated_at"      TIMESTAMP     DEFAULT NULL;

-- ── KeyRotationAudit actor columns ──────────────────────────────────────────
ALTER TABLE "_key_rotation_audits"
  ADD COLUMN IF NOT EXISTS "actor_type" VARCHAR(32)  NOT NULL DEFAULT 'developer',
  ADD COLUMN IF NOT EXISTS "actor_id"   VARCHAR(128) DEFAULT NULL;

-- ── Scope presets lookup table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "_key_scope_presets" (
  "id"          TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"        TEXT        NOT NULL UNIQUE,
  "description" TEXT        NOT NULL,
  "scopes"      TEXT[]      NOT NULL DEFAULT '{}',
  "is_builtin"  BOOLEAN     NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Built-in scope presets ───────────────────────────────────────────────────
INSERT INTO "_key_scope_presets" ("name", "description", "scopes", "is_builtin") VALUES
  ('read_only',
   'Read-only access to all public endpoints',
   ARRAY['transactions:read','events:read','contracts:read','tokens:read','wallets:read'],
   true),
  ('standard',
   'Standard developer access',
   ARRAY['transactions:read','events:read','contracts:read','tokens:read','wallets:read','search:read','analytics:read'],
   true),
  ('full_access',
   'Full API access',
   ARRAY['*'],
   true)
ON CONFLICT ("name") DO NOTHING;
