/**
 * Enhanced Admin API with RBAC Integration
 *
 * Example implementation showing how to integrate RBAC permissions
 * with existing admin routes while maintaining backward compatibility.
 */

import { Router } from 'express';
import { 
  requirePermission,
  requireAdminRead,
  requireAdminWrite,
  requireUserManagement,
  requireAuditRead,
  requireSensitiveAuditRead,
} from '../rbac/middleware';
import { 
  protectAdminRoutes,
  protectUserRoutes,
  routeProtectionPatterns,
  commonPermissions,
} from '../rbac/route-integration';
import { rbacService } from '../rbac/rbac-service';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

const router = Router();

// Apply admin-level authentication and basic permissions
router.use(protectAdminRoutes);

// ── System Administration Routes ─────────────────────────────────────────────

/**
 * GET /admin/system/status
 * System status and health check - requires admin read permission
 */
router.get('/system/status', requireAdminRead, async (req, res) => {
  try {
    // Get system metrics
    const metrics = {
      timestamp: new Date(),
      database: {
        connected: true, // Check database connectivity
        latency: '12ms', // Example metrics
      },
      cache: rbacService.getCacheStats(),
      permissions: {
        systemRoles: await rbacService.getRoles(true),
        customRoles: await rbacService.getRoles(false),
      },
      requestId: req.id,
    };

    res.json({
      status: 'healthy',
      metrics,
    });
  } catch (error) {
    logger.error('System status check failed', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve system status',
      code: 'SYSTEM_STATUS_ERROR',
    });
  }
});

/**
 * POST /admin/system/config
 * Update system configuration - requires admin write permission  
 */
router.post('/system/config', requireAdminWrite, async (req, res) => {
  try {
    const { key, value } = req.body;

    // Validate configuration update
    if (!key || value === undefined) {
      return res.status(400).json({
        error: 'Configuration key and value are required',
        code: 'INVALID_CONFIG',
      });
    }

    // Store configuration (example implementation)
    // In production, this would update a configuration store
    logger.info('System configuration updated', {
      key,
      value,
      actor: req.rbacContext?.principal,
    });

    res.json({
      message: 'Configuration updated successfully',
      key,
      value,
    });
  } catch (error) {
    logger.error('Configuration update failed', { error: error.message });
    res.status(500).json({
      error: 'Failed to update configuration',
      code: 'CONFIG_UPDATE_ERROR', 
    });
  }
});

// ── User Management Routes ───────────────────────────────────────────────────

/**
 * GET /admin/users
 * List all users - requires user management permissions
 */
