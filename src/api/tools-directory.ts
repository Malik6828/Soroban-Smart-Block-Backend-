/**
 * Public developer tools & integrations directory (ECO10 / #1021).
 *
 * Public:
 *   GET  /api/v1/tools-directory        — approved entries (filter: tag, q)
 *   GET  /api/v1/tools-directory/:id    — single approved entry
 *   POST /api/v1/tools-directory        — submit an entry (enters moderation as `pending`)
 * Admin (moderation):
 *   GET    /api/v1/tools-directory/admin/all      — all entries (filter: status)
 *   PATCH  /api/v1/tools-directory/admin/:id      — edit fields / approve / reject
 *   DELETE /api/v1/tools-directory/admin/:id      — remove an entry
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';

export type ToolStatus = 'pending' | 'approved' | 'rejected';
export type ToolKind = 'sdk' | 'tool' | 'app' | 'integration';

export interface ToolEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  kind: ToolKind;
  tags: string[];
  status: ToolStatus;
  submittedBy?: string;
  moderationNote?: string;
  createdAt: string;
  updatedAt: string;
}

const httpsUrl = z
  .string()
  .url()
  .max(512)
  .refine((u) => u.startsWith('https://'), 'URL must use https');
const tag = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Tags must be lowercase alphanumeric/dash, max 32 chars');

const SubmitSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(10).max(500),
  url: httpsUrl,
  kind: z.enum(['sdk', 'tool', 'app', 'integration']),
  tags: z.array(tag).max(10).default([]),
  submittedBy: z.string().trim().max(120).optional(),
});

const ModerateSchema = SubmitSchema.partial().extend({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  moderationNote: z.string().max(500).optional(),
});

const MAX_ENTRIES = 5_000;
const entries = new Map<string, ToolEntry>();

/** Test helper — clears the in-memory directory. */
export function resetToolsDirectory(): void {
  entries.clear();
}

function filter(list: ToolEntry[], query: Request['query']): ToolEntry[] {
  const t = typeof query.tag === 'string' ? query.tag.toLowerCase() : undefined;
  const q = typeof query.q === 'string' ? query.q.toLowerCase().slice(0, 100) : undefined;
  return list.filter(
    (e) =>
      (!t || e.tags.includes(t)) &&
      (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)),
  );
}

export const toolsDirectoryRouter = Router();

// ── Moderation (admin) ────────────────────────────────────────────────────────

const admin = Router();
admin.use(adminAuth);

admin.get('/all', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const list = filter([...entries.values()], req.query).filter(
    (e) => !status || e.status === status,
  );
  res.json({ entries: list, total: list.length });
});

admin.patch('/:id', (req: Request, res: Response) => {
  const entry = entries.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const parsed = ModerateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated: ToolEntry = { ...entry, ...parsed.data, updatedAt: new Date().toISOString() };
  entries.set(entry.id, updated);
  res.json(updated);
});

admin.delete('/:id', (req: Request, res: Response) => {
  if (!entries.delete(req.params.id)) return res.status(404).json({ error: 'Entry not found' });
  res.status(204).end();
});

toolsDirectoryRouter.use('/admin', admin);

// ── Public ────────────────────────────────────────────────────────────────────

toolsDirectoryRouter.get('/', (req: Request, res: Response) => {
  const approved = [...entries.values()].filter((e) => e.status === 'approved');
  const list = filter(approved, req.query).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ entries: list, total: list.length });
});

toolsDirectoryRouter.get('/:id', (req: Request, res: Response) => {
  const entry = entries.get(req.params.id);
  if (!entry || entry.status !== 'approved') {
    return res.status(404).json({ error: 'Entry not found' });
  }
  res.json(entry);
});

toolsDirectoryRouter.post('/', (req: Request, res: Response) => {
  const parsed = SubmitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (entries.size >= MAX_ENTRIES) return res.status(503).json({ error: 'Directory is full' });
  const duplicate = [...entries.values()].some((e) => e.url === parsed.data.url);
  if (duplicate) return res.status(409).json({ error: 'An entry with this URL already exists' });
  const now = new Date().toISOString();
  const entry: ToolEntry = {
    id: randomUUID(),
    ...parsed.data,
    tags: [...new Set(parsed.data.tags)],
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  entries.set(entry.id, entry);
  res.status(201).json(entry);
});
