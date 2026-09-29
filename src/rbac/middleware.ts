/**
 * RBAC Middleware Enforcement Layer
 *
 * Express middleware functions for enforcing fine-grained permissions
 * integrating with the existing authentication system.
 */

import type { Request, Response, NextFunction } from 'express';
import { rbacService } from './rbac-service';
import { logger } from '../logger';
import {
  AuthPrincipal,
  ResourceContext,
  PermissionCheckResult,
  PermissionDeniedError,
  TenantIsolationError,
  PermissionEvaluationError,
} from './types';
import { background } from '../utils/background';

// Extend Express Request interface to include RBAC context
declare global {
  namespace Express {
    interface Request {
      rbacContext?: {
        principal: AuthPrincipal;
        permissions: string[];
        tenantId?: string;
        evaluationTime: number;
      };
    }
  }
}

/**
 * Options for permission middleware
 */
export interface PermissionMiddlewareOptions {
  permissions: string | string[];
  requireAll?: boolean; // Default: false (require any)
  resource?: {
    type: string;
    idParam?: string; // Request parameter containing resource ID
    idHeader?: string; // Request header containing resource ID
    staticId?: string; // Static resource ID
  };
  tenant?: {
    param?: string; // Request parameter containing tenant ID
    header?: string; // Request header containing tenant ID
    fromPrincipal?: boolean; // Use principal's tenant ID (default: true)
  };
  onDenied?: (req: Request, res: Response, result: PermissionCheckResult) => void;
  skipAudit?: boolean; // Skip audit logging (default: false)
}

/**
 * Core permission checking middleware
 */
export function requirePermission(
  permissions: string | string[],
  options: Partial<PermissionMiddlewareOptions> = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const opts: PermissionMiddlewareOptions = {
    permissions,
    requireAll: false,
    tenant: { fromPrincipal: true },
    skipAudit: false,
    ...options,
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();
    
    try {
      // Extract principal from existing auth context
      const principal = extractPrincipal(req);
      if (!principal) {
        res.status(401).json({
          error: 'Authentication Required',
          message: 'No valid authentication context found',
          code: 'AUTH_REQUIRED',
        });
        return;
      }

      // Build resource context
      const resourceContext = buildResourceContext(req, opts);

      // Normalize permissions to array
      const permissionList = Array.isArray(opts.permissions) ? opts.permissions : [opts.permissions];

      // Check permissions
      let result: PermissionCheckResult;
      if (opts.requireAll) {
        result = await rbacService.hasAllPermissions(principal, permissionList, resourceContext, {
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          requestId: req.id || req.get('X-Request-ID'),
        });
      } else {
        result = await rbacService.hasAnyPermission(principal, permissionList, resourceContext, {
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          requestId: req.id || req.get('X-Request-ID'),
        });
      }

      if (!result.allowed) {
        // Audit permission denial
        if (!opts.skipAudit) {
          auditPermissionCheck(req, principal, permissionList, result, false);
        }

        // Call custom denial handler if provided
        if (opts.onDenied) {
          opts.onDenied(req, res, result);
          return;
        }

        // Default denial response
        res.status(403).json({
          error: 'Permission Denied',
          message: result.reason || `Missing required permission(s): ${permissionList.join(', ')}`,
          code: 'PERMISSION_DENIED',
          requiredPermissions: permissionList,
          appliedPermissions: result.appliedPermissions,
        });
        return;
      }

      // Store RBAC context for downstream usage
      req.rbacContext = {
        principal,
        permissions: result.appliedPermissions,
        tenantId: resourceContext?.tenantId,
        evaluationTime: result.evaluationTimeMs,
      };

      // Audit successful permission check
      if (!opts.skipAudit) {
        auditPermissionCheck(req, principal, permissionList, result, true);
      }

      next();
    } catch (error) {
      const evaluationTime = Date.now() - startTime;
      
      logger.error('Permission middleware error', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        evaluationTime,
      });

      if (error instanceof PermissionDeniedError) {
        res.status(403).json({
          error: 'Permission Denied',
          message: error.message,
          code: 'PERMISSION_DENIED',
        });
      } else if (error instanceof TenantIsolationError) {
        res.status(403).json({
          error: 'Tenant Isolation Violation',
          message: error.message,
          code: 'TENANT_ISOLATION_VIOLATION',
        });
      } else if (error instanceof PermissionEvaluationError) {
        res.status(500).json({
          error: 'Permission Evaluation Error',
          message: 'Unable to evaluate permissions',
          code: 'PERMISSION_EVALUATION_ERROR',
        });
      } else {
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Permission check failed',
          code: 'INTERNAL_ERROR',
        });
      }
    }
  };
}

/**
 * Convenience middleware functions for common permission patterns
 */

