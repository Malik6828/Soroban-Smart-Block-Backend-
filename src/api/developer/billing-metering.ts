/**
 * Billing Metering Router — PLT04
 *
 * Entitlement-aware billing endpoints that complement the existing
 * `src/api/developer/billing.ts` routes.  Mounts under:
 *   /developer/billing/...
 *   /developer/plan/...
 *
 * Endpoints
 * ─────────
 *   GET  /entitlements          — plan entitlements for a developer
 *   GET  /quota                 — current quota usage counters
 *   GET  /usage-summary         — full usage + cost estimate
 *   GET  /billing-events        — billing event history
 *   POST /plan/upgrade          — initiate Stripe upgrade checkout
 *   POST /plan/downgrade        — immediate plan downgrade
 *   GET  /plan/compare          — full plan comparison matrix (no auth)
 *   POST /webhook/stripe        — enhanced Stripe webhook processor
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { logger } from '../../logger';
import {
  getPlanEntitlements,
  checkQuota,
  getUsageSummary,
  getBillingHistory,
  createBillingEvent,
} from '../../services/billing-metering';
import { createCheckoutSession, handleStripeWebhook } from '../../services/stripe-billing';

export const billingMeteringRouter = Router();

// ─── GET /entitlements ────────────────────────────────────────────────────────

billingMeteringRouter.get(
  '/entitlements',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ developerId: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId } = parsed.data;

    const devRows = await prismaRead.$queryRaw<Array<{ plan_id: string | null }>>(
      Prisma.sql`SELECT plan_id FROM "_developers" WHERE id = ${developerId} LIMIT 1`,
    );

    if (devRows.length === 0) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    const entitlements = await getPlanEntitlements(devRows[0].plan_id);
    logger.debug('[billing-metering] GET /entitlements', { developerId });

    res.json({ data: entitlements });
  }),
);

// ─── GET /quota ───────────────────────────────────────────────────────────────

billingMeteringRouter.get(
  '/quota',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ developerId: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId } = parsed.data;

    const devExists = await prismaRead.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "_developers" WHERE id = ${developerId} LIMIT 1`,
    );
    if (devExists.length === 0) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    const quotaCheck = await checkQuota(developerId);
    logger.debug('[billing-metering] GET /quota', { developerId, allowed: quotaCheck.allowed });

    res.json({ data: quotaCheck });
  }),
);

// ─── GET /usage-summary ───────────────────────────────────────────────────────

billingMeteringRouter.get(
  '/usage-summary',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z.object({ developerId: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId } = parsed.data;

    try {
      const summary = await getUsageSummary(developerId);
      logger.debug('[billing-metering] GET /usage-summary', { developerId });
      res.json({ data: summary });
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        return res.status(404).json({ error: 'Developer not found' });
      }
      throw err;
    }
  }),
);

// ─── GET /billing-events ──────────────────────────────────────────────────────

billingMeteringRouter.get(
  '/billing-events',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z
      .object({
        developerId: z.string().min(1),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId, limit, offset } = parsed.data;

    const devExists = await prismaRead.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "_developers" WHERE id = ${developerId} LIMIT 1`,
    );
    if (devExists.length === 0) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    // getBillingHistory does not support offset natively — fetch limit+offset and slice
    const events = await getBillingHistory(developerId, limit + offset);
    const page = events.slice(offset, offset + limit);

    logger.debug('[billing-metering] GET /billing-events', { developerId, limit, offset });
    res.json({ data: page, total: events.length, limit, offset });
  }),
);

// ─── POST /plan/upgrade ───────────────────────────────────────────────────────

billingMeteringRouter.post(
  '/plan/upgrade',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z
      .object({
        developerId: z.string().min(1),
        targetPlan: z.enum(['developer', 'pro', 'enterprise']),
        successUrl: z.string().url(),
        cancelUrl: z.string().url(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId, targetPlan, successUrl, cancelUrl } = parsed.data;

    const devRows = await prismaRead.$queryRaw<Array<{ plan_id: string | null }>>(
      Prisma.sql`SELECT plan_id FROM "_developers" WHERE id = ${developerId} LIMIT 1`,
    );
    if (devRows.length === 0) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    const fromPlanId = devRows[0].plan_id;

    // Look up target plan id
    const targetRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "_billing_plans" WHERE name = ${targetPlan} LIMIT 1`,
    );
    if (targetRows.length === 0) {
      return res.status(404).json({ error: `Plan '${targetPlan}' not found` });
    }

    const toPlanId = targetRows[0].id;

    // Record the initiation event before calling Stripe so the DB is always
    // consistent regardless of whether the checkout completes.
    await createBillingEvent({
      developerId,
      eventType: 'upgrade_initiated',
      fromPlanId: fromPlanId ?? undefined,
      toPlanId,
      metadata: { targetPlan, successUrl, cancelUrl },
    });

    // Map 'developer' tier to 'pro' for the Stripe integration
    // (the Stripe price map only has 'pro' and 'enterprise')
    const stripeTier: 'pro' | 'enterprise' = targetPlan === 'enterprise' ? 'enterprise' : 'pro';

    const session = await createCheckoutSession({
      developerId,
      tier: stripeTier,
      successUrl,
      cancelUrl,
    });

    logger.info('[billing-metering] POST /plan/upgrade', { developerId, targetPlan });
    res.json({ checkoutUrl: session.url, sessionId: session.sessionId });
  }),
);

// ─── POST /plan/downgrade ─────────────────────────────────────────────────────

billingMeteringRouter.post(
  '/plan/downgrade',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = z
      .object({
        developerId: z.string().min(1),
        targetPlan: z.enum(['free', 'developer']),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { developerId, targetPlan } = parsed.data;

    const devRows = await prismaRead.$queryRaw<Array<{ id: string; plan_id: string | null }>>(
      Prisma.sql`SELECT id, plan_id FROM "_developers" WHERE id = ${developerId} LIMIT 1`,
    );
    if (devRows.length === 0) {
      return res.status(404).json({ error: 'Developer not found' });
    }

    const targetRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "_billing_plans" WHERE name = ${targetPlan} LIMIT 1`,
    );
    if (targetRows.length === 0) {
      return res.status(404).json({ error: `Plan '${targetPlan}' not found` });
    }

    const fromPlanId = devRows[0].plan_id;
    const toPlanId = targetRows[0].id;

    // Apply immediately for non-Stripe (free/developer) downgrades
    await prismaWrite.developer.update({
      where: { id: developerId },
      data: { planId: toPlanId },
    });

    await createBillingEvent({
      developerId,
      eventType: 'plan_changed',
      fromPlanId: fromPlanId ?? undefined,
      toPlanId,
      metadata: { targetPlan, immediate: true },
    });

    logger.info('[billing-metering] POST /plan/downgrade', { developerId, targetPlan });
    res.json({ message: `Plan downgraded to ${targetPlan}`, planId: toPlanId });
  }),
);

// ─── GET /plan/compare ────────────────────────────────────────────────────────

billingMeteringRouter.get(
  '/plan/compare',
  asyncHandler(async (_req: Request, res: Response) => {
    const plans = await prismaRead.$queryRaw<
      Array<{
        id: string;
        name: string;
        requests_per_day: number;
        requests_per_month: number;
        price_monthly: number;
        max_concurrent_keys: number;
        history_cutoff_days: number;
        max_webhooks: number;
        overage_rate_per_1k: number | string;
        trial_days: number;
        is_active: boolean;
        sort_order: number;
        features: unknown;
      }>
    >(
      Prisma.sql`
        SELECT id, name, requests_per_day, requests_per_month, price_monthly,
               max_concurrent_keys, history_cutoff_days, max_webhooks,
               overage_rate_per_1k, trial_days, is_active, sort_order, features
        FROM "_billing_plans"
        WHERE is_active = true
        ORDER BY sort_order ASC
      `,
    );

    const matrix = await Promise.all(
      plans.map(async (plan) => {
        const entitlements = await getPlanEntitlements(plan.id);
        return {
          id: plan.id,
          name: plan.name,
          priceMonthly: plan.price_monthly,
          requestsPerDay: plan.requests_per_day,
          requestsPerMonth: plan.requests_per_month,
          trialDays: plan.trial_days ?? 0,
          sortOrder: plan.sort_order ?? 0,
          entitlements,
        };
      }),
    );

    logger.debug('[billing-metering] GET /plan/compare', { count: matrix.length });
    res.json({ data: matrix });
  }),
);

// ─── POST /webhook/stripe ─────────────────────────────────────────────────────

billingMeteringRouter.post(
  '/webhook/stripe',
  asyncHandler(async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string | undefined;

    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    // Raw body must be available (configured in Express as express.raw for this path)
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({ error: 'Raw body required for webhook verification' });
    }

    // Load Stripe lazily to avoid hard dependency at startup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type StripeModule = any;
    let stripe: StripeModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const StripeClass = require('stripe');
      const StripeConstructor = StripeClass.default ?? StripeClass;
      stripe = new StripeConstructor(process.env.STRIPE_SECRET_KEY ?? '', {
        apiVersion: '2024-04-10',
      });
    } catch {
      logger.error('[billing-metering] Stripe package not installed');
      return res.status(500).json({ error: 'Billing provider not configured' });
    }

    let stripeEvent: {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET ?? '',
      ) as typeof stripeEvent;
    } catch (err) {
      logger.warn('[billing-metering] Stripe webhook signature invalid', { err: String(err) });
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const obj = stripeEvent.data.object as Record<string, unknown>;
    const stripeEventId = stripeEvent.id;

    try {
      switch (stripeEvent.type) {
        case 'checkout.session.completed': {
          const metadata = (obj.metadata ?? {}) as Record<string, string>;
          const developerId = metadata.developerId;
          const targetPlan = metadata.tier ?? metadata.plan;

          if (developerId && targetPlan) {
            const planRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`SELECT id FROM "_billing_plans" WHERE name = ${targetPlan} LIMIT 1`,
            );
            await createBillingEvent({
              developerId,
              eventType: 'payment_succeeded',
              toPlanId: planRows[0]?.id,
              stripeEventId,
              metadata: { checkoutSessionId: obj.id, amountTotal: obj.amount_total },
            });

            if (planRows[0]) {
              await prismaWrite.developer.update({
                where: { id: developerId },
                data: { planId: planRows[0].id },
              });

              await createBillingEvent({
                developerId,
                eventType: 'plan_changed',
                toPlanId: planRows[0].id,
                stripeEventId,
                metadata: { source: 'stripe_checkout' },
              });
            }
          }
          break;
        }

        case 'customer.subscription.deleted':
        case 'customer.subscription.paused': {
          const customerId = obj.customer as string | undefined;
          if (customerId) {
            const devRows = await prismaRead.$queryRaw<
              Array<{ id: string; plan_id: string | null }>
            >(
              Prisma.sql`
                SELECT id, plan_id FROM "_developers"
                WHERE stripe_customer_id = ${customerId}
                LIMIT 1
              `,
            );
            if (devRows.length > 0) {
              const freeRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
                Prisma.sql`SELECT id FROM "_billing_plans" WHERE name = 'free' LIMIT 1`,
              );
              await createBillingEvent({
                developerId: devRows[0].id,
                eventType: 'subscription_canceled',
                fromPlanId: devRows[0].plan_id ?? undefined,
                toPlanId: freeRows[0]?.id,
                stripeEventId,
                metadata: { subscriptionId: obj.id, status: obj.status },
              });

              if (freeRows[0]) {
                await prismaWrite.developer.update({
                  where: { id: devRows[0].id },
                  data: { planId: freeRows[0].id },
                });
              }
            }
          }
          break;
        }

        case 'customer.subscription.updated': {
          const customerId = obj.customer as string | undefined;
          const status = obj.status as string | undefined;
          if (customerId && status) {
            const devRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`
                SELECT id FROM "_developers"
                WHERE stripe_customer_id = ${customerId}
                LIMIT 1
              `,
            );
            if (devRows.length > 0) {
              await createBillingEvent({
                developerId: devRows[0].id,
                eventType: 'subscription_updated',
                stripeEventId,
                metadata: { status, subscriptionId: obj.id },
              });

              // Reflect subscription_status on developer row
              await prismaWrite.$executeRaw(
                Prisma.sql`
                  UPDATE "_developers"
                  SET subscription_status = ${status}
                  WHERE id = ${devRows[0].id}
                `,
              );
            }
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const customerId = obj.customer as string | undefined;
          const amountPaid = obj.amount_paid as number | undefined;
          if (customerId) {
            const devRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`
                SELECT id FROM "_developers"
                WHERE stripe_customer_id = ${customerId}
                LIMIT 1
              `,
            );
            if (devRows.length > 0) {
              await createBillingEvent({
                developerId: devRows[0].id,
                eventType: 'payment_succeeded',
                amountCents: amountPaid,
                stripeEventId,
                metadata: { invoiceId: obj.id, currency: obj.currency },
              });
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const customerId = obj.customer as string | undefined;
          const amountDue = obj.amount_due as number | undefined;
          if (customerId) {
            const devRows = await prismaRead.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`
                SELECT id FROM "_developers"
                WHERE stripe_customer_id = ${customerId}
                LIMIT 1
              `,
            );
            if (devRows.length > 0) {
              await createBillingEvent({
                developerId: devRows[0].id,
                eventType: 'payment_failed',
                amountCents: amountDue,
                stripeEventId,
                metadata: { invoiceId: obj.id, attemptCount: obj.attempt_count },
              });
            }
          }
          break;
        }

        default:
          logger.debug('[billing-metering] Unhandled Stripe event type', {
            type: stripeEvent.type,
          });
      }
    } catch (err) {
      logger.error('[billing-metering] Stripe webhook processing error', {
        stripeEventId,
        type: stripeEvent.type,
        err: String(err),
      });
      // Still acknowledge receipt to Stripe to prevent retries for business logic errors
    }

    // Also run the existing stripe-billing handler for tier promotion
    try {
      await handleStripeWebhook(rawBody, sig);
    } catch (err) {
      logger.warn('[billing-metering] Legacy stripe-billing webhook handler error', {
        err: String(err),
      });
    }

    res.json({ received: true, eventId: stripeEventId });
  }),
);
