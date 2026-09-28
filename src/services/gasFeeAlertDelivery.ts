import { prismaRead, prismaWrite } from '../db';
import { featureFlags } from '../feature-flags';
import {
  gasFeeAlertDeliveryOperations,
  gasFeeAlertDeliveryOperationsOtel,
  gasFeeAlertOutboxOperations,
  gasFeeAlertOutboxOperationsOtel,
} from '../metrics';
import { logger } from '../logger';
import { uuidv7 } from '../utils/uuidv7';

const MAX_EVENTS_PER_TICK = 100;
const SUBSCRIPTION_PAGE_SIZE = 500;

/** Persist owner-scoped gas alert deliveries before the shared retry worker sends them. */
export async function enqueueGasFeeAlertDeliveries(): Promise<void> {
  if (
    !featureFlags.isAvailableSync('gasFeeAlerts') ||
    !featureFlags.isEnabledSync('gasFeeAlerts')
  ) {
    gasFeeAlertDeliveryOperations.inc({ outcome: 'feature_disabled' });
    gasFeeAlertDeliveryOperationsOtel.add(1, { outcome: 'feature_disabled' });
    return;
  }

  const events = await prismaRead.gasFeeAlertEvent.findMany({
    where: { dispatchedAt: null },
    orderBy: { createdAt: 'asc' },
    take: MAX_EVENTS_PER_TICK,
  });

  for (const event of events) {
    if (!featureFlags.isEnabledSync('gasFeeAlerts', { developerId: event.developerId })) {
      gasFeeAlertOutboxOperations.inc({ outcome: 'developer_disabled' });
      gasFeeAlertOutboxOperationsOtel.add(1, { outcome: 'developer_disabled' });
      continue;
    }

    try {
      const enqueuedCount = await prismaWrite.$transaction(async (tx) => {
        const claimed = await tx.gasFeeAlertEvent.updateMany({
          where: { id: event.id, dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        });
        if (claimed.count === 0) return -1;

        const now = new Date();
        const apiKeys = await tx.devApiKey.findMany({
          where: {
            developerId: event.developerId,
            status: 'active',
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        });
        if (apiKeys.length === 0) return 0;

        let cursor: string | undefined;
        let deliveryCount = 0;

        while (true) {
          const subscriptions = await tx.webhookSubscription.findMany({
            where: {
              apiKeyId: { in: apiKeys.map((key) => key.id) },
              active: true,
              verified: true,
              eventType: 'gas_fee_alert',
              deliveryStrategy: 'immediate',
            },
            select: { id: true, responseRetentionDays: true },
            orderBy: { id: 'asc' },
            take: SUBSCRIPTION_PAGE_SIZE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          });
          if (subscriptions.length === 0) break;

          const created = await tx.webhookDelivery.createMany({
            data: subscriptions.map((subscription) => ({
              id: uuidv7(),
              subscriptionId: subscription.id,
              eventId: event.id,
              idempotencyKey: `${subscription.id}:${event.eventKey}`,
              attempt: 1,
              status: 'pending',
              processingStatus: 'idle',
              expiresAt: new Date(
                now.getTime() + Math.max(90, subscription.responseRetentionDays) * 24 * 60 * 60 * 1000,
              ),
            })),
            skipDuplicates: true,
          });
          deliveryCount += created.count;

          if (subscriptions.length < SUBSCRIPTION_PAGE_SIZE) break;
          cursor = subscriptions[subscriptions.length - 1].id;
        }
        return deliveryCount;
      });
      const outcome = enqueuedCount < 0 ? 'already_claimed' : enqueuedCount > 0 ? 'enqueued' : 'no_recipient';
      gasFeeAlertDeliveryOperations.inc({ outcome }, enqueuedCount > 0 ? enqueuedCount : 1);
      gasFeeAlertDeliveryOperationsOtel.add(enqueuedCount > 0 ? enqueuedCount : 1, { outcome });
    } catch (error) {
      gasFeeAlertDeliveryOperations.inc({ outcome: 'error' });
      gasFeeAlertDeliveryOperationsOtel.add(1, { outcome: 'error' });
      logger.error('[webhooks] Gas fee alert enqueue failed; event will be retried', {
        eventId: event.eventKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}