# Enterprise RBAC Permission Model Design

## Executive Summary

This document describes the design for implementing fine-grained role-based access control (RBAC) across the Soroban Smart Block Backend. The system extends the existing authentication infrastructure to provide enterprise-grade permissions, API key scoping, and multi-tenant isolation.

## Current State Analysis

### Existing Authentication Patterns
- **JWT Bearer Tokens**: Wallet-based authentication with session management
- **API Keys**: Developer keys with IP/domain/endpoint whitelisting and tier-based rate limiting
- **Admin Static Tokens**: High-security admin access with brute-force protection
- **Session Cookies**: Browser-compatible authentication with CSRF protection

### Existing Authorization Patterns
- **Simple Role Hierarchy**: user → developer → premium → admin → super_admin
- **Tier-Based Features**: free → developer → premium → enterprise with feature matrices
- **Basic Middleware**: `requireRole()`, `requireTier()`, `requireApiKey()`

### Current Limitations
- No fine-grained permissions (only coarse roles)
- No resource-level access control
- Limited API key scoping beyond endpoints
- No organization/tenant-based grouping
- No delegation or temporary permission patterns

## Permission Model Design

### 1. Core Permission Framework

#### Permission Structure
```typescript
interface Permission {
  id: string;                    // e.g., "admin:freeze:create"
  resource: string;              // Resource being protected (freeze, compliance, etc.)
  action: string;                // Action being performed (create, read, update, delete)
  scope?: string;                // Optional scope qualifier (admin, tenant, self)
  conditions?: PermissionCondition[]; // Runtime conditions
}

interface PermissionCondition {
  type: 'ip_restriction' | 'time_window' | 'rate_limit' | 'mfa_required' | 'approval_required';
  config: Json;
}
```

#### Permission Naming Convention
Format: `[scope:]resource:action[:qualifier]`

Examples:
- `admin:freeze:create` - Admin-level freeze creation
- `compliance:screen:read` - Compliance screening read access
- `self:profile:update` - Update own profile
- `tenant:analytics:export` - Export tenant analytics
- `system:audit:read:sensitive` - Read sensitive audit logs

### 2. Role-Based Access Control (RBAC)

#### Enhanced Role System
```typescript
interface Role {
  id: string;                    // e.g., "compliance_officer"
  name: string;                  // Human-readable name
  description?: string;          // Role description
  permissions: string[];         // Array of permission IDs
  inheritsFrom?: string[];       // Role inheritance
  isSystemRole: boolean;         // System vs custom role
  conditions?: RoleCondition[];  // Role-specific conditions
}

interface RoleCondition {
  type: 'require_mfa' | 'ip_whitelist' | 'time_restriction' | 'approval_chain';
  config: Json;
}
```

#### System Roles (Built-in)
1. **super_admin** - Full system access
2. **admin** - Administrative operations
3. **compliance_officer** - Compliance and freeze operations
4. **analyst** - Read-only analytics and reporting
5. **developer** - API development and testing
6. **support** - Customer support operations
7. **auditor** - Read-only audit access

#### Custom Roles
Organizations can create custom roles by combining base permissions with specific conditions.

### 3. API Key Scoping Enhancement

#### Enhanced API Key Model
```typescript
interface EnhancedApiKey extends DevApiKey {
  scopes: ApiKeyScope[];         // Fine-grained scopes
  permissions: string[];         // Explicit permissions
  tenantId?: string;             // Multi-tenant isolation
  resourceRestrictions: ResourceRestriction[];
}

interface ApiKeyScope {
  resource: string;              // e.g., "transactions", "contracts"
  actions: string[];             // e.g., ["read", "list"]
  conditions: ScopeCondition[];  // Runtime restrictions
}

interface ResourceRestriction {
  resourceType: string;          // e.g., "contract_address"
  allowedValues: string[];       // Specific allowed values
  pattern?: string;              // Regex pattern for validation
}
```

#### Scope Templates
Pre-defined scope templates for common use cases:
- **read_only**: Read access to public endpoints
- **analytics**: Analytics and reporting access
- **compliance**: Compliance screening and reporting
- **admin_read**: Administrative read-only access
- **developer**: Full development API access

### 4. Multi-Tenant Architecture

#### Tenant Model
```typescript
interface Tenant {
  id: string;
  name: string;
  slug: string;                  // URL-safe identifier
  parentTenantId?: string;       // Hierarchical tenants
  settings: TenantSettings;
  isolationLevel: 'strict' | 'shared';
  createdAt: DateTime;
  updatedAt: DateTime;
}

interface TenantSettings {
  allowedOrigins: string[];
  rateLimits: Record<string, number>;
  featureFlags: Record<string, boolean>;
  complianceRules: ComplianceRule[];
}
```

