/**
 * RBAC Audit Middleware
 *
 * Express middleware that automatically captures and logs RBAC events,
 * permission checks, and administrative actions for compliance and security.
 */

import type { Request, Response, NextFunction } from 'express';
import { rbacAuditLogger, AuditEventType, AuditSeverity } from './audit-logger';
import { logger } from '../logger';
import { AuthPrincipal } from './types';

// Extend Express Request to include audit context
declare global {
  namespace Express {
    interface Request {
      auditContext?: {
        startTime: number;
        requestId: string;
        sensitive: boolean;
        skipAudit: boolean;
      };
    }
  }
}

/**
 * Options for audit middleware
 */
export interface AuditMiddlewareOptions {
  logRequests?: boolean; // Log all requests (default: false)
  logResponses?: boolean; // Log all responses (default: false)
  logSensitive?: boolean; // Log sensitive data access (default: true)
  skipPaths?: string[]; // Paths to skip auditing
  sensitiveEndpoints?: string[]; // Endpoints that access sensitive data
  maxBodySize?: number; // Max request/response body size to log
}

/**
 * Main audit middleware
 */
export function auditMiddleware(options: AuditMiddlewareOptions = {}) {
  const {
    logRequests = false,
    logResponses = false,
    logSensitive = true,
    skipPaths = ['/health', '/metrics'],
    sensitiveEndpoints = [
      '/admin',
      '/audit',
      '/compliance',
      '/users/:id',
      '/api-keys',
    ],
    maxBodySize = 10240, // 10KB
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if path should be skipped
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Set up audit context
    req.auditContext = {
      startTime: Date.now(),
      requestId: req.id || req.get('X-Request-ID') || crypto.randomUUID(),
      sensitive: isSensitiveEndpoint(req.path, sensitiveEndpoints),
      skipAudit: false,
    };

    // Log request if configured
    if (logRequests) {
      await logRequest(req);
    }

    // Log sensitive access
    if (logSensitive && req.auditContext.sensitive) {
      await logSensitiveAccess(req);
    }

    // Intercept response to log it
    if (logResponses || req.auditContext.sensitive) {
      const originalSend = res.send;
      res.send = function(body: any) {
        logResponse(req, res, body, maxBodySize);
        return originalSend.call(this, body);
      };
    }

    next();
  };
}

/**
 * Middleware to mark request as sensitive
 */
export function markSensitive(req: Request, res: Response, next: NextFunction): void {
  if (req.auditContext) {
    req.auditContext.sensitive = true;
  }
  next();
}

/**
 * Middleware to skip audit logging for a request
 */
export function skipAudit(req: Request, res: Response, next: NextFunction): void {
  if (req.auditContext) {
    req.auditContext.skipAudit = true;
  }
  next();
}

/**
 * Middleware to audit admin actions
 */
