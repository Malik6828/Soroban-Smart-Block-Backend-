import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

process.env.TESTNET_DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.STELLAR_NETWORK ??= 'testnet';

const mocks = vi.hoisted(() => {
  const tx = {
    transaction: { findMany: vi.fn() },
    event: { findMany: vi.fn() },
    contractAbiSubmission: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    contractAbiSubmissionEvent: { create: vi.fn() },
    contractNetwork: { findUnique: vi.fn(), upsert: vi.fn() },
    contract: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    tx,
    readTransactions: vi.fn(),
    readEvents: vi.fn(),
    findSubmission: vi.fn(),
    listSubmissions: vi.fn(),
    countSubmissions: vi.fn(),
    listSubmissions: vi.fn(),
    countSubmissions: vi.fn(),
    readSubmissionById: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
});

vi.mock('../../src/db', () => ({
  prismaRead: {
    transaction: { findMany: mocks.readTransactions },
    event: { findMany: mocks.readEvents },
    contractAbiSubmission: {
      findUnique: mocks.readSubmissionById,
    },
  },
  prismaWrite: {
    contractAbiSubmission: {
      findFirst: mocks.findSubmission,
      findMany: mocks.listSubmissions,
      count: mocks.countSubmissions,
      findUnique: mocks.readSubmissionById,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  contractAbiSubmissionInternals,
  createContractAbiSubmission,
  getContractAbiSubmission,
  listContractAbiSubmissions,
  publishContractAbiSubmission,
  reviewContractAbiSubmission,
} from '../../src/services/contract-abi-submissions';

const input = {
  address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  network: 'testnet' as const,
  name: 'Example',
  abi: { functions: [{ name: 'transfer', inputs: [{ name: 'to', type: 'Address' }] }] },
};
const evidence = [{ functionName: 'transfer', ledgerSequence: 731 }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSubmission.mockResolvedValue(null);
  mocks.findSubmission.mockResolvedValue(null);
  mocks.readTransactions.mockResolvedValue(evidence);
  mocks.readEvents.mockResolvedValue([]);
  mocks.tx.transaction.findMany.mockResolvedValue(evidence);
  mocks.tx.event.findMany.mockResolvedValue([]);
  mocks.tx.contractAbiSubmission.create.mockResolvedValue({ id: 'submission-1', ...input });
  mocks.tx.contractAbiSubmissionEvent.create.mockResolvedValue({ id: 'event-1' });
  mocks.tx.contractAbiSubmission.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({ id: 'submission-1' });
  mocks.tx.contractAbiSubmission.findUniqueOrThrow.mockResolvedValue({ id: 'submission-1' });
  mocks.listSubmissions.mockResolvedValue([]);
  mocks.countSubmissions.mockResolvedValue(0);
  mocks.tx.contractNetwork.findUnique.mockResolvedValue(null);
  mocks.tx.contractNetwork.upsert.mockResolvedValue({ id: 'deployment-1' });
  mocks.tx.contract.upsert.mockResolvedValue({ id: 'contract-1', address: input.address });
});

describe('contract ABI submission canonicalization and idempotency', () => {
  it('produces the same content hash regardless of object key order', () => {
    const first = contractAbiSubmissionInternals.canonicalJson({ a: 1, nested: { c: 2, b: 3 } });
    const second = contractAbiSubmissionInternals.canonicalJson({ nested: { b: 3, c: 2 }, a: 1 });
    expect(first).toBe(second);
    expect(contractAbiSubmissionInternals.sha256(first)).toHaveLength(64);
  });

  it('persists a pending record and its initial event with indexed evidence', async () => {
    const result = await createContractAbiSubmission(input, 'developer-1');

    expect(result.duplicate).toBe(false);
    expect(mocks.tx.contractAbiSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'pending',
        address: input.address,
        network: 'testnet',
        submittedBy: 'developer-1',
        validationLedger: 731,
      }),
    });
    expect(mocks.tx.contractAbiSubmissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: null, toStatus: 'pending', actor: 'developer-1' }),
    });
  });

  it('returns an existing identical submission without repeating writes', async () => {
    const existing = { id: 'submission-1', status: 'pending' };
    mocks.findSubmission.mockResolvedValue(existing);

    const result = await createContractAbiSubmission(input, 'developer-1');

    expect(result).toEqual({ submission: existing, duplicate: true });
    expect(mocks.readTransactions).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('recovers an idempotency race after the database unique constraint fires', async () => {
    const existing = { id: 'submission-race', status: 'pending' };
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    mocks.findSubmission.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    mocks.tx.contractAbiSubmission.create.mockRejectedValueOnce(uniqueViolation);

    const result = await createContractAbiSubmission(input, 'developer-1');

    expect(result).toEqual({ submission: existing, duplicate: true });
  });

  it('rejects an ABI with no matching indexed call evidence', async () => {
    mocks.readTransactions.mockResolvedValue([]);

    await expect(createContractAbiSubmission(input, 'developer-1')).rejects.toThrow(
      'No submitted ABI function or event has been observed',
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('accepts event-only ABI evidence from indexed topic symbols', async () => {
    mocks.readEvents.mockResolvedValue([{ topicSymbol: 'transfer', ledgerSequence: 842 }]);
    const eventInput = {
      ...input,
      abi: { functions: [], events: [{ name: 'transfer', inputs: [{ name: 'amount', type: 'i128' }] }] },
    };

    await createContractAbiSubmission(eventInput, 'developer-1');

    expect(mocks.readEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contractAddress: input.address, topicSymbol: { in: ['transfer'] } },
      }),
    );
    expect(mocks.tx.contractAbiSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ validationLedger: 842 }),
    });
  });

  it('reports the oldest validation timestamp for a page of records', async () => {
    const now = Date.now();
    mocks.listSubmissions.mockResolvedValue([
      { id: 'newest', validatedAt: new Date(now - 1000) },
      { id: 'oldest', validatedAt: new Date(now - 10_000) },
    ]);
    mocks.countSubmissions.mockResolvedValue(2);

    const result = await listContractAbiSubmissions('pending', 1, 25);

    expect(result.items).toHaveLength(2);
    expect(result.freshness.oldestValidatedAt).toBe(new Date(now - 10_000).toISOString());
    expect(result.freshness.maxStalenessSeconds).toBeGreaterThanOrEqual(10);
  });

  it('returns null freshness for an empty queue page', async () => {
    const result = await listContractAbiSubmissions(undefined, 1, 25);

    expect(result.items).toEqual([]);
    expect(result.freshness.lastValidatedAt).toBeNull();
    expect(result.freshness.oldestValidatedAt).toBeNull();
    expect(result.freshness.maxStalenessSeconds).toBeNull();
  });

  it('returns a submission record by ID', async () => {
    const record = { id: 'submission-1', events: [] };
    mocks.readSubmissionById.mockResolvedValue(record);

    await expect(getContractAbiSubmission('submission-1')).resolves.toBe(record);
  });

  it('returns not-found for a missing submission record', async () => {
    mocks.readSubmissionById.mockResolvedValue(null);

    await expect(getContractAbiSubmission('missing')).rejects.toThrow('Contract ABI submission not found');
  });
});

