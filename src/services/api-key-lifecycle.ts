/**
 * API Key Lifecycle Service (PLT05)
 *
 * Provides scope validation, lifecycle statistics, audit history retrieval,
 * preset management, and a background rotation-policy checker.
 * All DB reads go through prismaRead; writes through prismaWrite.
 */

import { prismaRead } from '../db';
import { logger } from '../logger';
import { Counter } from 'prom-client';
import { registry } from '../metrics';

// ── Prometheus counters ───────────────────────────────────────────────────────

export const keyLifecycleChecksTotal = new Counter({
  name: 'api_key_lifecycle_checks_total',
  help: 'Total number of API key rotation-policy checks performed',
  labelNames: ['outcome'],
  registers: [registry],
});

export const keyBulkRevokesTotal = new Counter({
  name: 'api_key_bulk_revokes_total',
  help: 'Total number of keys revoked through the bulk-revoke endpoint',
  registers: [registry],
});

export const keyScopeValidationTotal = new Counter({
  name: 'api_key_scope_validation_total',
  help: 'Total scope validation calls',
  labelNames: ['result'],
  registers: [registry],
});

// ── Scope catalogue ───────────────────────────────────────────────────────────

export interface ScopeDefinition {
  scope: string;
  description: string;
  category: string;
}

/** Every first-class scope this API surface recognises. */
export const KNOWN_SCOPES = new Set<string>([
  'transactions:read',
  'events:read',
  'contracts:read',
  'contracts:write',
  'tokens:read',
  'wallets:read',
  'search:read',
  'analytics:read',
  'analytics:write',
  'dex:read',
  'mev:read',
  'sandbox:read',
  'sandbox:write',
  'developer:read',
  'developer:write',
  'admin:read',
  'admin:write',
  '*',
]);

const SCOPE_DEFINITIONS: ScopeDefinition[] = [
  {
    scope: 'transactions:read',
    description: 'Read transaction history and details',
    category: 'core',
  },
  { scope: 'events:read', description: 'Read contract events', category: 'core' },
  { scope: 'contracts:read', description: 'Read contract registry and metadata', category: 'core' },
  { scope: 'contracts:write', description: 'Register or update contract ABIs', category: 'core' },
  { scope: 'tokens:read', description: 'Read SEP-41 token information', category: 'core' },
  { scope: 'wallets:read', description: 'Read wallet/account history', category: 'core' },
  { scope: 'search:read', description: 'Use the autocomplete/search endpoints', category: 'core' },
  {
    scope: 'analytics:read',
    description: 'Read analytics reports and data lake queries',
    category: 'analytics',
  },
  {
    scope: 'analytics:write',
    description: 'Write/trigger analytics pipeline jobs',
    category: 'analytics',
  },
  { scope: 'dex:read', description: 'Read DEX swap analysis', category: 'defi' },
  { scope: 'mev:read', description: 'Read MEV detection results', category: 'defi' },
  { scope: 'sandbox:read', description: 'Read sandbox simulation results', category: 'dev' },
  { scope: 'sandbox:write', description: 'Execute sandbox simulations', category: 'dev' },
  {
    scope: 'developer:read',
    description: 'Read developer account and key metadata',
    category: 'account',
  },
  {
    scope: 'developer:write',
    description: 'Modify developer account settings',
    category: 'account',
  },
  { scope: 'admin:read', description: 'Admin read access', category: 'admin' },
  { scope: 'admin:write', description: 'Admin write access', category: 'admin' },
  { scope: '*', description: 'Wildcard — grants all scopes', category: 'special' },
];

/** Returns all known scope definitions. */
export function listScopes(): ScopeDefinition[] {
  return SCOPE_DEFINITIONS;
}

/**
 * Validates a comma-separated scope string.
 * Returns true only when every token is a recognised scope identifier.
 *
 * @example
 *   validateScope('transactions:read,events:read') // true
 *   validateScope('transactions:read,unknown:scope') // false
 */
