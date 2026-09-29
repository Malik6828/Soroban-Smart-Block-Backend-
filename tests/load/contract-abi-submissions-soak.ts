/**
 * ECO01 — PostgreSQL-backed ABI submission soak.
 *
 * Drives the production submission service against the real CI PostgreSQL
 * instance. Budgets: zero failures, p99 <= 250 ms, >= 90% of target rate, and
 * <= 128 MiB retained heap growth. Target defaults to 1 submission/s, a 10x
 * planning rate over the documented 0.1 submission/s projected peak.
 *
 * Run: npx ts-node --transpile-only tests/load/contract-abi-submissions-soak.ts
 */
import { randomUUID } from 'crypto';
import { prismaWrite } from '../../src/db';
import { createContractAbiSubmission } from '../../src/services/contract-abi-submissions';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DURATION_SEC = numberEnv('CONTRACT_ABI_DURATION_SEC', 1800);
const TARGET_RPS = numberEnv('CONTRACT_ABI_TARGET_RPS', 1);
const P99_BUDGET_MS = numberEnv('CONTRACT_ABI_P99_BUDGET_MS', 250);
const HEAP_BUDGET_MB = numberEnv('CONTRACT_ABI_HEAP_BUDGET_MB', 128);

async function main(): Promise<void> {
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  const address = `CABI${token}`;
  const functionName = `soak_${token}`;
  const latencies: number[] = [];
  let failures = 0;
  let submissions = 0;
  let ledgerSequence = 0;

  try {
    const latest = await prismaWrite.ledger.aggregate({ _max: { sequence: true } });
    ledgerSequence = (latest._max.sequence ?? 0) + 1;
    await prismaWrite.contract.create({ data: { address } });
    await prismaWrite.ledger.create({
      data: { sequence: ledgerSequence, hash: `contract-abi-soak-${token}`, closeTime: new Date() },
    });
    await prismaWrite.transaction.create({
      data: {
        id: `contract-abi-soak-tx-${token}`,
        hash: `contract-abi-soak-hash-${token}`,
        ledgerSequence,
        ledgerCloseTime: new Date(),
        sourceAccount: `contract-abi-soak-source-${token}`,
        contractAddress: address,
        functionName,
        rawXdr: 'soak-test-xdr',
        status: 'success',
      },
    });

    if (global.gc) global.gc();
    const heapStart = process.memoryUsage().heapUsed;
    const started = Date.now();
    const intervalMs = 1000 / TARGET_RPS;
    let nextAt = started;

    while (Date.now() - started < DURATION_SEC * 1000) {
      const requestStarted = performance.now();
      try {
        const result = await createContractAbiSubmission(
          {
            address,
            network: 'testnet',
            name: 'ABI submission soak fixture',
            description: `soak-${submissions}`,
            abi: { functions: [{ name: functionName, inputs: [{ name: 'value', type: 'i128' }] }] },
          },
          `soak-${token}`,
        );
        if (result.duplicate) throw new Error('unique soak payload unexpectedly deduplicated');
      } catch {
        failures += 1;
      }
      latencies.push(performance.now() - requestStarted);
      submissions += 1;
      nextAt += intervalMs;
      const waitMs = nextAt - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (global.gc) global.gc();
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapStart) / 1024 / 1024;
    latencies.sort((a, b) => a - b);
    const percentile = (percent: number) =>
      Math.round(latencies[Math.min(latencies.length - 1, Math.floor((percent / 100) * latencies.length))] ?? 0);
    const elapsedSec = (Date.now() - started) / 1000;
    const achievedRps = submissions / elapsedSec;
    const report = {
      durationSec: Math.round(elapsedSec),
      targetRequestsPerSec: TARGET_RPS,
      achievedRequestsPerSec: Math.round(achievedRps * 100) / 100,
      submissions,
      failures,
      latencyMs: { p50: percentile(50), p95: percentile(95), p99: percentile(99) },
      heapGrowthMb: Math.round(heapGrowthMb * 10) / 10,
      budgets: { p99Ms: P99_BUDGET_MS, heapGrowthMb: HEAP_BUDGET_MB },
    };
    const violations: string[] = [];
    if (failures > 0) violations.push(`${failures} failed submission(s)`);
    if (report.latencyMs.p99 > P99_BUDGET_MS) violations.push('p99 latency over budget');
    if (achievedRps < TARGET_RPS * 0.9) violations.push('could not sustain target rate');
    if (heapGrowthMb > HEAP_BUDGET_MB) violations.push('heap growth over budget');
    process.stdout.write(JSON.stringify({ ...report, pass: violations.length === 0, violations }, null, 2) + '\n');
    if (violations.length > 0) process.exitCode = 1;
  } finally {
    await prismaWrite.contractAbiSubmission.deleteMany({ where: { address } });
    await prismaWrite.transaction.deleteMany({ where: { contractAddress: address } });
    await prismaWrite.contractNetwork.deleteMany({ where: { address } });
    await prismaWrite.contract.deleteMany({ where: { address } });
    if (ledgerSequence) await prismaWrite.ledger.deleteMany({ where: { sequence: ledgerSequence } });
    await prismaWrite.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`contract ABI submission soak failed: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
