import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { findMany, updateMany, createMany, transaction } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/metrics', () => ({
  gasFeeAlertEvaluatorOperations: { inc: vi.fn() },
  gasFeeAlertEvaluatorOperationsOtel: { add: vi.fn() },
}));
vi.mock('../../src/feature-flags', () => ({
  featureFlags: { isEnabledSync: vi.fn().mockReturnValue(true) },
}));

import { evaluateGasFeeSnapshot } from '../../src/indexer/gasFeeAlertEvaluator';
import { featureFlags } from '../../src/feature-flags';

const bucketStart = new Date('2026-09-28T10:00:00.000Z');
const bucketEnd = new Date('2026-09-28T11:00:00.000Z');
const prismaRead = { gasFeeAlertRule: { findMany } } as unknown as PrismaClient;
const prismaWrite = { $transaction: transaction } as unknown as PrismaClient;

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    developerId: 'developer-1',
    network: 'testnet',
    direction: 'high',
    thresholdStroops: '200',
    cooldownSeconds: 900,
    lastObservedFeeStroops: '100',
    lastEvaluatedAt: new Date('2026-09-28T10:00:00.000Z'),
    lastTriggeredAt: null,
    ...overrides,
  };
}

const snapshot = (feeSumStroops: string, txCount = 1) => ({
  bucketStart,
  bucketEnd,
  feeSumStroops,
  txCount,
});

describe('evaluateGasFeeSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(featureFlags.isEnabledSync).mockReturnValue(true);
    findMany.mockResolvedValue([makeRule()]);
    updateMany.mockResolvedValue({ count: 1 });
    createMany.mockResolvedValue({ count: 1 });
    transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
      callback({ gasFeeAlertRule: { updateMany }, gasFeeAlertEvent: { createMany } }),
    );
  });

  it('persists a high crossing once with previous/current trend context', async () => {
    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          ruleId: 'rule-1',
          previousFeeStroops: '100',
          currentFeeStroops: '300',
          trend: 'rising',
          eventKey: `rule-1:${bucketStart.toISOString()}`,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('does not trigger again while the observed fee remains above the threshold', async () => {
    findMany.mockResolvedValue([makeRule({ lastObservedFeeStroops: '300' })]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('400'));

    expect(createMany).not.toHaveBeenCalled();
  });

  it('persists a low crossing with falling trend context', async () => {
    findMany.mockResolvedValue([
      makeRule({ direction: 'low', thresholdStroops: '200', lastObservedFeeStroops: '300' }),
    ]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('100'));

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ direction: 'low', trend: 'falling', currentFeeStroops: '100' })],
      skipDuplicates: true,
    });
  });

  it('uses the first snapshot only as a baseline', async () => {
    findMany.mockResolvedValue([makeRule({ lastObservedFeeStroops: null, lastEvaluatedAt: null })]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastObservedFeeStroops: '300' }) }),
    );
  });

  it('ignores corrupt or empty snapshots without querying rules', async () => {
    for (const invalid of [
      snapshot('NaN'),
      snapshot('100', 0),
      snapshot('100', 1.5),
    ]) {
      await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', invalid);
    }

    expect(findMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does nothing when the network has no active rules', async () => {
    findMany.mockResolvedValue([]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('100'));

    expect(transaction).not.toHaveBeenCalled();
  });

  it('skips rules with corrupt persisted directions, thresholds, or observations', async () => {
    findMany.mockResolvedValue([
      makeRule({ direction: 'sideways' }),
      makeRule({ id: 'bad-threshold', thresholdStroops: '1.0' }),
      makeRule({ id: 'bad-observation', lastObservedFeeStroops: '-1' }),
    ]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(transaction).not.toHaveBeenCalled();
  });

  it('compares stroops exactly beyond JavaScript safe integer precision', async () => {
    findMany.mockResolvedValue([
      makeRule({ thresholdStroops: '9007199254740993', lastObservedFeeStroops: '9007199254740992' }),
    ]);

    await evaluateGasFeeSnapshot(
      prismaRead,
      prismaWrite,
      'testnet',
      snapshot('9007199254740994'),
    );

    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('does not create an event while the rule cooldown is active', async () => {
    findMany.mockResolvedValue([
      makeRule({ lastTriggeredAt: new Date('2026-09-28T10:55:00.000Z') }),
    ]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('allows a new crossing after the cooldown has elapsed', async () => {
    findMany.mockResolvedValue([
      makeRule({ lastTriggeredAt: new Date('2026-09-28T10:00:00.000Z') }),
    ]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(createMany).toHaveBeenCalledOnce();
  });

  it('does not persist a trigger if another evaluator advanced the rule first', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(createMany).not.toHaveBeenCalled();
  });

  it('uses a strictly increasing evaluation cursor to reject stale snapshots', async () => {
    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'rule-1',
          network: 'testnet',
          isActive: true,
          thresholdStroops: '200',
          cooldownSeconds: 900,
          OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lt: bucketEnd } }],
        },
      }),
    );
  });

  it('skips rules whose developer feature flag is disabled', async () => {
    const { featureFlags } = await import('../../src/feature-flags');
    vi.mocked(featureFlags.isEnabledSync).mockReturnValue(false);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('300'));

    expect(updateMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('pages through more than 500 active rules with a stable cursor', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      makeRule({ id: `rule-${String(index).padStart(3, '0')}`, lastObservedFeeStroops: '300' }),
    );
    findMany.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]);

    await evaluateGasFeeSnapshot(prismaRead, prismaWrite, 'testnet', snapshot('400'));

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenLastCalledWith({
      where: { network: 'testnet', isActive: true },
      orderBy: { id: 'asc' },
      take: 500,
      skip: 1,
      cursor: { id: 'rule-499' },
    });
  });
});