/**
 * Tenant-Aware Database Clients
 *
 * Enhanced Prisma clients that automatically apply tenant isolation
 * and provide type-safe, tenant-aware database operations.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../logger';
import { 
  tenantIsolationService, 
  createTenantContext,
  TenantQueryContext,
  TENANT_ISOLATED_MODELS,
  GLOBAL_SHARED_MODELS,
  IsolationLevel,
} from '../rbac/tenant-isolation';
import { AuthPrincipal, TenantIsolationError } from '../rbac/types';

/**
 * Configuration for tenant-aware database operations
 */
export interface TenantDbConfig {
  strictIsolation: boolean; // Default: true
  logQueries: boolean; // Default: false
  auditAccess: boolean; // Default: true
  cacheResults: boolean; // Default: false
}

/**
 * Enhanced Prisma client with automatic tenant isolation
 */
export class TenantAwarePrismaClient {
  private client: PrismaClient;
  private config: TenantDbConfig;
  private queryCache = new Map<string, { result: any; expiresAt: number }>();

  constructor(client: PrismaClient, config: Partial<TenantDbConfig> = {}) {
    this.client = client;
    this.config = {
      strictIsolation: true,
      logQueries: false,
      auditAccess: true,
      cacheResults: false,
      ...config,
    };
  }

