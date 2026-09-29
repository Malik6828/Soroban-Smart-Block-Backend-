import { describe, expect, it } from 'vitest';
import {
  createBatchIdempotencyKey,
  isBatchBodyWithinLimit,
  orderWebhookEvents,
  serializeWebhookBatch,
} from '../src/webhooks/batch-utils';
import type { WebhookPayload } from '../src/webhooks/dispatcher';

const events: WebhookPayload[] = [
  {
    id: 'event-c',
    contractAddress: 'contract-a',
    eventType: 'transfer',
    decoded: {},
    ledgerSequence: 11,
    ledgerCloseTime: new Date('2026-09-28T00:00:01.000Z'),
    transactionHash: 'tx-b',
  },
  {
    id: 'event-a',
    contractAddress: 'contract-a',
    eventType: 'transfer',
    decoded: {},
    ledgerSequence: 10,
    ledgerCloseTime: new Date('2026-09-28T00:00:00.000Z'),
    transactionHash: 'tx-z',
  },
  {
    id: 'event-b',
    contractAddress: 'contract-a',
    eventType: 'transfer',
    decoded: {},
    ledgerSequence: 10,
    ledgerCloseTime: new Date('2026-09-28T00:00:00.000Z'),
    transactionHash: 'tx-a',
  },
];

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, candidateIndex) => candidateIndex !== index)).map((rest) => [item, ...rest]),
  );
}

describe('webhook batch contract utilities', () => {
  it('preserves deterministic per-entity ordering for every input permutation', () => {
    const expectedIds = ['event-b', 'event-a', 'event-c'];
    const expectedKey = createBatchIdempotencyKey('subscription-a', events);

    for (const permutation of permutations(events)) {
      expect(orderWebhookEvents(permutation).map((event) => event.id)).toEqual(expectedIds);
      expect(createBatchIdempotencyKey('subscription-a', permutation)).toBe(expectedKey);
    }
  });

  it('namespaces idempotency keys by subscription and exact membership', () => {
    expect(createBatchIdempotencyKey('subscription-b', events)).not.toBe(
      createBatchIdempotencyKey('subscription-a', events),
    );
    expect(createBatchIdempotencyKey('subscription-a', events.slice(0, 2))).not.toBe(
      createBatchIdempotencyKey('subscription-a', events),
    );
  });

  it('keeps event membership stable across retries while advancing attempt', () => {
    const envelope = {
      batchId: 'batch-a',
      idempotencyKey: createBatchIdempotencyKey('subscription-a', events),
      events: orderWebhookEvents(events),
    };
    const firstAttempt = JSON.parse(serializeWebhookBatch(envelope, 1));
    const retry = JSON.parse(serializeWebhookBatch(envelope, 2));

    expect(retry.events).toEqual(firstAttempt.events);
    expect(retry.batchId).toBe(firstAttempt.batchId);
    expect(retry.idempotencyKey).toBe(firstAttempt.idempotencyKey);
    expect(retry.attempt).toBe(2);
  });

  it('uses UTF-8 byte length for the hard request body bound', () => {
    expect(isBatchBodyWithinLimit('a', 1)).toBe(true);
    expect(isBatchBodyWithinLimit('é', 1)).toBe(false);
    expect(isBatchBodyWithinLimit('é', 2)).toBe(true);
  });
});