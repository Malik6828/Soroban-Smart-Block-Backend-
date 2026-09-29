/**
 * Enhanced Authentication Middleware
 *
 * Backwards-compatible enhancements to existing auth middleware that
 * integrates with the new RBAC system while maintaining existing functionality.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './tokens';
import { prismaWrite as prisma } from '../db';
import { hashToken } from './tokens';
import { hasRole, type Role, type Tier } from './rbac';
import { background } from '../utils/background';
import { AuthPrincipal } from '../rbac/types';

// Extend the existing User interface to include tenant information
interface EnhancedUser {
  id: string;
  address: string;
  role: Role;
  tier: Tier;
  sessionId: string;
  appId: string;
  tenantId?: string; // New: tenant association
}

// Extend Express Request to include RBAC principal
declare global {
  namespace Express {
    interface Request {
      rbacPrincipal?: AuthPrincipal;
    }
  }
}

/**
 * Enhanced version of requireAuth that sets up RBAC context
 */
export async function requireAuthWithRbac(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const payload = await verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  // Check session is still active
  const session = await prisma.authSession.findFirst({
    where: { id: payload.sessionId, tokenHash: hashToken(token), isActive: true },
    include: { 
      user: {
        include: {
          userRoles: {
            where: {
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            include: { role: true },
          },
        },
      },
    },
  });

  if (!session || !session.user.isActive) {
    return res.status(401).json({ error: 'Session revoked or user inactive' });
  }

  // Update last activity (non-blocking)
  background('auth.updateSessionActivity', () =>
    prisma.authSession
      .update({ where: { id: session.id }, data: { lastActivity: new Date() } })
      .then(() => {}),
  );

  // Set up legacy user context for backward compatibility
  req.user = {
    id: session.user.id,
    address: session.user.address,
    role: session.user.role as Role,
    tier: session.user.tier as Tier,
    sessionId: payload.sessionId,
    appId: payload.appId,
    tenantId: session.user.tenantId, // Include tenant information
  } as EnhancedUser;

  // Set up RBAC principal for new permission system
  req.rbacPrincipal = {
    type: 'user',
    userId: session.user.id,
    sessionId: payload.sessionId,
    tenantId: session.user.tenantId || undefined,
  };

  next();
}

/**
 * Optional authentication with RBAC context
 */
export async function optionalAuthWithRbac(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next();

  const payload = await verifyToken(token);
  if (!payload) return next();

  const session = await prisma.authSession.findFirst({
    where: { id: payload.sessionId, tokenHash: hashToken(token), isActive: true },
    include: { user: true },
  });

  if (session?.user.isActive) {
    req.user = {
      id: session.user.id,
      address: session.user.address,
      role: session.user.role as Role,
      tier: session.user.tier as Tier,
      sessionId: payload.sessionId,
      appId: payload.appId,
      tenantId: session.user.tenantId,
    } as EnhancedUser;

    req.rbacPrincipal = {
      type: 'user',
      userId: session.user.id,
      sessionId: payload.sessionId,
      tenantId: session.user.tenantId || undefined,
    };
  }
  
  next();
}

/**
 * Enhanced role requirement that falls back to RBAC permissions
 */
export function requireRoleOrPermission(role: Role, fallbackPermissions?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // First check legacy role system for backward compatibility
    if (hasRole(req.user.role, role)) {
      return next();
    }

    // If fallback permissions are provided and RBAC is available, check those
    if (fallbackPermissions && req.rbacPrincipal) {
      try {
        const { rbacService } = await import('../rbac/rbac-service');
        
        const result = await rbacService.hasAnyPermission(
          req.rbacPrincipal,
          fallbackPermissions,
          undefined,
          {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
          }
        );

        if (result.allowed) {
          return next();
        }
      } catch (error) {
        // Fall back to legacy behavior if RBAC fails
        console.warn('RBAC permission check failed, falling back to role check', error.message);
      }
    }

    return res.status(403).json({ 
      error: 'Insufficient role',
      required: role,
      current: req.user.role,
    });
  };
}

/**
 * Enhanced tier requirement with RBAC integration
 */
export function requireTierWithRbac(tier: Tier) {
  const order: Tier[] = ['free', 'developer', 'premium', 'enterprise'];
  
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (order.indexOf(req.user.tier) < order.indexOf(tier)) {
      return res.status(403).json({ 
        error: `Requires ${tier} tier or higher`,
        required: tier,
        current: req.user.tier,
      });
    }

    next();
  };
}

