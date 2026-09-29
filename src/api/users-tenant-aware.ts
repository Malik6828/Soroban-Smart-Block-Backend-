/**
 * Tenant-Aware User Management API
 *
 * Example implementation showing how to update existing user management
 * routes to use tenant isolation with minimal code changes.
 */

import { Router } from 'express';
import { 
  withTenantIsolation,
  TenantUserManager,
  requireTenantOwnership,
  validateTenantOwnership,
} from '../rbac/tenant-route-helpers';
import { requirePermission } from '../rbac/middleware';
import { rbacService } from '../rbac/rbac-service';
import { logger } from '../logger';
import { body, query, param, validationResult } from 'express-validator';

const router = Router();

// ── User Listing (Tenant-Scoped) ─────────────────────────────────────────────

/**
 * GET /users
 * List users in the current tenant with pagination and filtering
 */
router.get('/',
  // Validation
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString().isLength({ max: 100 }),
    query('role').optional().isString(),
    query('includeRoles').optional().isBoolean(),
  ],

  // Permission check - users can list users in their tenant, admins can list any
  requirePermission(['tenant:users:read', 'admin:users:read']),

  // Tenant-aware handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation Failed',
        details: errors.array(),
        code: 'VALIDATION_ERROR',
      });
    }

    const {
      page = 1,
      limit = 50,
      search,
      role,
      includeRoles = false,
    } = req.query;

    try {
      const result = await TenantUserManager.getUsers(req, {
        page: Number(page),
        limit: Number(limit),
        search: search as string,
        role: role as string,
        includeRoles: includeRoles === 'true',
      });

      // Transform users to include RBAC role information
      const enhancedUsers = result.users.map(user => ({
        ...user,
        rbacRoles: user.userRoles?.map(ur => ({
          id: ur.role.id,
          name: ur.role.name,
          grantedAt: ur.grantedAt,
          expiresAt: ur.expiresAt,
        })) || [],
        // Remove sensitive fields based on permission level
        userRoles: undefined,
      }));

      res.json({
        users: enhancedUsers,
        pagination: result.pagination,
        tenantId: req.tenantContext?.requestedTenantId,
      });
    } catch (error) {
      logger.error('Failed to list tenant users', {
        error: error.message,
        tenantId: req.tenantContext?.requestedTenantId,
        principal: req.rbacContext?.principal,
      });

      res.status(500).json({
        error: 'Failed to retrieve users',
        code: 'USER_LIST_ERROR',
      });
    }
  }, { requireTenant: true })
);

// ── User Details ─────────────────────────────────────────────────────────────

/**
 * GET /users/:userId
 * Get specific user details with tenant ownership validation
 */
router.get('/:userId',
  // Validation
  param('userId').isUUID(),

  // Permission check with conditional logic
  requirePermission(['self:profile:read', 'tenant:users:read', 'admin:users:read']),

  // Tenant ownership validation
  requireTenantOwnership('user', 'userId'),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Invalid User ID',
        code: 'INVALID_USER_ID',
      });
    }

    const { userId } = req.params;
    const { includeRoles = 'false', includePermissions = 'false' } = req.query;

    try {
      // Check if user is accessing their own profile
      const isSelfAccess = req.rbacContext?.principal.userId === userId;

      const user = await req.tenantDb!.executeWithTenantContext(req.tenantContext, async (client) => {
        return client.walletUser.findUnique({
          where: { id: userId },
          include: {
            userRoles: includeRoles === 'true' ? {
              include: { role: true },
            } : false,
            userPermissions: includePermissions === 'true' ? {
              include: { permission: true },
            } : false,
          },
        });
      });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'USER_NOT_FOUND',
        });
      }

      // Build response based on access level
      const response: any = {
        id: user.id,
        address: user.address,
        displayName: user.displayName,
        isActive: user.isActive,
        role: user.role,
        tier: user.tier,
        createdAt: user.createdAt,
        tenantId: user.tenantId,
      };

      // Include email only for self-access or admin
      if (isSelfAccess || req.rbacContext?.permissions?.includes('admin:users:read')) {
        response.email = user.email;
        response.lastLogin = user.lastLogin;
      }

      // Include roles if requested and authorized
      if (includeRoles === 'true' && user.userRoles) {
        response.rbacRoles = user.userRoles.map(ur => ({
          id: ur.role.id,
          name: ur.role.name,
          description: ur.role.description,
          grantedAt: ur.grantedAt,
          expiresAt: ur.expiresAt,
        }));
      }

      // Include permissions if requested and authorized (admin only)
      if (includePermissions === 'true' && req.rbacContext?.permissions?.includes('admin:users:read')) {
        if (user.userPermissions) {
          response.directPermissions = user.userPermissions.map(up => ({
            id: up.permission.id,
            resource: up.permission.resource,
            action: up.permission.action,
            scope: up.permission.scope,
            grantedAt: up.grantedAt,
            expiresAt: up.expiresAt,
          }));
        }
      }

      res.json({ user: response });
    } catch (error) {
      logger.error('Failed to get user details', {
        userId,
        error: error.message,
        principal: req.rbacContext?.principal,
      });

      res.status(500).json({
        error: 'Failed to retrieve user',
        code: 'USER_GET_ERROR',
      });
    }
  })
);