// Admin permissions
export const requireAdminRead = requirePermission('admin:system:read');
export const requireAdminWrite = requirePermission('admin:system:write');
export const requireUserManagement = requirePermission(['admin:users:read', 'admin:users:write'], { requireAll: true });

// Freeze management permissions  
export const requireFreezeRead = requirePermission('admin:freeze:read');
export const requireFreezeWrite = requirePermission(['admin:freeze:create', 'admin:freeze:update', 'admin:freeze:delete']);
export const requireFreezeViolationAccess = requirePermission(['freeze:violations:read', 'freeze:violations:resolve']);

// Compliance permissions
export const requireComplianceScreen = requirePermission('compliance:screen:read');
export const requireComplianceAlerts = requirePermission(['compliance:alerts:read', 'compliance:alerts:review']);
export const requireComplianceReports = requirePermission(['compliance:reports:read', 'compliance:reports:create']);
export const requireComplianceBlocking = requirePermission('compliance:blocking:manage');

// API permissions
export const requireApiRead = requirePermission(['api:contracts:read', 'api:transactions:read', 'api:events:read']);
export const requireApiWrite = requirePermission(['api:exports:create', 'api:webhooks:manage']);

// Audit permissions
export const requireAuditRead = requirePermission('audit:logs:read');
export const requireSensitiveAuditRead = requirePermission('audit:logs:read:sensitive');

// Self-service permissions
export const requireProfileAccess = requirePermission(['self:profile:read', 'self:profile:update']);
export const requireSessionManagement = requirePermission(['self:sessions:read', 'self:sessions:revoke']);

/**
 * Tenant-aware permission middleware
 */
export function requireTenantPermission(
  permissions: string | string[],
  options: Partial<PermissionMiddlewareOptions> = {}
): (req: Request, res: Response, next: NextFunction) => void {
  return requirePermission(permissions, {
    ...options,
    tenant: {
      param: 'tenantId',
      header: 'X-Tenant-ID',
      fromPrincipal: true,
      ...options.tenant,
    },
  });
}

/**
 * Resource-aware permission middleware
 */
export function requireResourcePermission(
  permissions: string | string[],
  resourceType: string,
  options: Partial<PermissionMiddlewareOptions> = {}
): (req: Request, res: Response, next: NextFunction) => void {
  return requirePermission(permissions, {
    ...options,
    resource: {
      type: resourceType,
      idParam: 'id',
      ...options.resource,
    },
  });
}

/**
 * Contract-specific permission middleware
 */
export const requireContractAccess = (permissions: string | string[]) =>
  requireResourcePermission(permissions, 'contract', {
    resource: { idParam: 'contractAddress' },
  });

/**
 * User-specific permission middleware  
 */
export const requireUserAccess = (permissions: string | string[]) =>
  requireResourcePermission(permissions, 'user', {
    resource: { idParam: 'userId' },
  });

/**
 * Multi-permission middleware that checks for different permission sets
 * based on the resource being accessed
 */
export function requireConditionalPermission(
  conditions: Array<{
    condition: (req: Request) => boolean;
    permissions: string | string[];
    options?: Partial<PermissionMiddlewareOptions>;
  }>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Find the first matching condition
    const matchedCondition = conditions.find(c => c.condition(req));
    
    if (!matchedCondition) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'No matching permission condition',
        code: 'NO_MATCHING_CONDITION',
      });
      return;
    }

    // Apply the matched permission requirement
    const middleware = requirePermission(matchedCondition.permissions, matchedCondition.options);
    middleware(req, res, next);
  };
}

/**
 * Permission middleware that allows different permissions based on HTTP method
 */
export function requireMethodPermissions(methodPermissions: {
  GET?: string | string[];
  POST?: string | string[];
  PUT?: string | string[];
  PATCH?: string | string[];
  DELETE?: string | string[];
}): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method as keyof typeof methodPermissions;
    const permissions = methodPermissions[method];

    if (!permissions) {
      res.status(405).json({
        error: 'Method Not Allowed',
        message: `Method ${method} not supported`,
        code: 'METHOD_NOT_ALLOWED',
      });
      return;
    }

    const middleware = requirePermission(permissions);
    middleware(req, res, next);
  };
}

/**
 * Enhanced API key middleware with RBAC integration
 */
export function enhancedApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // First run the existing apiKeyAuth middleware to set req.apiKey
  const originalApiKeyAuth = require('../middleware/apiKeyAuth').apiKeyAuth;
  
  originalApiKeyAuth(req, res, (error?: any) => {
    if (error) return next(error);
    
    // If we have an API key, enhance it with RBAC context
    if (req.apiKey) {
      // Store the enhanced principal for RBAC middleware
      req.rbacPrincipal = {
        type: 'api_key',
        apiKeyId: req.apiKey.id,
        tenantId: req.apiKey.tenantId,
      } as AuthPrincipal;
    }
    
    next();
  });
}

