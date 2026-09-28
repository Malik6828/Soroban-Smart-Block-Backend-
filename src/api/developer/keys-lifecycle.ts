/**
 * API Key Lifecycle Router (PLT05)
 *
 * Extends the existing key CRUD router with lifecycle-specific endpoints:
 *   GET  /scopes
 *   GET  /scope-presets
 *   POST /scope-presets
 *   GET  /stats
 *   POST /bulk-revoke
 *   GET  /:id/lifecycle
 *   PATCH /:id/lifecycle
 *   GET  /:id/audit
 *   POST /:id/expire
 *
 * All mutations use prismaWrite; all reads use prismaRead.
 * New schema columns (scope, environment, tags, etc.) are accessed via raw
 * SQL because the Prisma client types are not regenerated until the next
 * `prisma generate` run.
 */

import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { logger } from '../../logger';
import { uuidv7 } from '../../utils/uuidv7';
import {
  listScopes,
  validateScope,
  getKeyLifecycleStats,
  keyBulkRevokesTotal,
} from '../../services/api-key-lifecycle';

export const keysLifecycleRouter = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createPresetSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'name must be lowercase alphanumeric with underscores'),
  description: z.string().min(1).max(512),
  scopes: z.array(z.string().min(1)).min(1),
});

const updateLifecycleSchema = z.object({
  scope: z.string().max(1024).optional(),
  description: z.string().max(2048).optional(),
  environment: z.enum(['production', 'sandbox', 'test']).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  rotation_policy_days: z.number().int().min(1).max(3650).nullable().optional(),
});

const statsQuerySchema = z.object({
  developerId: z.string().min(1),
});

