/**
 * On-chain contributor/organization reputation badges (ECO09 / #1020).
 *
 * POST /api/v1/reputation-badges/issue          — (admin) score activity + issue badges
 * GET  /api/v1/reputation-badges/:subject       — display badges issued to a subject
 * GET  /api/v1/reputation-badges/verify/:hash   — verify an issuance record by hash
 *
 * Each issuance record is canonicalised and SHA-256 hashed so third parties can
 * independently recompute and verify it.
 */
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';

export type SubjectType = 'contributor' | 'protocol' | 'organization';

export interface ActivityStats {
  txCount: number;
  contractsDeployed: number;
  activeDays: number;
  uniqueCounterparties: number;
  firstSeenLedger: number;
  lastSeenLedger: number;
}

export interface Badge {
  id: string;
  name: string;
  tier: 'bronze' | 'silver' | 'gold';
}

export interface IssuanceRecord {
  subject: string;
  subjectType: SubjectType;
  score: number;
  badges: Badge[];
  stats: ActivityStats;
  issuedAt: string;
  hash: string;
}

interface BadgeRule {
  id: string;
  name: string;
  metric: keyof ActivityStats;
  tiers: [number, number, number];
}

const BADGE_RULES: BadgeRule[] = [
  {
    id: 'frequent-transactor',
    name: 'Frequent Transactor',
    metric: 'txCount',
    tiers: [100, 1_000, 10_000],
  },
  { id: 'builder', name: 'Builder', metric: 'contractsDeployed', tiers: [1, 10, 50] },
  { id: 'consistent', name: 'Consistently Active', metric: 'activeDays', tiers: [30, 180, 365] },
  {
    id: 'connected',
    name: 'Well Connected',
    metric: 'uniqueCounterparties',
    tiers: [25, 250, 2_500],
  },
];

/** Score 0–100: log-scaled contribution of each metric, capped per metric. */
export function scoreActivity(stats: ActivityStats): number {
  const part = (v: number, cap: number) => Math.min(1, Math.log10(1 + v) / Math.log10(1 + cap));
  const s =
    part(stats.txCount, 10_000) * 35 +
    part(stats.contractsDeployed, 50) * 20 +
    part(stats.activeDays, 365) * 25 +
    part(stats.uniqueCounterparties, 2_500) * 20;
  return Math.round(s * 100) / 100;
}

export function computeBadges(stats: ActivityStats): Badge[] {
  const badges: Badge[] = [];
  for (const rule of BADGE_RULES) {
    const v = stats[rule.metric];
    const tier =
      v >= rule.tiers[2]
        ? 'gold'
        : v >= rule.tiers[1]
          ? 'silver'
          : v >= rule.tiers[0]
            ? 'bronze'
            : null;
    if (tier) badges.push({ id: rule.id, name: rule.name, tier });
  }
  return badges;
}

export function hashRecord(record: Omit<IssuanceRecord, 'hash'>): string {
  const canonical = JSON.stringify({
    subject: record.subject,
    subjectType: record.subjectType,
    score: record.score,
    badges: record.badges,
    stats: record.stats,
    issuedAt: record.issuedAt,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const records = new Map<string, IssuanceRecord>(); // hash → record
const bySubject = new Map<string, string[]>(); // subject → hashes

/** Test helper — clears in-memory issuance records. */
export function resetReputationBadges(): void {
  records.clear();
  bySubject.clear();
}

export function issueBadges(
  subject: string,
  subjectType: SubjectType,
  stats: ActivityStats,
): IssuanceRecord {
  const base = {
    subject,
    subjectType,
    score: scoreActivity(stats),
    badges: computeBadges(stats),
    stats,
    issuedAt: new Date().toISOString(),
  };
  const record: IssuanceRecord = { ...base, hash: hashRecord(base) };
  records.set(record.hash, record);
  bySubject.set(subject, [...(bySubject.get(subject) ?? []), record.hash]);
  return record;
}

const count = z.number().int().min(0).max(1e12);
const IssueSchema = z.object({
  subject: z
    .string()
    .regex(/^[GC][A-Z2-7]{55}$|^org:[a-z0-9-]{2,64}$/, 'Stellar address or org:<slug>'),
  subjectType: z.enum(['contributor', 'protocol', 'organization']),
  stats: z.object({
    txCount: count,
    contractsDeployed: count,
    activeDays: count,
    uniqueCounterparties: count,
    firstSeenLedger: count,
    lastSeenLedger: count,
  }),
});

export const reputationBadgesRouter = Router();

reputationBadgesRouter.post('/issue', adminAuth, (req: Request, res: Response) => {
  const parsed = IssueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { subject, subjectType, stats } = parsed.data;
  res
    .status(201)
    .json(issueBadges(subject, subjectType, stats as Parameters<typeof issueBadges>[2]));
});

reputationBadgesRouter.get('/verify/:hash', (req: Request, res: Response) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.hash)) {
    return res.status(400).json({ error: 'Invalid hash' });
  }
  const record = records.get(req.params.hash);
  if (!record) return res.status(404).json({ valid: false, error: 'Issuance record not found' });
  const { hash, ...rest } = record;
  res.json({ valid: hashRecord(rest) === hash, record });
});

reputationBadgesRouter.get('/:subject', (req: Request, res: Response) => {
  const hashes = bySubject.get(req.params.subject) ?? [];
  if (!hashes.length) return res.status(404).json({ error: 'No badges issued for subject' });
  const history = hashes.map((h) => records.get(h)!);
  res.json({ subject: req.params.subject, current: history[history.length - 1], history });
});
