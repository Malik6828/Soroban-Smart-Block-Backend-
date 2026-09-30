/**
 * RBAC Permission Seeding
 *
 * Seeds the database with system roles and permissions for enterprise-grade access control.
 * This data defines the foundational permission model and cannot be modified through the API.
 */

import { prismaWrite as prisma } from '../db';
import { logger } from '../logger';

export interface SystemPermission {
  id: string;
  resource: string;
  action: string;
  scope?: string;
  description: string;
}

export interface SystemRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  inheritsFrom?: string[];
}

// ── System Permissions ───────────────────────────────────────────────────────
export const SYSTEM_PERMISSIONS: SystemPermission[] = [
  // ── Admin Permissions ─────────────────────────────────────────────────────
  { id: 'admin:system:read', resource: 'system', action: 'read', scope: 'admin', description: 'Read system configuration and status' },
  { id: 'admin:system:write', resource: 'system', action: 'write', scope: 'admin', description: 'Modify system configuration' },
  { id: 'admin:users:read', resource: 'users', action: 'read', scope: 'admin', description: 'View all user accounts' },
  { id: 'admin:users:write', resource: 'users', action: 'write', scope: 'admin', description: 'Modify user accounts and permissions' },
  { id: 'admin:roles:read', resource: 'roles', action: 'read', scope: 'admin', description: 'View roles and permissions' },
  { id: 'admin:roles:write', resource: 'roles', action: 'write', scope: 'admin', description: 'Create and modify roles' },
  { id: 'admin:tenants:read', resource: 'tenants', action: 'read', scope: 'admin', description: 'View tenant configurations' },
  { id: 'admin:tenants:write', resource: 'tenants', action: 'write', scope: 'admin', description: 'Manage tenant settings and isolation' },

  // ── Freeze Management Permissions ────────────────────────────────────────
  { id: 'admin:freeze:read', resource: 'freeze', action: 'read', scope: 'admin', description: 'View frozen ledger keys and violations' },
  { id: 'admin:freeze:create', resource: 'freeze', action: 'create', scope: 'admin', description: 'Create new ledger key freezes' },
  { id: 'admin:freeze:update', resource: 'freeze', action: 'update', scope: 'admin', description: 'Modify existing freezes' },
  { id: 'admin:freeze:delete', resource: 'freeze', action: 'delete', scope: 'admin', description: 'Remove ledger key freezes' },
  { id: 'freeze:violations:read', resource: 'freeze', action: 'read', description: 'View freeze violations' },
  { id: 'freeze:violations:resolve', resource: 'freeze', action: 'resolve', description: 'Mark freeze violations as resolved' },
  { id: 'freeze:stats:read', resource: 'freeze', action: 'stats', description: 'View freeze statistics and metrics' },

  // ── Compliance Permissions ───────────────────────────────────────────────
  { id: 'compliance:screen:read', resource: 'compliance', action: 'screen', description: 'Perform compliance screening of addresses' },
  { id: 'compliance:alerts:read', resource: 'compliance', action: 'read', description: 'View compliance alerts' },
  { id: 'compliance:alerts:review', resource: 'compliance', action: 'review', description: 'Review and resolve compliance alerts' },
  { id: 'compliance:lists:read', resource: 'compliance', action: 'lists', description: 'View sanctions lists' },
  { id: 'compliance:lists:refresh', resource: 'compliance', action: 'refresh', description: 'Refresh sanctions lists from sources' },
  { id: 'compliance:reports:read', resource: 'compliance', action: 'reports', description: 'View compliance reports' },
  { id: 'compliance:reports:create', resource: 'compliance', action: 'reports_create', description: 'Generate compliance reports' },
  { id: 'compliance:travel_rule:read', resource: 'compliance', action: 'travel_rule', description: 'Access travel rule data' },
  { id: 'compliance:travel_rule:submit', resource: 'compliance', action: 'travel_rule_submit', description: 'Submit travel rule information' },
  { id: 'compliance:risk:assess', resource: 'compliance', action: 'risk_assess', description: 'Perform risk assessments' },
  { id: 'compliance:blocking:manage', resource: 'compliance', action: 'blocking', description: 'Manage transaction blocking rules' },

  // ── API and Developer Permissions ────────────────────────────────────────
  { id: 'api:contracts:read', resource: 'contracts', action: 'read', description: 'Read contract data and metadata' },
  { id: 'api:transactions:read', resource: 'transactions', action: 'read', description: 'Read transaction data' },
  { id: 'api:events:read', resource: 'events', action: 'read', description: 'Read contract events' },
  { id: 'api:analytics:read', resource: 'analytics', action: 'read', description: 'Access analytics data' },
  { id: 'api:exports:create', resource: 'exports', action: 'create', description: 'Create data exports' },
  { id: 'api:webhooks:manage', resource: 'webhooks', action: 'manage', description: 'Manage webhook configurations' },
  { id: 'api:keys:read', resource: 'api_keys', action: 'read', description: 'View own API keys' },
  { id: 'api:keys:write', resource: 'api_keys', action: 'write', description: 'Create and modify own API keys' },

  // ── Audit and Security Permissions ───────────────────────────────────────
  { id: 'audit:logs:read', resource: 'audit', action: 'read', description: 'Read audit logs' },
  { id: 'audit:logs:read:sensitive', resource: 'audit', action: 'read', scope: 'sensitive', description: 'Read sensitive audit logs' },
  { id: 'security:sessions:read', resource: 'sessions', action: 'read', description: 'View authentication sessions' },
  { id: 'security:sessions:revoke', resource: 'sessions', action: 'revoke', description: 'Revoke user sessions' },

  // ── Self-Service Permissions ─────────────────────────────────────────────
  { id: 'self:profile:read', resource: 'profile', action: 'read', scope: 'self', description: 'View own profile' },
  { id: 'self:profile:update', resource: 'profile', action: 'update', scope: 'self', description: 'Update own profile' },
  { id: 'self:sessions:read', resource: 'sessions', action: 'read', scope: 'self', description: 'View own sessions' },
  { id: 'self:sessions:revoke', resource: 'sessions', action: 'revoke', scope: 'self', description: 'Revoke own sessions' },
  { id: 'self:keys:read', resource: 'api_keys', action: 'read', scope: 'self', description: 'View own API keys' },
  { id: 'self:keys:write', resource: 'api_keys', action: 'write', scope: 'self', description: 'Manage own API keys' },

  // ── Tenant-Scoped Permissions ────────────────────────────────────────────
  { id: 'tenant:analytics:read', resource: 'analytics', action: 'read', scope: 'tenant', description: 'View tenant analytics' },
  { id: 'tenant:users:read', resource: 'users', action: 'read', scope: 'tenant', description: 'View tenant users' },
  { id: 'tenant:users:invite', resource: 'users', action: 'invite', scope: 'tenant', description: 'Invite users to tenant' },
  { id: 'tenant:settings:read', resource: 'settings', action: 'read', scope: 'tenant', description: 'View tenant settings' },
  { id: 'tenant:settings:write', resource: 'settings', action: 'write', scope: 'tenant', description: 'Modify tenant settings' },
];

