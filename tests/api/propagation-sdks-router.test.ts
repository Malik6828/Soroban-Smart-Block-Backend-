import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { propagationRouter } from '../../src/api/propagation';
import { sdksRouter } from '../../src/api/sdks';

vi.mock('../../src/db', () => ({
  prismaRead: {
    propagationAnalysis: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'analysis-1',
          vulnerableContract: 'C123',
          directAffected: 2,
          affectedByDepth: {},
          totalValueAtRisk: '1000',
          analysisDepth: 2,
          analyzedAt: new Date(),
          advisory: { severity: 'HIGH', title: 'Test Bug', description: 'desc' },
        },
      ]),
    },
    sdkVersion: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    sdkDownload: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    apiSpecSnapshot: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
  prismaWrite: {
    sdkVersion: {
      create: vi.fn(),
      update: vi.fn(),
    },
    sdkDownload: {
      create: vi.fn(),
    },
    apiSpecSnapshot: {
      upsert: vi.fn(),
    },
  },
}));

describe('Propagation and SDKs Router Mounting and Integration (#1111)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/propagation', propagationRouter);
    app.use('/sdks', sdksRouter);
  });

  describe('Propagation Router', () => {
    it('should export propagationRouter', () => {
      expect(propagationRouter).toBeDefined();
      expect(typeof propagationRouter === 'function').toBe(true);
    });

    it('GET /propagation/contracts/:address/impact returns analysis array', async () => {
      const res = await request(app).get('/propagation/contracts/C123/impact');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('vulnerableContract', 'C123');
    });

    it('GET /propagation/analyze-propagation/:advisoryId returns advisory analyses', async () => {
      const res = await request(app).get('/propagation/analyze-propagation/adv-123');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('SDKs Router', () => {
    it('should export sdksRouter', () => {
      expect(sdksRouter).toBeDefined();
      expect(typeof sdksRouter === 'function').toBe(true);
    });

    it('GET /sdks returns available SDK registry', async () => {
      const res = await request(app).get('/sdks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('sdks');
      expect(res.body.sdks).toHaveProperty('typescript');
      expect(res.body.sdks).toHaveProperty('python');
      expect(res.body.sdks).toHaveProperty('rust');
    });

    it('GET /sdks/versions returns version history', async () => {
      const res = await request(app).get('/sdks/versions');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('versions');
    });

    it('GET /sdks/typescript returns language details', async () => {
      const res = await request(app).get('/sdks/typescript');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('language', 'typescript');
    });

    it('GET /sdks/typescript/install returns installation command', async () => {
      const res = await request(app).get('/sdks/typescript/install');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('installCommand');
    });
  });
});