/**
 * Dual authentication middleware that accepts either user auth or API key
 */
export function dualAuthWithRbac(req: Request, res: Response, next: NextFunction): void {
  // Try user authentication first
  requireAuthWithRbac(req, res, (userError?: any) => {
    if (!userError && req.user) {
      return next(); // User auth succeeded
    }

    // Try API key authentication
    const { apiKeyAuth } = require('../middleware/apiKeyAuth');
    apiKeyAuth(req, res, (apiKeyError?: any) => {
      if (!apiKeyError && req.apiKey) {
        // Set up RBAC principal for API key
        req.rbacPrincipal = {
          type: 'api_key',
          apiKeyId: req.apiKey.id,
          tenantId: req.apiKey.tenantId,
        };
        return next();
      }

      // Both authentication methods failed
      res.status(401).json({
        error: 'Authentication Required',
        message: 'Provide either Bearer token or X-Api-Key header',
        code: 'AUTH_REQUIRED',
      });
    });
  });
}

/**
 * Tenant-aware authentication that validates tenant access
 */
export function requireTenantAuth(allowedTenants?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    await requireAuthWithRbac(req, res, (error?: any) => {
      if (error) return;

      const userTenantId = req.user?.tenantId;
      const requestedTenantId = req.params.tenantId || req.get('X-Tenant-ID');

      // If no tenant restrictions, proceed
      if (!allowedTenants && !requestedTenantId) {
        return next();
      }

      // Check if user has access to the requested tenant
      if (requestedTenantId && userTenantId !== requestedTenantId) {
        return res.status(403).json({
          error: 'Tenant Access Denied',
          message: `No access to tenant: ${requestedTenantId}`,
          code: 'TENANT_ACCESS_DENIED',
        });
      }

      // Check if user's tenant is in allowed list
      if (allowedTenants && userTenantId && !allowedTenants.includes(userTenantId)) {
        return res.status(403).json({
          error: 'Tenant Not Allowed',
          message: `Tenant ${userTenantId} not allowed for this resource`,
          code: 'TENANT_NOT_ALLOWED',
        });
      }

      next();
    });
  };
}

/**
 * Migration helper to gradually replace legacy middleware with RBAC
 */
export function createMigrationMiddleware(
  legacyMiddleware: (req: Request, res: Response, next: NextFunction) => void,
  rbacPermissions: string[],
  options: {
    enableRbac?: boolean; // Feature flag to enable RBAC
    logComparison?: boolean; // Log differences between legacy and RBAC results
  } = {}
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { enableRbac = false, logComparison = false } = options;

    if (!enableRbac) {
      // Use legacy middleware only
      return legacyMiddleware(req, res, next);
    }

    // Run both systems and compare results if logging is enabled
    if (logComparison) {
      let legacyAllowed = false;
      let rbacAllowed = false;

      // Test legacy middleware
      legacyMiddleware(req, res, (error?: any) => {
        legacyAllowed = !error;
      });

      // Test RBAC middleware
      if (req.rbacPrincipal) {
        try {
          const { rbacService } = await import('../rbac/rbac-service');
          const result = await rbacService.hasAnyPermission(req.rbacPrincipal, rbacPermissions);
          rbacAllowed = result.allowed;
        } catch (error) {
          rbacAllowed = false;
        }
      }

      // Log comparison
      if (legacyAllowed !== rbacAllowed) {
        console.warn('RBAC vs Legacy permission mismatch', {
          url: req.url,
          method: req.method,
          principal: req.rbacPrincipal,
          permissions: rbacPermissions,
          legacyAllowed,
          rbacAllowed,
        });
      }
    }

    // Use RBAC middleware
    const { requirePermission } = await import('../rbac/middleware');
    const rbacMiddleware = requirePermission(rbacPermissions);
    rbacMiddleware(req, res, next);
  };
}

/**
 * Backward compatibility exports - these maintain the same interface as the original middleware
 * but with RBAC integration
 */
export const requireAuth = requireAuthWithRbac;
export const optionalAuth = optionalAuthWithRbac;

// Enhanced versions of common role checks with RBAC fallbacks
export const requireAdmin = requireRoleOrPermission('admin', ['admin:system:read', 'admin:system:write']);
export const requireDeveloper = requireRoleOrPermission('developer', ['api:contracts:read', 'api:transactions:read']);
export const requirePremium = requireRoleOrPermission('premium', ['api:analytics:read', 'api:exports:create']);

// Tier-based middleware (unchanged interface)
export const requireTier = requireTierWithRbac;