describe('contract ABI moderation transitions', () => {
  it('records pending to approved atomically', async () => {
    await reviewContractAbiSubmission('submission-1', 'approved', 'admin-1', 'Looks valid');

    expect(mocks.tx.contractAbiSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'submission-1', status: 'pending' },
      data: expect.objectContaining({ status: 'approved', reviewedBy: 'admin-1' }),
    });
    expect(mocks.tx.contractAbiSubmissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'pending',
        toStatus: 'approved',
        actor: 'admin-1',
        reason: 'Looks valid',
      }),
    });
  });

  it('records pending to rejected with the moderation reason', async () => {
    await reviewContractAbiSubmission('submission-1', 'rejected', 'admin-1', 'Mismatched topic');

    expect(mocks.tx.contractAbiSubmissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'pending',
        toStatus: 'rejected',
        actor: 'admin-1',
        reason: 'Mismatched topic',
      }),
    });
  });

  it('returns not-found when review targets a missing record', async () => {
    mocks.tx.contractAbiSubmission.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue(null);

    await expect(
      reviewContractAbiSubmission('missing', 'approved', 'admin-1'),
    ).rejects.toThrow('Contract ABI submission not found');
  });

  it('does not overwrite a record that has already left pending', async () => {
    mocks.tx.contractAbiSubmission.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({ id: 'submission-1' });

    await expect(
      reviewContractAbiSubmission('submission-1', 'rejected', 'admin-1', 'Reason'),
    ).rejects.toThrow('Only pending submissions can be reviewed');
    expect(mocks.tx.contractAbiSubmissionEvent.create).not.toHaveBeenCalled();
  });

  it('publishes the approved ABI and records the final transition', async () => {
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      address: input.address,
      network: 'testnet',
      status: 'approved',
      payload: input,
    });

    const result = await publishContractAbiSubmission('submission-1', 'admin-1');

    expect(result).toEqual({ id: 'submission-1' });
    expect(mocks.tx.contract.upsert).toHaveBeenCalled();
    expect(mocks.tx.contractNetwork.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address_network: { address: input.address, network: 'testnet' } },
        create: expect.objectContaining({ contractId: 'contract-1', network: 'testnet' }),
      }),
    );
    expect(mocks.tx.contractAbiSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'submission-1', status: 'approved' },
      data: expect.objectContaining({ status: 'published', validationLedger: 731 }),
    });
    expect(mocks.tx.contractAbiSubmissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'approved', toStatus: 'published', actor: 'admin-1' }),
    });
  });

  it('preserves existing canonical linkage when publishing a network alias', async () => {
    const alias = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4';
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      address: alias,
      network: 'testnet',
      status: 'approved',
      payload: { ...input, address: alias },
    });
    mocks.tx.transaction.findMany.mockResolvedValue([{ functionName: 'transfer', ledgerSequence: 731 }]);
    mocks.tx.contractNetwork.findUnique.mockResolvedValue({ contractId: 'canonical-1' });
    mocks.tx.contract.findUnique.mockResolvedValue({ address: input.address });

    await publishContractAbiSubmission('submission-1', 'admin-1');

    expect(mocks.tx.contract.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: input.address } }),
    );
    expect(mocks.tx.contractNetwork.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ address: alias }) }),
    );
  });

  it('does not publish while the submission is pending', async () => {
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      status: 'pending',
    });

    await expect(publishContractAbiSubmission('submission-1', 'admin-1')).rejects.toThrow(
      'Only approved submissions can be published',
    );
    expect(mocks.tx.contract.upsert).not.toHaveBeenCalled();
  });

  it('revalidates indexed evidence and leaves registry untouched if activity is missing', async () => {
    mocks.tx.contractAbiSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      address: input.address,
      network: 'testnet',
      status: 'approved',
      payload: input,
    });
    mocks.tx.transaction.findMany.mockResolvedValue([]);

    await expect(publishContractAbiSubmission('submission-1', 'admin-1')).rejects.toThrow(
      'No submitted ABI function or event has been observed',
    );
    expect(mocks.tx.contract.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.contractAbiSubmission.updateMany).not.toHaveBeenCalled();
  });
});
