/**
 * RBAC Route Integration Helpers
 *
 * Helper functions to easily integrate RBAC permissions into existing API routes
 * with minimal code changes and backwards compatibility.
 */

import type { Router } from 'express';
import { 
  requirePermission,
  requireTenantPermission,
  requireResourcePermission,
  requireMethodPermissions,
  requireConditionalPermission,
  enhancedApiKeyAuth,
  enhancedUserAuth,
  enhancedAdminAuth,
  type PermissionMiddlewareOptions,
} from './middleware';

/**
 * Route permission configuration
 */
export interface RoutePermissionConfig {
  // Basic permission requirements
  permissions?: string | string[];
  requireAll?: boolean;
  
  // Resource-specific settings
  resource?: {
    type: string;
    idParam?: string;
    idHeader?: string;
  };
  
  // Tenant-specific settings
  tenant?: {
    param?: string;
    header?: string;
    required?: boolean;
  };
  
  // HTTP method specific permissions
  methodPermissions?: {
    GET?: string | string[];
    POST?: string | string[];
    PUT?: string | string[];
    PATCH?: string | string[];
    DELETE?: string | string[];
  };
  
  // Conditional permissions based on request properties
  conditionalPermissions?: Array<{
    condition: (req: any) => boolean;
    permissions: string | string[];
  }>;
}

/**
 * Apply RBAC protection to a router
 */
export function protectRouter(router: Router, config: RoutePermissionConfig): Router {
  if (config.methodPermissions) {
    router.use(requireMethodPermissions(config.methodPermissions));
  } else if (config.conditionalPermissions) {
    router.use(requireConditionalPermission(
      config.conditionalPermissions.map(cp => ({
        condition: cp.condition,
        permissions: cp.permissions,
      }))
    ));
  } else if (config.permissions) {
    const options: Partial<PermissionMiddlewareOptions> = {
      requireAll: config.requireAll,
      resource: config.resource,
      tenant: config.tenant,
    };

    if (config.resource) {
      router.use(requireResourcePermission(config.permissions, config.resource.type, options));
    } else if (config.tenant?.required) {
      router.use(requireTenantPermission(config.permissions, options));
    } else {
      router.use(requirePermission(config.permissions, options));
    }
  }

  return router;
}

/**
 * Quick protection for admin routes
 */
export function protectAdminRoutes(router: Router): Router {
  router.use(enhancedAdminAuth);
  return protectRouter(router, {
    methodPermissions: {
      GET: 'admin:system:read',
      POST: 'admin:system:write',
      PUT: 'admin:system:write',
      PATCH: 'admin:system:write',
      DELETE: 'admin:system:write',
    },
  });
}

/**
 * Quick protection for freeze management routes
 */
export function protectFreezeRoutes(router: Router): Router {
  router.use(enhancedAdminAuth);
  return protectRouter(router, {
    methodPermissions: {
      GET: ['admin:freeze:read', 'freeze:violations:read'],
      POST: 'admin:freeze:create',
      PUT: 'admin:freeze:update',
      PATCH: 'admin:freeze:update', 
      DELETE: 'admin:freeze:delete',
    },
  });
}

/**
 * Quick protection for compliance routes
 */
export function protectComplianceRoutes(router: Router): Router {
  return protectRouter(router, {
    conditionalPermissions: [
      {
        condition: (req) => req.path.includes('/screen'),
        permissions: 'compliance:screen:read',
      },
      {
        condition: (req) => req.path.includes('/alerts'),
        permissions: ['compliance:alerts:read', 'compliance:alerts:review'],
      },
      {
        condition: (req) => req.path.includes('/reports'),
        permissions: req => req.method === 'GET' ? 'compliance:reports:read' : 'compliance:reports:create',
      },
      {
        condition: (req) => req.path.includes('/blocking'),
        permissions: 'compliance:blocking:manage',
      },
    ],
  });
}

/**
 * Quick protection for API routes (developer access)
 */
