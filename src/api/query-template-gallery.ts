/**
 * Community analytics query-template gallery (ECO04 / #1015).
 *
 * All routes require an API key; the key's developer is the author/actor.
 *   GET    /api/v1/query-templates                 — search (q, tag, author, sort=stars|recent)
 *   GET    /api/v1/query-templates/:id             — template detail
 *   POST   /api/v1/query-templates                 — create
 *   PATCH  /api/v1/query-templates/:id             — update (author only)
 *   DELETE /api/v1/query-templates/:id             — delete (author only)
 *   POST   /api/v1/query-templates/:id/fork        — fork into caller's namespace
 *   POST   /api/v1/query-templates/:id/star        — star
 *   DELETE /api/v1/query-templates/:id/star        — unstar
 *   POST   /api/v1/query-templates/:id/run         — sandboxed execution
 *
 * Sandbox: single read-only SELECT/WITH statement, DDL/DML and system catalogs rejected,
 * `{{param}}` placeholders bound from validated literals, row LIMIT enforced, and the
 * query engine's scan-byte and timeout budgets applied.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { executeQuery } from '../analytics/query-engine/query-router';

export interface QueryTemplate {
  id: string;
  title: string;
  description: string;
  sql: string;
  tags: string[];
  params: Record<string, string | number>;
  authorId: string;
  forkedFrom?: string;
  stars: number;
  forks: number;
  createdAt: string;
  updatedAt: string;
}

const MAX_TEMPLATES = 10_000;
const MAX_ROWS = 10_000;
const SANDBOX_MAX_SCAN_BYTES = 10 * 1024 ** 3;
const SANDBOX_TIMEOUT_MS = 30_000;

const templates = new Map<string, QueryTemplate>();
const starsByTemplate = new Map<string, Set<string>>();

/** Test helper — clears the in-memory gallery. */
export function resetQueryTemplateGallery(): void {
  templates.clear();
  starsByTemplate.clear();
}

const FORBIDDEN_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'drop',
  'create',
  'alter',
  'truncate',
  'grant',
  'revoke',
  'call',
  'execute',
  'prepare',
  'deallocate',
  'unload',
  'msck',
  'set',
  'use',
  'reset',
];
const FORBIDDEN = new RegExp(
  `\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b|information_schema|system\\.|\\$path`,
  'i',
);

/** Returns a reason the SQL is rejected by the sandbox, or undefined if allowed. */
export function validateSandboxSql(sql: string): string | undefined {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(stripped)) return 'Only SELECT/WITH queries are allowed';
  if (stripped.includes(';')) return 'Multiple statements are not allowed';
  const withoutStrings = stripped.replace(/'(?:[^']|'')*'/g, "''");
  if (FORBIDDEN.test(withoutStrings)) return 'Query uses a forbidden keyword or catalog';
  return undefined;
}

const paramName = z.string().regex(/^[a-z_][a-z0-9_]{0,31}$/i);
const paramValue = z.union([
  z.number().finite(),
  z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_\-:.]*$/, 'Param strings must be alphanumeric/_-:.'),
]);
const tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

const CreateSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2_000).default(''),
  sql: z
    .string()
    .min(1)
    .max(16_000)
    .superRefine((s, ctx) => {
      const reason = validateSandboxSql(s);
      if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
    }),
  tags: z.array(tag).max(10).default([]),
  params: z.record(paramName, paramValue).default({}),
});
const UpdateSchema = CreateSchema.partial();
const RunSchema = z.object({
  params: z.record(paramName, paramValue).default({}),
  limit: z.number().int().min(1).max(MAX_ROWS).default(1_000),
});

export function bindParams(sql: string, params: Record<string, string | number>): string {
  return sql.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`Missing parameter "${name}"`);
    }
    const v = params[name];
    return typeof v === 'number' ? String(v) : `'${v}'`;
  });
}

function actorId(req: Request): string | undefined {
  return req.apiKey?.developerId ?? req.apiKey?.id;
}

function publicView(t: QueryTemplate, viewer?: string) {
  return { ...t, starredByMe: viewer ? !!starsByTemplate.get(t.id)?.has(viewer) : false };
}

function load(req: Request, res: Response): QueryTemplate | undefined {
  const t = templates.get(req.params.id);
  if (!t) res.status(404).json({ error: 'Template not found' });
  return t;
}

function loadOwned(req: Request, res: Response): QueryTemplate | undefined {
  const t = load(req, res);
  if (t && t.authorId !== actorId(req)) {
    res.status(403).json({ error: 'Only the author can modify this template' });
    return undefined;
  }
  return t;
}

export const queryTemplateGalleryRouter = Router();

