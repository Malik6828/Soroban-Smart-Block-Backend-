/**
 * src/db/raw.ts
 *
 * Raw-SQL access for indexer-internal tables that have no Prisma model
 * (e.g. `adaptive_polling_state`). Prisma owns the domain tables; this module
 * only serves parameterized queries against the same database the Prisma
 * clients point at, so indexer state survives process restarts.
 *
 * Every call site must pass values as the second argument (`$1, $2, …`
 * placeholders) — string interpolation of user-influenced input is rejected
 * by design; see docs/security/sql-injection.md.
 */

import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // A pooled background client that idle-errors must not crash the process.
    pool.on('error', (err) => {
      logger.error(`[db/raw] idle client error: ${err.message}`);
    });
  }
  return pool;
}

/**
 * Run a parameterized raw-SQL statement.
 * Shape-compatible with the previous `db.query(sql, params)` call sites so the
 * indexer modules keep their call signature.
 */
export async function rawQuery<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[]);
}

/**
 * Run a callback with a dedicated client (multi-statement transactions).
 */
export async function withRawClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Close the pool (graceful shutdown / tests).
 */
export async function closeRawPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