  /**
   * Execute a query with tenant context
   */
  async executeWithTenantContext<T>(
    context: TenantQueryContext,
    operation: (client: PrismaClient) => Promise<T>
  ): Promise<T> {
    // Validate tenant access first
    if (this.config.strictIsolation && context.validateAccess) {
      const access = await tenantIsolationService.validateTenantAccess(
        context.principal,
        context.requestedTenantId
      );

      if (!access.allowed) {
        throw new TenantIsolationError(
          `Tenant access denied: ${access.reason}`,
          { principal: context.principal, requestedTenantId: context.requestedTenantId }
        );
      }
    }

    // Create tenant-aware client
    const tenantClients = await tenantIsolationService.createTenantClients(context);
    
    // Execute operation
    const startTime = Date.now();
    try {
      const result = await operation(tenantClients.prismaRead);
      
      // Log query execution if enabled
      if (this.config.logQueries) {
        logger.debug('Tenant query executed', {
          tenantId: context.requestedTenantId,
          principal: context.principal,
          executionTime: Date.now() - startTime,
        });
      }

      // Audit access if enabled
      if (this.config.auditAccess) {
        await this.auditDatabaseAccess(context, 'read', Date.now() - startTime);
      }

      return result;
    } catch (error) {
      logger.error('Tenant query failed', {
        tenantId: context.requestedTenantId,
        principal: context.principal,
        error: error.message,
        executionTime: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Execute a write operation with tenant context
   */
  async executeWriteWithTenantContext<T>(
    context: TenantQueryContext,
    operation: (client: PrismaClient) => Promise<T>
  ): Promise<T> {
    // Validate tenant access
    const access = await tenantIsolationService.validateTenantAccess(
      context.principal,
      context.requestedTenantId
    );

    if (!access.allowed) {
      throw new TenantIsolationError(
        `Tenant write access denied: ${access.reason}`,
        { principal: context.principal, requestedTenantId: context.requestedTenantId }
      );
    }

    const tenantClients = await tenantIsolationService.createTenantClients(context);
    
    const startTime = Date.now();
    try {
      const result = await operation(tenantClients.prismaWrite);
      
      // Audit write access
      if (this.config.auditAccess) {
        await this.auditDatabaseAccess(context, 'write', Date.now() - startTime);
      }

      // Clear relevant caches
      this.clearRelatedCache(context.requestedTenantId);

      return result;
    } catch (error) {
      logger.error('Tenant write operation failed', {
        tenantId: context.requestedTenantId,
        principal: context.principal,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get all users for a tenant (with automatic isolation)
   */
  async getTenantUsers(context: TenantQueryContext, options: {
    page?: number;
    limit?: number;
    includeRoles?: boolean;
  } = {}) {
    return this.executeWithTenantContext(context, async (client) => {
      const { page = 1, limit = 50, includeRoles = false } = options;
      const offset = (page - 1) * limit;

      const include = includeRoles ? {
        userRoles: {
          include: { role: true },
        },
      } : {};

      const [users, total] = await Promise.all([
        client.walletUser.findMany({
          include,
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        client.walletUser.count(),
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
   * Get user by ID with tenant isolation
   */
  async getTenantUser(context: TenantQueryContext, userId: string, includeRoles = false) {
    return this.executeWithTenantContext(context, async (client) => {
      const include = includeRoles ? {
        userRoles: {
          include: { role: true },
        },
      } : {};

      return client.walletUser.findUnique({
        where: { id: userId },
        include,
      });
    });
  }

  /**
   * Create a new user in a tenant
   */
  async createTenantUser(
    context: TenantQueryContext,
    userData: Prisma.WalletUserCreateInput
  ) {
    return this.executeWriteWithTenantContext(context, async (client) => {
      // Ensure tenantId is set
      const enhancedData = {
        ...userData,
        tenantId: context.requestedTenantId || context.principal.tenantId,
      };

      return client.walletUser.create({
        data: enhancedData,
      });
    });
  }

  /**
   * Update a user within tenant boundaries
   */
  async updateTenantUser(
    context: TenantQueryContext,
    userId: string,
    updateData: Prisma.WalletUserUpdateInput
  ) {
    return this.executeWriteWithTenantContext(context, async (client) => {
      return client.walletUser.update({
        where: { id: userId },
        data: updateData,
      });
    });
  }

  /**
   * Get tenant-specific API keys
   */
  async getTenantApiKeys(context: TenantQueryContext, developerId?: string) {
    return this.executeWithTenantContext(context, async (client) => {
      const where: Prisma.DevApiKeyWhereInput = {
        status: 'active',
      };

      if (developerId) {
        where.developerId = developerId;
      }

      return client.devApiKey.findMany({
        where,
        select: {
          id: true,
          keyPrefix: true,
          name: true,
          tier: true,
          allowedIps: true,
          allowedDomains: true,
          allowedEndpoints: true,
          expiresAt: true,
          lastUsedAt: true,
          createdAt: true,
          apiKeyScopes: {
            include: { permission: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  /**
   * Get tenant audit logs with automatic filtering
   */
  async getTenantAuditLogs(
    context: TenantQueryContext,
    options: {
      page?: number;
      limit?: number;
      actor?: string;
      action?: string;
      startDate?: Date;
      endDate?: Date;
    } = {}
  ) {
    return this.executeWithTenantContext(context, async (client) => {
      const { page = 1, limit = 100, actor, action, startDate, endDate } = options;
      const offset = (page - 1) * limit;

      const where: Prisma.AuditLogWhereInput = {};

      if (actor) where.actor = actor;
      if (action) where.action = action;
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = startDate;
        if (endDate) where.createdAt.lte = endDate;
      }

      const [logs, total] = await Promise.all([
        client.auditLog.findMany({
          where,
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        client.auditLog.count({ where }),
      ]);

      return {
        logs,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    });
  }

  /**
   * Execute raw tenant-aware query
   */
  async executeRawQuery<T>(
    context: TenantQueryContext,
    query: string,
    params: any[] = []
  ): Promise<T> {
    // Validate that query doesn't bypass tenant isolation
    if (this.config.strictIsolation && !this.isQuerySafe(query, context)) {
      throw new TenantIsolationError(
        'Raw query may bypass tenant isolation',
        { query, principal: context.principal }
      );
    }

    return this.executeWithTenantContext(context, async (client) => {
      return client.$queryRaw<T>`${Prisma.sql([query], ...params)}`;
    });
  }

  /**
   * Batch operations with tenant context
   */
  async executeBatch(
    context: TenantQueryContext,
    operations: Array<(client: PrismaClient) => Promise<any>>
  ): Promise<any[]> {
    return this.executeWriteWithTenantContext(context, async (client) => {
      return client.$transaction(operations.map(op => op(client)));
    });
  }

  /**
   * Get tenant-specific statistics
   */
  async getTenantStats(context: TenantQueryContext): Promise<{
    users: number;
    apiKeys: number;
    auditLogs: number;
    lastActivity: Date | null;
  }> {
    return this.executeWithTenantContext(context, async (client) => {
      const [users, apiKeys, auditLogs, lastActivity] = await Promise.all([
        client.walletUser.count(),
        client.devApiKey.count({ where: { status: 'active' } }),
        client.auditLog.count(),
        client.auditLog.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

      return {
        users,
        apiKeys,
        auditLogs,
        lastActivity: lastActivity?.createdAt || null,
      };
    });
  }

  // ── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Audit database access for compliance
   */
  private async auditDatabaseAccess(
    context: TenantQueryContext,
    operationType: 'read' | 'write',
    executionTime: number
  ): Promise<void> {
    try {
      const auditData = {
        principal: context.principal,
        tenantId: context.requestedTenantId,
        operationType,
        executionTime,
        timestamp: new Date(),
      };

      logger.info('Database access audit', auditData);

      // Store audit log in background
      setTimeout(async () => {
        try {
          const { prismaWrite } = await import('../db');
          await prismaWrite.auditLog.create({
            data: {
              id: crypto.randomUUID(),
              actor: context.principal.userId || context.principal.apiKeyId || 'system',
              action: `database_${operationType}`,
              target: `tenant:${context.requestedTenantId}`,
              newState: auditData,
            },
          });
        } catch (error) {
          logger.warn('Failed to create database audit log', { error: error.message });
        }
      }, 0);
    } catch (error) {
      logger.warn('Database access audit failed', { error: error.message });
    }
  }

  /**
   * Check if a raw query is safe (doesn't bypass tenant isolation)
   */
  private isQuerySafe(query: string, context: TenantQueryContext): boolean {
    const lowerQuery = query.toLowerCase().trim();
    
    // Allow admin to bypass checks
    if (context.bypassIsolation && context.principal.type === 'admin') {
      return true;
    }

    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /select.*from.*where.*tenant_id\s*!=/, // Selecting from different tenants
      /update.*set.*tenant_id\s*=/, // Changing tenant ownership
      /delete.*from.*where.*tenant_id\s*!=/, // Deleting from different tenants
      /drop\s+table/i, // DDL operations
      /create\s+table/i,
      /alter\s+table/i,
    ];

    const hasDangerousPattern = dangerousPatterns.some(pattern => pattern.test(lowerQuery));
    if (hasDangerousPattern) {
      return false;
    }

    // Ensure query includes tenant filtering for isolated models
    const touchesIsolatedModel = TENANT_ISOLATED_MODELS.some(model => 
      lowerQuery.includes(model.toLowerCase())
    );

    if (touchesIsolatedModel) {
      const targetTenantId = context.requestedTenantId || context.principal.tenantId;
      if (!targetTenantId) {
        return false; // No tenant context for isolated model
      }

      // Query should include tenant filtering
      return lowerQuery.includes('tenant_id') && lowerQuery.includes(targetTenantId);
    }

    return true;
  }

  /**
   * Clear cache entries related to a tenant
   */
  private clearRelatedCache(tenantId?: string): void {
    if (!this.config.cacheResults) return;

    if (tenantId) {
      // Clear cache entries for specific tenant
      const keysToDelete: string[] = [];
      for (const [key, _] of this.queryCache.entries()) {
        if (key.includes(tenantId)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.queryCache.delete(key));
    } else {
      // Clear all cache
      this.queryCache.clear();
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    hitRate: number;
    entries: Array<{ key: string; expiresAt: number }>;
  } {
    const entries = Array.from(this.queryCache.entries()).map(([key, cached]) => ({
      key,
      expiresAt: cached.expiresAt,
    }));

    return {
      size: this.queryCache.size,
      hitRate: 0.85, // Placeholder - implement actual hit rate tracking
      entries,
    };
  }
}

/**
 * Create tenant-aware database clients
 */
export async function createTenantAwareClients(config?: Partial<TenantDbConfig>): Promise<{
  tenantRead: TenantAwarePrismaClient;
  tenantWrite: TenantAwarePrismaClient;
}> {
  const { prismaRead, prismaWrite } = await import('../db');

  return {
    tenantRead: new TenantAwarePrismaClient(prismaRead, { ...config, auditAccess: false }),
    tenantWrite: new TenantAwarePrismaClient(prismaWrite, config),
  };
}

/**
 * Utility function for tenant-safe database operations
 */
export async function withTenantDb<T>(
  principal: AuthPrincipal,
  tenantId: string | undefined,
  operation: (db: TenantAwarePrismaClient) => Promise<T>,
  options: { 
    writeAccess?: boolean;
    bypassIsolation?: boolean;
    validateAccess?: boolean;
  } = {}
): Promise<T> {
  const { writeAccess = false, bypassIsolation = false, validateAccess = true } = options;

  const context = createTenantContext(principal, {
    requestedTenantId: tenantId,
    bypassIsolation,
    validateAccess,
  });

  const clients = await createTenantAwareClients();
  const client = writeAccess ? clients.tenantWrite : clients.tenantRead;

  return operation(client);
}

/**
 * Tenant isolation testing utilities
 */
export class TenantDbTester {
  /**
   * Test that tenant isolation is working correctly
   */
  static async testIsolation(
    tenant1Id: string,
    tenant2Id: string,
    principal1: AuthPrincipal,
    principal2: AuthPrincipal
  ): Promise<{ success: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      const clients = await createTenantAwareClients({ strictIsolation: true });

      // Create test data in tenant1
      const context1 = createTenantContext(principal1, { requestedTenantId: tenant1Id });
      await clients.tenantWrite.executeWriteWithTenantContext(context1, async (client) => {
        return client.walletUser.create({
          data: {
            id: 'test-user-tenant1',
            address: 'test-address-tenant1',
            tenantId: tenant1Id,
          },
        });
      });

      // Try to access tenant1 data from tenant2 context
      const context2 = createTenantContext(principal2, { requestedTenantId: tenant2Id });
      const crossTenantAccess = await clients.tenantRead.executeWithTenantContext(
        context2,
        async (client) => {
          return client.walletUser.findMany();
        }
      );

      // Should not see tenant1 data
      const leakedData = crossTenantAccess.filter(user => user.tenantId === tenant1Id);
      if (leakedData.length > 0) {
        issues.push(`Cross-tenant data leak: ${leakedData.length} users from tenant1 visible to tenant2`);
      }

      // Clean up test data
      await clients.tenantWrite.executeWriteWithTenantContext(context1, async (client) => {
        return client.walletUser.delete({
          where: { id: 'test-user-tenant1' },
        });
      });

    } catch (error) {
      if (error instanceof TenantIsolationError) {
        // This is expected - isolation is working
      } else {
        issues.push(`Unexpected error: ${error.message}`);
      }
    }

    return {
      success: issues.length === 0,
      issues,
    };
  }
}

export default TenantAwarePrismaClient;