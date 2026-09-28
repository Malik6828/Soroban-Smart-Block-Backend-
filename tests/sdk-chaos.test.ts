/**
 * Chaos and fault-injection tests for SDK generation pipeline.
 * Tests graceful degradation, circuit breakers, and fallback behavior under failure scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gracefulDegradation, fallbacks, type ComponentHandler, type GeneratedFile } from '../scripts/sdk/graceful-degradation';
import { featureFlags, FLAG_NAMES } from '../scripts/sdk/feature-flags';
import { logger } from '../scripts/sdk/sdk-logger';
import { metrics } from '../scripts/sdk/sdk-metrics';

describe('SDK Generation Chaos Tests', () => {
  beforeEach(() => {
    // Reset all state before each test
    gracefulDegradation.resetCircuitBreaker();
    metrics.reset();
    logger.getCorrelationId(); // Reset correlation ID
  });

  afterEach(() => {
    // Clean up after each test
    gracefulDegradation.resetCircuitBreaker();
    metrics.reset();
  });

  describe('Circuit Breaker Tests', () => {
    it('should open circuit breaker after threshold failures', async () => {
      const failingHandler: ComponentHandler = {
        name: 'failing-component',
        critical: false,
        execute: () => {
          throw new Error('Simulated failure');
        },
      };

      const config = { maxRetries: 1, circuitBreakerThreshold: 3 };
      gracefulDegradation.configure(config);

      // Trigger failures until circuit breaker opens
      for (let i = 0; i < 5; i++) {
        await gracefulDegradation.executeWithDegradation([failingHandler]);
      }

      const status = gracefulDegradation.getCircuitBreakerStatus();
      const componentStatus = status.get('failing-component');
      
      expect(componentStatus?.open).toBe(true);
      expect(componentStatus?.count).toBeGreaterThanOrEqual(3);
    });

    it('should reset circuit breaker after timeout', async () => {
      const failingHandler: ComponentHandler = {
        name: 'failing-component',
        critical: false,
        execute: () => {
          throw new Error('Simulated failure');
        },
      };

      const config = { 
        maxRetries: 1, 
        circuitBreakerThreshold: 2,
        circuitBreakerTimeout: 100 // 100ms timeout for testing
      };
      gracefulDegradation.configure(config);

      // Trigger failures to open circuit breaker
      for (let i = 0; i < 3; i++) {
        await gracefulDegradation.executeWithDegradation([failingHandler]);
      }

      expect(gracefulDegradation.getCircuitBreakerStatus().get('failing-component')?.open).toBe(true);

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Circuit breaker should be reset
      expect(gracefulDegradation.getCircuitBreakerStatus().get('failing-component')).toBeUndefined();
    });

    it('should prevent execution when circuit breaker is open', async () => {
      const handler: ComponentHandler = {
        name: 'circuit-breaker-test',
        critical: false,
        execute: () => [{ path: 'test.txt', content: 'test' }],
      };

      const config = { 
        maxRetries: 1, 
        circuitBreakerThreshold: 2 
      };
      gracefulDegradation.configure(config);

      // Open circuit breaker
      const failingHandler: ComponentHandler = {
        name: 'circuit-breaker-test',
        critical: false,
        execute: () => {
          throw new Error('Simulated failure');
        },
      };

      for (let i = 0; i < 3; i++) {
        await gracefulDegradation.executeWithDegradation([failingHandler]);
      }

      // Try to execute with same handler name
      const result = await gracefulDegradation.executeWithDegradation([handler]);
      
      expect(result.success).toBe(true); // Optional handler should still succeed overall
      expect(result.failedComponents).toContain('circuit-breaker-test');
      expect(result.errors[0].error).toContain('Circuit breaker is open');
    });
  });

  describe('Retry Logic Tests', () => {
    it('should retry failed operations', async () => {
      let attemptCount = 0;
      const flakyHandler: ComponentHandler = {
        name: 'flaky-component',
        critical: false,
        execute: () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error('Temporary failure');
          }
          return [{ path: 'test.txt', content: 'success' }];
        },
      };

      const config = { maxRetries: 5, retryDelay: 10 };
      gracefulDegradation.configure(config);

      const result = await gracefulDegradation.executeWithDegradation([flakyHandler]);
      
      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(1);
      expect(attemptCount).toBe(3); // Initial attempt + 2 retries
    });

    it('should give up after max retries', async () => {
      let attemptCount = 0;
      const alwaysFailingHandler: ComponentHandler = {
        name: 'always-failing',
        critical: false,
        execute: () => {
          attemptCount++;
          throw new Error('Always fails');
        },
      };

      const config = { maxRetries: 3, retryDelay: 10 };
      gracefulDegradation.configure(config);

      const result = await gracefulDegradation.executeWithDegradation([alwaysFailingHandler]);
      
      expect(result.success).toBe(true); // Optional handler
      expect(result.failedComponents).toContain('always-failing');
      expect(attemptCount).toBe(4); // Initial attempt + 3 retries
    });
  });

  describe('Fallback Tests', () => {
    it('should use fallback when optional handler fails', async () => {
      const failingHandler: ComponentHandler = {
        name: 'with-fallback',
        critical: false,
        execute: () => {
          throw new Error('Handler failed');
        },
        fallback: () => [{ path: 'fallback.txt', content: 'fallback content' }],
      };

      const result = await gracefulDegradation.executeWithDegradation([failingHandler]);
      
      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.fallbacksActivated).toContain('with-fallback');
      expect(result.generatedFiles).toHaveLength(1);
      expect(result.generatedFiles[0].path).toBe('fallback.txt');
    });

    it('should not use fallback for critical handlers', async () => {
      const criticalHandler: ComponentHandler = {
        name: 'critical-with-fallback',
        critical: true,
        execute: () => {
          throw new Error('Critical handler failed');
        },
        fallback: () => [{ path: 'fallback.txt', content: 'fallback content' }],
      };

      const result = await gracefulDegradation.executeWithDegradation([criticalHandler]);
      
      expect(result.success).toBe(false);
      expect(result.fallbacksActivated).not.toContain('critical-with-fallback');
      expect(result.generatedFiles).toHaveLength(0);
    });

    it('should handle fallback failures gracefully', async () => {
      const handlerWithBadFallback: ComponentHandler = {
        name: 'bad-fallback',
        critical: false,
        execute: () => {
          throw new Error('Handler failed');
        },
        fallback: () => {
          throw new Error('Fallback also failed');
        },
      };

      const result = await gracefulDegradation.executeWithDegradation([handlerWithBadFallback]);
      
      expect(result.success).toBe(true); // Optional handler
      expect(result.failedComponents).toContain('bad-fallback');
      expect(result.errors.some(e => e.component === 'bad-fallback-fallback')).toBe(true);
    });
  });

  describe('Critical vs Optional Handlers', () => {
    it('should fail fast when critical handler fails', async () => {
      const criticalHandler: ComponentHandler = {
        name: 'critical',
        critical: true,
        execute: () => {
          throw new Error('Critical failure');
        },
      };

      const optionalHandler: ComponentHandler = {
        name: 'optional',
        critical: false,
        execute: () => [{ path: 'optional.txt', content: 'optional' }],
      };

      const result = await gracefulDegradation.executeWithDegradation([
        criticalHandler,
        optionalHandler,
      ]);
      
      expect(result.success).toBe(false);
      expect(result.failedComponents).toContain('critical');
      expect(result.generatedFiles).toHaveLength(0); // Optional handler should not run
    });

    it('should continue with optional handlers after critical success', async () => {
      const criticalHandler: ComponentHandler = {
        name: 'critical',
        critical: true,
        execute: () => [{ path: 'critical.txt', content: 'critical' }],
      };

      const optionalHandler: ComponentHandler = {
        name: 'optional',
        critical: false,
        execute: () => [{ path: 'optional.txt', content: 'optional' }],
      };

      const result = await gracefulDegradation.executeWithDegradation([
        criticalHandler,
        optionalHandler,
      ]);
      
      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(2);
    });

    it('should succeed overall when optional handler fails', async () => {
      const criticalHandler: ComponentHandler = {
        name: 'critical',
        critical: true,
        execute: () => [{ path: 'critical.txt', content: 'critical' }],
      };

      const failingOptional: ComponentHandler = {
        name: 'optional',
        critical: false,
        execute: () => {
          throw new Error('Optional failure');
        },
      };

      const result = await gracefulDegradation.executeWithDegradation([
        criticalHandler,
        failingOptional,
      ]);
      
      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.generatedFiles).toHaveLength(1);
      expect(result.failedComponents).toContain('optional');
    });
  });

  describe('Feature Flag Integration', () => {
    it('should respect feature flag configuration', () => {
      expect(featureFlags.isEnabled(FLAG_NAMES.TYPESCRIPT_GENERATION)).toBe(true);
      expect(featureFlags.isEnabled(FLAG_NAMES.EXPERIMENTAL_GENERATORS)).toBe(false);
    });

    it('should validate feature flag dependencies', () => {
      const validation = featureFlags.validateDependencies();
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should handle invalid feature flag dependencies', () => {
      // Add a flag with invalid dependency
      featureFlags.registerFlag('test-flag', {
        enabled: true,
        description: 'Test flag',
        dependsOn: ['non-existent-flag'],
      });

      const validation = featureFlags.validateDependencies();
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Metrics Integration', () => {
    it('should track generation success', () => {
      metrics.incrementCounter('sdk_generation_success_total');
      expect(metrics.getCounter('sdk_generation_success_total')).toBe(1);
    });

    it('should track generation failure', () => {
      metrics.incrementCounter('sdk_generation_failure_total');
      expect(metrics.getCounter('sdk_generation_failure_total')).toBe(1);
    });

    it('should record histogram values', () => {
      metrics.recordHistogram('sdk_generation_duration_seconds', 2.5);
      const stats = metrics.getHistogramStats('sdk_generation_duration_seconds');
      expect(stats.count).toBe(1);
      expect(stats.avg).toBe(2.5);
    });

    it('should generate metrics summary', () => {
      metrics.incrementCounter('test_counter', 5);
      metrics.recordHistogram('test_histogram', 1.5);
      
      const summary = metrics.getSummary();
      expect(summary).toContain('test_counter');
      expect(summary).toContain('test_histogram');
    });
  });

  describe('Predefined Fallbacks', () => {
    it('should provide parity matrix fallback', () => {
      const fallbackFiles = fallbacks.parityMatrix();
      expect(fallbackFiles).toHaveLength(1);
      expect(fallbackFiles[0].path).toBe('docs/sdk/parity-matrix.md');
      expect(fallbackFiles[0].content).toContain('degraded mode');
    });

    it('should provide API surface fallback', () => {
      const fallbackFiles = fallbacks.apiSurface('1.0.0');
      expect(fallbackFiles).toHaveLength(1);
      expect(fallbackFiles[0].path).toBe('packages/client/api-surface.json');
      expect(fallbackFiles[0].content).toContain('degraded');
    });

    it('should provide minimal models fallback', () => {
      const fallbackFiles = fallbacks.minimalModels();
      expect(fallbackFiles).toHaveLength(1);
      expect(fallbackFiles[0].path).toBe('packages/client/src/generated/models.ts');
      expect(fallbackFiles[0].content).toContain('degraded mode');
    });
  });

  describe('End-to-End Chaos Scenarios', () => {
    it('should handle multiple component failures', async () => {
      const handlers: ComponentHandler[] = [
        {
          name: 'critical-1',
          critical: true,
          execute: () => [{ path: 'critical-1.txt', content: 'success' }],
        },
        {
          name: 'optional-1',
          critical: false,
          execute: () => {
            throw new Error('Optional 1 failed');
          },
          fallback: () => [{ path: 'fallback-1.txt', content: 'fallback' }],
        },
        {
          name: 'optional-2',
          critical: false,
          execute: () => {
            throw new Error('Optional 2 failed');
          },
        },
        {
          name: 'critical-2',
          critical: true,
          execute: () => [{ path: 'critical-2.txt', content: 'success' }],
        },
      ];

      const result = await gracefulDegradation.executeWithDegradation(handlers);
      
      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.generatedFiles).toHaveLength(3); // 2 critical + 1 fallback
      expect(result.failedComponents).toHaveLength(1); // Only optional-2
      expect(result.fallbacksActivated).toHaveLength(1);
    });

    it('should recover from transient failures', async () => {
      let attemptCount = 0;
      const flakyHandler: ComponentHandler = {
        name: 'flaky',
        critical: true,
        execute: () => {
          attemptCount++;
          if (attemptCount <= 2) {
            throw new Error('Transient failure');
          }
          return [{ path: 'flaky.txt', content: 'recovered' }];
        },
      };

      const config = { maxRetries: 5, retryDelay: 10 };
      gracefulDegradation.configure(config);

      const result = await gracefulDegradation.executeWithDegradation([flakyHandler]);
      
      expect(result.success).toBe(true);
      expect(result.generatedFiles).toHaveLength(1);
      expect(attemptCount).toBe(3);
    });
  });
});
