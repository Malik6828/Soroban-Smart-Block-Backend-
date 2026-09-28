/**
 * Public dataset & bulk-download exports (ECO02 / #1013).
 *
 * Public:
 *   GET  /api/v1/datasets                              — catalog with schema + freshness
 *   GET  /api/v1/datasets/:dataset                     — dataset detail
 *   GET  /api/v1/datasets/:dataset/manifests           — published snapshots (newest first)
 *   GET  /api/v1/datasets/:dataset/manifests/latest    — latest snapshot manifest
 * Admin:
 *   POST /api/v1/datasets/:dataset/manifests           — publish a generated snapshot manifest
 *
 * Files are served from DATASET_PUBLIC_BASE_URL (S3/HTTP). Generation is rate-aware: a dataset
 * cannot be republished more often than its `minIntervalMinutes`.
 */
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';

export type DatasetId = 'transactions' | 'events' | 'contracts' | 'tokens';
export type DatasetFormat = 'parquet' | 'csv';

interface DatasetDefinition {
  id: DatasetId;
  description: string;
  cadence: 'hourly' | 'daily';
  minIntervalMinutes: number;
  partitionBy: string;
  columns: { name: string; type: string }[];
}

export interface DatasetFile {
  path: string;
  format: DatasetFormat;
  rows: number;
  bytes: number;
  sha256: string;
  url: string;
}

export interface DatasetManifest {
  id: string;
  dataset: DatasetId;
  schemaVersion: number;
  ledgerRange: { from: number; to: number };
  files: DatasetFile[];
  totalRows: number;
  totalBytes: number;
  publishedAt: string;
}

const HOUR = 60;
const CADENCE_MINUTES = { hourly: HOUR, daily: 24 * HOUR };

export const DATASETS: Record<DatasetId, DatasetDefinition> = {
  transactions: {
    id: 'transactions',
    description: 'All Soroban transactions with fees, status and invoked contract',
    cadence: 'hourly',
    minIntervalMinutes: 30,
    partitionBy: 'ledger_date',
    columns: [
      { name: 'hash', type: 'string' },
      { name: 'ledger', type: 'int64' },
      { name: 'ledger_date', type: 'date' },
      { name: 'source_account', type: 'string' },
      { name: 'contract_id', type: 'string' },
      { name: 'fee_charged', type: 'int64' },
      { name: 'successful', type: 'bool' },
    ],
  },
  events: {
    id: 'events',
    description: 'Decoded contract events',
    cadence: 'hourly',
    minIntervalMinutes: 30,
    partitionBy: 'ledger_date',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'ledger', type: 'int64' },
      { name: 'ledger_date', type: 'date' },
      { name: 'contract_id', type: 'string' },
      { name: 'topic', type: 'string' },
      { name: 'data_json', type: 'string' },
    ],
  },
  contracts: {
    id: 'contracts',
    description: 'Deployed contracts with wasm hash and deployer',
    cadence: 'daily',
    minIntervalMinutes: 6 * HOUR,
    partitionBy: 'deployed_date',
    columns: [
      { name: 'contract_id', type: 'string' },
      { name: 'wasm_hash', type: 'string' },
      { name: 'deployer', type: 'string' },
      { name: 'deployed_ledger', type: 'int64' },
      { name: 'deployed_date', type: 'date' },
    ],
  },
  tokens: {
    id: 'tokens',
    description: 'Token contracts (SEP-41 / SAC) with metadata and supply',
    cadence: 'daily',
    minIntervalMinutes: 6 * HOUR,
    partitionBy: 'snapshot_date',
    columns: [
      { name: 'contract_id', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'decimals', type: 'int32' },
      { name: 'total_supply', type: 'decimal(38,0)' },
      { name: 'snapshot_date', type: 'date' },
    ],
  },
};

const SCHEMA_VERSION = 1;
const MAX_MANIFESTS_PER_DATASET = 500;
const manifests = new Map<DatasetId, DatasetManifest[]>();

/** Test helper — clears published manifests. */
export function resetPublicDatasets(): void {
  manifests.clear();
}