/**
 * Enhanced user auth middleware with RBAC integration
 */
export function enhancedUserAuth(req: Request, res: Response, next: NextFunction): void {
  // First run the existing requireAuth middleware to set req.user
  const originalRequireAuth = require('../auth/middleware').requireAuth;
  
  originalRequireAuth(req, res, (error?: any) => {
    if (error) return next(error);
    
    // If we have a user, enhance it with RBAC context
    if (req.user) {
      // Store the enhanced principal for RBAC middleware
      req.rbacPrincipal = {
        type: 'user',
        userId: req.user.id,
        sessionId: req.user.sessionId,
        tenantId: req.user.tenantId,
      } as AuthPrincipal;
    }
    
    next();
  });
}

/**
 * Enhanced admin auth middleware with RBAC integration
 */
export function enhancedAdminAuth(req: Request, res: Response, next: NextFunction): void {
  // First run the existing adminAuth middleware
  const originalAdminAuth = require('../middleware/adminAuth').adminAuth;
  
  originalAdminAuth(req, res, (error?: any) => {
    if (error) return next(error);
    
    // Admin authentication succeeded, set RBAC principal
    req.rbacPrincipal = {
      type: 'admin',
    } as AuthPrincipal;
    
    next();
  });
}

// ── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Extract authentication principal from request
 */
function extractPrincipal(req: Request): AuthPrincipal | null {
  // Check for explicitly set RBAC principal first
  if (req.rbacPrincipal) {
    return req.rbacPrincipal;
  }

  // Extract from existing auth contexts
  if (req.user) {
    return {
      type: 'user',
      userId: req.user.id,
      sessionId: req.user.sessionId,
      tenantId: req.user.tenantId,
    };
  }

  if (req.apiKey) {
    return {
      type: 'api_key',
      apiKeyId: req.apiKey.id,
      tenantId: req.apiKey.tenantId,
    };
  }

  if (req.actor === 'admin') {
    return {
      type: 'admin',
    };
  }

  return null;
}

/**
 * Build resource context from request and options
 */
function buildResourceContext(
  req: Request,
  options: PermissionMiddlewareOptions
): ResourceContext | undefined {
  if (!options.resource) return undefined;

  let resourceId: string | undefined;

  // Extract resource ID
  if (options.resource.staticId) {
    resourceId = options.resource.staticId;
  } else if (options.resource.idParam) {
    resourceId = req.params[options.resource.idParam];
  } else if (options.resource.idHeader) {
    resourceId = req.get(options.resource.idHeader);
  }

  if (!resourceId) return undefined;

  // Extract tenant ID
  let tenantId: string | undefined;
  
  if (options.tenant?.fromPrincipal) {
    const principal = extractPrincipal(req);
    tenantId = principal?.tenantId;
  }
  
  if (!tenantId && options.tenant?.param) {
    tenantId = req.params[options.tenant.param];
  }
  
  if (!tenantId && options.tenant?.header) {
    tenantId = req.get(options.tenant.header);
  }

  return {
    resourceType: options.resource.type,
    resourceId,
    tenantId,
    metadata: {
      method: req.method,
      url: req.url,
      timestamp: new Date(),
    },
  };
}

/**
 * Audit permission check (background logging)
 */
function auditPermissionCheck(
  req: Request,
  principal: AuthPrincipal,
  permissions: string[],
  result: PermissionCheckResult,
  allowed: boolean
): void {
  background('rbac.auditPermissionCheck', async () => {
    try {
      const auditData = {
        principal,
        permissions,
        allowed,
        reason: result.reason,
        appliedPermissions: result.appliedPermissions,
        evaluationTimeMs: result.evaluationTimeMs,
        cacheHit: result.cacheHit,
        request: {
          method: req.method,
          url: req.url,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          requestId: req.id || req.get('X-Request-ID'),
        },
        timestamp: new Date(),
      };

      logger.info('RBAC permission check', auditData);

      // Store in database for compliance
      if (!allowed || permissions.some(p => p.includes('sensitive') || p.includes('admin'))) {
        const { prismaWrite } = await import('../db');
        
        await prismaWrite.auditLog.create({
          data: {
            id: crypto.randomUUID(),
            actor: principal.userId || principal.apiKeyId || 'admin',
            action: 'permission_check',
            target: `permissions:${permissions.join(',')}`,
            previousState: null,
            newState: auditData,
            reason: allowed ? 'access_granted' : 'access_denied',
          },
        });
      }
    } catch (error) {
      logger.warn('Failed to audit permission check', { error: error.message });
    }
  });
}

// Export types for other modules
export type { PermissionMiddlewareOptions, AuthPrincipal, ResourceContext };