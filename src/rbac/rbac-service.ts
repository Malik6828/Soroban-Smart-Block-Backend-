/**
 * RBAC Service
 *
 * High-level service for role-based access control operations including
 * role management, permission assignment, and administrative functions.
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { permissionEngine } from './permission-engine';
import {
  AuthPrincipal,
  Permission,
  Role,
  UserRole,
  UserPermission,
  Tenant,
  PermissionCheckResult,
  ResourceContext,
  PermissionEvaluationContext,
  RbacError,
  PermissionDeniedError,
  ROLE_ID_PATTERN,
  PERMISSION_ID_PATTERN,
  TENANT_SLUG_PATTERN,
} from './types';

export interface CreateRoleRequest {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  inheritsFrom?: string[];
  conditions?: any[];
  tenantId?: string;
}

export interface CreatePermissionRequest {
  id: string;
  resource: string;
  action: string;
  scope?: string;
  description?: string;
  conditions?: any[];
}

export interface AssignRoleRequest {
  userId: string;
  roleId: string;
  tenantId?: string;
  expiresAt?: Date;
  conditions?: any[];
  grantedBy: string;
}

export interface GrantPermissionRequest {
  userId: string;
  permissionId: string;
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  expiresAt?: Date;
  conditions?: any[];
  grantedBy: string;
}

export interface CreateTenantRequest {
  name: string;
  slug: string;
  parentTenantId?: string;
  settings?: Record<string, any>;
  isolationLevel?: 'strict' | 'shared';
}

export class RbacService {
  // ── Permission Checking ──────────────────────────────────────────────────
  
  /**
   * Check if a principal has a specific permission
   */
  async hasPermission(
    principal: AuthPrincipal,
    permission: string,
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    return permissionEngine.hasPermission(principal, permission, resource, context);
  }

  /**
   * Check if a principal has any of the specified permissions
   */
  async hasAnyPermission(
    principal: AuthPrincipal,
    permissions: string[],
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    return permissionEngine.hasAnyPermission(principal, permissions, resource, context);
  }

  /**
   * Check if a principal has all of the specified permissions
   */
  async hasAllPermissions(
    principal: AuthPrincipal,
    permissions: string[],
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    return permissionEngine.hasAllPermissions(principal, permissions, resource, context);
  }

  /**
   * Require a specific permission, throwing an error if not granted
   */
  async requirePermission(
    principal: AuthPrincipal,
    permission: string,
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<void> {
    const result = await this.hasPermission(principal, permission, resource, context);
    if (!result.allowed) {
      throw new PermissionDeniedError(permission, principal, {
        reason: result.reason,
        resource,
      });
    }
  }

  // ── Permission Management ────────────────────────────────────────────────

  /**
   * Create a new permission
   */
  async createPermission(request: CreatePermissionRequest, actor: AuthPrincipal): Promise<Permission> {
    await this.requirePermission(actor, 'admin:roles:write');

    // Validate permission ID format
    if (!PERMISSION_ID_PATTERN.test(request.id)) {
      throw new RbacError('Invalid permission ID format', 'INVALID_FORMAT');
    }

    // Check for duplicate
    const existing = await prismaRead.permission.findUnique({
      where: { id: request.id },
    });

    if (existing) {
      throw new RbacError(`Permission already exists: ${request.id}`, 'DUPLICATE_PERMISSION');
    }

    const permission = await prismaWrite.permission.create({
      data: {
        id: request.id,
        resource: request.resource,
        action: request.action,
        scope: request.scope,
        description: request.description,
        conditions: request.conditions || [],
        isSystemPermission: false,
      },
    });

    logger.info('Permission created', {
      permissionId: permission.id,
      actor: actor.userId || actor.apiKeyId,
    });

    return {
      id: permission.id,
      resource: permission.resource,
      action: permission.action,
      scope: permission.scope || undefined,
      description: permission.description || undefined,
      conditions: (permission.conditions as any) || [],
      isSystemPermission: permission.isSystemPermission,
    };
  }

  /**
   * Get all permissions
   */
  async getPermissions(tenantId?: string): Promise<Permission[]> {
    const permissions = await prismaRead.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });

    return permissions.map(p => ({
      id: p.id,
      resource: p.resource,
      action: p.action,
      scope: p.scope || undefined,
      description: p.description || undefined,
      conditions: (p.conditions as any) || [],
      isSystemPermission: p.isSystemPermission,
    }));
  }

  /**
   * Get permission by ID
   */
  async getPermission(id: string): Promise<Permission | null> {
    const permission = await prismaRead.permission.findUnique({
      where: { id },
    });

    if (!permission) return null;

    return {
      id: permission.id,
      resource: permission.resource,
      action: permission.action,
      scope: permission.scope || undefined,
      description: permission.description || undefined,
      conditions: (permission.conditions as any) || [],
      isSystemPermission: permission.isSystemPermission,
    };
  }

  /**
   * Update a permission (non-system only)
   */
  async updatePermission(
    id: string,
    updates: Partial<CreatePermissionRequest>,
    actor: AuthPrincipal
  ): Promise<Permission> {
    await this.requirePermission(actor, 'admin:roles:write');

    const permission = await prismaRead.permission.findUnique({
      where: { id },
    });

    if (!permission) {
      throw new RbacError(`Permission not found: ${id}`, 'NOT_FOUND');
    }

    if (permission.isSystemPermission) {
      throw new RbacError('Cannot modify system permission', 'SYSTEM_PERMISSION');
    }

    const updated = await prismaWrite.permission.update({
      where: { id },
      data: {
        description: updates.description,
        conditions: updates.conditions,
      },
    });

    logger.info('Permission updated', {
      permissionId: id,
      actor: actor.userId || actor.apiKeyId,
    });

    return {
      id: updated.id,
      resource: updated.resource,
      action: updated.action,
      scope: updated.scope || undefined,
      description: updated.description || undefined,
      conditions: (updated.conditions as any) || [],
      isSystemPermission: updated.isSystemPermission,
    };
  }

  /**
   * Delete a permission (non-system only)
   */
  async deletePermission(id: string, actor: AuthPrincipal): Promise<void> {
    await this.requirePermission(actor, 'admin:roles:write');

    const permission = await prismaRead.permission.findUnique({
      where: { id },
    });

    if (!permission) {
      throw new RbacError(`Permission not found: ${id}`, 'NOT_FOUND');
    }

    if (permission.isSystemPermission) {
      throw new RbacError('Cannot delete system permission', 'SYSTEM_PERMISSION');
    }

    // Check if permission is in use
    const usageCount = await prismaRead.rolePermission.count({
      where: { permissionId: id },
    });

    if (usageCount > 0) {
      throw new RbacError(
        `Cannot delete permission in use by ${usageCount} role(s)`,
        'PERMISSION_IN_USE'
      );
    }

    await prismaWrite.permission.delete({
      where: { id },
    });

    logger.info('Permission deleted', {
      permissionId: id,
      actor: actor.userId || actor.apiKeyId,
    });
  }

  // ── Role Management ───────────────────────────────────────────────────────

  /**
   * Create a new role
   */
  async createRole(request: CreateRoleRequest, actor: AuthPrincipal): Promise<Role> {
    await this.requirePermission(actor, 'admin:roles:write');

    // Validate role ID format
    if (!ROLE_ID_PATTERN.test(request.id)) {
      throw new RbacError('Invalid role ID format', 'INVALID_FORMAT');
    }

    // Check for duplicate
    const existing = await prismaRead.role.findUnique({
      where: { id: request.id },
    });

    if (existing) {
      throw new RbacError(`Role already exists: ${request.id}`, 'DUPLICATE_ROLE');
    }

    // Validate that all permissions exist
    if (request.permissions.length > 0) {
      const permissionCount = await prismaRead.permission.count({
        where: { id: { in: request.permissions } },
      });

      if (permissionCount !== request.permissions.length) {
        throw new RbacError('One or more permissions do not exist', 'INVALID_PERMISSIONS');
      }
    }

    // Validate inheritance chain
    if (request.inheritsFrom) {
      await this.validateRoleInheritance(request.inheritsFrom);
    }

    // Create the role
    const role = await prismaWrite.role.create({
      data: {
        id: request.id,
        name: request.name,
        description: request.description,
        inheritsFrom: request.inheritsFrom || [],
        conditions: request.conditions || [],
        isSystemRole: false,
      },
    });

    // Assign permissions to the role
    if (request.permissions.length > 0) {
      await prismaWrite.rolePermission.createMany({
        data: request.permissions.map(permissionId => ({
          roleId: role.id,
          permissionId,
          grantedBy: actor.userId || actor.apiKeyId || 'system',
        })),
      });
    }

    logger.info('Role created', {
      roleId: role.id,
      permissions: request.permissions.length,
      actor: actor.userId || actor.apiKeyId,
    });

    return await this.getRole(role.id) as Role;
  }

  /**
   * Get all roles
   */
  async getRoles(includeSystem: boolean = false): Promise<Role[]> {
    const where = includeSystem ? {} : { isSystemRole: false };
    
    const roles = await prismaRead.role.findMany({
      where,
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return roles.map(role => ({
      id: role.id,
      name: role.name,
      description: role.description || undefined,
      inheritsFrom: role.inheritsFrom,
      isSystemRole: role.isSystemRole,
      conditions: (role.conditions as any) || [],
      permissions: role.rolePermissions.map(rp => ({
        id: rp.permission.id,
        resource: rp.permission.resource,
        action: rp.permission.action,
        scope: rp.permission.scope || undefined,
        description: rp.permission.description || undefined,
        conditions: (rp.permission.conditions as any) || [],
        isSystemPermission: rp.permission.isSystemPermission,
      })),
    }));
  }

  /**
   * Get role by ID
   */
  async getRole(id: string): Promise<Role | null> {
    const role = await prismaRead.role.findUnique({
      where: { id },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });

    if (!role) return null;

    return {
      id: role.id,
      name: role.name,
      description: role.description || undefined,
      inheritsFrom: role.inheritsFrom,
      isSystemRole: role.isSystemRole,
      conditions: (role.conditions as any) || [],
      permissions: role.rolePermissions.map(rp => ({
        id: rp.permission.id,
        resource: rp.permission.resource,
        action: rp.permission.action,
        scope: rp.permission.scope || undefined,
        description: rp.permission.description || undefined,
        conditions: (rp.permission.conditions as any) || [],
        isSystemPermission: rp.permission.isSystemPermission,
      })),
    };
  }

  /**
   * Update a role (non-system only)
   */
  async updateRole(
    id: string,
    updates: Partial<CreateRoleRequest>,
    actor: AuthPrincipal
  ): Promise<Role> {
    await this.requirePermission(actor, 'admin:roles:write');

    const role = await prismaRead.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new RbacError(`Role not found: ${id}`, 'NOT_FOUND');
    }

    if (role.isSystemRole) {
      throw new RbacError('Cannot modify system role', 'SYSTEM_ROLE');
    }

    // Validate inheritance changes
    if (updates.inheritsFrom) {
      await this.validateRoleInheritance(updates.inheritsFrom, id);
    }

    // Update the role
    const updated = await prismaWrite.role.update({
      where: { id },
      data: {
        name: updates.name,
        description: updates.description,
        inheritsFrom: updates.inheritsFrom,
        conditions: updates.conditions,
      },
    });

    // Update permissions if provided
    if (updates.permissions) {
      // Remove existing permissions
      await prismaWrite.rolePermission.deleteMany({
        where: { roleId: id },
      });

      // Add new permissions
      if (updates.permissions.length > 0) {
        await prismaWrite.rolePermission.createMany({
          data: updates.permissions.map(permissionId => ({
            roleId: id,
            permissionId,
            grantedBy: actor.userId || actor.apiKeyId || 'system',
          })),
        });
      }
    }

    logger.info('Role updated', {
      roleId: id,
      actor: actor.userId || actor.apiKeyId,
    });

    return await this.getRole(id) as Role;
  }

  /**
   * Delete a role (non-system only)
   */
  async deleteRole(id: string, actor: AuthPrincipal): Promise<void> {
    await this.requirePermission(actor, 'admin:roles:write');

    const role = await prismaRead.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new RbacError(`Role not found: ${id}`, 'NOT_FOUND');
    }

    if (role.isSystemRole) {
      throw new RbacError('Cannot delete system role', 'SYSTEM_ROLE');
    }

    // Check if role is assigned to users
    const userCount = await prismaRead.userRole.count({
      where: { roleId: id },
    });

    if (userCount > 0) {
      throw new RbacError(
        `Cannot delete role assigned to ${userCount} user(s)`,
        'ROLE_IN_USE'
      );
    }

    // Check if role is inherited by other roles
    const inheritingCount = await prismaRead.role.count({
      where: { inheritsFrom: { has: id } },
    });

    if (inheritingCount > 0) {
      throw new RbacError(
        `Cannot delete role inherited by ${inheritingCount} role(s)`,
        'ROLE_INHERITED'
      );
    }

    await prismaWrite.role.delete({
      where: { id },
    });

    logger.info('Role deleted', {
      roleId: id,
      actor: actor.userId || actor.apiKeyId,
    });
  }

  // ── User Role Assignment ──────────────────────────────────────────────────

  /**
   * Assign a role to a user
   */
  async assignRole(request: AssignRoleRequest, actor: AuthPrincipal): Promise<UserRole> {
    await this.requirePermission(actor, 'admin:users:write', {
      resourceType: 'user',
      resourceId: request.userId,
      tenantId: request.tenantId,
    });

    // Validate that user exists
    const user = await prismaRead.walletUser.findUnique({
      where: { id: request.userId },
    });

    if (!user) {
      throw new RbacError(`User not found: ${request.userId}`, 'USER_NOT_FOUND');
    }

    // Validate that role exists
    const role = await prismaRead.role.findUnique({
      where: { id: request.roleId },
    });

    if (!role) {
      throw new RbacError(`Role not found: ${request.roleId}`, 'ROLE_NOT_FOUND');
    }

    // Check for existing assignment
    const existing = await prismaRead.userRole.findUnique({
      where: {
        userId_roleId_tenantId: {
          userId: request.userId,
          roleId: request.roleId,
          tenantId: request.tenantId || 'null',
        },
      },
    });

    if (existing) {
      throw new RbacError('Role already assigned to user', 'DUPLICATE_ASSIGNMENT');
    }

    const userRole = await prismaWrite.userRole.create({
      data: {
        userId: request.userId,
        roleId: request.roleId,
        tenantId: request.tenantId,
        grantedBy: request.grantedBy,
        expiresAt: request.expiresAt,
        conditions: request.conditions || [],
      },
    });

    // Clear permission cache for the user
    await permissionEngine.clearCache({
      type: 'user',
      userId: request.userId,
      tenantId: request.tenantId,
    });

    logger.info('Role assigned to user', {
      userId: request.userId,
      roleId: request.roleId,
      tenantId: request.tenantId,
      actor: request.grantedBy,
    });

    return {
      userId: userRole.userId,
      roleId: userRole.roleId,
      tenantId: userRole.tenantId || undefined,
      grantedBy: userRole.grantedBy || undefined,
      grantedAt: userRole.grantedAt,
      expiresAt: userRole.expiresAt || undefined,
      conditions: (userRole.conditions as any) || [],
    };
  }

  /**
   * Remove a role from a user
   */
  async revokeRole(
    userId: string,
    roleId: string,
    tenantId: string | undefined,
    actor: AuthPrincipal
  ): Promise<void> {
    await this.requirePermission(actor, 'admin:users:write', {
      resourceType: 'user',
      resourceId: userId,
      tenantId,
    });

    const deleted = await prismaWrite.userRole.deleteMany({
      where: {
        userId,
        roleId,
        tenantId: tenantId || null,
      },
    });

    if (deleted.count === 0) {
      throw new RbacError('Role assignment not found', 'NOT_FOUND');
    }

    // Clear permission cache for the user
    await permissionEngine.clearCache({
      type: 'user',
      userId,
      tenantId,
    });

    logger.info('Role revoked from user', {
      userId,
      roleId,
      tenantId,
      actor: actor.userId || actor.apiKeyId,
    });
  }

  /**
   * Get user roles
   */
  async getUserRoles(userId: string, tenantId?: string): Promise<UserRole[]> {
    const userRoles = await prismaRead.userRole.findMany({
      where: {
        userId,
        tenantId: tenantId || null,
      },
      include: { role: true },
    });

    return userRoles.map(ur => ({
      userId: ur.userId,
      roleId: ur.roleId,
      tenantId: ur.tenantId || undefined,
      grantedBy: ur.grantedBy || undefined,
      grantedAt: ur.grantedAt,
      expiresAt: ur.expiresAt || undefined,
      conditions: (ur.conditions as any) || [],
    }));
  }

  // ── Direct Permission Assignment ──────────────────────────────────────────

  /**
   * Grant a direct permission to a user
   */
  async grantPermission(request: GrantPermissionRequest, actor: AuthPrincipal): Promise<UserPermission> {
    await this.requirePermission(actor, 'admin:users:write', {
      resourceType: 'user',
      resourceId: request.userId,
      tenantId: request.tenantId,
    });

    // Validate that permission exists
    const permission = await prismaRead.permission.findUnique({
      where: { id: request.permissionId },
    });

    if (!permission) {
      throw new RbacError(`Permission not found: ${request.permissionId}`, 'PERMISSION_NOT_FOUND');
    }

    const userPermission = await prismaWrite.userPermission.create({
      data: {
        userId: request.userId,
        permissionId: request.permissionId,
        tenantId: request.tenantId,
        resourceType: request.resourceType,
        resourceId: request.resourceId,
        grantedBy: request.grantedBy,
        expiresAt: request.expiresAt,
        conditions: request.conditions || [],
      },
    });

    // Clear permission cache for the user
    await permissionEngine.clearCache({
      type: 'user',
      userId: request.userId,
      tenantId: request.tenantId,
    });

    logger.info('Permission granted to user', {
      userId: request.userId,
      permissionId: request.permissionId,
      tenantId: request.tenantId,
      actor: request.grantedBy,
    });

    return {
      id: userPermission.id,
      userId: userPermission.userId,
      permissionId: userPermission.permissionId,
      tenantId: userPermission.tenantId || undefined,
      resourceType: userPermission.resourceType || undefined,
      resourceId: userPermission.resourceId || undefined,
      grantedBy: userPermission.grantedBy || undefined,
      grantedAt: userPermission.grantedAt,
      expiresAt: userPermission.expiresAt || undefined,
      conditions: (userPermission.conditions as any) || [],
    };
  }

  /**
   * Revoke a direct permission from a user
   */
  async revokePermission(userPermissionId: string, actor: AuthPrincipal): Promise<void> {
    const userPermission = await prismaRead.userPermission.findUnique({
      where: { id: userPermissionId },
    });

    if (!userPermission) {
      throw new RbacError('User permission not found', 'NOT_FOUND');
    }

    await this.requirePermission(actor, 'admin:users:write', {
      resourceType: 'user',
      resourceId: userPermission.userId,
      tenantId: userPermission.tenantId || undefined,
    });

    await prismaWrite.userPermission.delete({
      where: { id: userPermissionId },
    });

    // Clear permission cache for the user
    await permissionEngine.clearCache({
      type: 'user',
      userId: userPermission.userId,
      tenantId: userPermission.tenantId || undefined,
    });

    logger.info('Permission revoked from user', {
      userPermissionId,
      userId: userPermission.userId,
      permissionId: userPermission.permissionId,
      actor: actor.userId || actor.apiKeyId,
    });
  }

  // ── Tenant Management ─────────────────────────────────────────────────────

  /**
   * Create a new tenant
   */
  async createTenant(request: CreateTenantRequest, actor: AuthPrincipal): Promise<Tenant> {
    await this.requirePermission(actor, 'admin:tenants:write');

    // Validate slug format
    if (!TENANT_SLUG_PATTERN.test(request.slug)) {
      throw new RbacError('Invalid tenant slug format', 'INVALID_FORMAT');
    }

    // Check for duplicate slug
    const existing = await prismaRead.tenant.findUnique({
      where: { slug: request.slug },
    });

    if (existing) {
      throw new RbacError(`Tenant slug already exists: ${request.slug}`, 'DUPLICATE_SLUG');
    }

    const tenant = await prismaWrite.tenant.create({
      data: {
        name: request.name,
        slug: request.slug,
        parentTenantId: request.parentTenantId,
        settings: request.settings || {},
        isolationLevel: request.isolationLevel || 'strict',
      },
    });

    logger.info('Tenant created', {
      tenantId: tenant.id,
      slug: tenant.slug,
      actor: actor.userId || actor.apiKeyId,
    });

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      parentTenantId: tenant.parentTenantId || undefined,
      settings: tenant.settings as Record<string, any>,
      isolationLevel: tenant.isolationLevel as 'strict' | 'shared',
    };
  }

  /**
   * Get all tenants
   */
  async getTenants(): Promise<Tenant[]> {
    const tenants = await prismaRead.tenant.findMany({
      orderBy: { name: 'asc' },
    });

    return tenants.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      parentTenantId: t.parentTenantId || undefined,
      settings: t.settings as Record<string, any>,
      isolationLevel: t.isolationLevel as 'strict' | 'shared',
    }));
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return permissionEngine.getCacheStats();
  }

  // ── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Validate role inheritance to prevent cycles
   */
  private async validateRoleInheritance(inheritsFrom: string[], excludeRoleId?: string): Promise<void> {
    const visited = new Set<string>();
    const processing = new Set<string>();

    const checkRole = async (roleId: string): Promise<void> => {
      if (processing.has(roleId)) {
        throw new RbacError(`Circular role inheritance detected: ${roleId}`, 'CIRCULAR_INHERITANCE');
      }

      if (visited.has(roleId)) return;

      processing.add(roleId);
      visited.add(roleId);

      const role = await prismaRead.role.findUnique({
        where: { id: roleId },
        select: { inheritsFrom: true },
      });

      if (!role) {
        throw new RbacError(`Inherited role not found: ${roleId}`, 'ROLE_NOT_FOUND');
      }

      for (const inheritedRoleId of role.inheritsFrom) {
        if (inheritedRoleId === excludeRoleId) {
          throw new RbacError(`Role inheritance would create cycle: ${roleId}`, 'CIRCULAR_INHERITANCE');
        }
        await checkRole(inheritedRoleId);
      }

      processing.delete(roleId);
    };

    for (const roleId of inheritsFrom) {
      await checkRole(roleId);
    }
  }
}

// Singleton instance
export const rbacService = new RbacService();