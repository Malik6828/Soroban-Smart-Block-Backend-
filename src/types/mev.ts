/**
 * src/types/mev.ts
 *
 * Canonical MEV classification values.
 *
 * `MevEvent.mevType` is a plain `String` column (see prisma/schema.prisma), so
 * the set of legal values lives in TypeScript rather than in a Postgres enum.
 * Keeping it in a dependency-free module means both runtime code
 * (src/indexer/mev-classifier.ts) and test helpers can import it without
 * pulling in the Prisma client / database layer.
 */
export type MevType =
  | 'sandwich'
  | 'flash_loan_attack'
  | 'backrunning'
  | 'frontrunning'
  | 'cross_dex_arbitrage'
  | 'liquidation'
  | 'jit_liquidity'
  | 'unknown';

/** Human-readable labels for each classification. */
export const MEV_TYPE_LABELS: Record<MevType, string> = {
  sandwich: 'Sandwich Attack',
  flash_loan_attack: 'Flash Loan Attack',
  backrunning: 'Backrunning',
  frontrunning: 'Frontrunning',
  cross_dex_arbitrage: 'Cross-DEX Arbitrage',
  liquidation: 'Liquidation',
  jit_liquidity: 'JIT Liquidity',
  unknown: 'Unknown',
};
