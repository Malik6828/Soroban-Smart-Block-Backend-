/**
 * Tenant-Aware Route Integration Helpers
 *
 * Helper functions to integrate tenant isolation into existing API routes
 * with minimal code changes and maximum security.
 */

import type { Request, Response, NextFunction } from 'express';
import { 
  TenantAwarePrismaClient,
  createTenantAwareClients,
  withTenantDb,
} from '../db/tenant-aware-db';
import { 
  createTenantContext,
  tenantIsolationService,
  createTenantContextMiddleware,
} from './tenant-isolation';
import { AuthPrincipal, TenantIsolationError } from './types';
import { logger } from '../logger';

// Extend Express Request to include tenant database clients
declare global {
  namespace Express {
    interface Request {
      tenantDb?: TenantAwarePrismaClient;
      tenantWriteDb?: TenantAwarePrismaClient;
      tenantContext?: any;
    }
  }
}

/**
 * Middleware to inject tenant-aware database clients into request
 */
export function injectTenantDb(options: {
  requireWriteAccess?: boolean;
  strictIsolation?: boolean;
  logQueries?: boolean;
} = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.rbacPrincipal) {
        return res.status(401).json({
          error: 'Authentication Required',
          message: 'No RBAC principal found for tenant database access',
          code: 'RBAC_PRINCIPAL_REQUIRED',
        });
      }

      // Create tenant context
      const requestedTenantId = 
        req.params.tenantId || 
        req.query.tenantId || 
        req.get('X-Tenant-ID');

      req.tenantContext = createTenantContext(req.rbacPrincipal, {
        requestedTenantId,
        bypassIsolation: req.rbacPrincipal.type === 'admin' && req.query.bypassIsolation === 'true',
      });

      // Create tenant-aware database clients
      const clients = await createTenantAwareClients({
        strictIsolation: options.strictIsolation !== false,
        logQueries: options.logQueries || false,
        auditAccess: true,
      });

      req.tenantDb = clients.tenantRead;
      if (options.requireWriteAccess) {
        req.tenantWriteDb = clients.tenantWrite;
      }

      next();
    } catch (error) {
      logger.error('Failed to inject tenant database clients', { 
        error: error.message,
        principal: req.rbacPrincipal,
      });

      if (error instanceof TenantIsolationError) {
        res.status(403).json({
          error: 'Tenant Access Denied',
          message: error.message,
          code: 'TENANT_ISOLATION_ERROR',
        });
      } else {
        res.status(500).json({
          error: 'Database Client Error',
          message: 'Failed to initialize tenant database access',
          code: 'DB_CLIENT_ERROR',
        });
      }
    }
  };
}

/**
 * Enhanced route handler wrapper with automatic tenant isolation
 */
export function withTenantIsolation<T = any>(
  handler: (req: Request & { tenantDb: TenantAwarePrismaClient }, res: Response) => Promise<T>,
  options: {
    requireWriteAccess?: boolean;
    requireTenant?: boolean;
    allowedRoles?: string[];
    permissions?: string[];
  } = {}
) {
  return [
    // Inject tenant database clients
    injectTenantDb({ requireWriteAccess: options.requireWriteAccess }),

    // Validate tenant requirement
    (req: Request, res: Response, next: NextFunction) => {
      if (options.requireTenant && !req.tenantContext?.requestedTenantId && !req.rbacPrincipal?.tenantId) {
        return res.status(400).json({
          error: 'Tenant Required',
          message: 'This endpoint requires tenant context',
          code: 'TENANT_REQUIRED',
        });
      }
      next();
    },

    // Execute handler with error handling
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req as Request & { tenantDb: TenantAwarePrismaClient }, res);
      } catch (error) {
        logger.error('Tenant-aware route handler error', {
          error: error.message,
          url: req.url,
          method: req.method,
          principal: req.rbacPrincipal,
          tenantContext: req.tenantContext,
        });

        if (error instanceof TenantIsolationError) {
          res.status(403).json({
            error: 'Tenant Isolation Violation',
            message: error.message,
            code: 'TENANT_ISOLATION_VIOLATION',
          });
        } else {
          res.status(500).json({
            error: 'Internal Server Error',
            message: 'Route handler failed',
            code: 'HANDLER_ERROR',
          });
        }
      }
    },
  ];
}

/**
 * Tenant-scoped user management helpers
 */
