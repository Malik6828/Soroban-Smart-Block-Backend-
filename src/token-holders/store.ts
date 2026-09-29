import type { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';

/**
 * Shared model for token-holder tracking, used by both the read path
 * (`src/api/token-holders.ts`) and the write path
 * (`src/indexer/tokenHolderTracker.ts`).
 *
 * The holder tables (`token_holders`, `whale_alerts`,
 * `token_concentration_metrics`, `holder_cohorts`) are not declared in
 * `prisma/schema.prisma`, so PrismaClient's generated delegate types reject
 * every access. Declaring the row shapes here gives both sides one typed
 * contract instead of each call site degrading to `any`.
 */

/** A holder's balance as tracked for a single contract. */
export type HolderSnapshot = {
  id: string;
  contractAddress: string;
  holderAddress: string;
  /** Exact balance, kept as a string to avoid float drift on token amounts. */
  balance: string;
  /** The same balance as a number, for ranking and concentration maths. */
  balanceRaw: number;
  /** Share of total supply held, as a percentage. */
  percentage: number;
  rank: number | null;
  firstSeenAt: Date;
  lastUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A single balance movement produced by a SEP-41 transfer, as seen by
 * `updateHolderBalance`. `delta` is negative when tokens leave the holder.
 */
export type TokenHolderDelta = {
  contractAddress: string;
  holderAddress: string;
  delta: number;
  txHash: string;
  /** Balance before the movement; 0 when the holder is new. */
  oldBalance: number;
  /** Balance after the movement, clamped at 0. */
  newBalance: number;
  /** Total contract supply after the movement. */
  totalSupply: number;
};

/** The balance pair carried across a transfer, before and after. */
export type HolderBalanceChange = {
  oldBalance: number;
  newBalance: number;
  changeAmt: number;
  changePct: number;
};

/** A whale alert emitted when a holder's balance moves past a threshold. */
export type WhaleAlertRow = {
  id: string;
  contractAddress: string;
  holderAddress: string;
  alertType: string;
  oldBalance: string;
  newBalance: string;
  changeAmt: string;
  changePct: number;
  txHash: string | null;
  detectedAt: Date;
  createdAt: Date;
};

/** Cached concentration metrics for a contract, recomputed on transfer. */
export type TokenConcentrationMetricsRow = {
  id: string;
  contractAddress: string;
  nakamotoCoefficient: number;
  hhi: number;
  giniCoefficient: number;
  top10Pct: number;
  top100Pct: number;
  totalHolders: number;
  totalSupply: string;
  computedAt: Date;
  createdAt: Date;
};

/** Retention statistics for a cohort of holders that joined in one period. */
export type HolderCohortRow = {
  id: string;
  contractAddress: string;
  cohortPeriod: string;
  cohortStart: Date;
  initialHolders: number;
  retainedAt30d: number | null;
  retainedAt60d: number | null;
  retainedAt90d: number | null;
  avgHoldTime: number | null;
  createdAt: Date;
};

/** Result of summing a numeric column across a set of rows. */
export type HolderAggregate = {
  _sum: { balanceRaw: number | null };
  _count: number;
};

export type TokenHolderQueryArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  skip?: number;
  take?: number;
  cursor?: Record<string, unknown>;
};

export type TokenHolderWriteArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

/** Arguments for `aggregate`, which selects accumulators rather than columns. */
export type TokenHolderAggregateArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  _sum?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
  _count?: boolean | Record<string, boolean>;
};

/**
 * Delegate surface for a single token-holder model. The `T` parameter lets
 * callers request a projected row shape for `select`/`include` queries.
 */
export interface TokenHolderDelegate<TRow> {
  findMany<T = TRow>(args?: TokenHolderQueryArgs): Promise<T[]>;
  findUnique<T = TRow>(args: TokenHolderQueryArgs): Promise<T | null>;
  findFirst<T = TRow>(args?: TokenHolderQueryArgs): Promise<T | null>;
  count(args?: TokenHolderQueryArgs): Promise<number>;
  aggregate<T = HolderAggregate>(args?: TokenHolderAggregateArgs): Promise<T>;
  create<T = TRow>(args: TokenHolderWriteArgs): Promise<T>;
  update<T = TRow>(args: TokenHolderWriteArgs): Promise<T>;
  delete<T = TRow>(args: TokenHolderWriteArgs): Promise<T>;
  deleteMany(args?: TokenHolderQueryArgs): Promise<{ count: number }>;
}

export interface TokenHolderModels {
  tokenHolder: TokenHolderDelegate<HolderSnapshot>;
  whaleAlert: TokenHolderDelegate<WhaleAlertRow>;
  tokenConcentrationMetrics: TokenHolderDelegate<TokenConcentrationMetricsRow>;
  holderCohort: TokenHolderDelegate<HolderCohortRow>;
}

// Single narrowing point for the token-holder subsystem.
const asTokenHolderModels = (client: unknown): TokenHolderModels => client as TokenHolderModels;

export const tokenHolderRead: TokenHolderModels = asTokenHolderModels(prismaRead);
export const tokenHolderWrite: TokenHolderModels = asTokenHolderModels(prismaWrite);

export type { Prisma };
