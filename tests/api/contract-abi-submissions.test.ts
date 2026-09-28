import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TESTNET_DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.STELLAR_NETWORK ??= 'testnet';

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  isEnabled: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  review: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../../src/feature-flags', () => ({
  featureFlags: { isAvailable: mocks.isAvailable, isEnabled: mocks.isEnabled },
}));
vi.mock('../../src/middleware/apiKeyAuth', () => ({
  requireApiKey: (req: Request, _res: Response, next: NextFunction) => {
    req.apiKey = { id: 'key-1', keyName: 'test', developerId: 'developer-1', tier: 'free' };
    next();
  },
}));
vi.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.actor = 'admin-1';
    next();
  },
}));
vi.mock('../../src/services/contract-abi-submissions', () => ({
  createContractAbiSubmission: mocks.create,
  listContractAbiSubmissions: mocks.list,
  getContractAbiSubmission: mocks.get,
  reviewContractAbiSubmission: mocks.review,
  publishContractAbiSubmission: mocks.publish,
}));

const address = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const payload = {
  address,
  network: 'testnet',
  name: 'Example',
  abi: { functions: [{ name: 'transfer', inputs: [{ name: 'to', type: 'Address' }] }] },
};
let app: express.Express;

beforeAll(async () => {
  const { contractAbiSubmissionsRouter, contractAbiSubmissionsAdminRouter } = await import(
    '../../src/api/contract-abi-submissions'
  );
  app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/contracts/abi-submissions', contractAbiSubmissionsRouter);
  app.use('/admin/contract-abi-submissions', contractAbiSubmissionsAdminRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Internal error' });
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAvailable.mockResolvedValue(true);
  mocks.isEnabled.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ submission: { id: 'submission-1' }, duplicate: false });
  mocks.list.mockResolvedValue({ items: [], pagination: {}, freshness: {} });
  mocks.get.mockResolvedValue({ id: 'submission-1' });
  mocks.review.mockResolvedValue({ id: 'submission-1' });
  mocks.publish.mockResolvedValue({ id: 'submission-1' });
});

describe('contract ABI submission API', () => {
  it('fails closed when the submission feature is disabled', async () => {
    mocks.isEnabled.mockResolvedValue(false);

    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('FEATURE_DISABLED');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reports missing schema separately from a disabled feature', async () => {
    mocks.isAvailable.mockResolvedValue(false);

    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SCHEMA_UNAVAILABLE');
  });

  it('returns a bounded validation error for invalid payloads', async () => {
    const response = await request(app).post('/contracts/abi-submissions').send({ address: 'bad' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_SUBMISSION');
  });

  it('rejects duplicate ABI function names', async () => {
    const duplicateFunction = payload.abi.functions[0];
    const response = await request(app)
      .post('/contracts/abi-submissions')
      .send({ ...payload, abi: { functions: [duplicateFunction, duplicateFunction] } });

    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'Function names must be unique' })]),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects requests for a network that is not indexed by this API', async () => {
    const response = await request(app)
      .post('/contracts/abi-submissions')
      .send({ ...payload, network: 'mainnet' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('NETWORK_DATA_UNAVAILABLE');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a payload above the application size budget', async () => {
    const functions = Array.from({ length: 256 }, (_, index) => ({
      name: `function_${index}`,
      inputs: Array.from({ length: 16 }, (__, param) => ({
        name: `argument_${param}_${'x'.repeat(100)}`,
        type: `Type${'x'.repeat(100)}`,
      })),
    }));
    const response = await request(app)
      .post('/contracts/abi-submissions')
      .send({ ...payload, abi: { functions } });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('creates an attributed submission and returns 201', async () => {
    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(payload, 'developer-1');
  });

  it('returns 200 for an idempotent replay', async () => {
    mocks.create.mockResolvedValue({ submission: { id: 'submission-1' }, duplicate: true });

    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(200);
    expect(response.body.duplicate).toBe(true);
  });

  it('maps indexed-evidence rejection to its service error response', async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error('No indexed evidence'), { statusCode: 422 }));

    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('No indexed evidence');
  });

  it('maps unexpected storage errors to server errors', async () => {
    mocks.create.mockRejectedValue(new Error('database offline'));

    const response = await request(app).post('/contracts/abi-submissions').send(payload);

    expect(response.status).toBe(500);
  });

  it('validates admin list filters', async () => {
    const response = await request(app).get('/admin/contract-abi-submissions?limit=101');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_QUERY');
  });

  it('returns a freshness-aware admin queue', async () => {
    const queue = { items: [{ id: 'submission-1' }], pagination: { total: 1 }, freshness: { asOf: 'now' } };
    mocks.list.mockResolvedValue(queue);

    const response = await request(app).get('/admin/contract-abi-submissions?status=pending');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(queue);
    expect(mocks.list).toHaveBeenCalledWith('pending', 1, 25);
  });

  it('returns one submission with its transition history', async () => {
    const record = { id: 'submission-1', events: [{ toStatus: 'pending' }] };
    mocks.get.mockResolvedValue(record);

    const response = await request(app).get('/admin/contract-abi-submissions/submission-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(record);
    expect(mocks.get).toHaveBeenCalledWith('submission-1');
  });

  it('requires a rejection reason', async () => {
    const response = await request(app)
      .post('/admin/contract-abi-submissions/submission-1/reject')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REVIEW');
  });

  it('records the authenticated admin reviewer', async () => {
    const response = await request(app)
      .post('/admin/contract-abi-submissions/submission-1/approve')
      .send({ reviewNote: 'Verified against indexed calls' });

    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(
      'submission-1',
      'approved',
      'admin-1',
      'Verified against indexed calls',
    );
  });

  it('records an admin rejection with its required reason', async () => {
    const response = await request(app)
      .post('/admin/contract-abi-submissions/submission-1/reject')
      .send({ reviewNote: 'ABI does not match indexed events' });

    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(
      'submission-1',
      'rejected',
      'admin-1',
      'ABI does not match indexed events',
    );
  });

  it('returns state conflicts from the review service', async () => {
    mocks.review.mockRejectedValue(Object.assign(new Error('Only pending submissions can be reviewed'), { statusCode: 409 }));

    const response = await request(app)
      .post('/admin/contract-abi-submissions/submission-1/approve')
      .send({});

    expect(response.status).toBe(409);
  });

  it('publishes only through the explicit admin action', async () => {
    const response = await request(app).post('/admin/contract-abi-submissions/submission-1/publish');

    expect(response.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith('submission-1', 'admin-1');
  });

  it('returns publication state conflicts without exposing a partial success', async () => {
    mocks.publish.mockRejectedValue(Object.assign(new Error('Only approved submissions can be published'), { statusCode: 409 }));

    const response = await request(app).post('/admin/contract-abi-submissions/submission-1/publish');

    expect(response.status).toBe(409);
  });

  it('fails closed when feature availability cannot be checked', async () => {
    mocks.isAvailable.mockRejectedValue(new Error('database offline'));

    const response = await request(app).get('/admin/contract-abi-submissions');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('FEATURE_UNAVAILABLE');
  });
});