const FileSchema = z.object({
  path: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_\-=/.]+\.(parquet|csv|csv\.gz)$/, 'Invalid file path')
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'Invalid file path'),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const PublishSchema = z
  .object({
    ledgerRange: z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
    files: z.array(FileSchema).min(1).max(1_000),
  })
  .refine((b) => b.ledgerRange.to >= b.ledgerRange.from, 'ledgerRange.to must be >= from');

function baseUrl(): string {
  return (process.env.DATASET_PUBLIC_BASE_URL ?? '/datasets').replace(/\/+$/, '');
}

function freshness(def: DatasetDefinition) {
  const latest = manifests.get(def.id)?.[0];
  const expectedMinutes = CADENCE_MINUTES[def.cadence];
  if (!latest) return { lastPublishedAt: null, ageMinutes: null, expectedMinutes, stale: true };
  const ageMinutes = Math.floor((Date.now() - Date.parse(latest.publishedAt)) / 60_000);
  // Stale once a full cadence period has been missed.
  return {
    lastPublishedAt: latest.publishedAt,
    ageMinutes,
    expectedMinutes,
    stale: ageMinutes > expectedMinutes * 2,
  };
}

function describe(def: DatasetDefinition) {
  return {
    ...def,
    schemaVersion: SCHEMA_VERSION,
    formats: ['parquet', 'csv'] as DatasetFormat[],
    freshness: freshness(def),
  };
}

function getDataset(req: Request, res: Response): DatasetDefinition | undefined {
  const def = Object.prototype.hasOwnProperty.call(DATASETS, req.params.dataset)
    ? DATASETS[req.params.dataset as DatasetId]
    : undefined;
  if (!def) res.status(404).json({ error: 'Dataset not found' });
  return def;
}

export const publicDatasetsRouter = Router();

publicDatasetsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ data: Object.values(DATASETS).map(describe) });
});

publicDatasetsRouter.get('/:dataset', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (def) res.json(describe(def));
});

publicDatasetsRouter.get('/:dataset/manifests', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const list = manifests.get(def.id) ?? [];
  res.json({ data: list.slice(0, limit), total: list.length });
});

publicDatasetsRouter.get('/:dataset/manifests/latest', (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const latest = manifests.get(def.id)?.[0];
  if (!latest) {
    res.status(404).json({ error: 'No snapshot published yet' });
    return;
  }
  res.json(latest);
});

publicDatasetsRouter.post('/:dataset/manifests', adminAuth, (req: Request, res: Response) => {
  const def = getDataset(req, res);
  if (!def) return;
  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid manifest', details: parsed.error.flatten() });
    return;
  }
  const list = manifests.get(def.id) ?? [];
  const last = list[0];
  if (last) {
    const elapsedMin = (Date.now() - Date.parse(last.publishedAt)) / 60_000;
    if (elapsedMin < def.minIntervalMinutes) {
      const retryAfter = Math.ceil((def.minIntervalMinutes - elapsedMin) * 60);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Dataset was published too recently', retryAfter });
      return;
    }
  }
  const files: DatasetFile[] = parsed.data.files.map((f) => ({
    ...f,
    format: f.path.endsWith('.parquet') ? 'parquet' : 'csv',
    url: `${baseUrl()}/${def.id}/${f.path}`,
  }));
  const publishedAt = new Date().toISOString();
  const manifest: DatasetManifest = {
    id: createHash('sha256')
      .update(`${def.id}:${publishedAt}:${files.map((f) => f.sha256).join(',')}`)
      .digest('hex')
      .slice(0, 16),
    dataset: def.id,
    schemaVersion: SCHEMA_VERSION,
    ledgerRange: parsed.data.ledgerRange,
    files,
    totalRows: files.reduce((s, f) => s + f.rows, 0),
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    publishedAt,
  };
  list.unshift(manifest);
  manifests.set(def.id, list.slice(0, MAX_MANIFESTS_PER_DATASET));
  res.status(201).json(manifest);
});
