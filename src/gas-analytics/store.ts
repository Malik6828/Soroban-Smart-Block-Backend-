import { prismaRead, prismaWrite } from '../db';

/**
 * Shared model for gas analytics indexing, used by
 * `src/indexer/gasAnalyticsEngine.ts`.
 *
 * The gas analytics tables (`gas_analytics`, `gas_alerts`,
 * `gas_optimization_suggestions`) are not declared in
 * `prisma/schema.prisma`, so PrismaClient's generated delegate types reject
 * every access. Declaring the row shapes here gives each call site a concrete
 * result type instead of `any`.
 */

/** Per-transaction resource usage recorded by the gas indexer. */
export type GasAnalyticsRow = {
  id: string;
  txHash: string;
  contractAddress: string;
  functionName: string;
  cpuInstructions: number;
  memoryBytes: number;
  ledgerReadBytes: number;
  ledgerWriteBytes: number;
  ledgerEntryCount: number;
  contractEventsBytes: number;
  returnValueBytes: number;
  hostFunctionCalls: number;
  contractCalls: number;
  storageAccesses: number;
  txSizeBytes: number;
  /** Fee in stroops, kept as a string to avoid float drift. */
  totalFee: string;
  effectiveFeePerInstr: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  failureFlag: boolean;
  errorCode: string | null;
  createdAt: Date;
};

/** An anomaly or cost-spike alert raised by the detector. */
export type GasAlertRow = {
  id: string;
  contractAddress: string;
  alertType: string;
  severity: string;
  metric: string;
  currentValue: number;
  baselineValue: number;
  deviationPct: number;
  txHash: string | null;
  message: string;
  detectedAt: Date;
  createdAt: Date;
};

/** A cost-reduction suggestion derived from per-function gas averages. */
export type GasOptimizationSuggestionRow = {
  id: string;
  contractAddress: string;
  functionName: string;
  suggestionType: string;
  title: string;
  description: string;
  currentCost: string;
  estimatedSavings: string;
  savingsPct: number;
  effort: string;
  severity: string;
  createdAt: Date;
  updatedAt: Date;
};

export type GasAnalyticsQueryArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  skip?: number;
  take?: number;
  cursor?: Record<string, unknown>;
};

export type GasAnalyticsWriteArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

/** Arguments for `upsert`, which takes separate create and update payloads. */
export type GasAnalyticsUpsertArgs = {
  where: Record<string, unknown>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/**
 * Delegate surface for a single gas analytics model. The `T` parameter lets
 * callers request a projected row shape for `select` queries.
 */
export interface GasAnalyticsDelegate<TRow> {
  findMany<T = TRow>(args?: GasAnalyticsQueryArgs): Promise<T[]>;
  findUnique<T = TRow>(args: GasAnalyticsQueryArgs): Promise<T | null>;
  findFirst<T = TRow>(args?: GasAnalyticsQueryArgs): Promise<T | null>;
  count(args?: GasAnalyticsQueryArgs): Promise<number>;
  aggregate<T = { _sum: Record<string, number | null>; _count: number }>(
    args?: GasAnalyticsQueryArgs,
  ): Promise<T>;
  create<T = TRow>(args: GasAnalyticsWriteArgs): Promise<T>;
  update<T = TRow>(args: GasAnalyticsWriteArgs): Promise<T>;
  upsert<T = TRow>(args: GasAnalyticsUpsertArgs): Promise<T>;
  delete<T = TRow>(args: GasAnalyticsWriteArgs): Promise<T>;
  deleteMany(args?: GasAnalyticsQueryArgs): Promise<{ count: number }>;
}

export interface GasAnalyticsModels {
  gasAnalytics: GasAnalyticsDelegate<GasAnalyticsRow>;
  gasAlert: GasAnalyticsDelegate<GasAlertRow>;
  gasOptimizationSuggestion: GasAnalyticsDelegate<GasOptimizationSuggestionRow>;
}

// Single narrowing point for the gas analytics subsystem.
const asGasAnalyticsModels = (client: unknown): GasAnalyticsModels => client as GasAnalyticsModels;

export const gasAnalyticsRead: GasAnalyticsModels = asGasAnalyticsModels(prismaRead);
export const gasAnalyticsWrite: GasAnalyticsModels = asGasAnalyticsModels(prismaWrite);
