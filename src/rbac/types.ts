/**
 * RBAC Type Definitions
 *
 * Core types for the Role-Based Access Control system including permissions,
 * roles, tenants, and authentication principals.
 */

export interface AuthPrincipal {
  type: 'user' | 'api_key' | 'admin';
  userId?: string;
  apiKeyId?: string;
  tenantId?: string;
  sessionId?: string;
}

export interface PermissionCondition {
  type: 'ip_restriction' | 'time_window' | 'rate_limit' | 'mfa_required' | 'approval_required';
  config: Record<string, any>;
}

export interface RoleCondition {
  type: 'require_mfa' | 'ip_whitelist' | 'time_restriction' | 'approval_chain';
  config: Record<string, any>;
}

export interface Permission {
  id: string;
  resource: string;
  action: string;
  scope?: string;
  description?: string;
  conditions: PermissionCondition[];
  isSystemPermission: boolean;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  inheritsFrom: string[];
  isSystemRole: boolean;
  conditions: RoleCondition[];
  permissions?: Permission[];
}

export interface UserRole {
  userId: string;
  roleId: string;
  tenantId?: string;
  grantedBy?: string;
  grantedAt: Date;
  expiresAt?: Date;
  conditions: RoleCondition[];
}

export interface UserPermission {
  id: string;
  userId: string;
  permissionId: string;
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  grantedBy?: string;
  grantedAt: Date;
  expiresAt?: Date;
  conditions: PermissionCondition[];
}

export interface ApiKeyScope {
  id: string;
  apiKeyId: string;
  permissionId: string;
  resourceRestrictions: ResourceRestriction[];
  conditions: PermissionCondition[];
}

export interface ResourceRestriction {
  resourceType: string;
  allowedValues: string[];
  pattern?: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  parentTenantId?: string;
  settings: Record<string, any>;
  isolationLevel: 'strict' | 'shared';
}

export interface ResourceContext {
  resourceType: string;
  resourceId: string;
  tenantId?: string;
  metadata?: Record<string, any>;
}

export interface ResolvedPermissions {
  permissions: Set<string>;
  conditions: Map<string, PermissionCondition[]>;
  expiresAt?: Date;
  cacheKey: string;
}

export interface PermissionEvaluationContext {
  principal: AuthPrincipal;
  resource?: ResourceContext;
  timestamp: Date;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  conditions?: PermissionCondition[];
  appliedPermissions: string[];
  cacheHit: boolean;
  evaluationTimeMs: number;
}

export interface ScopeCondition {
  type: 'ip_restriction' | 'endpoint_pattern' | 'rate_limit' | 'time_window';
  config: Record<string, any>;
}

export interface ApiKeyContext {
  id: string;
  keyName: string;
  developerId: string;
  tenantId?: string;
  tier: string;
  scopes: ApiKeyScope[];
  allowedIps?: string[];
  allowedDomains?: string[];
  allowedEndpoints?: string[];
}

export interface PermissionCacheEntry {
  cacheKey: string;
  userId?: string;
  apiKeyId?: string;
  tenantId?: string;
  permissions: ResolvedPermissions;
  expiresAt: Date;
  createdAt: Date;
}

export interface RoleInheritanceTree {
  roleId: string;
  directPermissions: string[];
  inheritedPermissions: Map<string, string[]>; // roleId -> permissions
  conditions: RoleCondition[];
}

export interface PermissionWildcardMatcher {
  pattern: string;
  regex: RegExp;
  priority: number;
}

export interface TenantIsolationConfig {
  level: 'strict' | 'shared';
  allowedResources: string[];
  crossTenantPermissions: string[];
  inheritanceRules: Record<string, any>;
}

// Error types for RBAC operations
export class RbacError extends Error {
  constructor(message: string, public code: string, public details?: any) {
    super(message);
    this.name = 'RbacError';
  }
}

export class PermissionDeniedError extends RbacError {
  constructor(permission: string, principal: AuthPrincipal, details?: any) {
    super(`Permission denied: ${permission}`, 'PERMISSION_DENIED', { permission, principal, ...details });
    this.name = 'PermissionDeniedError';
  }
}

export class TenantIsolationError extends RbacError {
  constructor(message: string, details?: any) {
    super(message, 'TENANT_ISOLATION_VIOLATION', details);
    this.name = 'TenantIsolationError';
  }
}

export class PermissionEvaluationError extends RbacError {
  constructor(message: string, details?: any) {
    super(message, 'PERMISSION_EVALUATION_ERROR', details);
    this.name = 'PermissionEvaluationError';
  }
}

// Utility types
export type PermissionPattern = string; // e.g., "admin:*", "compliance:screen:*"
export type ResourcePattern = string;  // e.g., "contracts:*", "transactions:abc123"
export type TenantScope = 'global' | 'tenant' | 'self';
export type PermissionScope = 'admin' | 'tenant' | 'self' | 'global';

// Constants
export const PERMISSION_CACHE_TTL = 300; // 5 minutes in seconds
export const ROLE_CACHE_TTL = 600; // 10 minutes in seconds
export const MAX_ROLE_INHERITANCE_DEPTH = 10;
export const WILDCARD_PERMISSIONS = ['*', 'admin:*', 'compliance:*', 'api:*'];

// Validation patterns
export const PERMISSION_ID_PATTERN = /^[a-z_]+:[a-z_]+:[a-z_]+(?::[a-z_]+)?$/;
export const ROLE_ID_PATTERN = /^[a-z_][a-z0-9_]*$/;
export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;