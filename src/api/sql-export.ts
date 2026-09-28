/**
 * Analytics template SQL export (ECO07 / #1018).
 *
 * GET /api/v1/analytics/sql-export              — list exportable templates
 * GET /api/v1/analytics/sql-export/:templateId  — render a template as runnable SQL
 *
 * Query params:
 *   dialect  trino (default) | athena
 *   format   json (default) | sql — `sql` returns a downloadable .sql file
 *   <param>  any template parameter override (validated against the template defaults)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  DASHBOARD_TEMPLATES,
  DashboardTemplate,
  getTemplate,
  interpolateTemplate,
} from '../analytics/dashboards/templates';

export const sqlExportRouter = Router();

export type SqlDialect = 'trino' | 'athena';

const QuerySchema = z.object({
  dialect: z.enum(['trino', 'athena']).default('trino'),
  format: z.enum(['json', 'sql']).default('json'),
});

const RESERVED = new Set(['dialect', 'format']);

/** Validate raw overrides against the template's declared parameters and types. */
export function validateParams(
  template: DashboardTemplate,
  raw: Record<string, unknown>,
): { params: Record<string, string | number>; errors: string[] } {
  const params: Record<string, string | number> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED.has(key)) continue;
    if (!(key in template.defaultParams)) {
      errors.push(`Unknown parameter: ${key}`);
      continue;
    }
    if (typeof value !== 'string' || value.length > 256) {
      errors.push(`Invalid value for parameter: ${key}`);
      continue;
    }
    if (typeof template.defaultParams[key] === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`Parameter ${key} must be numeric`);
        continue;
      }
      params[key] = n;
    } else {
      params[key] = value;
    }
  }
  return { params, errors };
}

/** Render a template as standalone SQL for the requested dialect. */
export function renderTemplateSql(
  template: DashboardTemplate,
  params: Record<string, string | number>,
  dialect: SqlDialect,
): string {
  let sql = interpolateTemplate(template, params).trim();
  if (dialect === 'athena') {
    // Athena (engine v3) does not accept the `TIMESTAMP WITH TIME ZONE` cast shorthand
    // used by some Trino templates; normalise to plain TIMESTAMP.
    sql = sql.replace(/TIMESTAMP WITH TIME ZONE/gi, 'TIMESTAMP');
  }
  const header = [
    `-- Template: ${template.id} (${template.name})`,
    `-- Dialect: ${dialect}`,
    `-- Exported: ${new Date().toISOString()}`,
  ].join('\n');
  return `${header}\n${sql.replace(/;\s*$/, '')};\n`;
}

sqlExportRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    dialects: ['trino', 'athena'],
    templates: DASHBOARD_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      params: t.defaultParams,
    })),
  });
});

sqlExportRouter.get('/:templateId', (req: Request, res: Response) => {
  const template = getTemplate(req.params.templateId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const q = QuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.flatten() });

  const { params, errors } = validateParams(template, req.query as Record<string, unknown>);
  if (errors.length) return res.status(400).json({ error: 'Invalid parameters', details: errors });

  const sql = renderTemplateSql(template, params, q.data.dialect);
  if (q.data.format === 'sql') {
    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${template.id}.${q.data.dialect}.sql"`,
    );
    return res.send(sql);
  }
  res.json({
    templateId: template.id,
    dialect: q.data.dialect,
    params: { ...template.defaultParams, ...params },
    sql,
  });
});
