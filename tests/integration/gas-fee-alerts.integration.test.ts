import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prismaWrite } from '../../src/db';

vi.mock('../../src/feature-flags', () => ({
  featureFlags: { isEnabledSync: vi.fn().mockReturnValue(true) },
}));

import { evaluateGasFeeSnapshot } from '../../src/indexer/gasFeeAlertEvaluator';

const enabled = process.env.GAS_FEE_ALERTS_INTEGRATION === '1';
const integrationDescribe = describe.skipIf(!enabled);

integrationDescribe('gas fee alert PostgreSQL integration', () => {
  const token = randomUUID().replace(/-/g, '');
  const ruleId = `gas-rule-${token}`;
  const developerId = `gas-developer-${token}`;
  const bucketStart = new Date('2026-09-28T10:00:00.000Z');
  const bucketEnd = new Date('2026-09-28T11:00:00.000Z');
  const triggerName = `gas_alert_fail_${token}`;
  const functionName = `gas_alert_fail_fn_${token}`;
  let triggerCreated = false;

  afterAll(async () => {
    if (triggerCreated) {
      await prismaWrite.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "_gas_fee_alert_events"`,
      );
      await prismaWrite.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    await prismaWrite.gasFeeAlertEvent.deleteMany({ where: { ruleId } });
    await prismaWrite.gasFeeAlertRule.deleteMany({ where: { id: ruleId } });
  });

  async function createCrossingRule(): Promise<void> {
    await prismaWrite.gasFeeAlertRule.create({
      data: {
        id: ruleId,
        developerId,
        network: 'testnet',
        direction: 'high',
        thresholdStroops: '200',
        cooldownSeconds: 900,
        lastObservedFeeStroops: '100',
        lastEvaluatedAt: new Date(bucketStart.getTime() - 60 * 60 * 1000),
      },
    });
  }

  it('deduplicates concurrent evaluation and recovers atomically from an injected event-write failure', async () => {
    await createCrossingRule();

    const snapshot = { bucketStart, bucketEnd, feeSumStroops: '300', txCount: 1 };
    await Promise.all([
      evaluateGasFeeSnapshot(prismaWrite, prismaWrite, 'testnet', snapshot),
      evaluateGasFeeSnapshot(prismaWrite, prismaWrite, 'testnet', snapshot),
    ]);

    expect(await prismaWrite.gasFeeAlertEvent.count({ where: { ruleId } })).toBe(1);

    await prismaWrite.gasFeeAlertEvent.deleteMany({ where: { ruleId } });
    await prismaWrite.gasFeeAlertRule.update({
      where: { id: ruleId },
      data: {
        lastObservedFeeStroops: '100',
        lastEvaluatedAt: new Date(bucketStart.getTime() - 60 * 60 * 1000),
        lastTriggeredAt: null,
      },
    });
    await prismaWrite.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."rule_id" = '${ruleId}' THEN
          RAISE EXCEPTION 'injected gas fee alert event write failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prismaWrite.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "_gas_fee_alert_events"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    triggerCreated = true;

    await expect(evaluateGasFeeSnapshot(prismaWrite, prismaWrite, 'testnet', snapshot)).rejects.toThrow(
      'injected gas fee alert event write failure',
    );
    const rolledBackRule = await prismaWrite.gasFeeAlertRule.findUniqueOrThrow({
      where: { id: ruleId },
    });
    expect(rolledBackRule.lastObservedFeeStroops).toBe('100');
    expect(rolledBackRule.lastEvaluatedAt?.getTime()).toBe(
      bucketStart.getTime() - 60 * 60 * 1000,
    );
    expect(await prismaWrite.gasFeeAlertEvent.count({ where: { ruleId } })).toBe(0);

    await prismaWrite.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "_gas_fee_alert_events"`);
    await prismaWrite.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    triggerCreated = false;

    await evaluateGasFeeSnapshot(prismaWrite, prismaWrite, 'testnet', snapshot);
    expect(await prismaWrite.gasFeeAlertEvent.count({ where: { ruleId } })).toBe(1);
  }, 30_000);
});