export function protectApiRoutes(router: Router): Router {
  // Allow both user auth and API key auth
  router.use((req, res, next) => {
    enhancedUserAuth(req, res, (userError) => {
      if (!userError && req.user) {
        return next(); // User auth succeeded
      }
      
      // Try API key auth
      enhancedApiKeyAuth(req, res, (apiKeyError) => {
        if (apiKeyError) {
          return res.status(401).json({
            error: 'Authentication Required',
            message: 'Provide either Bearer token or X-Api-Key header',
          });
        }
        next();
      });
    });
  });

  return protectRouter(router, {
    methodPermissions: {
      GET: ['api:contracts:read', 'api:transactions:read', 'api:events:read'],
      POST: ['api:exports:create', 'api:webhooks:manage'],
      PUT: 'api:webhooks:manage',
      PATCH: 'api:webhooks:manage',
      DELETE: 'api:webhooks:manage',
    },
  });
}

/**
 * Quick protection for contract-specific routes
 */
export function protectContractRoutes(router: Router): Router {
  return protectRouter(router, {
    permissions: 'api:contracts:read',
    resource: {
      type: 'contract',
      idParam: 'contractAddress',
    },
  });
}

/**
 * Quick protection for user management routes
 */
export function protectUserRoutes(router: Router): Router {
  return protectRouter(router, {
    conditionalPermissions: [
      {
        // Users can access their own profile
        condition: (req) => req.user && req.params.userId === req.user.id,
        permissions: ['self:profile:read', 'self:profile:update'],
      },
      {
        // Admins can access any user
        condition: (req) => true,
        permissions: ['admin:users:read', 'admin:users:write'],
      },
    ],
    resource: {
      type: 'user',
      idParam: 'userId',
    },
  });
}

/**
 * Quick protection for tenant-scoped routes
 */
export function protectTenantRoutes(router: Router, permissions: string | string[]): Router {
  return protectRouter(router, {
    permissions,
    tenant: {
      param: 'tenantId',
      header: 'X-Tenant-ID',
      required: true,
    },
  });
}

/**
 * Migration helper for existing routes
 */
export interface RouteMigrationConfig {
  // Mapping from old role requirements to new permissions
  roleMapping: {
    [role: string]: string | string[];
  };
  
  // Feature flag to enable RBAC (default: false)
  enableRbac?: boolean;
  
  // Log permission check comparisons
  logComparison?: boolean;
  
  // Fallback behavior when RBAC fails
  fallbackToLegacy?: boolean;
}

/**
 * Create a migration middleware for gradual RBAC adoption
 */
export function createRouteMigration(router: Router, config: RouteMigrationConfig): Router {
  const { 
    roleMapping, 
    enableRbac = false, 
    logComparison = false,
    fallbackToLegacy = true 
  } = config;

  if (!enableRbac) {
    // Return router unchanged for legacy behavior
    return router;
  }

  // Enhance authentication middleware
  router.use((req, res, next) => {
    // Set up RBAC principal based on existing auth context
    if (req.user) {
      req.rbacPrincipal = {
        type: 'user',
        userId: req.user.id,
        sessionId: req.user.sessionId,
        tenantId: req.user.tenantId,
      };
    } else if (req.apiKey) {
      req.rbacPrincipal = {
        type: 'api_key', 
        apiKeyId: req.apiKey.id,
        tenantId: req.apiKey.tenantId,
      };
    } else if (req.actor === 'admin') {
      req.rbacPrincipal = {
        type: 'admin',
      };
    }
    
    next();
  });

  return router;
}

/**
 * Apply default RBAC protection based on route patterns
 */