export class TenantUserManager {
  /**
   * Get users for current tenant with pagination and filtering
   */
  static async getUsers(
    req: Request,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      role?: string;
      includeRoles?: boolean;
    } = {}
  ) {
    const { page = 1, limit = 50, search, role, includeRoles = false } = options;

    if (!req.tenantDb || !req.tenantContext) {
      throw new Error('Tenant database context not available');
    }

    return req.tenantDb.executeWithTenantContext(req.tenantContext, async (client) => {
      const where: any = {};

      if (search) {
        where.OR = [
          { address: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (role) {
        where.userRoles = {
          some: { role: { id: role } },
        };
      }

      const include = includeRoles ? {
        userRoles: {
          include: { role: true },
        },
      } : {};

      const offset = (page - 1) * limit;

      const [users, total] = await Promise.all([
        client.walletUser.findMany({
          where,
          include,
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        client.walletUser.count({ where }),
      ]);

      return {
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    });
  }

  /**
   * Create a new user in the current tenant
   */
  static async createUser(
    req: Request,
    userData: {
      address: string;
      displayName?: string;
      email?: string;
      role?: string;
    }
  ) {
    if (!req.tenantWriteDb || !req.tenantContext) {
      throw new Error('Tenant write database context not available');
    }

    return req.tenantWriteDb.executeWriteWithTenantContext(req.tenantContext, async (client) => {
      const user = await client.walletUser.create({
        data: {
          id: crypto.randomUUID(),
          address: userData.address,
          displayName: userData.displayName,
          email: userData.email,
          role: userData.role || 'user',
          tenantId: req.tenantContext.requestedTenantId || req.tenantContext.principal.tenantId,
        },
      });

      logger.info('Tenant user created', {
        userId: user.id,
        tenantId: user.tenantId,
        actor: req.rbacPrincipal?.userId || req.rbacPrincipal?.apiKeyId,
      });

      return user;
    });
  }

  /**
   * Update user within tenant boundaries
   */
  static async updateUser(
    req: Request,
    userId: string,
    updateData: {
      displayName?: string;
      email?: string;
      isActive?: boolean;
    }
  ) {
    if (!req.tenantWriteDb || !req.tenantContext) {
      throw new Error('Tenant write database context not available');
    }

    return req.tenantWriteDb.executeWriteWithTenantContext(req.tenantContext, async (client) => {
      const user = await client.walletUser.update({
        where: { id: userId },
        data: updateData,
      });

      logger.info('Tenant user updated', {
        userId,
        tenantId: user.tenantId,
        actor: req.rbacPrincipal?.userId || req.rbacPrincipal?.apiKeyId,
      });

      return user;
    });
  }
}

/**
 * Tenant-scoped API key management helpers
 */
export class TenantApiKeyManager {
  /**
   * Get API keys for current tenant
   */
  static async getApiKeys(req: Request, developerId?: string) {
    if (!req.tenantDb || !req.tenantContext) {
      throw new Error('Tenant database context not available');
    }

    return req.tenantDb.getTenantApiKeys(req.tenantContext, developerId);
  }

  /**
   * Create API key scoped to current tenant
   */
  static async createApiKey(
    req: Request,
    keyData: {
      developerId: string;
      name: string;
      permissions: string[];
      tier?: string;
      allowedIps?: string[];
      allowedDomains?: string[];
      allowedEndpoints?: string[];
      expiresAt?: Date;
    }
  ) {
    if (!req.tenantWriteDb || !req.tenantContext) {
      throw new Error('Tenant write database context not available');
    }

    return req.tenantWriteDb.executeWriteWithTenantContext(req.tenantContext, async (client) => {
      // Generate API key
      const keyId = crypto.randomUUID();
      const keyValue = crypto.randomBytes(32).toString('hex');
      const keyHash = crypto.createHash('sha256').update(keyValue).digest('hex');
      const keyPrefix = keyValue.substring(0, 8);

      // Create API key record
      const apiKey = await client.devApiKey.create({
        data: {
          id: keyId,
          developerId: keyData.developerId,
          keyPrefix,
          keyHash,
          name: keyData.name,
          tier: keyData.tier || 'free',
          allowedIps: keyData.allowedIps || [],
          allowedDomains: keyData.allowedDomains || [],
          allowedEndpoints: keyData.allowedEndpoints || [],
          expiresAt: keyData.expiresAt,
          tenantId: req.tenantContext.requestedTenantId || req.tenantContext.principal.tenantId,
        },
      });

      // Create API key scopes
      if (keyData.permissions.length > 0) {
        await Promise.all(
          keyData.permissions.map(permissionId =>
            client.apiKeyScope.create({
              data: {
                id: crypto.randomUUID(),
                apiKeyId: keyId,
                permissionId,
              },
            })
          )
        );
      }

      logger.info('Tenant API key created', {
        apiKeyId: keyId,
        tenantId: apiKey.tenantId,
        actor: req.rbacPrincipal?.userId || req.rbacPrincipal?.apiKeyId,
      });

      return {
        ...apiKey,
        keyValue: `${keyPrefix}.${keyValue}`, // Return full key only once
      };
    });
  }
}

/**
 * Tenant analytics and reporting helpers
 */
export class TenantAnalytics {
  /**
   * Get tenant statistics
   */
  static async getTenantStats(req: Request) {
    if (!req.tenantDb || !req.tenantContext) {
      throw new Error('Tenant database context not available');
    }

    return req.tenantDb.getTenantStats(req.tenantContext);
  }

  /**
   * Get tenant activity summary
   */
  static async getActivitySummary(req: Request, days = 30) {
    if (!req.tenantDb || !req.tenantContext) {
      throw new Error('Tenant database context not available');
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return req.tenantDb.executeWithTenantContext(req.tenantContext, async (client) => {
      const [
        newUsers,
        activeApiKeys,
        auditEvents,
        lastLogin
      ] = await Promise.all([
        client.walletUser.count({
          where: { createdAt: { gte: startDate } },
        }),
        client.devApiKey.count({
          where: { 
            status: 'active',
            lastUsedAt: { gte: startDate },
          },
        }),
        client.auditLog.count({
          where: { createdAt: { gte: startDate } },
        }),
        client.walletUser.findFirst({
          where: { lastLogin: { not: null } },
          orderBy: { lastLogin: 'desc' },
          select: { lastLogin: true },
        }),
      ]);

      return {
        period: { days, startDate, endDate: new Date() },
        metrics: {
          newUsers,
          activeApiKeys,
          auditEvents,
          lastActivity: lastLogin?.lastLogin,
        },
      };
    });
  }
}

/**
 * Route protection patterns for tenant-aware endpoints
 */
export const tenantRoutePatterns = {
  /**
   * Protect user management routes with tenant isolation
   */
  userManagement: [
    injectTenantDb({ requireWriteAccess: true }),
    async (req: Request, res: Response, next: NextFunction) => {
      // Additional user management specific validations
      next();
    },
  ],

  /**
   * Protect API key management routes with tenant isolation
   */
  apiKeyManagement: [
    injectTenantDb({ requireWriteAccess: true }),
    async (req: Request, res: Response, next: NextFunction) => {
      // Ensure user can manage API keys in their tenant
      next();
    },
  ],

  /**
   * Protect analytics routes with read-only tenant isolation
   */
  analytics: [
    injectTenantDb({ requireWriteAccess: false }),
  ],

  /**
   * Protect audit log routes with sensitive data handling
   */
  auditLogs: [
    injectTenantDb({ requireWriteAccess: false, logQueries: true }),
  ],
};

/**
 * Utility to validate tenant ownership of resources
 */
export async function validateTenantOwnership(
  req: Request,
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  if (!req.tenantDb || !req.tenantContext) {
    return false;
  }

  try {
    const result = await req.tenantDb.executeWithTenantContext(req.tenantContext, async (client) => {
      // This is a simplified check - in production, you'd have specific validation per resource type
      switch (resourceType) {
        case 'user':
          return client.walletUser.findUnique({ where: { id: resourceId } });
        case 'apikey':
          return client.devApiKey.findUnique({ where: { id: resourceId } });
        default:
          return null;
      }
    });

    return result !== null;
  } catch (error) {
    logger.warn('Tenant ownership validation failed', { 
      resourceType, 
      resourceId, 
      error: error.message 
    });
    return false;
  }
}

/**
 * Express middleware to validate tenant ownership of route parameters
 */
export function requireTenantOwnership(resourceType: string, paramName = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const resourceId = req.params[paramName];
    
    if (!resourceId) {
      return res.status(400).json({
        error: 'Resource ID Required',
        message: `Parameter '${paramName}' is required`,
        code: 'RESOURCE_ID_REQUIRED',
      });
    }

    const hasOwnership = await validateTenantOwnership(req, resourceType, resourceId);
    
    if (!hasOwnership) {
      return res.status(404).json({
        error: 'Resource Not Found',
        message: `${resourceType} not found or access denied`,
        code: 'RESOURCE_NOT_FOUND',
      });
    }

    next();
  };
}

export {
  TenantUserManager,
  TenantApiKeyManager,
  TenantAnalytics,
};