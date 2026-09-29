import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findEvents: vi.fn(),
  claimEvent: vi.fn(),
  findKeys: vi.fn(),
  findSubscriptions: vi.fn(),
  createDeliveries: vi.fn(),
  transaction: vi.fn(),
  findDelivery: vi.fn(),
  findGasEvent: vi.fn(),
  findTransactionEvent: vi.fn(),
  findClaimedDeliveries: vi.fn(),
  claimDelivery: vi.fn(),
  completeDelivery: vi.fn(),
  updateDeliveryAttempt: vi.fn(),
  isAvailableSync: vi.fn(),
  isEnabledSync: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../src/db', () => ({
  prismaRead: {
    gasFeeAlertEvent: { findMany: h.findEvents, findUnique: h.findGasEvent },
    event: { findUnique: h.findTransactionEvent },
    webhookDelivery: { findUnique: h.findDelivery },
  },
  prismaWrite: {
    $transaction: h.transaction,
    webhookDelivery: { updateMany: h.updateDeliveryAttempt },
  },
}));
vi.mock('../src/feature-flags', () => ({
  featureFlags: {
    isAvailableSync: h.isAvailableSync,
    isEnabledSync: h.isEnabledSync,
  },
}));
vi.mock('../src/logger', () => ({
  logger: { error: h.loggerError, info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/webhooks/ssrf-guard', () => ({
  assertSafeUrl: vi.fn().mockResolvedValue(undefined),
  safePost: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { retryPendingDeliveries } from '../src/webhooks/dispatcher';
import { enqueueGasFeeAlertDeliveries } from '../src/services/gasFeeAlertDelivery';
import { safePost } from '../src/webhooks/ssrf-guard';

const gasAlertEvent = {
  id: 'gas-alert-row-1',
  eventKey: 'rule-1:2026-09-28T10:00:00.000Z',
  ruleId: 'rule-1',
  developerId: 'developer-1',
  network: 'testnet',
  direction: 'high',
  thresholdStroops: '200',
  previousFeeStroops: '100',
  currentFeeStroops: '300',
  trend: 'rising',
  bucketStart: new Date('2026-09-28T10:00:00.000Z'),
  bucketEnd: new Date('2026-09-28T11:00:00.000Z'),
  dispatchedAt: null,
  createdAt: new Date('2026-09-28T11:00:00.000Z'),
};

describe('enqueueGasFeeAlertDeliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isAvailableSync.mockReturnValue(true);
    h.isEnabledSync.mockReturnValue(true);
    h.findEvents.mockResolvedValue([gasAlertEvent]);
    h.claimEvent.mockResolvedValue({ count: 1 });
    h.findKeys.mockResolvedValue([{ id: 'key-1' }]);
    h.findSubscriptions.mockResolvedValue([{ id: 'subscription-1', responseRetentionDays: 90 }]);
    h.createDeliveries.mockResolvedValue({ count: 1 });
    h.claimDelivery.mockResolvedValue({ count: 1 });
    h.completeDelivery.mockResolvedValue({});
    h.updateDeliveryAttempt.mockResolvedValue({ count: 1 });
    h.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        gasFeeAlertEvent: { updateMany: h.claimEvent },
        devApiKey: { findMany: h.findKeys },
        webhookSubscription: { findMany: h.findSubscriptions },
        webhookDelivery: { createMany: h.createDeliveries },
        webhookOutboxEvent: { updateMany: vi.fn() },
      }),
    );
  });

  it('enqueues owner-matched verified subscriptions idempotently', async () => {
    await enqueueGasFeeAlertDeliveries();

    expect(h.claimEvent).toHaveBeenCalledWith({
      where: { id: gasAlertEvent.id, dispatchedAt: null },
      data: { dispatchedAt: expect.any(Date) },
    });
    expect(h.findKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          developerId: gasAlertEvent.developerId,
          status: 'active',
          revokedAt: null,
        }),
      }),
    );
    expect(h.findSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          apiKeyId: { in: ['key-1'] },
          active: true,
          verified: true,
          eventType: 'gas_fee_alert',
          deliveryStrategy: 'immediate',
        }),
      }),
    );
    const delivery = h.createDeliveries.mock.calls[0][0].data[0];
    expect(delivery.idempotencyKey).toBe(`subscription-1:${gasAlertEvent.eventKey}`);
    expect(delivery.eventId).toBe(gasAlertEvent.id);
    expect(h.createDeliveries.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('does not query events when the global feature flag is disabled', async () => {
    h.isEnabledSync.mockReturnValue(false);

    await enqueueGasFeeAlertDeliveries();

    expect(h.findEvents).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('does not query events when the schema is unavailable', async () => {
    h.isAvailableSync.mockReturnValue(false);

    await enqueueGasFeeAlertDeliveries();

    expect(h.findEvents).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('returns without opening transactions when there are no pending events', async () => {
    h.findEvents.mockResolvedValue([]);

    await enqueueGasFeeAlertDeliveries();

    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('does not claim an event after its developer flag is disabled', async () => {
    h.isEnabledSync.mockImplementation((_key: string, context?: { developerId?: string }) =>
      !context?.developerId,
    );

    await enqueueGasFeeAlertDeliveries();

    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.findKeys).not.toHaveBeenCalled();
  });

  it('does not fan out when the event owner has no active API keys', async () => {
    h.findKeys.mockResolvedValue([]);

    await enqueueGasFeeAlertDeliveries();

    expect(h.findSubscriptions).not.toHaveBeenCalled();
    expect(h.createDeliveries).not.toHaveBeenCalled();
  });

  it('marks an event with no eligible webhook subscribers without creating deliveries', async () => {
    h.findSubscriptions.mockResolvedValue([]);

    await enqueueGasFeeAlertDeliveries();

    expect(h.createDeliveries).not.toHaveBeenCalled();
  });

  it('continues after a transaction failure so the shared worker can retry the event', async () => {
    h.transaction.mockRejectedValue(new Error('injected transaction failure'));

    await expect(enqueueGasFeeAlertDeliveries()).resolves.toBeUndefined();

    expect(h.loggerError).toHaveBeenCalledWith(
      '[webhooks] Gas fee alert enqueue failed; event will be retried',
      expect.objectContaining({ eventId: gasAlertEvent.eventKey }),
    );
  });

  it('paginates large subscription sets without accumulating additional pages', async () => {
    h.findSubscriptions
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          id: `subscription-${String(index).padStart(3, '0')}`,
          responseRetentionDays: 90,
        })),
      )
      .mockResolvedValueOnce([]);

    await enqueueGasFeeAlertDeliveries();

    expect(h.findSubscriptions).toHaveBeenCalledTimes(2);
    expect(h.findSubscriptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 500,
        skip: 1,
        cursor: { id: 'subscription-499' },
      }),
    );
    expect(h.createDeliveries.mock.calls[0][0].data).toHaveLength(500);
  });

  it('does not fan out when another worker already claimed the event', async () => {
    h.claimEvent.mockResolvedValue({ count: 0 });

    await enqueueGasFeeAlertDeliveries();

    expect(h.findKeys).not.toHaveBeenCalled();
    expect(h.createDeliveries).not.toHaveBeenCalled();
  });

  it('retries from the persisted gas payload and sends the idempotency key', async () => {
    const delivery = {
      id: 'delivery-1',
      subscriptionId: 'subscription-1',
      eventId: gasAlertEvent.id,
      idempotencyKey: `subscription-1:${gasAlertEvent.eventKey}`,
      attempt: 1,
      subscription: {
        url: 'https://example.com/hook',
        secret: 'test-secret',
        active: true,
        storeResponseBody: false,
        responseRetentionDays: 90,
      },
    };
    h.findClaimedDeliveries
      .mockResolvedValueOnce([{ id: delivery.id }])
      .mockResolvedValueOnce([delivery]);
    h.findDelivery.mockResolvedValue(delivery);
    h.findTransactionEvent.mockResolvedValue(null);
    h.findGasEvent.mockResolvedValue(gasAlertEvent);
    vi.mocked(safePost).mockResolvedValue({ status: 204, data: '' } as never);
    h.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        webhookDelivery: {
          findMany: h.findClaimedDeliveries,
          updateMany: h.claimDelivery,
          update: h.completeDelivery,
        },
        webhookOutboxEvent: { updateMany: vi.fn() },
      }),
    );

    await retryPendingDeliveries();

    expect(safePost).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.stringContaining('gas_fee_alert'),
      expect.objectContaining({ 'Idempotency-Key': delivery.idempotencyKey }),
      expect.any(Number),
    );
    expect(h.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: delivery.id },
        data: expect.objectContaining({ status: 'success' }),
      }),
    );
  });
});