router.get('/users', requireUserManagement, async (req, res) => {
  try {
    const { page = 1, limit = 50, tenantId } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const where = tenantId ? { tenantId: String(tenantId) } : {};

    const [users, total] = await Promise.all([
      prismaRead.walletUser.findMany({
        where,
        select: {
          id: true,
          address: true,
          role: true,
          tier: true,
          displayName: true,
          email: true,
          isActive: true,
          tenantId: true,
          lastLogin: true,
          createdAt: true,
          userRoles: {
            include: { role: true },
          },
        },
        skip: offset,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.walletUser.count({ where }),
    ]);

    res.json({
      users: users.map(user => ({
        ...user,
        rbacRoles: user.userRoles.map(ur => ur.role.name),
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    logger.error('Failed to list users', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve users',
      code: 'USER_LIST_ERROR',
    });
  }
});

/**
 * PUT /admin/users/:userId/role
 * Update user role - requires user management permissions
 */
router.put('/users/:userId/role', requireUserManagement, async (req, res) => {
  try {
    const { userId } = req.params;
    const { roleId, tenantId, expiresAt } = req.body;

    if (!roleId) {
      return res.status(400).json({
        error: 'Role ID is required',
        code: 'MISSING_ROLE_ID',
      });
    }

    // Assign the role using RBAC service
    const userRole = await rbacService.assignRole(
      {
        userId,
        roleId,
        tenantId,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        grantedBy: req.rbacContext?.principal?.userId || 'admin',
      },
      req.rbacContext!.principal
    );

    res.json({
      message: 'Role assigned successfully',
      userRole,
    });
  } catch (error) {
    logger.error('Failed to assign role', { userId: req.params.userId, error: error.message });
    
    if (error.code === 'PERMISSION_DENIED') {
      return res.status(403).json({
        error: error.message,
        code: 'PERMISSION_DENIED',
      });
    }

    res.status(500).json({
      error: 'Failed to assign role',
      code: 'ROLE_ASSIGNMENT_ERROR',
    });
  }
});

// ── Role and Permission Management ───────────────────────────────────────────

/**
 * GET /admin/roles
 * List all roles - requires admin read permission
 */
router.get('/roles', requireAdminRead, async (req, res) => {
  try {
    const { includeSystem = 'false' } = req.query;
    
    const roles = await rbacService.getRoles(includeSystem === 'true');

    res.json({ roles });
  } catch (error) {
    logger.error('Failed to list roles', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve roles',
      code: 'ROLE_LIST_ERROR',
    });
  }
});

/**
 * POST /admin/roles
 * Create a new role - requires admin write permission
 */
router.post('/roles', requireAdminWrite, async (req, res) => {
  try {
    const { id, name, description, permissions, inheritsFrom } = req.body;

    if (!id || !name || !Array.isArray(permissions)) {
      return res.status(400).json({
        error: 'Role ID, name, and permissions array are required',
        code: 'INVALID_ROLE_DATA',
      });
    }

    const role = await rbacService.createRole(
      {
        id,
        name,
        description,
        permissions,
        inheritsFrom: inheritsFrom || [],
      },
      req.rbacContext!.principal
    );

    res.status(201).json({
      message: 'Role created successfully',
      role,
    });
  } catch (error) {
    logger.error('Failed to create role', { error: error.message });
    
    if (error.code === 'PERMISSION_DENIED') {
      return res.status(403).json({
        error: error.message,
        code: 'PERMISSION_DENIED',
      });
    }

    if (error.code === 'DUPLICATE_ROLE') {
      return res.status(409).json({
        error: error.message,
        code: 'DUPLICATE_ROLE',
      });
    }

    res.status(500).json({
      error: 'Failed to create role',
      code: 'ROLE_CREATE_ERROR',
    });
  }
});

/**
 * GET /admin/permissions
 * List all permissions - requires admin read permission
 */
router.get('/permissions', requireAdminRead, async (req, res) => {
  try {
    const permissions = await rbacService.getPermissions();
    
    // Group permissions by resource for better organization
    const groupedPermissions = permissions.reduce((acc, permission) => {
      if (!acc[permission.resource]) {
        acc[permission.resource] = [];
      }
      acc[permission.resource].push(permission);
      return acc;
    }, {} as Record<string, typeof permissions>);

    res.json({ 
      permissions,
      grouped: groupedPermissions,
    });
  } catch (error) {
    logger.error('Failed to list permissions', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve permissions',
      code: 'PERMISSION_LIST_ERROR',
    });
  }
});

// ── Tenant Management Routes ─────────────────────────────────────────────────

/**
 * GET /admin/tenants
 * List all tenants - requires tenant read permission
 */
router.get('/tenants', requirePermission('admin:tenants:read'), async (req, res) => {
  try {
    const tenants = await rbacService.getTenants();

    res.json({ tenants });
  } catch (error) {
    logger.error('Failed to list tenants', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve tenants',
      code: 'TENANT_LIST_ERROR',
    });
  }
});

/**
 * POST /admin/tenants  
 * Create a new tenant - requires tenant write permission
 */
router.post('/tenants', requirePermission('admin:tenants:write'), async (req, res) => {
  try {
    const { name, slug, parentTenantId, settings, isolationLevel } = req.body;

    if (!name || !slug) {
      return res.status(400).json({
        error: 'Tenant name and slug are required',
        code: 'INVALID_TENANT_DATA',
      });
    }

    const tenant = await rbacService.createTenant(
      {
        name,
        slug,
        parentTenantId,
        settings: settings || {},
        isolationLevel: isolationLevel || 'strict',
      },
      req.rbacContext!.principal
    );

    res.status(201).json({
      message: 'Tenant created successfully',
      tenant,
    });
  } catch (error) {
    logger.error('Failed to create tenant', { error: error.message });
    
    if (error.code === 'PERMISSION_DENIED') {
      return res.status(403).json({
        error: error.message,
        code: 'PERMISSION_DENIED',
      });
    }

    if (error.code === 'DUPLICATE_SLUG') {
      return res.status(409).json({
        error: error.message,
        code: 'DUPLICATE_SLUG',
      });
    }

    res.status(500).json({
      error: 'Failed to create tenant',
      code: 'TENANT_CREATE_ERROR',
    });
  }
});

// ── Audit and Security Routes ────────────────────────────────────────────────

/**
 * GET /admin/audit/logs
 * Get audit logs - requires audit read permission
 */
router.get('/audit/logs', requireAuditRead, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 100, 
      actor, 
      action,
      startDate,
      endDate 
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const where: any = {};

    if (actor) where.actor = String(actor);
    if (action) where.action = String(action);
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(String(startDate));
      if (endDate) where.createdAt.lte = new Date(String(endDate));
    }

    const [logs, total] = await Promise.all([
      prismaRead.auditLog.findMany({
        where,
        skip: offset,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.auditLog.count({ where }),
    ]);

    res.json({
      logs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    logger.error('Failed to retrieve audit logs', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve audit logs',
      code: 'AUDIT_LOG_ERROR',
    });
  }
});

/**
 * GET /admin/audit/sensitive
 * Get sensitive audit logs - requires sensitive audit read permission
 */
router.get('/audit/sensitive', requireSensitiveAuditRead, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const [logs, total] = await Promise.all([
      prismaRead.sensitiveReadAudit.findMany({
        skip: offset,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.sensitiveReadAudit.count(),
    ]);

    res.json({
      logs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    logger.error('Failed to retrieve sensitive audit logs', { error: error.message });
    res.status(500).json({
      error: 'Failed to retrieve sensitive audit logs',
      code: 'SENSITIVE_AUDIT_ERROR',
    });
  }
});

/**
 * GET /admin/permissions/check
 * Check permissions for a principal - utility endpoint for debugging
 */
router.get('/permissions/check', requireAdminRead, async (req, res) => {
  try {
    const { userId, apiKeyId, permission, resourceType, resourceId } = req.query;

    if (!userId && !apiKeyId) {
      return res.status(400).json({
        error: 'Either userId or apiKeyId is required',
        code: 'MISSING_PRINCIPAL',
      });
    }

    if (!permission) {
      return res.status(400).json({
        error: 'Permission is required',
        code: 'MISSING_PERMISSION',
      });
    }

    const principal = userId 
      ? { type: 'user' as const, userId: String(userId) }
      : { type: 'api_key' as const, apiKeyId: String(apiKeyId) };

    const resource = resourceType && resourceId 
      ? { resourceType: String(resourceType), resourceId: String(resourceId) }
      : undefined;

    const result = await rbacService.hasPermission(
      principal,
      String(permission),
      resource,
      {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      }
    );

    res.json({
      principal,
      permission: String(permission),
      resource,
      result,
    });
  } catch (error) {
    logger.error('Permission check failed', { error: error.message });
    res.status(500).json({
      error: 'Permission check failed',
      code: 'PERMISSION_CHECK_ERROR',
    });
  }
});

export default router;