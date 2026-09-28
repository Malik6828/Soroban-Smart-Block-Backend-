/**
 * Tests for PLT05 — API Key Lifecycle Management Portal
 * Covers all endpoints in src/api/developer/keys-lifecycle.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Top-level mock function references (created once, reset between tests)
// ---------------------------------------------------------------------------

const mockQueryRawUnsafe = vi.fn();
const mockExecuteRaw = vi.fn();
const mockExecuteRawUnsafe = vi.fn();
const mockDevApiKeyFindFirst = vi.fn();
const mockDevApiKeyFindMany = vi.fn();
const mockDevApiKeyUpdate = vi.fn();
const mockDeveloperFindUnique = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../src/db', () => ({
  prismaWrite: {
    devApiKey: {
      update: mockDevApiKeyUpdate,
      findMany: mockDevApiKeyFindMany,
    },
    developer: {
      findUnique: mockDeveloperFindUnique,
    },
    $transaction: mockTransaction,
    $executeRaw: mockExecuteRaw,
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
  prismaRead: {
    devApiKey: {
      findFirst: mockDevApiKeyFindFirst,
      findMany: mockDevApiKeyFindMany,
    },
    developer: {
      findUnique: mockDeveloperFindUnique,
    },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

vi.mock('../../src/middleware/apiKeyAuth', () => ({
  invalidateKeyCache: vi.fn(),
  apiKeyAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/metrics', () => ({
  registry: { registerMetric: vi.fn() },
}));

vi.mock('../../src/utils/uuidv7', () => ({
  uuidv7: vi.fn().mockReturnValue('test-uuid-1234'),
}));

// ---------------------------------------------------------------------------
// App factory — create a fresh Express instance for each test
// ---------------------------------------------------------------------------

async function buildApp() {
  const { keysLifecycleRouter } = await import('../../src/api/developer/keys-lifecycle');
  const app = express();
  app.use(express.json());
  app.use('/developer/keys', keysLifecycleRouter);
  return app;
}

// Helpers to set up default mock behaviour before each test
function setupDefaultMocks() {
  mockDevApiKeyFindFirst.mockResolvedValue({ id: 'key_1', status: 'active' });
  mockDevApiKeyFindMany.mockResolvedValue([
    { id: 'key_1', status: 'active', expiresAt: null, createdAt: new Date('2026-01-01') },
  ]);
  mockDevApiKeyUpdate.mockResolvedValue({ id: 'key_1', status: 'revoked' });
  mockDeveloperFindUnique.mockResolvedValue({ id: 'dev_1' });
  mockTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      devApiKey: {
        update: vi.fn().mockResolvedValue({ id: 'key_1' }),
      },
    }),
  );
  mockExecuteRaw.mockResolvedValue(1);
  mockExecuteRawUnsafe.mockResolvedValue(1);
  mockQueryRawUnsafe.mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /developer/keys/scopes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('returns all scope definitions', async () => {
    const app = await buildApp();
    const res = await request(app).get('/developer/keys/scopes');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);

    const scopes = res.body.data as Array<{ scope: string; description: string; category: string }>;
    expect(scopes.some((s) => s.scope === 'transactions:read')).toBe(true);
    expect(scopes.some((s) => s.scope === '*')).toBe(true);
    expect(scopes[0]).toHaveProperty('description');
    expect(scopes[0]).toHaveProperty('category');
  });
});

describe('GET /developer/keys/scope-presets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('returns presets from the database', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 'preset_1',
        name: 'read_only',
        description: 'Read-only access',
        scopes: ['transactions:read'],
        is_builtin: true,
        created_at: new Date(),
      },
    ]);

    const app = await buildApp();
    const res = await request(app).get('/developer/keys/scope-presets');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].name).toBe('read_only');
  });
});

describe('POST /developer/keys/scope-presets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('creates a custom scope preset', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]); // no conflict
    mockExecuteRaw.mockResolvedValueOnce(1);

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/scope-presets')
      .send({
        name: 'my_preset',
        description: 'Custom preset',
        scopes: ['transactions:read', 'events:read'],
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my_preset');
    expect(res.body.isBuiltin).toBe(false);
  });

  it('returns 400 for invalid name format', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/scope-presets')
      .send({
        name: 'Invalid Name With Spaces',
        description: 'Test',
        scopes: ['transactions:read'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 for unrecognised scope tokens', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]); // no conflict
    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/scope-presets')
      .send({
        name: 'bad_scope',
        description: 'Has invalid scope',
        scopes: ['transactions:read', 'totally:fake:scope'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid scopes');
  });

  it('returns 409 when preset name already exists', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: 'existing_id' }]);

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/scope-presets')
      .send({
        name: 'read_only',
        description: 'Duplicate',
        scopes: ['transactions:read'],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe('GET /developer/keys/stats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('returns lifecycle stats for a developer', async () => {
    // rotation check query returns no overdue keys
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);

    const app = await buildApp();
    const res = await request(app).get('/developer/keys/stats').query({ developerId: 'dev_1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalKeys');
    expect(res.body).toHaveProperty('activeKeys');
    expect(res.body).toHaveProperty('revokedKeys');
    expect(res.body).toHaveProperty('expiredKeys');
    expect(res.body).toHaveProperty('keysNeedingRotation');
    expect(res.body).toHaveProperty('averageKeyAgeDays');
  });

  it('returns 400 when developerId is missing', async () => {
    const app = await buildApp();
    const res = await request(app).get('/developer/keys/stats');
    expect(res.status).toBe(400);
  });

  it('returns 404 when developer does not exist', async () => {
    mockDeveloperFindUnique.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await request(app)
      .get('/developer/keys/stats')
      .query({ developerId: 'nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Developer not found');
  });
});

describe('POST /developer/keys/bulk-revoke', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('revokes multiple keys atomically', async () => {
    mockDevApiKeyFindMany.mockResolvedValueOnce([
      { id: 'key_1', keyHash: 'hash1' },
      { id: 'key_2', keyHash: 'hash2' },
    ]);

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/bulk-revoke')
      .send({
        developerId: 'dev_1',
        keyIds: ['key_1', 'key_2'],
        reason: 'Security incident',
      });

    expect(res.status).toBe(200);
    expect(res.body.revokedCount).toBe(2);
    expect(res.body.revokedIds).toContain('key_1');
    expect(res.body.revokedIds).toContain('key_2');
  });

  it('returns 400 when keyIds is empty', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/bulk-revoke')
      .send({ developerId: 'dev_1', keyIds: [] });

    expect(res.status).toBe(400);
  });

  it('returns 404 when no active keys match', async () => {
    mockDevApiKeyFindMany.mockResolvedValueOnce([]);

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/bulk-revoke')
      .send({ developerId: 'dev_1', keyIds: ['ghost_key'] });

    expect(res.status).toBe(404);
  });
});

describe('GET /developer/keys/:id/lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('returns lifecycle metadata for a key', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        scope: 'transactions:read,events:read',
        description: 'Production key',
        environment: 'production',
        tags: ['prod', 'main'],
        rotation_policy_days: 90,
        last_rotated_at: null,
        last_seen_ip: '203.0.113.1',
      },
    ]);

    const app = await buildApp();
    const res = await request(app)
      .get('/developer/keys/key_1/lifecycle')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('key_1');
    expect(res.body.scope).toBe('transactions:read,events:read');
    expect(res.body.environment).toBe('production');
    expect(res.body.rotationPolicyDays).toBe(90);
    expect(res.body.lastSeenIp).toBe('203.0.113.1');
  });

  it('returns 404 when key does not belong to developer', async () => {
    mockDevApiKeyFindFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await request(app)
      .get('/developer/keys/ghost/lifecycle')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /developer/keys/:id/lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('updates scope and environment', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/developer/keys/key_1/lifecycle')
      .query({ developerId: 'dev_1' })
      .send({ scope: 'transactions:read', environment: 'sandbox' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
  });

  it('returns 400 for invalid scope token', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/developer/keys/key_1/lifecycle')
      .query({ developerId: 'dev_1' })
      .send({ scope: 'not:a:real:scope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid scope');
  });

  it('returns 400 when no fields are provided', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/developer/keys/key_1/lifecycle')
      .query({ developerId: 'dev_1' })
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No lifecycle fields/);
  });

  it('returns 404 when key is not found', async () => {
    mockDevApiKeyFindFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await request(app)
      .patch('/developer/keys/ghost/lifecycle')
      .query({ developerId: 'dev_1' })
      .send({ description: 'test' });

    expect(res.status).toBe(404);
  });
});

describe('GET /developer/keys/:id/audit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('returns audit history for a key', async () => {
    // rows query
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 'audit_1',
        developer_id: 'dev_1',
        old_key_id: 'key_1',
        new_key_id: 'key_2',
        reason: 'manual',
        ip_address: '127.0.0.1',
        user_agent: 'test',
        was_successful: true,
        error_message: null,
        metadata: {},
        rotated_at: new Date('2026-07-01'),
        actor_type: 'developer',
        actor_id: null,
      },
    ]);
    // count query
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: 1 }]);

    const app = await buildApp();
    const res = await request(app)
      .get('/developer/keys/key_1/audit')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].reason).toBe('manual');
    expect(res.body.data[0].actorType).toBe('developer');
  });

  it('returns 404 when key does not exist', async () => {
    mockDevApiKeyFindFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await request(app)
      .get('/developer/keys/ghost/audit')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(404);
  });
});

describe('POST /developer/keys/:id/expire', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  it('expires an active key', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/key_1/expire')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(true);
    expect(res.body.id).toBe('key_1');
    expect(res.body.expiresAt).toBeDefined();
  });

  it('returns 409 when key is already revoked', async () => {
    mockDevApiKeyFindFirst.mockResolvedValueOnce({
      id: 'key_1',
      status: 'revoked',
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/key_1/expire')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already revoked/);
  });

  it('returns 404 when key is not found', async () => {
    mockDevApiKeyFindFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await request(app)
      .post('/developer/keys/ghost/expire')
      .query({ developerId: 'dev_1' });

    expect(res.status).toBe(404);
  });
});
