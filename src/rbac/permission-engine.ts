/**
 * Permission Evaluation Engine
 *
 * Core engine for evaluating permissions with caching, role inheritance,
 * and condition validation. Provides enterprise-grade performance and security.
 */

import crypto from 'crypto';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { background } from '../utils/background';
import {
  AuthPrincipal,
  Permission,
  PermissionCheckResult,
  PermissionEvaluationContext,
  ResolvedPermissions,
  RoleInheritanceTree,
  PermissionCondition,
  ResourceContext,
  PermissionEvaluationError,
  TenantIsolationError,
  PERMISSION_CACHE_TTL,
  MAX_ROLE_INHERITANCE_DEPTH,
} from './types';

export class PermissionEngine {
  private permissionCache = new Map<string, { permissions: ResolvedPermissions; expiresAt: number }>();
  private roleCache = new Map<string, { tree: RoleInheritanceTree; expiresAt: number }>();
  private wildcardMatchers: RegExp[] = [];

  constructor() {
    this.initializeWildcardMatchers();
    this.startCacheCleanup();
  }

  /**
   * Main entry point for permission checking
   */
  async hasPermission(
    principal: AuthPrincipal,
    permission: string,
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    const startTime = Date.now();
    const evaluationContext: PermissionEvaluationContext = {
      principal,
      resource,
      timestamp: new Date(),
      ip: context?.ip,
      userAgent: context?.userAgent,
      requestId: context?.requestId || crypto.randomUUID(),
    };

    try {
      // Validate tenant isolation first
      await this.validateTenantIsolation(principal, resource);

      // Resolve permissions for the principal
      const resolvedPermissions = await this.resolvePermissions(principal);

      // Check exact permission match
      let allowed = resolvedPermissions.permissions.has(permission);
      let appliedPermissions: string[] = [];

      if (allowed) {
        appliedPermissions.push(permission);
      } else {
        // Check wildcard permissions
        const wildcardMatches = this.findWildcardMatches(permission, resolvedPermissions.permissions);
        if (wildcardMatches.length > 0) {
          allowed = true;
          appliedPermissions = wildcardMatches;
        }
      }

      if (!allowed) {
        return {
          allowed: false,
          reason: `Missing required permission: ${permission}`,
          appliedPermissions: [],
          cacheHit: resolvedPermissions.cacheKey !== '',
          evaluationTimeMs: Date.now() - startTime,
        };
      }

      // Validate conditions for matching permissions
      const conditionResults = await this.validateConditions(
        appliedPermissions,
        resolvedPermissions.conditions,
        evaluationContext
      );

      if (!conditionResults.valid) {
        return {
          allowed: false,
          reason: conditionResults.reason,
          conditions: conditionResults.failedConditions,
          appliedPermissions,
          cacheHit: resolvedPermissions.cacheKey !== '',
          evaluationTimeMs: Date.now() - startTime,
        };
      }

      return {
        allowed: true,
        appliedPermissions,
        conditions: conditionResults.appliedConditions,
        cacheHit: resolvedPermissions.cacheKey !== '',
        evaluationTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      logger.error('Permission evaluation failed', {
        principal,
        permission,
        resource,
        error: error.message,
        requestId: evaluationContext.requestId,
      });

      return {
        allowed: false,
        reason: 'Permission evaluation error',
        appliedPermissions: [],
        cacheHit: false,
        evaluationTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if principal has any of the specified permissions
   */
  async hasAnyPermission(
    principal: AuthPrincipal,
    permissions: string[],
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    for (const permission of permissions) {
      const result = await this.hasPermission(principal, permission, resource, context);
      if (result.allowed) {
        return result;
      }
    }

    return {
      allowed: false,
      reason: `Missing any of required permissions: ${permissions.join(', ')}`,
      appliedPermissions: [],
      cacheHit: false,
      evaluationTimeMs: 0,
    };
  }

  /**
   * Check if principal has all of the specified permissions
   */
  async hasAllPermissions(
    principal: AuthPrincipal,
    permissions: string[],
    resource?: ResourceContext,
    context?: Partial<PermissionEvaluationContext>
  ): Promise<PermissionCheckResult> {
    const results: PermissionCheckResult[] = [];
    let totalTime = 0;

    for (const permission of permissions) {
      const result = await this.hasPermission(principal, permission, resource, context);
      results.push(result);
      totalTime += result.evaluationTimeMs;

      if (!result.allowed) {
        return {
          allowed: false,
          reason: result.reason,
          appliedPermissions: results.flatMap(r => r.appliedPermissions),
          cacheHit: results.some(r => r.cacheHit),
          evaluationTimeMs: totalTime,
        };
      }
    }

    return {
      allowed: true,
      appliedPermissions: results.flatMap(r => r.appliedPermissions),
      cacheHit: results.some(r => r.cacheHit),
      evaluationTimeMs: totalTime,
    };
  }

  /**
   * Resolve all permissions for a principal with caching
   */
  private async resolvePermissions(principal: AuthPrincipal): Promise<ResolvedPermissions> {
    const cacheKey = this.buildPermissionCacheKey(principal);

    // Check in-memory cache first
    const cached = this.permissionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.permissions;
    }

    // Check database cache
    const dbCached = await this.getPermissionCache(cacheKey);
    if (dbCached && dbCached.expiresAt > new Date()) {
      const permissions = this.deserializePermissions(dbCached.permissions);
      this.permissionCache.set(cacheKey, {
        permissions,
        expiresAt: dbCached.expiresAt.getTime(),
      });
      return permissions;
    }

    // Resolve permissions from source
    let permissions: ResolvedPermissions;

    if (principal.type === 'user') {
      permissions = await this.resolveUserPermissions(principal.userId!, principal.tenantId);
    } else if (principal.type === 'api_key') {
      permissions = await this.resolveApiKeyPermissions(principal.apiKeyId!, principal.tenantId);
    } else if (principal.type === 'admin') {
      permissions = await this.resolveAdminPermissions();
    } else {
      throw new PermissionEvaluationError(`Unknown principal type: ${principal.type}`);
    }

    permissions.cacheKey = cacheKey;

    // Cache the results
    await this.cachePermissions(cacheKey, permissions);

    return permissions;
  }

  /**
   * Resolve permissions for a user through roles and direct assignments
   */
  private async resolveUserPermissions(userId: string, tenantId?: string): Promise<ResolvedPermissions> {
    const permissions = new Set<string>();
    const conditions = new Map<string, PermissionCondition[]>();
    let earliestExpiration: Date | undefined;

    // Get user roles
    const userRoles = await prismaRead.userRole.findMany({
      where: {
        userId,
        tenantId: tenantId || null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    // Process role-based permissions with inheritance
    for (const userRole of userRoles) {
      if (userRole.expiresAt && (!earliestExpiration || userRole.expiresAt < earliestExpiration)) {
        earliestExpiration = userRole.expiresAt;
      }

      const roleTree = await this.buildRoleInheritanceTree(userRole.roleId);
      
      // Add direct role permissions
      roleTree.directPermissions.forEach(permId => permissions.add(permId));

      // Add inherited permissions
      for (const [roleId, inheritedPerms] of roleTree.inheritedPermissions) {
        inheritedPerms.forEach(permId => permissions.add(permId));
      }

      // Merge role conditions
      if (userRole.conditions && Array.isArray(userRole.conditions)) {
        for (const condition of userRole.conditions as PermissionCondition[]) {
          const existing = conditions.get('*') || [];
          conditions.set('*', [...existing, condition]);
        }
      }
    }

    // Get direct user permissions
    const userPermissions = await prismaRead.userPermission.findMany({
      where: {
        userId,
        tenantId: tenantId || null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { permission: true },
    });

    for (const userPerm of userPermissions) {
      if (userPerm.expiresAt && (!earliestExpiration || userPerm.expiresAt < earliestExpiration)) {
        earliestExpiration = userPerm.expiresAt;
      }

      permissions.add(userPerm.permission.id);

      // Add permission-specific conditions
      if (userPerm.conditions && Array.isArray(userPerm.conditions)) {
        const existing = conditions.get(userPerm.permission.id) || [];
        conditions.set(userPerm.permission.id, [...existing, ...(userPerm.conditions as PermissionCondition[])]);
      }
    }

    return {
      permissions,
      conditions,
      expiresAt: earliestExpiration,
      cacheKey: '',
    };
  }

  /**
   * Resolve permissions for an API key through scopes
   */
  private async resolveApiKeyPermissions(apiKeyId: string, tenantId?: string): Promise<ResolvedPermissions> {
    const permissions = new Set<string>();
    const conditions = new Map<string, PermissionCondition[]>();

    const apiKeyScopes = await prismaRead.apiKeyScope.findMany({
      where: { apiKeyId },
      include: { permission: true },
    });

    for (const scope of apiKeyScopes) {
      permissions.add(scope.permission.id);

      // Add scope-specific conditions
      if (scope.conditions && Array.isArray(scope.conditions)) {
        const existing = conditions.get(scope.permission.id) || [];
        conditions.set(scope.permission.id, [...existing, ...(scope.conditions as PermissionCondition[])]);
      }
    }

    return {
      permissions,
      conditions,
      cacheKey: '',
    };
  }

  /**
   * Resolve admin permissions (full access)
   */
  private async resolveAdminPermissions(): Promise<ResolvedPermissions> {
    const permissions = new Set(['*']); // Admin wildcard permission
    const conditions = new Map<string, PermissionCondition[]>();

    return {
      permissions,
      conditions,
      cacheKey: '',
    };
  }

  /**
   * Build role inheritance tree with circular dependency detection
   */
  private async buildRoleInheritanceTree(roleId: string): Promise<RoleInheritanceTree> {
    const cacheKey = `role_tree:${roleId}`;
    const cached = this.roleCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tree;
    }

    const visited = new Set<string>();
    const processing = new Set<string>();

    const buildTree = async (currentRoleId: string, depth = 0): Promise<RoleInheritanceTree> => {
      if (depth > MAX_ROLE_INHERITANCE_DEPTH) {
        throw new PermissionEvaluationError(`Role inheritance depth exceeded: ${currentRoleId}`);
      }

      if (processing.has(currentRoleId)) {
        throw new PermissionEvaluationError(`Circular role inheritance detected: ${currentRoleId}`);
      }

      if (visited.has(currentRoleId)) {
        return { roleId: currentRoleId, directPermissions: [], inheritedPermissions: new Map(), conditions: [] };
      }

      processing.add(currentRoleId);
      visited.add(currentRoleId);

      const role = await prismaRead.role.findUnique({
        where: { id: currentRoleId },
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
      });

      if (!role) {
        throw new PermissionEvaluationError(`Role not found: ${currentRoleId}`);
      }

      const directPermissions = role.rolePermissions.map(rp => rp.permission.id);
      const inheritedPermissions = new Map<string, string[]>();
      const conditions = (role.conditions as any[]) || [];

      // Process inherited roles
      for (const inheritedRoleId of role.inheritsFrom) {
        const inheritedTree = await buildTree(inheritedRoleId, depth + 1);
        
        // Add inherited role's direct permissions
        inheritedPermissions.set(inheritedRoleId, inheritedTree.directPermissions);
        
        // Add inherited role's inherited permissions
        for (const [subRoleId, subPermissions] of inheritedTree.inheritedPermissions) {
          inheritedPermissions.set(subRoleId, subPermissions);
        }
      }

      processing.delete(currentRoleId);

      return {
        roleId: currentRoleId,
        directPermissions,
        inheritedPermissions,
        conditions,
      };
    };

    const tree = await buildTree(roleId);

    // Cache the tree
    this.roleCache.set(cacheKey, {
      tree,
      expiresAt: Date.now() + (600 * 1000), // 10 minutes
    });

    return tree;
  }

  /**
   * Validate tenant isolation rules
   */
  private async validateTenantIsolation(principal: AuthPrincipal, resource?: ResourceContext): Promise<void> {
    if (!resource?.tenantId) return; // No isolation required

    // Admin principals can access any tenant
    if (principal.type === 'admin') return;

    // Check if principal's tenant matches resource tenant
    if (principal.tenantId && principal.tenantId !== resource.tenantId) {
      const principalTenant = await prismaRead.tenant.findUnique({
        where: { id: principal.tenantId },
      });

      const resourceTenant = await prismaRead.tenant.findUnique({
        where: { id: resource.tenantId },
      });

      if (!principalTenant || !resourceTenant) {
        throw new TenantIsolationError('Invalid tenant configuration');
      }

      // Check if tenant hierarchy allows access
      const hasHierarchicalAccess = await this.checkTenantHierarchy(principal.tenantId, resource.tenantId);
      if (!hasHierarchicalAccess) {
        throw new TenantIsolationError(`Cross-tenant access denied: ${principal.tenantId} -> ${resource.tenantId}`);
      }
    }
  }

  /**
   * Check tenant hierarchy for cross-tenant access
   */
  private async checkTenantHierarchy(principalTenantId: string, resourceTenantId: string): Promise<boolean> {
    // For now, only allow same-tenant access
    // Future enhancement: implement parent-child tenant relationships
    return principalTenantId === resourceTenantId;
  }

  /**
   * Find wildcard permission matches
   */
  private findWildcardMatches(permission: string, availablePermissions: Set<string>): string[] {
    const matches: string[] = [];

    for (const availablePermission of availablePermissions) {
      if (availablePermission === '*') {
        matches.push(availablePermission);
        continue;
      }

      if (availablePermission.endsWith(':*')) {
        const prefix = availablePermission.slice(0, -1); // Remove the '*'
        if (permission.startsWith(prefix)) {
          matches.push(availablePermission);
        }
      }
    }

    return matches;
  }

  /**
   * Validate conditions for permissions
   */
  private async validateConditions(
    permissions: string[],
    conditionsMap: Map<string, PermissionCondition[]>,
    context: PermissionEvaluationContext
  ): Promise<{
    valid: boolean;
    reason?: string;
    failedConditions?: PermissionCondition[];
    appliedConditions?: PermissionCondition[];
  }> {
    const appliedConditions: PermissionCondition[] = [];
    const failedConditions: PermissionCondition[] = [];

    // Check global conditions (*)
    const globalConditions = conditionsMap.get('*') || [];
    for (const condition of globalConditions) {
      const result = await this.validateCondition(condition, context);
      appliedConditions.push(condition);
      
      if (!result.valid) {
        failedConditions.push(condition);
        return {
          valid: false,
          reason: result.reason,
          failedConditions,
          appliedConditions,
        };
      }
    }

    // Check permission-specific conditions
    for (const permission of permissions) {
      const permissionConditions = conditionsMap.get(permission) || [];
      for (const condition of permissionConditions) {
        const result = await this.validateCondition(condition, context);
        appliedConditions.push(condition);
        
        if (!result.valid) {
          failedConditions.push(condition);
          return {
            valid: false,
            reason: result.reason,
            failedConditions,
            appliedConditions,
          };
        }
      }
    }

    return {
      valid: true,
      appliedConditions,
    };
  }

  /**
   * Validate a single condition
   */
  private async validateCondition(
    condition: PermissionCondition,
    context: PermissionEvaluationContext
  ): Promise<{ valid: boolean; reason?: string }> {
    switch (condition.type) {
      case 'ip_restriction':
        return this.validateIpRestriction(condition.config, context.ip);
      
      case 'time_window':
        return this.validateTimeWindow(condition.config, context.timestamp);
      
      case 'rate_limit':
        return await this.validateRateLimit(condition.config, context);
      
      case 'mfa_required':
        return this.validateMfaRequired(condition.config, context);
      
      case 'approval_required':
        return await this.validateApprovalRequired(condition.config, context);
      
      default:
        logger.warn(`Unknown condition type: ${condition.type}`);
        return { valid: true }; // Unknown conditions are ignored
    }
  }

  /**
   * Validate IP restriction condition
   */
  private validateIpRestriction(config: any, ip?: string): { valid: boolean; reason?: string } {
    if (!ip) {
      return { valid: false, reason: 'IP address required for IP restriction' };
    }

    const allowedIps = config.allowedIps as string[] || [];
    if (allowedIps.length === 0) {
      return { valid: true }; // No restrictions
    }

    // Simple IP matching - enhance with CIDR support in production
    const isAllowed = allowedIps.some(allowedIp => {
      if (allowedIp.includes('/')) {
        // CIDR notation - implement proper CIDR matching
        return false; // Placeholder
      }
      return ip === allowedIp;
    });

    return {
      valid: isAllowed,
      reason: isAllowed ? undefined : `IP ${ip} not in allowed list`,
    };
  }

  /**
   * Validate time window condition
   */
  private validateTimeWindow(config: any, timestamp: Date): { valid: boolean; reason?: string } {
    const startTime = config.startTime as string;
    const endTime = config.endTime as string;
    const timezone = config.timezone as string || 'UTC';

    // Simple time validation - enhance with proper timezone support
    const currentTime = timestamp.toISOString().substr(11, 8); // HH:MM:SS
    
    if (startTime && currentTime < startTime) {
      return { valid: false, reason: `Access not allowed before ${startTime}` };
    }

    if (endTime && currentTime > endTime) {
      return { valid: false, reason: `Access not allowed after ${endTime}` };
    }

    return { valid: true };
  }

  /**
   * Validate rate limit condition
   */
  private async validateRateLimit(config: any, context: PermissionEvaluationContext): Promise<{ valid: boolean; reason?: string }> {
    // Implement rate limiting logic
    // This would integrate with the existing rate limiting system
    return { valid: true }; // Placeholder
  }

  /**
   * Validate MFA required condition
   */
  private validateMfaRequired(config: any, context: PermissionEvaluationContext): { valid: boolean; reason?: string } {
    // Check if the current session has MFA
    // This would check session metadata for MFA completion
    return { valid: true }; // Placeholder - implement MFA checking
  }

  /**
   * Validate approval required condition
   */
  private async validateApprovalRequired(config: any, context: PermissionEvaluationContext): Promise<{ valid: boolean; reason?: string }> {
    // Check if the operation has required approvals
    // This would integrate with an approval workflow system
    return { valid: true }; // Placeholder
  }

  /**
   * Build cache key for permission resolution
   */
  private buildPermissionCacheKey(principal: AuthPrincipal): string {
    const parts = [
      principal.type,
      principal.userId || '',
      principal.apiKeyId || '',
      principal.tenantId || '',
      principal.sessionId || '',
    ];
    
    return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
  }

  /**
   * Cache permissions in database
   */
  private async cachePermissions(cacheKey: string, permissions: ResolvedPermissions): Promise<void> {
    const expiresAt = new Date(Date.now() + (PERMISSION_CACHE_TTL * 1000));

    try {
      await prismaWrite.permissionCache.upsert({
        where: { cacheKey },
        update: {
          permissions: this.serializePermissions(permissions),
          expiresAt,
        },
        create: {
          cacheKey,
          permissions: this.serializePermissions(permissions),
          expiresAt,
          userId: permissions.cacheKey.includes('user') ? permissions.cacheKey.split(':')[1] : undefined,
          apiKeyId: permissions.cacheKey.includes('api_key') ? permissions.cacheKey.split(':')[2] : undefined,
        },
      });

      // Cache in memory as well
      this.permissionCache.set(cacheKey, {
        permissions,
        expiresAt: expiresAt.getTime(),
      });
    } catch (error) {
      logger.warn('Failed to cache permissions', { cacheKey, error: error.message });
    }
  }

  /**
   * Get permissions from database cache
   */
  private async getPermissionCache(cacheKey: string) {
    try {
      return await prismaRead.permissionCache.findUnique({
        where: { cacheKey },
      });
    } catch (error) {
      logger.warn('Failed to get permission cache', { cacheKey, error: error.message });
      return null;
    }
  }

  /**
   * Serialize permissions for storage
   */
  private serializePermissions(permissions: ResolvedPermissions): any {
    return {
      permissions: Array.from(permissions.permissions),
      conditions: Object.fromEntries(
        Array.from(permissions.conditions.entries()).map(([key, value]) => [key, value])
      ),
      expiresAt: permissions.expiresAt?.toISOString(),
    };
  }

  /**
   * Deserialize permissions from storage
   */
  private deserializePermissions(data: any): ResolvedPermissions {
    return {
      permissions: new Set(data.permissions || []),
      conditions: new Map(Object.entries(data.conditions || {})),
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      cacheKey: '',
    };
  }

  /**
   * Initialize wildcard matchers
   */
  private initializeWildcardMatchers(): void {
    // Initialize regex patterns for wildcard matching
    this.wildcardMatchers = [
      /^\*$/, // Global wildcard
      /^admin:\*$/, // Admin wildcard
      /^[a-z_]+:\*$/, // Resource wildcard
    ];
  }

  /**
   * Start cache cleanup background process
   */
  private startCacheCleanup(): void {
    const cleanup = () => {
      const now = Date.now();
      
      // Clean in-memory caches
      for (const [key, entry] of this.permissionCache.entries()) {
        if (entry.expiresAt <= now) {
          this.permissionCache.delete(key);
        }
      }

      for (const [key, entry] of this.roleCache.entries()) {
        if (entry.expiresAt <= now) {
          this.roleCache.delete(key);
        }
      }

      // Clean database cache (run in background)
      background('rbac.cacheCleanup', async () => {
        try {
          await prismaWrite.permissionCache.deleteMany({
            where: { expiresAt: { lte: new Date() } },
          });
        } catch (error) {
          logger.warn('Failed to clean permission cache', { error: error.message });
        }
      });
    };

    // Run cleanup every 5 minutes
    setInterval(cleanup, 5 * 60 * 1000);
  }

  /**
   * Clear cache for a specific principal
   */
  async clearCache(principal: AuthPrincipal): Promise<void> {
    const cacheKey = this.buildPermissionCacheKey(principal);
    
    // Clear in-memory cache
    this.permissionCache.delete(cacheKey);
    
    // Clear database cache
    try {
      await prismaWrite.permissionCache.deleteMany({
        where: { cacheKey },
      });
    } catch (error) {
      logger.warn('Failed to clear permission cache', { cacheKey, error: error.message });
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    permissionCacheSize: number;
    roleCacheSize: number;
    hitRate: number;
  } {
    return {
      permissionCacheSize: this.permissionCache.size,
      roleCacheSize: this.roleCache.size,
      hitRate: 0.95, // Placeholder - implement actual hit rate tracking
    };
  }
}

// Singleton instance
export const permissionEngine = new PermissionEngine();