#### Tenant Isolation Levels
1. **Strict Isolation**: Complete data separation at query level
2. **Shared Resources**: Shared data with access controls

### 5. Permission Enforcement Patterns

#### Middleware Stack Enhancement
```typescript
// New middleware functions
function requirePermission(permission: string, options?: PermissionOptions)
function requireAnyPermission(permissions: string[])
function requireAllPermissions(permissions: string[])
function requireTenantAccess(tenantId?: string)
function requireResourceAccess(resourceType: string, resourceId: string)
```

#### Resource-Level Access Control
```typescript
interface ResourceAccessControl {
  resourceType: string;          // e.g., "contract", "transaction"
  resourceId: string;            // Specific resource identifier
  permissions: ResourcePermission[];
}

interface ResourcePermission {
  principal: string;             // User ID or API key ID
  principalType: 'user' | 'api_key' | 'role';
  permissions: string[];         // Granted permissions
  grantedBy: string;             // Who granted the permission
  grantedAt: DateTime;
  expiresAt?: DateTime;
}
```

## Database Schema Design

### New Permission Tables

```sql
-- Core permission definitions
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT,
  description TEXT,
  conditions JSONB DEFAULT '[]',
  is_system_permission BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Role definitions with inheritance
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  inherits_from TEXT[] DEFAULT '{}',
  is_system_role BOOLEAN DEFAULT false,
  conditions JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Role-permission assignments
CREATE TABLE role_permissions (
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by TEXT,
  granted_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

-- User-role assignments (extends existing WalletUser)
CREATE TABLE user_roles (
  user_id TEXT REFERENCES wallet_users(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id TEXT,
  granted_by TEXT,
  granted_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  conditions JSONB DEFAULT '[]',
  PRIMARY KEY (user_id, role_id, COALESCE(tenant_id, ''))
);

-- Direct user permissions (for exceptions)
CREATE TABLE user_permissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES wallet_users(id) ON DELETE CASCADE,
  permission_id TEXT REFERENCES permissions(id) ON DELETE CASCADE,
  tenant_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  granted_by TEXT,
  granted_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  conditions JSONB DEFAULT '[]'
);

-- Enhanced API key scopes
CREATE TABLE api_key_scopes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id TEXT REFERENCES _dev_api_keies(id) ON DELETE CASCADE,
  permission_id TEXT REFERENCES permissions(id) ON DELETE CASCADE,
  resource_restrictions JSONB DEFAULT '[]',
  conditions JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Multi-tenant support
CREATE TABLE tenants (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  parent_tenant_id TEXT REFERENCES tenants(id),
  settings JSONB DEFAULT '{}',
  isolation_level TEXT DEFAULT 'strict',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Resource-level access control
CREATE TABLE resource_permissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  granted_by TEXT,
  granted_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  tenant_id TEXT REFERENCES tenants(id)
);

-- Permission evaluation cache
CREATE TABLE permission_cache (
  cache_key TEXT PRIMARY KEY,
  user_id TEXT,
  api_key_id TEXT,
  tenant_id TEXT,
  permissions JSONB NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Indexes for Performance
```sql
-- Permission lookup optimization
CREATE INDEX idx_user_roles_user_tenant ON user_roles(user_id, tenant_id);
CREATE INDEX idx_user_permissions_user_tenant ON user_permissions(user_id, tenant_id);
CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);
CREATE INDEX idx_resource_permissions_resource ON resource_permissions(resource_type, resource_id);
CREATE INDEX idx_permission_cache_user ON permission_cache(user_id, tenant_id);
CREATE INDEX idx_permission_cache_api_key ON permission_cache(api_key_id, tenant_id);
```

## Permission Evaluation Algorithm

### 1. Permission Resolution Flow
```typescript
async function evaluatePermissions(
  principal: AuthPrincipal,
  tenantId?: string
): Promise<ResolvedPermissions> {
  // 1. Check cache first
  const cached = await getCachedPermissions(principal, tenantId);
  if (cached && !cached.isExpired()) return cached;

  // 2. Resolve permissions based on principal type
  let permissions: Set<string> = new Set();

  if (principal.type === 'user') {
    // Get role-based permissions
    permissions = await resolveUserPermissions(principal.userId, tenantId);
    
    // Add direct user permissions
    const directPerms = await getDirectUserPermissions(principal.userId, tenantId);
    directPerms.forEach(p => permissions.add(p));
  } else if (principal.type === 'api_key') {
    // Get API key scoped permissions
    permissions = await resolveApiKeyPermissions(principal.apiKeyId, tenantId);
  }

  // 3. Apply conditions and restrictions
  const resolvedPermissions = await applyPermissionConditions(permissions, principal);

  // 4. Cache results
  await cachePermissions(principal, tenantId, resolvedPermissions);

  return resolvedPermissions;
}
```

### 2. Runtime Permission Check
```typescript
async function hasPermission(
  principal: AuthPrincipal,
  permission: string,
  resource?: ResourceContext,
  tenantId?: string
): Promise<boolean> {
  const permissions = await evaluatePermissions(principal, tenantId);
  
  // Check exact permission match
  if (permissions.has(permission)) {
    return await validatePermissionConditions(permission, principal, resource);
  }

  // Check wildcard permissions
  const wildcardMatches = permissions.getWildcardMatches(permission);
  for (const match of wildcardMatches) {
    if (await validatePermissionConditions(match, principal, resource)) {
      return true;
    }
  }

  return false;
}
```

## Migration Strategy

### Phase 1: Foundation (Week 1-2)
1. Create new database tables and indexes
2. Implement core permission evaluation engine
3. Add basic system roles and permissions
4. Create data migration scripts for existing roles

### Phase 2: Middleware Integration (Week 3-4)
1. Enhance existing middleware with permission checks
2. Add new permission-based middleware functions
3. Update API routes to use fine-grained permissions
4. Implement permission caching

### Phase 3: Multi-Tenant Support (Week 5-6)
1. Add tenant model and isolation
2. Implement tenant-aware queries
3. Add tenant-scoped permission evaluation
4. Create tenant management APIs

### Phase 4: Advanced Features (Week 7-8)
1. Implement resource-level permissions
2. Add conditional permissions
3. Create permission delegation mechanisms
4. Add approval workflows

## Security Considerations

### 1. Least Privilege Principle
- Default roles have minimal permissions
- Explicit permission grants required
- Regular permission audits and cleanup

### 2. Defense in Depth
- Multiple validation layers
- Query-level tenant isolation
- Input sanitization at all levels
- Rate limiting on permission evaluation

### 3. Audit and Monitoring
- Complete permission evaluation audit trail
- Real-time permission violation alerts
- Regular access reviews and reporting
- Automated compliance checks

## Performance Considerations

### 1. Caching Strategy
- Redis-based permission caching with TTL
- Cache invalidation on role/permission changes
- Distributed cache for multi-instance deployments

### 2. Query Optimization
- Optimized permission resolution queries
- Batch permission evaluations
- Database query optimization with proper indexes

### 3. Scalability
- Horizontal scaling support
- Efficient permission storage
- Lazy loading of complex permission trees

## Error Handling and Recovery

### 1. Graceful Degradation
- Fallback to basic role checking if permission system fails
- Circuit breaker for permission evaluation service
- Default deny policy for unknown permissions

### 2. Audit Trail
- Complete audit log for all permission evaluations
- Failed permission check logging
- Security incident detection and alerting

## Compliance and Regulatory Features

### 1. Access Reviews
- Automated quarterly access reviews
- Permission usage analytics
- Unused permission cleanup

### 2. Segregation of Duties
- Role conflict detection
- Sensitive operation approval requirements
- Multi-person authorization for critical actions

### 3. Data Retention
- Permission change history retention
- Audit log archival policies
- Compliance reporting automation

## Testing Strategy

### 1. Unit Tests (90% Coverage Target)
- Permission evaluation logic
- Role inheritance resolution
- Condition validation
- Cache behavior

### 2. Integration Tests
- End-to-end permission flows
- Multi-tenant isolation verification
- API authentication and authorization
- Database constraint validation

### 3. Performance Tests
- Permission evaluation latency
- Cache hit rates and performance
- Concurrent permission checking
- Database query optimization

### 4. Security Tests
- Privilege escalation attempts
- Tenant isolation bypass attempts
- Permission injection attacks
- Rate limiting effectiveness

## Monitoring and Alerting

### 1. Key Metrics
- Permission evaluation latency
- Cache hit rates
- Failed authorization attempts
- Permission usage patterns

### 2. SLI/SLO Definitions
- Permission evaluation latency < 50ms (p99)
- Cache hit rate > 95%
- Authorization availability > 99.9%
- Audit log retention 100%

### 3. Alerting Rules
- High permission evaluation latency
- Excessive failed authorization attempts
- Unusual permission usage patterns
- Cache failure or degradation

## Rollback Plan

### 1. Feature Flags
- Permission system can be disabled instantly
- Fallback to existing role-based system
- Gradual rollout per tenant/user group

### 2. Data Migration Rollback
- Database migration rollback scripts
- Permission data export/import tools
- Configuration restoration procedures

### 3. Monitoring During Rollout
- Real-time error rate monitoring
- Performance impact measurement
- User experience impact tracking

## Conclusion

This permission model provides enterprise-grade fine-grained access control while maintaining backward compatibility with the existing authentication system. The design emphasizes security, performance, and scalability while providing comprehensive audit trails and compliance features.

The phased implementation approach allows for gradual rollout and validation, minimizing risk while delivering immediate value through enhanced security and access control capabilities.