const bulkRevokeSchema = z.object({
  developerId: z.string().min(1),
  keyIds: z.array(z.string().min(1)).min(1).max(100),
  reason: z.string().max(256).optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── GET /scopes ───────────────────────────────────────────────────────────────

keysLifecycleRouter.get(
  '/scopes',
  asyncHandler(async (_req, res) => {
    const scopes = listScopes();
    res.json({ data: scopes, total: scopes.length });
  }),
);

// ── GET /scope-presets ────────────────────────────────────────────────────────

keysLifecycleRouter.get(
  '/scope-presets',
  asyncHandler(async (_req, res) => {
    const rows = await prismaRead.$queryRawUnsafe<
      {
        id: string;
        name: string;
        description: string;
        scopes: string[];
        is_builtin: boolean;
        created_at: Date;
      }[]
    >(`SELECT id, name, description, scopes, is_builtin, created_at
       FROM "_key_scope_presets"
       ORDER BY is_builtin DESC, name ASC`);

    res.json({ data: rows });
  }),
);

// ── POST /scope-presets ───────────────────────────────────────────────────────

keysLifecycleRouter.post(
  '/scope-presets',
  asyncHandler(async (req, res) => {
    const parsed = createPresetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { name, description, scopes } = parsed.data;

    // Validate every scope token
    const scopeString = scopes.join(',');
    if (!validateScope(scopeString)) {
      return res.status(400).json({
        error: 'Invalid scopes',
        details: `One or more scope tokens are not recognised. Call GET /scopes for the full list.`,
      });
    }

    // Check for name conflict
    const existing = await prismaRead.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "_key_scope_presets" WHERE name = $1 LIMIT 1`,
      name,
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A scope preset with that name already exists' });
    }

    const id = uuidv7();
    await prismaWrite.$executeRaw(
      Prisma.sql`INSERT INTO "_key_scope_presets" (id, name, description, scopes, is_builtin, created_at)
                 VALUES (${id}, ${name}, ${description}, ${scopes}, false, NOW())`,
    );

    logger.info('[keys-lifecycle] Scope preset created', { id, name });

    res.status(201).json({ id, name, description, scopes, isBuiltin: false });
  }),
);

// ── GET /stats ────────────────────────────────────────────────────────────────

keysLifecycleRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const parsed = statsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const developer = await prismaRead.developer.findUnique({
      where: { id: parsed.data.developerId },
      select: { id: true },
    });
    if (!developer) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    const stats = await getKeyLifecycleStats(parsed.data.developerId);
    res.json(stats);
  }),
);

// ── POST /bulk-revoke ─────────────────────────────────────────────────────────

keysLifecycleRouter.post(
  '/bulk-revoke',
  asyncHandler(async (req, res) => {
    const parsed = bulkRevokeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { developerId, keyIds, reason } = parsed.data;

    // Confirm developer exists
    const developer = await prismaRead.developer.findUnique({
      where: { id: developerId },
      select: { id: true },
    });
    if (!developer) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    // Fetch keys that belong to this developer and are still active
    const keys = await prismaRead.devApiKey.findMany({
      where: { id: { in: keyIds }, developerId, status: 'active' },
      select: { id: true, keyHash: true },
    });

    if (keys.length === 0) {
      return res.status(404).json({
        error: 'No active keys found matching the provided IDs for this developer',
      });
    }

    const revokedAt = new Date();
    const revokedIds: string[] = [];

    await prismaWrite.$transaction(async (tx) => {
      for (const key of keys) {
        await tx.devApiKey.update({
          where: { id: key.id },
          data: { status: 'revoked', revokedAt },
        });
        revokedIds.push(key.id);
      }
    });

    keyBulkRevokesTotal.inc(revokedIds.length);

    logger.warn('[keys-lifecycle] Bulk key revocation', {
      developerId,
      count: revokedIds.length,
      reason,
      revokedIds,
    });

    const notFound = keyIds.filter((id) => !revokedIds.includes(id));
    res.json({
      revokedCount: revokedIds.length,
      revokedIds,
      ...(notFound.length > 0 ? { skipped: notFound } : {}),
    });
  }),
);

// ── GET /:id/lifecycle ────────────────────────────────────────────────────────

keysLifecycleRouter.get(
  '/:id/lifecycle',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    // Base key existence check via ORM
    const base = await prismaRead.devApiKey.findFirst({
      where: { id, developerId },
      select: { id: true },
    });
    if (!base) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Lifecycle fields via raw SQL
    const rows = await prismaRead.$queryRawUnsafe<
      {
        scope: string | null;
        description: string | null;
        environment: string;
        tags: unknown;
        rotation_policy_days: number | null;
        last_rotated_at: Date | null;
        last_seen_ip: string | null;
      }[]
    >(
      `SELECT scope, description, environment, tags, rotation_policy_days, last_rotated_at, last_seen_ip
       FROM "_dev_api_keies"
       WHERE id = $1`,
      id,
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const row = rows[0];
    res.json({
      id,
      scope: row.scope,
      description: row.description,
      environment: row.environment ?? 'production',
      tags: Array.isArray(row.tags) ? row.tags : [],
      rotationPolicyDays: row.rotation_policy_days,
      lastRotatedAt: row.last_rotated_at,
      lastSeenIp: row.last_seen_ip,
    });
  }),
);

// ── PATCH /:id/lifecycle ──────────────────────────────────────────────────────

keysLifecycleRouter.patch(
  '/:id/lifecycle',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const parsed = updateLifecycleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    // Confirm key ownership
    const existing = await prismaRead.devApiKey.findFirst({
      where: { id, developerId },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const { scope, description, environment, tags, rotation_policy_days } = parsed.data;

    // Validate scope if provided
    if (scope !== undefined && scope !== null && !validateScope(scope)) {
      return res.status(400).json({
        error: 'Invalid scope',
        details:
          'One or more scope tokens are not recognised. Call GET /keys/scopes for the full list.',
      });
    }

    // Build the SET clause dynamically — only include provided fields
    const setClauses: string[] = [];
    const params: unknown[] = [id];
    let paramIdx = 2;

    if (scope !== undefined) {
      setClauses.push(`scope = $${paramIdx++}`);
      params.push(scope);
    }
    if (description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      params.push(description);
    }
    if (environment !== undefined) {
      setClauses.push(`environment = $${paramIdx++}`);
      params.push(environment);
    }
    if (tags !== undefined) {
      setClauses.push(`tags = $${paramIdx++}::jsonb`);
      params.push(JSON.stringify(tags));
    }
    if (rotation_policy_days !== undefined) {
      setClauses.push(`rotation_policy_days = $${paramIdx++}`);
      params.push(rotation_policy_days);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No lifecycle fields provided to update' });
    }

    setClauses.push(`updated_at = NOW()`);

    await prismaWrite.$executeRawUnsafe(
      `UPDATE "_dev_api_keies" SET ${setClauses.join(', ')} WHERE id = $1`,
      ...params,
    );

    logger.info('[keys-lifecycle] Lifecycle updated', {
      id,
      developerId,
      fields: Object.keys(parsed.data),
    });

    res.json({ id, updated: true });
  }),
);

// ── GET /:id/audit ────────────────────────────────────────────────────────────

keysLifecycleRouter.get(
  '/:id/audit',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    // Confirm key ownership
    const existing = await prismaRead.devApiKey.findFirst({
      where: { id, developerId },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const queryParsed = auditQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: queryParsed.error.flatten() });
    }

    const { limit, offset } = queryParsed.data;

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
       WHERE (old_key_id = $1 OR new_key_id = $1)
         AND developer_id = $2
       ORDER BY rotated_at DESC
       LIMIT $3 OFFSET $4`,
      id,
      developerId,
      limit,
      offset,
    );

    const total = await prismaRead.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count
       FROM "_key_rotation_audits"
       WHERE (old_key_id = $1 OR new_key_id = $1)
         AND developer_id = $2`,
      id,
      developerId,
    );

    res.json({
      data: rows.map((r) => ({
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
      })),
      total: total.length > 0 ? Number(total[0].count) : 0,
      limit,
      offset,
    });
  }),
);

// ── POST /:id/expire ──────────────────────────────────────────────────────────

keysLifecycleRouter.post(
  '/:id/expire',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const existing = await prismaRead.devApiKey.findFirst({
      where: { id, developerId },
      select: { id: true, status: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'API key not found' });
    }

    if (existing.status === 'revoked') {
      return res.status(409).json({ error: 'Key is already revoked and cannot be expired' });
    }

    const now = new Date();
    await prismaWrite.devApiKey.update({
      where: { id },
      data: { expiresAt: now, status: 'expired' },
    });

    logger.info('[keys-lifecycle] Key manually expired', { id, developerId });

    res.json({ id, expired: true, expiresAt: now.toISOString() });
  }),
);