// ── User Creation ────────────────────────────────────────────────────────────

/**
 * POST /users
 * Create a new user in the current tenant
 */
router.post('/',
  // Validation
  [
    body('address').isString().isLength({ min: 56, max: 56 }).matches(/^G[A-Z0-9]{55}$/),
    body('displayName').optional().isString().isLength({ max: 100 }),
    body('email').optional().isEmail(),
    body('role').optional().isIn(['user', 'developer']),
  ],

  // Permission check
  requirePermission(['tenant:users:invite', 'admin:users:write']),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation Failed',
        details: errors.array(),
        code: 'VALIDATION_ERROR',
      });
    }

    const { address, displayName, email, role = 'user' } = req.body;

    try {
      // Check if user with this address already exists in any tenant
      const { prismaRead } = await import('../db');
      const existingUser = await prismaRead.walletUser.findUnique({
        where: { address },
      });

      if (existingUser) {
        return res.status(409).json({
          error: 'User already exists',
          message: `User with address ${address} already exists`,
          code: 'USER_EXISTS',
        });
      }

      // Create user in tenant
      const user = await TenantUserManager.createUser(req, {
        address,
        displayName,
        email,
        role,
      });

      // Assign default role if not 'user'
      if (role !== 'user') {
        try {
          await rbacService.assignRole(
            {
              userId: user.id,
              roleId: role,
              tenantId: user.tenantId || undefined,
              grantedBy: req.rbacContext?.principal.userId || 'system',
            },
            req.rbacContext!.principal
          );
        } catch (roleError) {
          logger.warn('Failed to assign role to new user', {
            userId: user.id,
            role,
            error: roleError.message,
          });
        }
      }

      res.status(201).json({
        message: 'User created successfully',
        user: {
          id: user.id,
          address: user.address,
          displayName: user.displayName,
          role: user.role,
          tenantId: user.tenantId,
          createdAt: user.createdAt,
        },
      });
    } catch (error) {
      logger.error('Failed to create user', {
        error: error.message,
        address,
        principal: req.rbacContext?.principal,
      });

      res.status(500).json({
        error: 'Failed to create user',
        code: 'USER_CREATE_ERROR',
      });
    }
  }, { requireWriteAccess: true, requireTenant: true })
);

// ── User Updates ─────────────────────────────────────────────────────────────

/**
 * PUT /users/:userId
 * Update user information with tenant ownership validation
 */
router.put('/:userId',
  // Validation
  [
    param('userId').isUUID(),
    body('displayName').optional().isString().isLength({ max: 100 }),
    body('email').optional().isEmail(),
    body('isActive').optional().isBoolean(),
  ],

  // Permission check with conditional logic for self-updates
  requirePermission(['self:profile:update', 'tenant:users:write', 'admin:users:write']),

  // Tenant ownership validation
  requireTenantOwnership('user', 'userId'),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation Failed',
        details: errors.array(),
        code: 'VALIDATION_ERROR',
      });
    }

    const { userId } = req.params;
    const { displayName, email, isActive } = req.body;

    try {
      // Check if user is updating their own profile
      const isSelfUpdate = req.rbacContext?.principal.userId === userId;

      // Build update data based on permissions
      const updateData: any = {};
      
      if (displayName !== undefined) updateData.displayName = displayName;
      if (email !== undefined) updateData.email = email;
      
      // Only allow isActive updates by admin/tenant managers
      if (isActive !== undefined && !isSelfUpdate) {
        const canManageUsers = req.rbacContext?.permissions?.some(p => 
          p.includes('admin:users:write') || p.includes('tenant:users:write')
        );
        
        if (canManageUsers) {
          updateData.isActive = isActive;
        }
      }

      const user = await TenantUserManager.updateUser(req, userId, updateData);

      res.json({
        message: 'User updated successfully',
        user: {
          id: user.id,
          address: user.address,
          displayName: user.displayName,
          email: user.email,
          isActive: user.isActive,
          tenantId: user.tenantId,
          updatedAt: user.updatedAt,
        },
      });
    } catch (error) {
      logger.error('Failed to update user', {
        userId,
        error: error.message,
        principal: req.rbacContext?.principal,
      });

      res.status(500).json({
        error: 'Failed to update user',
        code: 'USER_UPDATE_ERROR',
      });
    }
  }, { requireWriteAccess: true })
);