// ── System Roles ─────────────────────────────────────────────────────────────
export const SYSTEM_ROLES: SystemRole[] = [
  {
    id: 'super_admin',
    name: 'Super Administrator',
    description: 'Full system access including tenant management and system configuration',
    permissions: [
      'admin:system:read',
      'admin:system:write',
      'admin:users:read',
      'admin:users:write',
      'admin:roles:read',
      'admin:roles:write',
      'admin:tenants:read',
      'admin:tenants:write',
      'admin:freeze:read',
      'admin:freeze:create',
      'admin:freeze:update',
      'admin:freeze:delete',
      'compliance:screen:read',
      'compliance:alerts:read',
      'compliance:alerts:review',
      'compliance:lists:read',
      'compliance:lists:refresh',
      'compliance:reports:read',
      'compliance:reports:create',
      'compliance:blocking:manage',
      'audit:logs:read',
      'audit:logs:read:sensitive',
      'security:sessions:read',
      'security:sessions:revoke',
    ],
  },
  {
    id: 'admin',
    name: 'Administrator',
    description: 'Administrative access to system operations and user management',
    permissions: [
      'admin:users:read',
      'admin:users:write',
      'admin:roles:read',
      'admin:freeze:read',
      'admin:freeze:create',
      'admin:freeze:update',
      'admin:freeze:delete',
      'compliance:screen:read',
      'compliance:alerts:read',
      'compliance:alerts:review',
      'compliance:reports:read',
      'compliance:reports:create',
      'audit:logs:read',
      'security:sessions:read',
      'security:sessions:revoke',
    ],
  },
  {
    id: 'compliance_officer',
    name: 'Compliance Officer',
    description: 'Compliance operations including screening, alerts, and freeze management',
    permissions: [
      'admin:freeze:read',
      'admin:freeze:create',
      'admin:freeze:update',
      'freeze:violations:read',
      'freeze:violations:resolve',
      'freeze:stats:read',
      'compliance:screen:read',
      'compliance:alerts:read',
      'compliance:alerts:review',
      'compliance:lists:read',
      'compliance:lists:refresh',
      'compliance:reports:read',
      'compliance:reports:create',
      'compliance:travel_rule:read',
      'compliance:travel_rule:submit',
      'compliance:risk:assess',
      'compliance:blocking:manage',
      'audit:logs:read',
    ],
  },
  {
    id: 'analyst',
    name: 'Data Analyst',
    description: 'Read-only access to analytics, reports, and audit data',
    permissions: [
      'freeze:violations:read',
      'freeze:stats:read',
      'compliance:alerts:read',
      'compliance:reports:read',
      'api:analytics:read',
      'audit:logs:read',
      'tenant:analytics:read',
    ],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'API development access including contracts, transactions, and events',
    permissions: [
      'api:contracts:read',
      'api:transactions:read',
      'api:events:read',
      'api:analytics:read',
      'api:exports:create',
      'api:webhooks:manage',
      'api:keys:read',
      'api:keys:write',
      'self:profile:read',
      'self:profile:update',
      'self:sessions:read',
      'self:sessions:revoke',
      'self:keys:read',
      'self:keys:write',
    ],
  },
  {
    id: 'support',
    name: 'Customer Support',
    description: 'Customer support operations with limited user and session management',
    permissions: [
      'admin:users:read',
      'freeze:violations:read',
      'freeze:stats:read',
      'compliance:alerts:read',
      'security:sessions:read',
      'security:sessions:revoke',
      'audit:logs:read',
      'tenant:users:read',
    ],
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Read-only access for compliance and security auditing',
    permissions: [
      'admin:users:read',
      'admin:roles:read',
      'freeze:violations:read',
      'freeze:stats:read',
      'compliance:alerts:read',
      'compliance:reports:read',
      'audit:logs:read',
      'audit:logs:read:sensitive',
      'security:sessions:read',
    ],
  },
  {
    id: 'tenant_admin',
    name: 'Tenant Administrator',
    description: 'Administrative access within a specific tenant',
    permissions: [
      'tenant:users:read',
      'tenant:users:invite',
      'tenant:settings:read',
      'tenant:settings:write',
      'tenant:analytics:read',
      'api:contracts:read',
      'api:transactions:read',
      'api:events:read',
      'api:analytics:read',
      'self:profile:read',
      'self:profile:update',
      'self:sessions:read',
      'self:sessions:revoke',
    ],
  },
  {
    id: 'user',
    name: 'Standard User',
    description: 'Basic user access for self-service operations',
    permissions: [
      'self:profile:read',
      'self:profile:update',
      'self:sessions:read',
      'self:sessions:revoke',
      'self:keys:read',
      'self:keys:write',
    ],
  },
];