export function auditAdminAction(action: string, options: {
  getTarget?: (req: Request) => string;
  getTargetType?: (req: Request) => string;
  getDetails?: (req: Request, res: Response) => Record<string, any>;
  logBefore?: boolean;
  logAfter?: boolean;
} = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.rbacPrincipal || req.auditContext?.skipAudit) {
      return next();
    }

    const target = options.getTarget ? options.getTarget(req) : undefined;
    const targetType = options.getTargetType ? options.getTargetType(req) : undefined;

    // Log before action if configured
    if (options.logBefore) {
      await rbacAuditLogger.logAdminAction(
        req.rbacPrincipal,
        `${action} (started)`,
        target,
        {
          targetType,
          requestId: req.auditContext?.requestId,
          details: options.getDetails ? options.getDetails(req, res) : {},
        }
      );
    }

    // Capture original state if needed
    let previousState: any = undefined;
    if (options.logAfter && target) {
      // This is a simplified implementation - in practice, you'd capture actual state
      previousState = { capturedAt: new Date() };
    }

    // Hook into response to log completion
    const originalSend = res.send;
    res.send = function(body: any) {
      if (options.logAfter) {
        // Log in background to not delay response
        setImmediate(async () => {
          try {
            let newState: any = undefined;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              // Success - capture new state
              newState = typeof body === 'string' ? JSON.parse(body) : body;
            }

            await rbacAuditLogger.logAdminAction(
              req.rbacPrincipal!,
              `${action} (${res.statusCode >= 200 && res.statusCode < 300 ? 'completed' : 'failed'})`,
              target,
              {
                targetType,
                previousState,
                newState: newState && Object.keys(newState).length < 10 ? newState : { status: 'large_response' },
                requestId: req.auditContext?.requestId,
                details: {
                  statusCode: res.statusCode,
                  method: req.method,
                  path: req.path,
                  ...options.getDetails ? options.getDetails(req, res) : {},
                },
              }
            );
          } catch (error) {
            logger.warn('Failed to log admin action completion', { error: error.message });
          }
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to audit role/permission changes
 */
export function auditRoleChange(
  changeType: 'assign' | 'revoke',
  options: {
    getRoleId: (req: Request) => string;
    getUserId: (req: Request) => string;
    getTenantId?: (req: Request) => string;
    getReason?: (req: Request) => string;
  }
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.rbacPrincipal || req.auditContext?.skipAudit) {
      return next();
    }

    const originalSend = res.send;
    res.send = function(body: any) {
      // Log role change after successful response
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setImmediate(async () => {
          try {
            const roleId = options.getRoleId(req);
            const userId = options.getUserId(req);
            const tenantId = options.getTenantId ? options.getTenantId(req) : undefined;
            const reason = options.getReason ? options.getReason(req) : undefined;

            if (changeType === 'assign') {
              await rbacAuditLogger.logRoleAssignment(
                req.rbacPrincipal!,
                userId,
                roleId,
                tenantId,
                {
                  reason,
                  requestId: req.auditContext?.requestId,
                }
              );
            } else {
              await rbacAuditLogger.logRoleRevocation(
                req.rbacPrincipal!,
                userId,
                roleId,
                tenantId,
                {
                  reason,
                  requestId: req.auditContext?.requestId,
                }
              );
            }
          } catch (error) {
            logger.warn('Failed to log role change', { error: error.message });
          }
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to audit data exports
 */
export function auditDataExport(
  dataType: string,
  options: {
    getFilters?: (req: Request) => Record<string, any>;
    getRecordCount?: (req: Request, res: Response) => number;
  } = {}
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.rbacPrincipal || req.auditContext?.skipAudit) {
      return next();
    }

    const originalSend = res.send;
    res.send = function(body: any) {
      // Log data export after successful response
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setImmediate(async () => {
          try {
            await rbacAuditLogger.logEvent({
              id: crypto.randomUUID(),
              type: AuditEventType.DATA_EXPORT,
              severity: AuditSeverity.INFO,
              actor: req.rbacPrincipal!.userId || req.rbacPrincipal!.apiKeyId || 'unknown',
              actorType: req.rbacPrincipal!.type,
              target: dataType,
              targetType: 'data',
              action: `Data export: ${dataType}`,
              requestId: req.auditContext?.requestId,
              sessionId: req.rbacPrincipal!.sessionId,
              tenantId: req.rbacPrincipal!.tenantId,
              ipAddress: req.ip,
              userAgent: req.get('User-Agent'),
              details: {
                dataType,
                filters: options.getFilters ? options.getFilters(req) : {},
                recordCount: options.getRecordCount ? options.getRecordCount(req, res) : 'unknown',
                format: req.query.format || 'json',
                statusCode: res.statusCode,
              },
              timestamp: new Date(),
              source: 'rbac.audit-middleware',
              tags: ['data-export', dataType.toLowerCase()],
            });
          } catch (error) {
            logger.warn('Failed to log data export', { error: error.message });
          }
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to audit bulk operations
 */
export function auditBulkOperation(
  operationType: string,
  options: {
    getAffectedCount?: (req: Request, res: Response) => number;
    getTargets?: (req: Request) => string[];
  } = {}
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.rbacPrincipal || req.auditContext?.skipAudit) {
      return next();
    }

    const originalSend = res.send;
    res.send = function(body: any) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setImmediate(async () => {
          try {
            await rbacAuditLogger.logEvent({
              id: crypto.randomUUID(),
              type: AuditEventType.BULK_OPERATION,
              severity: AuditSeverity.INFO,
              actor: req.rbacPrincipal!.userId || req.rbacPrincipal!.apiKeyId || 'unknown',
              actorType: req.rbacPrincipal!.type,
              target: operationType,
              targetType: 'bulk',
              action: `Bulk operation: ${operationType}`,
              requestId: req.auditContext?.requestId,
              sessionId: req.rbacPrincipal!.sessionId,
              tenantId: req.rbacPrincipal!.tenantId,
              ipAddress: req.ip,
              userAgent: req.get('User-Agent'),
              details: {
                operationType,
                affectedCount: options.getAffectedCount ? options.getAffectedCount(req, res) : 'unknown',
                targets: options.getTargets ? options.getTargets(req) : [],
                statusCode: res.statusCode,
              },
              timestamp: new Date(),
              source: 'rbac.audit-middleware',
              tags: ['bulk-operation', operationType.toLowerCase().replace(/\s+/g, '-')],
            });
          } catch (error) {
            logger.warn('Failed to log bulk operation', { error: error.message });
          }
        });
      }

      return originalSend.call(this, body);
    };

    next();
  };
}

/**
 * Enhanced error handling that logs security violations
 */
export function auditErrorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log security-related errors
  if (isSecurityError(error)) {
    setImmediate(async () => {
      try {
        await rbacAuditLogger.logSecurityViolation(
          error.name,
          req.rbacPrincipal,
          {
            description: error.message,
            severity: determineSeverity(error),
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            requestId: req.auditContext?.requestId,
            details: {
              stack: error.stack,
              url: req.url,
              method: req.method,
              body: sanitizeBody(req.body),
              query: req.query,
            },
          }
        );
      } catch (auditError) {
        logger.error('Failed to audit security error', { auditError: auditError.message });
      }
    });
  }

  // Pass to next error handler
  next(error);
}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Log incoming request
 */
async function logRequest(req: Request): Promise<void> {
  if (!req.rbacPrincipal || req.auditContext?.skipAudit) return;

  try {
    await rbacAuditLogger.logEvent({
      id: crypto.randomUUID(),
      type: AuditEventType.ADMIN_ACTION, // Generic for request logging
      severity: AuditSeverity.INFO,
      actor: req.rbacPrincipal.userId || req.rbacPrincipal.apiKeyId || 'anonymous',
      actorType: req.rbacPrincipal.type,
      action: `${req.method} ${req.path}`,
      requestId: req.auditContext?.requestId,
      sessionId: req.rbacPrincipal.sessionId,
      tenantId: req.rbacPrincipal.tenantId,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      details: {
        method: req.method,
        path: req.path,
        query: req.query,
        body: sanitizeBody(req.body),
        headers: sanitizeHeaders(req.headers),
      },
      timestamp: new Date(),
      source: 'rbac.audit-middleware',
      tags: ['request', req.method.toLowerCase()],
    });
  } catch (error) {
    logger.warn('Failed to log request', { error: error.message });
  }
}

/**
 * Log sensitive data access
 */
async function logSensitiveAccess(req: Request): Promise<void> {
  if (!req.rbacPrincipal) return;

  try {
    await rbacAuditLogger.logSensitiveAccess(
      req.rbacPrincipal,
      'endpoint',
      req.path,
      {
        endpoint: req.path,
        method: req.method,
        requestId: req.auditContext?.requestId,
        ipAddress: req.ip,
        reason: 'Sensitive endpoint accessed',
      }
    );
  } catch (error) {
    logger.warn('Failed to log sensitive access', { error: error.message });
  }
}

/**
 * Log response
 */
async function logResponse(
  req: Request,
  res: Response,
  body: any,
  maxBodySize: number
): Promise<void> {
  if (!req.rbacPrincipal || req.auditContext?.skipAudit) return;

  try {
    const duration = Date.now() - (req.auditContext?.startTime || Date.now());
    
    await rbacAuditLogger.logEvent({
      id: crypto.randomUUID(),
      type: AuditEventType.ADMIN_ACTION,
      severity: res.statusCode >= 400 ? AuditSeverity.WARNING : AuditSeverity.INFO,
      actor: req.rbacPrincipal.userId || req.rbacPrincipal.apiKeyId || 'anonymous',
      actorType: req.rbacPrincipal.type,
      action: `${req.method} ${req.path} - ${res.statusCode}`,
      requestId: req.auditContext?.requestId,
      sessionId: req.rbacPrincipal.sessionId,
      tenantId: req.rbacPrincipal.tenantId,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      details: {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        responseBody: sanitizeResponseBody(body, maxBodySize),
        contentType: res.get('Content-Type'),
      },
      timestamp: new Date(),
      source: 'rbac.audit-middleware',
      tags: ['response', res.statusCode >= 400 ? 'error' : 'success'],
    });
  } catch (error) {
    logger.warn('Failed to log response', { error: error.message });
  }
}

/**
 * Check if endpoint is sensitive
 */
function isSensitiveEndpoint(path: string, sensitiveEndpoints: string[]): boolean {
  return sensitiveEndpoints.some(endpoint => {
    if (endpoint.includes(':')) {
      // Handle parameterized paths
      const pattern = endpoint.replace(/:[^/]+/g, '[^/]+');
      const regex = new RegExp(`^${pattern}$`);
      return regex.test(path);
    }
    return path.startsWith(endpoint);
  });
}

/**
 * Check if error is security-related
 */
function isSecurityError(error: Error): boolean {
  const securityErrorTypes = [
    'PermissionDeniedError',
    'TenantIsolationError',
    'AuthenticationError',
    'AuthorizationError',
    'RateLimitError',
    'ValidationError',
  ];

  return securityErrorTypes.includes(error.name) || 
         error.message.toLowerCase().includes('security') ||
         error.message.toLowerCase().includes('permission') ||
         error.message.toLowerCase().includes('unauthorized');
}

/**
 * Determine severity from error
 */
function determineSeverity(error: Error): AuditSeverity {
  if (error.name.includes('Critical') || error.message.includes('critical')) {
    return AuditSeverity.CRITICAL;
  }
  if (error.name.includes('Permission') || error.name.includes('Authorization')) {
    return AuditSeverity.ERROR;
  }
  return AuditSeverity.WARNING;
}

/**
 * Sanitize request body for logging
 */
function sanitizeBody(body: any, maxSize = 1024): any {
  if (!body) return body;

  const sanitized = { ...body };
  
  // Remove sensitive fields
  const sensitiveFields = ['password', 'secret', 'token', 'key', 'apiKey', 'clientSecret'];
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });

  // Truncate if too large
  const str = JSON.stringify(sanitized);
  if (str.length > maxSize) {
    return { __truncated: true, size: str.length, preview: str.substring(0, maxSize) };
  }

  return sanitized;
}

/**
 * Sanitize response body for logging
 */
function sanitizeResponseBody(body: any, maxSize: number): any {
  if (!body) return body;

  const str = typeof body === 'string' ? body : JSON.stringify(body);
  if (str.length > maxSize) {
    return { __truncated: true, size: str.length, preview: str.substring(0, maxSize) };
  }

  try {
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return body;
  }
}

/**
 * Sanitize headers for logging
 */
function sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
  const sanitized = { ...headers };
  
  // Remove sensitive headers
  const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie', 'x-admin-token'];
  sensitiveHeaders.forEach(header => {
    if (sanitized[header]) {
      sanitized[header] = '[REDACTED]';
    }
  });

  return sanitized;
}

// Export convenience functions for common audit patterns
export const auditPatterns = {
  userManagement: auditAdminAction('User Management', {
    getTarget: (req) => req.params.userId || req.body.userId,
    getTargetType: () => 'user',
    logAfter: true,
  }),

  roleManagement: auditAdminAction('Role Management', {
    getTarget: (req) => req.params.roleId || req.body.roleId,
    getTargetType: () => 'role',
    logAfter: true,
  }),

  permissionManagement: auditAdminAction('Permission Management', {
    getTarget: (req) => req.params.permissionId || req.body.permissionId,
    getTargetType: () => 'permission',
    logAfter: true,
  }),

  tenantManagement: auditAdminAction('Tenant Management', {
    getTarget: (req) => req.params.tenantId || req.body.tenantId,
    getTargetType: () => 'tenant',
    logAfter: true,
  }),

  apiKeyManagement: auditAdminAction('API Key Management', {
    getTarget: (req) => req.params.keyId || 'new-key',
    getTargetType: () => 'api_key',
    logAfter: true,
  }),
};

export {
  auditMiddleware,
  markSensitive,
  skipAudit,
  auditAdminAction,
  auditRoleChange,
  auditDataExport,
  auditBulkOperation,
  auditErrorHandler,
};