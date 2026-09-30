import { createHash } from 'node:crypto';
import type { WebhookPayload } from './dispatcher';

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export interface WebhookBatchEnvelope {
  batchId: string;
  idempotencyKey: string;
  events: WebhookPayload[];
}

export function orderWebhookEvents(events: readonly WebhookPayload[]): WebhookPayload[] {
  return [...events].sort(
    (left, right) =>
      left.ledgerSequence - right.ledgerSequence ||
      compareText(left.transactionHash, right.transactionHash) ||
      compareText(left.id, right.id),
  );
}

export function createBatchIdempotencyKey(
  subscriptionId: string,
  events: readonly WebhookPayload[],
): string {
  const orderedIds = orderWebhookEvents(events).map((event) => event.id);
  return createHash('sha256').update(JSON.stringify([subscriptionId, orderedIds])).digest('hex');
}

export function serializeWebhookBatch(envelope: WebhookBatchEnvelope, attempt: number): string {
  return JSON.stringify({ ...envelope, attempt });
}

export function isBatchBodyWithinLimit(body: string, maxBytes: number): boolean {
  return Buffer.byteLength(body, 'utf8') <= maxBytes;
}