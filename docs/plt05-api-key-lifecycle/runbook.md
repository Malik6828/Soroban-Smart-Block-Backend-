# PLT05 — API Key Lifecycle Management Portal: Operations Runbook

## Running / Debugging the Feature

### Local development

```bash
# Start the API and dependencies
docker compose up postgres redis

# In a second terminal, start the API
npm run dev
```

The lifecycle endpoints are available at:
```
http://localhost:3000/api/v1/developer/keys/scopes
http://localhost:3000/api/v1/developer/keys/scope-presets
http://localhost:3000/api/v1/developer/keys/stats?developerId=<id>
```

### Applying the migration

The migration SQL is in `prisma/migrations/20260928000001_plt05_api_key_lifecycle/migration.sql`.

```bash
# Apply to a local database
npx prisma migrate deploy

# Verify columns were added
psql $DATABASE_URL -c "\d _dev_api_keies" | grep -E 'scope|environment|tags|rotation_policy'
psql $DATABASE_URL -c "\d _key_rotation_audits" | grep actor
psql $DATABASE_URL -c "SELECT name, is_builtin FROM _key_scope_presets;"
```

### Background rotation checker

The checker is started by calling `scheduleKeyRotationCheck()` from `src/services/api-key-lifecycle.ts`. To enable it at startup, import and call it in your application entry point (`src/index.ts` or the indexer):

```typescript
import { scheduleKeyRotationCheck } from './services/api-key-lifecycle';
scheduleKeyRotationCheck(); // runs every hour
```

Warnings appear in the structured log as:
```json
{
  "level": "warn",
  "message": "[api-key-lifecycle] Key past rotation policy",
  "keyId": "...",
  "developerId": "...",
  "rotationPolicyDays": 90,
  "ageDays": 95
}
```

---

## Checking Key Rotation Audit Logs

### Via API

```bash
# All audit events for developer dev_1
curl "http://localhost:3000/api/v1/developer/keys/stats?developerId=dev_1"

# Per-key audit trail
curl "http://localhost:3000/api/v1/developer/keys/<keyId>/audit?developerId=dev_1&limit=20&offset=0"
```

### Via database

```sql
-- All rotation events for a developer, most recent first
SELECT
  id, old_key_id, new_key_id, reason,
  COALESCE(actor_type, 'developer') AS actor_type,
  actor_id, was_successful, rotated_at
FROM "_key_rotation_audits"
WHERE developer_id = 'dev_1'
ORDER BY rotated_at DESC
LIMIT 50;

-- Failed rotation attempts
SELECT *
FROM "_key_rotation_audits"
WHERE was_successful = false
ORDER BY rotated_at DESC;

-- Automated rotations in the past 7 days
SELECT *
FROM "_key_rotation_audits"
WHERE actor_type = 'automated'
  AND rotated_at > NOW() - INTERVAL '7 days';
```

---

## Bulk-Revoking Compromised Keys

Use this procedure when a security incident requires immediate mass revocation.

### Via API

```bash
curl -X POST http://localhost:3000/api/v1/developer/keys/bulk-revoke \
  -H "Content-Type: application/json" \
  -d '{
    "developerId": "dev_1",
    "keyIds": ["key_abc", "key_def", "key_ghi"],
    "reason": "Credential exposure incident 2026-09-28"
  }'
```

The response confirms which keys were revoked and which were skipped (e.g. already revoked):

```json
{
  "revokedCount": 3,
  "revokedIds": ["key_abc", "key_def", "key_ghi"]
}
```

### Via database (emergency — all keys for a developer)

Only use this if the API is unreachable:

```sql
BEGIN;
UPDATE "_dev_api_keies"
SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
WHERE developer_id = 'dev_1'
  AND status = 'active';
COMMIT;
```

After a database-level revocation, the in-process key cache still holds the old resolved contexts for up to `KEY_CACHE_TTL_MS` milliseconds (default 10 s). To force immediate invalidation, restart the API pod or set `KEY_CACHE_TTL_MS=0` temporarily.

---

## Rollback Procedure

The migration only adds columns and a new table; it does not modify or remove any existing columns, constraints, or data. Rollback is safe.

```sql
-- Remove lifecycle columns from DevApiKey
ALTER TABLE "_dev_api_keies"
  DROP COLUMN IF EXISTS scope,
  DROP COLUMN IF EXISTS last_seen_ip,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS environment,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS rotation_policy_days,
  DROP COLUMN IF EXISTS last_rotated_at;

-- Remove actor columns from KeyRotationAudit
ALTER TABLE "_key_rotation_audits"
  DROP COLUMN IF EXISTS actor_type,
  DROP COLUMN IF EXISTS actor_id;

-- Drop scope presets table
DROP TABLE IF EXISTS "_key_scope_presets";
```

After rolling back the SQL, remove the migration entry from `_prisma_migrations`:

```sql
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260928000001_plt05_api_key_lifecycle';
```

Then revert the code changes:
- Remove `keysLifecycleRouter` import and mount from `src/api/developer/router.ts`
- Remove `src/api/developer/keys-lifecycle.ts`
- Remove `src/services/api-key-lifecycle.ts`
- Remove the `KeyScopePreset` model from `prisma/schema.prisma`

---

## Monitoring

### Prometheus metrics

| Metric                                  | Type    | Labels          | Meaning                                      |
|-----------------------------------------|---------|-----------------|----------------------------------------------|
| `api_key_lifecycle_checks_total`        | Counter | `outcome`       | Rotation-policy checker runs (none_due / warnings_emitted / error) |
| `api_key_bulk_revokes_total`            | Counter | —               | Individual keys revoked via bulk-revoke      |
| `api_key_scope_validation_total`        | Counter | `result`        | Scope validation calls (valid / invalid)     |

Query examples (PromQL):

```promql
# Rate of scope validation failures
rate(api_key_scope_validation_total{result="invalid"}[5m])

# Keys revoked per hour
increase(api_key_bulk_revokes_total[1h])

# Rotation checker errors
increase(api_key_lifecycle_checks_total{outcome="error"}[1h])
```

### Log queries (structured JSON)

```bash
# Keys currently overdue for rotation
grep '"Key past rotation policy"' /var/log/app.log | jq '{keyId: .keyId, ageDays: .ageDays}'

# Bulk revocations in the last 24 hours
grep '"Bulk key revocation"' /var/log/app.log | jq '{developerId: .developerId, count: .count, reason: .reason}'
```

### Alerts to configure

- **Warning**: `api_key_lifecycle_checks_total{outcome="error"} > 0` for 5 minutes → rotation checker is failing.
- **Info**: `api_key_lifecycle_checks_total{outcome="warnings_emitted"} > 10` → more than 10 keys are overdue.
- **Critical**: `api_key_bulk_revokes_total > 50` spike → large-scale revocation in progress; confirm this was intentional.
