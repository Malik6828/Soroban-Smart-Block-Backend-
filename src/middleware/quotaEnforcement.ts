/**
 * Quota Enforcement Middleware — PLT04
 *
 * Checks the current developer's quota before forwarding the request.
 * Attaches the `req.apiKey` shape populated by the API key auth middleware.
 *
 * Behavior:
 *  - If no req.apiKey is present, pass through immediately (public/unauthenticated requests).
 *  - On quota exceeded, respond 429 with upgrade URL.
 *  - On quota-check error, log a warning and pass through (graceful degradation).
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { checkQuota } from '../services/billing-metering';

// `req.apiKey` is declared once, as `ApiKeyContext`, in src/types/express.d.ts.

/**
 * Express middleware that enforces per-developer quota limits.
 *
 * Mount after API key authentication middleware so that `req.apiKey` is
 * populated.  Place before route handlers to gate all downstream routes.
 *
 * @example
 * import { quotaEnforcementMiddleware } from './middleware/quotaEnforcement';
 * app.use('/api/v1', apiKeyAuth, quotaEnforcementMiddleware);
 */
export function quotaEnforcementMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip quota check for unauthenticated (public) requests
  if (!req.apiKey?.developerId) {
    next();
    return;
  }

  const { developerId } = req.apiKey;

  checkQuota(developerId)
    .then(({ allowed, reason, usagePct }) => {
      if (!allowed) {
        logger.warn(
          { developerId, reason, usagePct, path: req.path },
          '[quota-enforcement] Quota exceeded — blocking request',
        );
        res.status(429).json({
          error: 'Quota exceeded',
          reason: reason ?? 'Request quota exceeded for your current plan',
          usagePct,
          upgradeUrl: '/developer/billing/plan/upgrade',
        });
        return;
      }

      next();
    })
    .catch((err: unknown) => {
      // Graceful degradation: log and allow the request rather than blocking
      logger.warn(
        { err, developerId, path: req.path },
        '[quota-enforcement] checkQuota threw — passing through',
      );
      next();
    });
}