export function validateScope(scope: string): boolean {
  if (!scope || typeof scope !== 'string') {
    keyScopeValidationTotal.inc({ result: 'invalid' });
    return false;
  }
  const tokens = scope
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    keyScopeValidationTotal.inc({ result: 'invalid' });
    return false;
  }
  const valid = tokens.every((t) => KNOWN_SCOPES.has(t));
  keyScopeValidationTotal.inc({ result: valid ? 'valid' : 'invalid' });
  return valid;
}

/**
 * Checks whether a key's scope covers the required permission.
 * A null/empty keyScope means no scope restriction — all permissions are granted.
 * The wildcard scope `*` grants everything.
 *
 * @param keyScope - comma-separated scope string stored on the key (may be null)
 * @param required - single scope token that the request needs
 */
export function checkScopeAuthorized(keyScope: string | null, required: string): boolean {
  if (!keyScope) return true; // no scope restriction
  const tokens = keyScope
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.includes('*')) return true;
  return tokens.includes(required);
}

// ── TypeScript interfaces ─────────────────────────────────────────────────────

export interface KeyLifecycleStats {
  totalKeys: number;
  activeKeys: number;
  revokedKeys: number;
  expiredKeys: number;
  keysNeedingRotation: number;
  averageKeyAgeDays: number;
}

