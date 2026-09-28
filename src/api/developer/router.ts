import { Router } from 'express';
import { authRouter } from './auth';
import { keysRouter } from './keys';
import { keysLifecycleRouter } from './keys-lifecycle';
import { devWebhooksRouter } from './webhooks';
import { usageRouter } from './usage';
import { rateLimitsRouter, quotaRouter } from './rate-limits';
import { billingRouter, plansRouter } from './billing';
import { billingMeteringRouter } from './billing-metering';
import { portalRouter } from './portal';

export const developerRouter = Router();

developerRouter.use('/auth', authRouter);
developerRouter.use('/keys', keysRouter);
developerRouter.use('/keys', keysLifecycleRouter);
developerRouter.use('/webhooks', devWebhooksRouter);
developerRouter.use('/usage', usageRouter);
developerRouter.use('/rate-limits', rateLimitsRouter);
developerRouter.use('/quota', quotaRouter);
developerRouter.use('/plans', plansRouter);
// PLT04: mount billingMeteringRouter before base routers so its more-specific
// endpoints (/plan/upgrade, /plan/downgrade, /plan/compare, /billing/entitlements, etc.)
// are matched first, then fall through to the existing plansRouter / billingRouter.
developerRouter.use('/plan', billingMeteringRouter);
developerRouter.use('/plan', plansRouter);
developerRouter.use('/billing', billingMeteringRouter);
developerRouter.use('/billing', billingRouter);
developerRouter.use('/', portalRouter);
