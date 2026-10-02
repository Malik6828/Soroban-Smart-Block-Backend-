/**
 * Versioned schema registry for decoded events (ECO06 / #1017).
 *
 * Public:
 *   GET  /api/v1/event-schemas                                  — list events + latest version
 *   GET  /api/v1/event-schemas/:event                           — all versions of an event
 *   GET  /api/v1/event-schemas/:event/versions/:version         — one version (or `latest`)
 *   GET  /api/v1/event-schemas/:event/versions/:version/json-schema — JSON-Schema export
 *   POST /api/v1/event-schemas/:event/compatibility             — dry-run compatibility check
 * Admin:
 *   POST /api/v1/event-schemas/:event                           — register a new version
 *
 * Compatibility (`backward`, the default): a new version may add optional fields but may not
 * remove fields, change a field's type, or add/promote required fields. `none` skips checks.
 */
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';

export const FIELD_TYPES = [
  'address',
  'bool',
  'bytes',
  'i32',
  'i64',
  'i128',
  'u32',
  'u64',
  'u128',
  'string',
  'symbol',
  'map',
  'vec',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface SchemaField {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
}

export interface SchemaVersion {
  event: string;
  version: number;
  fields: SchemaField[];
  compatibility: 'backward' | 'none';
  fingerprint: string;
  createdAt: string;
}

const eventName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Invalid event name');

const FieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  description: z.string().max(300).optional(),
});

const RegisterSchema = z.object({
  fields: z
    .array(FieldSchema)
    .min(1)
    .max(100)
    .refine((f) => new Set(f.map((x) => x.name)).size === f.length, 'Duplicate field names'),
  compatibility: z.enum(['backward', 'none']).default('backward'),
});

const MAX_VERSIONS_PER_EVENT = 200;
const registry = new Map<string, SchemaVersion[]>();

/** Test helper — clears the in-memory registry. */
export function resetEventSchemaRegistry(): void {
  registry.clear();
}

function fingerprint(fields: SchemaField[]): string {
  const canonical = [...fields]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${f.type}:${f.required ? 1 : 0}`)
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Returns a list of backward-compatibility violations (empty when compatible). */
export function checkBackwardCompatibility(prev: SchemaField[], next: SchemaField[]): string[] {
  const issues: string[] = [];
  const nextByName = new Map(next.map((f) => [f.name, f]));
  const prevNames = new Set(prev.map((f) => f.name));
  for (const p of prev) {
    const n = nextByName.get(p.name);
    if (!n) {
      issues.push(`Field "${p.name}" was removed`);
    } else if (n.type !== p.type) {
      issues.push(`Field "${p.name}" changed type ${p.type} -> ${n.type}`);
    } else if (n.required && !p.required) {
      issues.push(`Field "${p.name}" became required`);
    }
  }
  for (const n of next) {
    if (!prevNames.has(n.name) && n.required) issues.push(`New field "${n.name}" must be optional`);
  }
  return issues;
}

const JSON_TYPE: Record<FieldType, object> = {
  address: { type: 'string', pattern: '^[CG][A-Z2-7]{55}$' },
  bool: { type: 'boolean' },
  bytes: { type: 'string', contentEncoding: 'base64' },
  i32: { type: 'integer' },
  i64: { type: 'string', pattern: '^-?\\d+$' },
  i128: { type: 'string', pattern: '^-?\\d+$' },
  u32: { type: 'integer', minimum: 0 },
  u64: { type: 'string', pattern: '^\\d+$' },
  u128: { type: 'string', pattern: '^\\d+$' },
  string: { type: 'string' },
  symbol: { type: 'string' },
  map: { type: 'object' },
  vec: { type: 'array' },
};

export function toJsonSchema(v: SchemaVersion): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:soroban-explorer:event:${v.event}:v${v.version}`,
    title: `${v.event} v${v.version}`,
    type: 'object',
    properties: Object.fromEntries(
      v.fields.map((f) => [
        f.name,
        { ...JSON_TYPE[f.type], ...(f.description ? { description: f.description } : {}) },
      ]),
    ),
    required: v.fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };
}

function findVersion(event: string, version: string): SchemaVersion | undefined {
  const versions = registry.get(event);
  if (!versions?.length) return undefined;
  if (version === 'latest') return versions[versions.length - 1];
  const n = Number(version);
  return Number.isInteger(n) ? versions.find((v) => v.version === n) : undefined;
}

function parseEvent(req: Request, res: Response): string | undefined {
  const parsed = eventName.safeParse(req.params.event);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event name' });
    return undefined;
  }
  return parsed.data;
}

export const eventSchemaRegistryRouter = Router();

eventSchemaRegistryRouter.get('/', (_req: Request, res: Response) => {
  const data = [...registry.entries()].map(([event, versions]) => ({
    event,
    latestVersion: versions[versions.length - 1].version,
    versions: versions.length,
  }));
  res.json({ data, total: data.length });
});

eventSchemaRegistryRouter.get('/:event', (req: Request, res: Response) => {
  const event = parseEvent(req, res);
  if (!event) return;
  const versions = registry.get(event);
  if (!versions) {
    res.status(404).json({ error: 'Event schema not found' });
    return;
  }
  res.json({ event, versions });
});

eventSchemaRegistryRouter.get('/:event/versions/:version', (req: Request, res: Response) => {
  const event = parseEvent(req, res);
  if (!event) return;
  const v = findVersion(event, req.params.version);
  if (!v) {
    res.status(404).json({ error: 'Schema version not found' });
    return;
  }
  res.json(v);
});

eventSchemaRegistryRouter.get(
  '/:event/versions/:version/json-schema',
  (req: Request, res: Response) => {
    const event = parseEvent(req, res);
    if (!event) return;
    const v = findVersion(event, req.params.version);
    if (!v) {
      res.status(404).json({ error: 'Schema version not found' });
      return;
    }
    res.type('application/schema+json').json(toJsonSchema(v));
  },
);

eventSchemaRegistryRouter.post('/:event/compatibility', (req: Request, res: Response) => {
  const event = parseEvent(req, res);
  if (!event) return;
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid schema', details: parsed.error.flatten() });
    return;
  }
  const latest = findVersion(event, 'latest');
  const issues = latest
    ? checkBackwardCompatibility(
        latest.fields,
        parsed.data.fields as Parameters<typeof checkBackwardCompatibility>[1],
      )
    : [];
  res.json({ event, againstVersion: latest?.version ?? null, compatible: !issues.length, issues });
});

eventSchemaRegistryRouter.post('/:event', adminAuth, (req: Request, res: Response) => {
  const event = parseEvent(req, res);
  if (!event) return;
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid schema', details: parsed.error.flatten() });
    return;
  }
  const versions = registry.get(event) ?? [];
  const latest = versions[versions.length - 1];
  const fields = parsed.data.fields as SchemaField[];
  const fp = fingerprint(fields);
  if (latest?.fingerprint === fp) {
    res.status(200).json({ ...latest, unchanged: true });
    return;
  }
  if (latest && parsed.data.compatibility === 'backward') {
    const issues = checkBackwardCompatibility(latest.fields, fields);
    if (issues.length) {
      res.status(409).json({ error: 'Incompatible schema change', issues });
      return;
    }
  }
  if (versions.length >= MAX_VERSIONS_PER_EVENT) {
    res.status(409).json({ error: 'Version limit reached for this event' });
    return;
  }
  const version: SchemaVersion = {
    event,
    version: (latest?.version ?? 0) + 1,
    fields,
    compatibility: parsed.data.compatibility,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
  };
  versions.push(version);
  registry.set(event, versions);
  res.status(201).json(version);
});
