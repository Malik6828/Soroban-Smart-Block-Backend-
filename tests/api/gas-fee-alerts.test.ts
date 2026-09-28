import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as db from '../../src/db';

vi.mock('../../src/db', () => ({
  prismaRead: {
    gasFeeAlertRule: { findMany: vi.fn(), findFirst: vi.fn() },
    gasFeeAlertEvent: { findMany: vi.fn() },
  },
  prismaWrite: {
    gasFeeAlertRule: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('../../src/feature-flags', () => ({
  featureFlags: {
    isAvailable: vi.fn().mockResolvedValue(true),
    isEnabled: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../../src/middleware/apiKeyAuth', () => ({
  requireApiKey: (req: { apiKey?: unknown }, _res: unknown, next: () => void) => {
    req.apiKey = { developerId: 'developer-1' };
    next();
  },
}));
vi.mock('../../src/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { gasFeeAlertsRouter } from '../../src/api/gas';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/gas', gasFeeAlertsRouter);
  app.use((error: { status?: number; message?: string }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return app;
}

describe('gas fee alert API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a rule with the authenticated owner and exact stroop threshold', async () => {
    vi.mocked(db.prismaWrite.gasFeeAlertRule.create).mockResolvedValue({
      id: 'rule-1',
      developerId: 'developer-1',
      network: 'mainnet',
      direction: 'high',
      thresholdStroops: '9007199254740993',
    } as never);

    const response = await request(makeApp()).post('/gas/fee-alert-rules').send({
      network: 'mainnet',
      direction: 'high',
      thresholdStroops: '9007199254740993',
    });

    expect(response.status).toBe(201);
    expect(db.prismaWrite.gasFeeAlertRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        developerId: 'developer-1',
        thresholdStroops: '9007199254740993',
      }),
    });
  });

  it('rejects malformed thresholds without writing a rule', async () => {
    const response = await request(makeApp()).post('/gas/fee-alert-rules').send({
      network: 'mainnet',
      direction: 'high',
      thresholdStroops: '1e6',
    });

    expect(response.status).not.toBe(201);
    expect(db.prismaWrite.gasFeeAlertRule.create).not.toHaveBeenCalled();
  });

  it('lists rules only for the authenticated developer and requested network', async () => {
    vi.mocked(db.prismaRead.gasFeeAlertRule.findMany).mockResolvedValue([]);

    const response = await request(makeApp()).get('/gas/fee-alert-rules?network=testnet');

    expect(response.status).toBe(200);
    expect(db.prismaRead.gasFeeAlertRule.findMany).toHaveBeenCalledWith({
      where: { developerId: 'developer-1', network: 'testnet' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('lists crossing events only for the authenticated developer and requested network', async () => {
    vi.mocked(db.prismaRead.gasFeeAlertEvent.findMany).mockResolvedValue([]);

    const response = await request(makeApp()).get('/gas/fee-alert-events?network=devnet');

    expect(response.status).toBe(200);
    expect(db.prismaRead.gasFeeAlertEvent.findMany).toHaveBeenCalledWith({
      where: { developerId: 'developer-1', network: 'devnet' },
      orderBy: { bucketEnd: 'desc' },
      take: 50,
    });
  });

  it('does not update rules owned by another developer', async () => {
    vi.mocked(db.prismaRead.gasFeeAlertRule.findFirst).mockResolvedValue(null);

    const response = await request(makeApp())
      .patch('/gas/fee-alert-rules/other-owner-rule')
      .send({ isActive: false });

    expect(response.status).toBe(404);
    expect(db.prismaWrite.gasFeeAlertRule.update).not.toHaveBeenCalled();
  });

  it('deletes only rules owned by the authenticated developer', async () => {
    vi.mocked(db.prismaWrite.gasFeeAlertRule.deleteMany).mockResolvedValue({ count: 1 } as never);

    const response = await request(makeApp()).delete('/gas/fee-alert-rules/rule-1');

    expect(response.status).toBe(204);
    expect(db.prismaWrite.gasFeeAlertRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rule-1', developerId: 'developer-1' },
    });
  });
});