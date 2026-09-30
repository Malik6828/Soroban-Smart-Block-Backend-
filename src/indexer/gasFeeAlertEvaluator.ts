import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { featureFlags } from '../feature-flags';
import { logger } from '../logger';
import {
  gasFeeAlertEvaluatorOperations,
  gasFeeAlertEvaluatorOperationsOtel,
} from '../metrics';

interface FeeSnapshot {
  bucketStart: Date;
  bucketEnd: Date;
  feeSumStroops: string;
  txCount: number;
}

const STOOPS_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const RULE_PAGE_SIZE = 500;

function recordEvaluationOutcome(outcome: string): void {
  gasFeeAlertEvaluatorOperations.inc({ outcome });
  gasFeeAlertEvaluatorOperationsOtel.add(1, { outcome });
}

function isCrossing(direction: 'high' | 'low', previous: bigint, current: bigint, threshold: bigint): boolean {
  if (direction === 'high') return previous <= threshold && current > threshold;
  return previous >= threshold && current < threshold;
}

export async function evaluateGasFeeSnapshot(
  prismaRead: PrismaClient,
  prismaWrite: PrismaClient,
  network: string,
  snapshot: FeeSnapshot,
): Promise<void> {
  if (
    !STOOPS_PATTERN.test(snapshot.feeSumStroops) ||
    !Number.isSafeInteger(snapshot.txCount) ||
    snapshot.txCount <= 0
  ) {
    recordEvaluationOutcome('invalid_snapshot');
    logger.error('gas fee alert evaluation received an invalid snapshot', {
      network,
      bucketStart: snapshot.bucketStart.toISOString(),
    });
    return;
  }

  const current = BigInt(snapshot.feeSumStroops) / BigInt(snapshot.txCount);
  let cursor: string | undefined;
  while (true) {
    const rules = await prismaRead.gasFeeAlertRule.findMany({
      where: { network, isActive: true },
      orderBy: { id: 'asc' },
      take: RULE_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    for (const rule of rules) {
      if (!featureFlags.isEnabledSync('gasFeeAlerts', { developerId: rule.developerId })) {
        recordEvaluationOutcome('developer_disabled');
        continue;
      }

      if (!['high', 'low'].includes(rule.direction) || !STOOPS_PATTERN.test(rule.thresholdStroops)) {
        recordEvaluationOutcome('invalid_rule');
        logger.error('gas fee alert rule has an invalid stored threshold', { ruleId: rule.id, network });
        continue;
      }

      const threshold = BigInt(rule.thresholdStroops);
      let previous: bigint | null = null;
      if (rule.lastObservedFeeStroops !== null) {
        if (!STOOPS_PATTERN.test(rule.lastObservedFeeStroops)) {
          recordEvaluationOutcome('invalid_rule');
          logger.error('gas fee alert rule has an invalid stored observation', {
            ruleId: rule.id,
            network,
          });
          continue;
        }
        previous = BigInt(rule.lastObservedFeeStroops);
      }

      const crossing = previous !== null && isCrossing(rule.direction, previous, current, threshold);
      const cooldownElapsed =
        rule.lastTriggeredAt === null ||
        snapshot.bucketEnd.getTime() - rule.lastTriggeredAt.getTime() >= rule.cooldownSeconds * 1000;
      const shouldTrigger = crossing && cooldownElapsed;

      const outcome = await prismaWrite.$transaction(async (tx) => {
        const claim = await tx.gasFeeAlertRule.updateMany({
          where: {
            id: rule.id,
            network,
            isActive: true,
            thresholdStroops: rule.thresholdStroops,
            cooldownSeconds: rule.cooldownSeconds,
            OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lt: snapshot.bucketEnd } }],
          },
          data: {
            lastObservedFeeStroops: current.toString(),
            lastEvaluatedAt: snapshot.bucketEnd,
            ...(shouldTrigger ? { lastTriggeredAt: snapshot.bucketEnd } : {}),
          },
        });
        if (claim.count === 0) return 'concurrent';

        if (shouldTrigger && previous !== null) {
            const trend = current > previous ? 'rising' : 'falling';
          await tx.gasFeeAlertEvent.createMany({
            data: [
              {
                id: randomUUID(),
                eventKey: `${rule.id}:${snapshot.bucketStart.toISOString()}`,
                ruleId: rule.id,
                developerId: rule.developerId,
                network,
                direction: rule.direction,
                thresholdStroops: rule.thresholdStroops,
                previousFeeStroops: previous.toString(),
                currentFeeStroops: current.toString(),
                trend,
                bucketStart: snapshot.bucketStart,
                bucketEnd: snapshot.bucketEnd,
              },
            ],
            skipDuplicates: true,
          });
          return 'triggered';
        }
        return previous === null ? 'baseline' : 'observed';
      });

      recordEvaluationOutcome(outcome);
    }

    if (rules.length < RULE_PAGE_SIZE) break;
    cursor = rules[rules.length - 1].id;
  }
}