// ── User Role Management ─────────────────────────────────────────────────────

/**
 * POST /users/:userId/roles
 * Assign a role to a user within tenant boundaries
 */
router.post('/:userId/roles',
  // Validation
  [
    param('userId').isUUID(),
    body('roleId').isString().isLength({ min: 1 }),
    body('expiresAt').optional().isISO8601(),
  ],

  // Permission check
  requirePermission(['admin:users:write', 'tenant:users:write']),

  // Tenant ownership validation
  requireTenantOwnership('user', 'userId'),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation Failed',
        details: errors.array(),
        code: 'VALIDATION_ERROR',
      });
    }

    const { userId } = req.params;
    const { roleId, expiresAt } = req.body;

    try {
      const userRole = await rbacService.assignRole(
        {
          userId,
          roleId,
          tenantId: req.tenantContext?.requestedTenantId,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          grantedBy: req.rbacContext?.principal.userId || 'admin',
        },
        req.rbacContext!.principal
      );

      res.json({
        message: 'Role assigned successfully',
        userRole,
      });
    } catch (error) {
      logger.error('Failed to assign user role', {
        userId,
        roleId,
        error: error.message,
        principal: req.rbacContext?.principal,
      });

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
  }, { requireWriteAccess: true })
);

/**
 * DELETE /users/:userId/roles/:roleId
 * Remove a role from a user within tenant boundaries
 */
router.delete('/:userId/roles/:roleId',
  // Validation
  [
    param('userId').isUUID(),
    param('roleId').isString(),
  ],

  // Permission check
  requirePermission(['admin:users:write', 'tenant:users:write']),

  // Tenant ownership validation
  requireTenantOwnership('user', 'userId'),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation Failed',
        details: errors.array(),
        code: 'VALIDATION_ERROR',
      });
    }

    const { userId, roleId } = req.params;

    try {
      await rbacService.revokeRole(
        userId,
        roleId,
        req.tenantContext?.requestedTenantId,
        req.rbacContext!.principal
      );

      res.json({
        message: 'Role revoked successfully',
      });
    } catch (error) {
      logger.error('Failed to revoke user role', {
        userId,
        roleId,
        error: error.message,
        principal: req.rbacContext?.principal,
      });

      if (error.code === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Role assignment not found',
          code: 'ROLE_NOT_ASSIGNED',
        });
      }

      res.status(500).json({
        error: 'Failed to revoke role',
        code: 'ROLE_REVOKE_ERROR',
      });
    }
  }, { requireWriteAccess: true })
);

// ── User Permissions Check ───────────────────────────────────────────────────

/**
 * GET /users/:userId/permissions
 * Get effective permissions for a user (debugging/admin endpoint)
 */
router.get('/:userId/permissions',
  // Validation
  param('userId').isUUID(),

  // Permission check (admin or self only)
  requirePermission(['admin:users:read', 'self:profile:read']),

  // Handler
  ...withTenantIsolation(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Invalid User ID',
        code: 'INVALID_USER_ID',
      });
    }

    const { userId } = req.params;

    try {
      // Verify user access (self or admin)
      const isSelfAccess = req.rbacContext?.principal.userId === userId;
      const hasAdminAccess = req.rbacContext?.permissions?.includes('admin:users:read');

      if (!isSelfAccess && !hasAdminAccess) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'Can only view own permissions or requires admin access',
          code: 'PERMISSION_DENIED',
        });
      }

      // Check if user exists in tenant
      const hasOwnership = await validateTenantOwnership(req, 'user', userId);
      if (!hasOwnership) {
        return res.status(404).json({
          error: 'User not found',
          code: 'USER_NOT_FOUND',
        });
      }

      // Get user roles and permissions
      const userRoles = await rbacService.getUserRoles(
        userId, 
        req.tenantContext?.requestedTenantId
      );

      // Simulate permission check to get effective permissions
      const principal = { 
        type: 'user' as const, 
        userId, 
        tenantId: req.tenantContext?.requestedTenantId 
      };

      const permissionResult = await rbacService.hasPermission(
        principal,
        'self:profile:read' // Test permission to trigger resolution
      );

      res.json({
        userId,
        tenantId: req.tenantContext?.requestedTenantId,
        roles: userRoles,
        effectivePermissions: permissionResult.appliedPermissions,
        evaluationTime: permissionResult.evaluationTimeMs,
        cacheHit: permissionResult.cacheHit,
      });
    } catch (error) {
      logger.error('Failed to get user permissions', {
        userId,
        error: error.message,
        principal: req.rbacContext?.principal,
      });

      res.status(500).json({
        error: 'Failed to retrieve user permissions',
        code: 'PERMISSION_GET_ERROR',
      });
    }
  })
);

export default router;