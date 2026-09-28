/**
 * Protocol Economic Dashboard — indexer service (#301)
 *
 * Aggregates transaction fees into ProtocolEconomicsSnapshot rows.
 *
 * On Stellar, the minimum base fee (100 stroops) is effectively "burned"
 * (removed from circulation / credited to the network). The surplus
 * (feeCharged - BASE_FEE * txCount) is the network revenue retained.
 *
 * Call `runProtocolEconomics()` on a schedule (e.g. hourly via cron-engine).
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

type Bucket = 'hour' | 'day' | 'week';

const BUCKET_MS: Record<Bucket, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

// Stellar base fee in stroops — this portion is destroyed per transaction
const BASE_FEE_STROOPS = 100;

async function computeBucket(bucket: Bucket, bucketStart: Date): Promise<void> {
  const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS[bucket]);

  const rows = await prismaRead.transaction.findMany({
    where: { ledgerCloseTime: { gte: bucketStart, lt: bucketEnd } },
    select: { feeCharged: true, status: true },
  });

  const txCount = rows.length;
  if (txCount === 0) return;

  let totalFeesBig = 0n;
  let successCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    if (row.feeCharged) {
      try {
        const fee = BigInt(row.feeCharged);
        if (fee > 0n) totalFeesBig += fee;
      } catch {
        // ignore malformed fee string
      }
    }
    if (row.status === 'success') successCount++;
    else failedCount++;
  }

  const feeBurnBig = BigInt(BASE_FEE_STROOPS) * BigInt(txCount);
  const networkRevenueBig = totalFeesBig > feeBurnBig ? totalFeesBig - feeBurnBig : 0n;
  const avgFee = txCount > 0 ? Number(totalFeesBig) / txCount : 0;
  const totalFees = Number(totalFeesBig);
  const feeBurn = Number(feeBurnBig);
  const networkRevenue = Number(networkRevenueBig);

  await prismaWrite.protocolEconomicsSnapshot.upsert({
    where: { bucket_bucketStart: { bucket, bucketStart } },
    create: {
      bucket,
      bucketStart,
      bucketEnd,
      txCount,
      totalFees,
      feeBurn,
      networkRevenue,
      avgFee,
      successCount,
      failedCount,
    },
    update: {
      bucketEnd,
      txCount,
      totalFees,
      feeBurn,
      networkRevenue,
      avgFee,
      successCount,
      failedCount,
    },
  });
}

/**
 * Compute economics snapshots for the most recent completed bucket of each
 * granularity. Idempotent — safe to call concurrently or repeatedly.
 */
export async function runProtocolEconomics(): Promise<void> {
  const now = new Date();
  for (const bucket of ['hour', 'day', 'week'] as Bucket[]) {
    const ms = BUCKET_MS[bucket];
    const bucketStart = new Date(Math.floor(now.getTime() / ms) * ms - ms);
    await computeBucket(bucket, bucketStart);
  }
}

export function startProtocolEconomicsScheduler(intervalMs = BUCKET_MS.hour): NodeJS.Timeout {
  runProtocolEconomics().catch((err) =>
    logger.error('[protocolEconomics] initial run failed:', err),
  );
  return setInterval(() => {
    runProtocolEconomics().catch((err) =>
      logger.error('[protocolEconomics] scheduled run failed:', err),
    );
  }, intervalMs);
}