/**
 * Seeds system permissions and roles
 */
export async function seedPermissions(): Promise<void> {
  logger.info('Starting permission seeding...');

  try {
    // Create permissions
    logger.info(`Creating ${SYSTEM_PERMISSIONS.length} system permissions`);
    for (const permission of SYSTEM_PERMISSIONS) {
      await prisma.permission.upsert({
        where: { id: permission.id },
        update: {
          resource: permission.resource,
          action: permission.action,
          scope: permission.scope,
          description: permission.description,
          isSystemPermission: true,
        },
        create: {
          id: permission.id,
          resource: permission.resource,
          action: permission.action,
          scope: permission.scope,
          description: permission.description,
          isSystemPermission: true,
        },
      });
    }

    // Create roles
    logger.info(`Creating ${SYSTEM_ROLES.length} system roles`);
    for (const role of SYSTEM_ROLES) {
      await prisma.role.upsert({
        where: { id: role.id },
        update: {
          name: role.name,
          description: role.description,
          inheritsFrom: role.inheritsFrom || [],
          isSystemRole: true,
        },
        create: {
          id: role.id,
          name: role.name,
          description: role.description,
          inheritsFrom: role.inheritsFrom || [],
          isSystemRole: true,
        },
      });

      // Assign permissions to role
      for (const permissionId of role.permissions) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId,
            },
          },
          update: {}, // No updates needed
          create: {
            roleId: role.id,
            permissionId,
            grantedBy: 'system',
          },
        });
      }
    }

    logger.info('Permission seeding completed successfully');
  } catch (error) {
    logger.error('Permission seeding failed', { error });
    throw error;
  }
}