export interface AuditEntry {
  id: string;
  developerId: string;
  oldKeyId: string;
  newKeyId: string;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  wasSuccessful: boolean;
  errorMessage: string | null;
  metadata: unknown;
  rotatedAt: Date;
  actorType: string;
  actorId: string | null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Returns lifecycle statistics for a developer's API keys.
 * Counts by status, expired (expiresAt in the past), and keys past their
 * rotation policy window.
 */
export async function getKeyLifecycleStats(developerId: string): Promise<KeyLifecycleStats> {
  const now = new Date();

  // Fetch all keys for the developer in a single query.
  const keys = await prismaRead.devApiKey.findMany({
    where: { developerId },
    select: {
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  let activeKeys = 0;
  let revokedKeys = 0;
  let expiredKeys = 0;
  let totalAgeDays = 0;

  for (const key of keys) {
    const ageDays = (now.getTime() - key.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    totalAgeDays += ageDays;

    if (key.status === 'revoked') {
      revokedKeys++;
    } else if (key.expiresAt && key.expiresAt <= now) {
      expiredKeys++;
    } else if (key.status === 'active') {
      activeKeys++;
    }
  }

  // Keys needing rotation: active keys where rotation_policy_days is set and
  // (now - createdAt) > rotation_policy_days. We query via raw SQL since the
  // column isn't in the Prisma-generated type yet.
  const rotationRows = await prismaRead.$queryRawUnsafe<{ count: bigint }[]>(
    `
    SELECT COUNT(*)::bigint AS count
    FROM "_dev_api_keies"
    WHERE "developer_id" = $1
      AND "status" = 'active'
      AND "rotation_policy_days" IS NOT NULL
      AND (NOW() - "created_at") > ("rotation_policy_days" * INTERVAL '1 day')
  `,
    developerId,
  );

  const keysNeedingRotation = rotationRows.length > 0 ? Number(rotationRows[0].count) : 0;
  const averageKeyAgeDays = keys.length > 0 ? totalAgeDays / keys.length : 0;

  return {
    totalKeys: keys.length,
    activeKeys,
    revokedKeys,
    expiredKeys,
    keysNeedingRotation,
    averageKeyAgeDays: Math.round(averageKeyAgeDays * 10) / 10,
  };
}

// ── Audit history ─────────────────────────────────────────────────────────────

/**
 * Returns paginated rotation audit history for a developer.
 * Reads the new actor_type/actor_id columns via raw SQL since they're not in
 * the Prisma type yet.
 */
export async function getAuditHistory(
  developerId: string,
  opts: { limit: number; offset: number },
): Promise<AuditEntry[]> {
  const rows = await prismaRead.$queryRawUnsafe<
    {
      id: string;
      developer_id: string;
      old_key_id: string;
      new_key_id: string;
      reason: string | null;
      ip_address: string | null;
      user_agent: string | null;
      was_successful: boolean;
      error_message: string | null;
      metadata: unknown;
      rotated_at: Date;
      actor_type: string;
      actor_id: string | null;
    }[]
  >(
    `SELECT id, developer_id, old_key_id, new_key_id, reason, ip_address,
            user_agent, was_successful, error_message, metadata, rotated_at,
            COALESCE(actor_type, 'developer') AS actor_type,
            actor_id
     FROM "_key_rotation_audits"
     WHERE developer_id = $1
     ORDER BY rotated_at DESC
     LIMIT $2 OFFSET $3`,
    developerId,
    opts.limit,
    opts.offset,
  );

  return rows.map((r) => ({
    id: r.id,
    developerId: r.developer_id,
    oldKeyId: r.old_key_id,
    newKeyId: r.new_key_id,
    reason: r.reason,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    wasSuccessful: r.was_successful,
    errorMessage: r.error_message,
    metadata: r.metadata,
    rotatedAt: r.rotated_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
  }));
}

// ── Scope presets ─────────────────────────────────────────────────────────────

/**
 * Returns the scope string for a named preset.
 * Throws if the preset does not exist.
 */
export async function buildScopeFromPreset(presetName: string): Promise<string> {
  const preset = await prismaRead.$queryRawUnsafe<{ scopes: string[] }[]>(
    `SELECT scopes FROM "_key_scope_presets" WHERE name = $1 LIMIT 1`,
    presetName,
  );

  if (!preset || preset.length === 0) {
    throw new Error(`Scope preset '${presetName}' not found`);
  }

  return preset[0].scopes.join(',');
}

// ── Background rotation-policy checker ───────────────────────────────────────

const ROTATION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // every hour

/**
 * Starts a background interval that warns about keys past their rotation policy.
 * Does NOT auto-rotate — only emits warnings so operators can act.
 *
 * Safe to call multiple times; each call starts an independent interval.
 */
export function scheduleKeyRotationCheck(): void {
  setInterval(async () => {
    try {
      const rows = await prismaRead.$queryRawUnsafe<
        {
          id: string;
          developer_id: string;
          name: string;
          rotation_policy_days: number;
          created_at: Date;
        }[]
      >(`
        SELECT id, developer_id, name, rotation_policy_days, created_at
        FROM "_dev_api_keies"
        WHERE status = 'active'
          AND rotation_policy_days IS NOT NULL
          AND (NOW() - created_at) > (rotation_policy_days * INTERVAL '1 day')
        LIMIT 500
      `);

      if (rows.length === 0) {
        keyLifecycleChecksTotal.inc({ outcome: 'none_due' });
        return;
      }

      keyLifecycleChecksTotal.inc({ outcome: 'warnings_emitted' });

      for (const row of rows) {
        const ageDays = Math.floor(
          (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24),
        );
        logger.warn('[api-key-lifecycle] Key past rotation policy', {
          keyId: row.id,
          developerId: row.developer_id,
          keyName: row.name,
          rotationPolicyDays: row.rotation_policy_days,
          ageDays,
        });
      }

      logger.info('[api-key-lifecycle] Rotation check complete', { overdue: rows.length });
    } catch (err) {
      keyLifecycleChecksTotal.inc({ outcome: 'error' });
      logger.error('[api-key-lifecycle] Rotation check failed', { error: String(err) });
    }
  }, ROTATION_CHECK_INTERVAL_MS);

  logger.info('[api-key-lifecycle] Key rotation policy checker scheduled', {
    intervalMs: ROTATION_CHECK_INTERVAL_MS,
  });
}
