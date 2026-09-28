/**
 * Graceful degradation system for SDK generation pipeline.
 * Ensures partial success and fallback behavior when components fail.
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface DegradationResult {
  success: boolean;
  partial: boolean;
  generatedFiles: GeneratedFile[];
  failedComponents: string[];
  fallbacksActivated: string[];
  errors: Array<{ component: string; error: string; recoverable: boolean }>;
}

export interface ComponentHandler {
  name: string;
  critical: boolean;
  fallback?: () => GeneratedFile[];
  execute: () => GeneratedFile[];
}

class GracefulDegradation {
  private maxRetries: number = 3;
  private retryDelay: number = 1000; // ms
  private circuitBreakerThreshold: number = 5;
  private circuitBreakerTimeout: number = 60000; // ms
  private circuitBreakerFailures: Map<string, { count: number; lastFailure: number }> = new Map();

  async executeWithDegradation(
    handlers: ComponentHandler[],
    context?: { correlationId?: string }
  ): Promise<DegradationResult> {
    const result: DegradationResult = {
      success: true,
      partial: false,
      generatedFiles: [],
      failedComponents: [],
      fallbacksActivated: [],
      errors: [],
    };

    const criticalHandlers = handlers.filter(h => h.critical);
    const optionalHandlers = handlers.filter(h => !h.critical);

    // Execute critical handlers first
    for (const handler of criticalHandlers) {
      const handlerResult = await this.executeHandler(handler, context);
      
      if (handlerResult.success) {
        result.generatedFiles.push(...handlerResult.files);
      } else {
        result.success = false;
        result.failedComponents.push(handler.name);
        result.errors.push({
          component: handler.name,
          error: handlerResult.error || 'Unknown error',
          recoverable: handlerResult.recoverable || false,
        });

        // If critical handler fails and is not recoverable, fail fast
        if (!handlerResult.recoverable) {
          return result;
        }
      }
    }

    // Execute optional handlers with best-effort
    for (const handler of optionalHandlers) {
      const handlerResult = await this.executeHandler(handler, context);
      
      if (handlerResult.success) {
        result.generatedFiles.push(...handlerResult.files);
      } else {
        result.partial = true;
        result.failedComponents.push(handler.name);
        result.errors.push({
          component: handler.name,
          error: handlerResult.error || 'Unknown error',
          recoverable: true, // Optional handlers are always recoverable
        });

        // Try fallback if available
        if (handler.fallback) {
          try {
            const fallbackFiles = handler.fallback();
            result.generatedFiles.push(...fallbackFiles);
            result.fallbacksActivated.push(handler.name);
          } catch (fallbackError) {
            result.errors.push({
              component: `${handler.name}-fallback`,
              error: String(fallbackError),
              recoverable: true,
            });
          }
        }
      }
    }

    // Mark as partial if any optional handlers failed but succeeded with fallbacks
    if (result.fallbacksActivated.length > 0) {
      result.partial = true;
    }

    return result;
  }

  private async executeHandler(
    handler: ComponentHandler,
    context?: { correlationId?: string }
  ): Promise<{ success: boolean; files: GeneratedFile[]; error?: string; recoverable?: boolean }> {
    // Check circuit breaker
    if (this.isCircuitBreakerOpen(handler.name)) {
      return {
        success: false,
        files: [],
        error: 'Circuit breaker is open for this component',
        recoverable: true,
      };
    }

    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const files = handler.execute();
        this.recordSuccess(handler.name);
        return { success: true, files };
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    // All retries failed
    this.recordFailure(handler.name);
    
    return {
      success: false,
      files: [],
      error: lastError?.message || 'Unknown error',
      recoverable: !handler.critical,
    };
  }

  private isCircuitBreakerOpen(componentName: string): boolean {
    const state = this.circuitBreakerFailures.get(componentName);
    if (!state) return false;

    if (Date.now() - state.lastFailure > this.circuitBreakerTimeout) {
      // Reset circuit breaker after timeout
      this.circuitBreakerFailures.delete(componentName);
      return false;
    }

    return state.count >= this.circuitBreakerThreshold;
  }

  private recordSuccess(componentName: string): void {
    this.circuitBreakerFailures.delete(componentName);
  }

  private recordFailure(componentName: string): void {
    const state = this.circuitBreakerFailures.get(componentName) || { count: 0, lastFailure: 0 };
    state.count++;
    state.lastFailure = Date.now();
    this.circuitBreakerFailures.set(componentName, state);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getCircuitBreakerStatus(): Map<string, { open: boolean; count: number; lastFailure: number }> {
    const status = new Map();
    for (const [name, state] of this.circuitBreakerFailures) {
      status.set(name, {
        open: this.isCircuitBreakerOpen(name),
        count: state.count,
        lastFailure: state.lastFailure,
      });
    }
    return status;
  }

  resetCircuitBreaker(componentName?: string): void {
    if (componentName) {
      this.circuitBreakerFailures.delete(componentName);
    } else {
      this.circuitBreakerFailures.clear();
    }
  }

  configure(options: {
    maxRetries?: number;
    retryDelay?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerTimeout?: number;
  }): void {
    if (options.maxRetries !== undefined) this.maxRetries = options.maxRetries;
    if (options.retryDelay !== undefined) this.retryDelay = options.retryDelay;
    if (options.circuitBreakerThreshold !== undefined) this.circuitBreakerThreshold = options.circuitBreakerThreshold;
    if (options.circuitBreakerTimeout !== undefined) this.circuitBreakerTimeout = options.circuitBreakerTimeout;
  }
}

// Singleton instance
export const gracefulDegradation = new GracefulDegradation();

// Fallback implementations for common scenarios
export const fallbacks = {
  // Fallback for parity matrix generation
  parityMatrix: (): GeneratedFile[] => [{
    path: 'docs/sdk/parity-matrix.md',
    content: `# SDK Parity Matrix

*Generated in degraded mode - full parity information unavailable*

This file was generated using a fallback due to parity matrix generation failure.
Please check the logs for details and regenerate when the issue is resolved.
`,
  }],

  // Fallback for API surface
  apiSurface: (version: string): GeneratedFile[] => [{
    path: 'packages/client/api-surface.json',
    content: JSON.stringify({
      version,
      generatedAt: new Date().toISOString(),
      degraded: true,
      operations: [],
    }, null, 2) + '\n',
  }],

  // Minimal models fallback
  minimalModels: (): GeneratedFile[] => [{
    path: 'packages/client/src/generated/models.ts',
    content: `// AUTO-GENERATED in degraded mode - minimal types only
// Full models unavailable due to generation failure

export type Unknown = unknown;
`,
  }],
};