/**
 * Validates that all system role permissions exist
 */
export async function validatePermissionIntegrity(): Promise<void> {
  logger.info('Validating permission integrity...');

  const allPermissionIds = new Set(SYSTEM_PERMISSIONS.map((p) => p.id));

  for (const role of SYSTEM_ROLES) {
    for (const permissionId of role.permissions) {
      if (!allPermissionIds.has(permissionId)) {
        throw new Error(`Role ${role.id} references unknown permission: ${permissionId}`);
      }
    }
  }

  // Verify database consistency
  const dbPermissions = await prisma.permission.findMany({
    where: { isSystemPermission: true },
    select: { id: true },
  });
  
  const dbPermissionIds = new Set(dbPermissions.map((p) => p.id));

  for (const permission of SYSTEM_PERMISSIONS) {
    if (!dbPermissionIds.has(permission.id)) {
      logger.warn(`System permission ${permission.id} not found in database`);
    }
  }

  logger.info('Permission integrity validation completed');
}

/**
 * Creates default tenant for system operations
 */
export async function createDefaultTenant(): Promise<string> {
  const defaultTenant = await prisma.tenant.upsert({
    where: { slug: 'system' },
    update: {},
    create: {
      id: 'tenant_system',
      name: 'System Tenant',
      slug: 'system',
      settings: {
        description: 'Default system tenant for administrative operations',
        isDefault: true,
      },
      isolationLevel: 'shared',
    },
  });

  return defaultTenant.id;
}

/**
 * Migrates existing users to the new RBAC system
 */
export async function migrateExistingUsers(): Promise<void> {
  logger.info('Migrating existing users to RBAC system...');

  const users = await prisma.walletUser.findMany({
    select: { id: true, role: true },
  });

  const defaultTenantId = await createDefaultTenant();

  for (const user of users) {
    // Map old role to new role
    const newRoleId = mapLegacyRoleToSystemRole(user.role);
    
    if (newRoleId) {
      await prisma.userRole.upsert({
        where: {
          userId_roleId_tenantId: {
            userId: user.id,
            roleId: newRoleId,
            tenantId: defaultTenantId,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: newRoleId,
          tenantId: defaultTenantId,
          grantedBy: 'migration',
        },
      });

      // Update user's tenant assignment
      await prisma.walletUser.update({
        where: { id: user.id },
        data: { tenantId: defaultTenantId },
      });
    }
  }

  logger.info(`Migrated ${users.length} users to RBAC system`);
}

/**
 * Maps legacy roles to system roles
 */
function mapLegacyRoleToSystemRole(legacyRole: string): string | null {
  const roleMap: Record<string, string> = {
    user: 'user',
    developer: 'developer',
    premium: 'developer', // Premium users get developer permissions
    admin: 'admin',
    super_admin: 'super_admin',
  };

  return roleMap[legacyRole] || null;
}

/**
 * Complete setup process for RBAC system
 */
export async function setupRbacSystem(): Promise<void> {
  logger.info('Setting up RBAC system...');

  await validatePermissionIntegrity();
  await seedPermissions();
  await createDefaultTenant();
  await migrateExistingUsers();

  logger.info('RBAC system setup completed successfully');
}