queryTemplateGalleryRouter.get('/', (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().slice(0, 100) : '';
  const t = typeof req.query.tag === 'string' ? req.query.tag.toLowerCase() : '';
  const author = typeof req.query.author === 'string' ? req.query.author : '';
  const sort = req.query.sort === 'recent' ? 'recent' : 'stars';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const matches = [...templates.values()]
    .filter(
      (x) =>
        (!t || x.tags.includes(t)) &&
        (!author || x.authorId === author) &&
        (!q || x.title.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)),
    )
    .sort((a, b) =>
      sort === 'stars' ? b.stars - a.stars : b.createdAt.localeCompare(a.createdAt),
    );
  res.json({
    data: matches.slice(offset, offset + limit).map((x) => publicView(x, actorId(req))),
    total: matches.length,
  });
});

queryTemplateGalleryRouter.get('/:id', (req: Request, res: Response) => {
  const t = load(req, res);
  if (t) res.json(publicView(t, actorId(req)));
});

queryTemplateGalleryRouter.post('/', (req: Request, res: Response) => {
  const author = actorId(req);
  if (!author) {
    res.status(401).json({ error: 'API key required' });
    return;
  }
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid template', details: parsed.error.flatten() });
    return;
  }
  if (templates.size >= MAX_TEMPLATES) {
    res.status(507).json({ error: 'Template gallery is full' });
    return;
  }
  const now = new Date().toISOString();
  const t: QueryTemplate = {
    id: randomUUID(),
    ...parsed.data,
    authorId: author,
    stars: 0,
    forks: 0,
    createdAt: now,
    updatedAt: now,
  };
  templates.set(t.id, t);
  res.status(201).json(publicView(t, author));
});

queryTemplateGalleryRouter.patch('/:id', (req: Request, res: Response) => {
  const t = loadOwned(req, res);
  if (!t) return;
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid template', details: parsed.error.flatten() });
    return;
  }
  Object.assign(t, parsed.data, { updatedAt: new Date().toISOString() });
  res.json(publicView(t, actorId(req)));
});

queryTemplateGalleryRouter.delete('/:id', (req: Request, res: Response) => {
  const t = loadOwned(req, res);
  if (!t) return;
  templates.delete(t.id);
  starsByTemplate.delete(t.id);
  res.status(204).end();
});

queryTemplateGalleryRouter.post('/:id/fork', (req: Request, res: Response) => {
  const src = load(req, res);
  const author = actorId(req);
  if (!src || !author) {
    if (src) res.status(401).json({ error: 'API key required' });
    return;
  }
  if (templates.size >= MAX_TEMPLATES) {
    res.status(507).json({ error: 'Template gallery is full' });
    return;
  }
  const now = new Date().toISOString();
  const fork: QueryTemplate = {
    ...src,
    id: randomUUID(),
    title: typeof req.body?.title === 'string' ? req.body.title.slice(0, 120) : src.title,
    tags: [...src.tags],
    params: { ...src.params },
    authorId: author,
    forkedFrom: src.id,
    stars: 0,
    forks: 0,
    createdAt: now,
    updatedAt: now,
  };
  src.forks += 1;
  templates.set(fork.id, fork);
  res.status(201).json(publicView(fork, author));
});

function setStar(starred: boolean) {
  return (req: Request, res: Response) => {
    const t = load(req, res);
    const who = actorId(req);
    if (!t || !who) {
      if (t) res.status(401).json({ error: 'API key required' });
      return;
    }
    const set = starsByTemplate.get(t.id) ?? new Set<string>();
    if (starred) set.add(who);
    else set.delete(who);
    starsByTemplate.set(t.id, set);
    t.stars = set.size;
    res.json({ id: t.id, stars: t.stars, starredByMe: starred });
  };
}

queryTemplateGalleryRouter.post('/:id/star', setStar(true));
queryTemplateGalleryRouter.delete('/:id/star', setStar(false));

queryTemplateGalleryRouter.post(
  '/:id/run',
  asyncHandler(async (req: Request, res: Response) => {
    const t = load(req, res);
    if (!t) return;
    const parsed = RunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid run request', details: parsed.error.flatten() });
      return;
    }
    let sql: string;
    try {
      sql = bindParams(t.sql, { ...t.params, ...parsed.data.params });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const reason = validateSandboxSql(sql);
    if (reason) {
      res.status(400).json({ error: reason });
      return;
    }
    const inner = sql.trim().replace(/;\s*$/, '');
    const limited = `SELECT * FROM (${inner}) AS sandboxed LIMIT ${parsed.data.limit}`;
    try {
      const { result, estimate } = await executeQuery({
        sql: limited,
        maxScanBytes: SANDBOX_MAX_SCAN_BYTES,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      });
      res.json({ templateId: t.id, result, estimate });
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  }),
);