export function applyDefaultRbacProtection(router: Router): Router {
  // Admin routes (anything under /admin)
  router.use('/admin/*', enhancedAdminAuth);
  router.use('/admin/*', requirePermission(['admin:system:read', 'admin:system:write']));
  
  // Freeze routes
  router.use('/freeze/*', enhancedAdminAuth);
  router.use('/freeze/*', requirePermission([
    'admin:freeze:read', 
    'admin:freeze:create',
    'admin:freeze:update', 
    'admin:freeze:delete'
  ]));
  
  // Compliance routes  
  router.use('/compliance/*', requirePermission([
    'compliance:screen:read',
    'compliance:alerts:read', 
    'compliance:reports:read'
  ]));
  
  // API routes (contracts, transactions, events)
  router.use(['/contracts/*', '/transactions/*', '/events/*'], requirePermission([
    'api:contracts:read',
    'api:transactions:read', 
    'api:events:read'
  ]));
  
  // User profile routes
  router.use('/users/:userId/*', requireConditionalPermission([
    {
      condition: (req) => req.user && req.params.userId === req.user.id,
      permissions: ['self:profile:read', 'self:profile:update'],
    },
    {
      condition: () => true,
      permissions: ['admin:users:read', 'admin:users:write'],
    },
  ]));

  return router;
}

/**
 * Quick setup for common route protection patterns
 */
export const routeProtectionPatterns = {
  // Admin-only routes
  adminOnly: (router: Router) => protectAdminRoutes(router),
  
  // Compliance officer routes
  complianceOnly: (router: Router) => protectRouter(router, {
    permissions: [
      'compliance:screen:read',
      'compliance:alerts:read',
      'compliance:reports:read',
      'compliance:blocking:manage',
    ],
  }),
  
  // Developer API routes
  developerApi: (router: Router) => protectApiRoutes(router),
  
  // Self-service routes (users can only access their own data)
  selfService: (router: Router) => protectRouter(router, {
    conditionalPermissions: [
      {
        condition: (req) => req.user && req.params.userId === req.user.id,
        permissions: ['self:profile:read', 'self:profile:update'],
      },
    ],
  }),
  
  // Read-only routes
  readOnly: (router: Router) => protectRouter(router, {
    methodPermissions: {
      GET: ['api:contracts:read', 'api:transactions:read', 'api:events:read'],
    },
  }),
  
  // Tenant-scoped routes
  tenantScoped: (permissions: string | string[]) => (router: Router) => 
    protectTenantRoutes(router, permissions),
    
  // Audit access routes
  auditAccess: (router: Router) => protectRouter(router, {
    conditionalPermissions: [
      {
        condition: (req) => req.path.includes('/sensitive'),
        permissions: 'audit:logs:read:sensitive',
      },
      {
        condition: () => true,
        permissions: 'audit:logs:read',
      },
    ],
  }),
};

/**
 * Bulk apply protection to multiple routers
 */
export function protectRouters(
  routers: Array<{ router: Router; config: RoutePermissionConfig }> 
): void {
  routers.forEach(({ router, config }) => {
    protectRouter(router, config);
  });
}

// Export common permission sets for easy reuse
export const commonPermissions = {
  admin: {
    read: 'admin:system:read',
    write: 'admin:system:write',
    full: ['admin:system:read', 'admin:system:write'],
  },
  freeze: {
    read: 'admin:freeze:read',
    manage: ['admin:freeze:create', 'admin:freeze:update', 'admin:freeze:delete'],
    violations: ['freeze:violations:read', 'freeze:violations:resolve'],
  },
  compliance: {
    screen: 'compliance:screen:read',
    alerts: ['compliance:alerts:read', 'compliance:alerts:review'],
    reports: ['compliance:reports:read', 'compliance:reports:create'],
    blocking: 'compliance:blocking:manage',
  },
  api: {
    read: ['api:contracts:read', 'api:transactions:read', 'api:events:read'],
    write: ['api:exports:create', 'api:webhooks:manage'],
  },
  audit: {
    read: 'audit:logs:read',
    sensitive: 'audit:logs:read:sensitive',
  },
  self: {
    profile: ['self:profile:read', 'self:profile:update'],
    sessions: ['self:sessions:read', 'self:sessions:revoke'],
    keys: ['self:keys:read', 'self:keys:write'],
  },
};