/**
 * Load tests for SDK generation pipeline.
 * Tests system behavior under sustained high load and concurrent operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateAll } from '../scripts/sdk/generate';
import { gracefulDegradation } from '../scripts/sdk/graceful-degradation';
import { metrics } from '../scripts/sdk/sdk-metrics';
import { featureFlags } from '../scripts/sdk/feature-flags';

// Mock OpenAPI document for load testing
const mockOpenAPIDoc = {
  openapi: '3.0.0',
  info: {
    title: 'Test API',
    version: '1.0.0',
  },
  paths: {
    '/test': {
      get: {
        operationId: 'getTest',
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      TestModel: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
};

describe('SDK Generation Load Tests', () => {
  beforeAll(() => {
    // Reset state before load tests
    metrics.reset();
    gracefulDegradation.resetCircuitBreaker();
    gracefulDegradation.configure({
      maxRetries: 2,
      retryDelay: 100,
      circuitBreakerThreshold: 10,
      circuitBreakerTimeout: 30000,
    });
  });

  afterAll(() => {
    // Clean up after load tests
    metrics.reset();
    gracefulDegradation.resetCircuitBreaker();
  });

  describe('Sustained Load Tests', () => {
    it('should handle 100 consecutive generations without errors', () => {
      const iterations = 100;
      const errors: Error[] = [];
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        try {
          generateAll(mockOpenAPIDoc);
        } catch (error) {
          errors.push(error as Error);
        }
      }

      const duration = Date.now() - startTime;
      const avgLatency = duration / iterations;

      expect(errors.length).toBe(0);
      expect(avgLatency).toBeLessThan(100); // Average latency should be < 100ms
      expect(duration).toBeLessThan(10000); // Total should complete in < 10s
    });

    it('should handle 500 consecutive generations with acceptable performance', () => {
      const iterations = 500;
      const errors: Error[] = [];
      const latencies: number[] = [];
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const iterStart = Date.now();
        try {
          generateAll(mockOpenAPIDoc);
          latencies.push(Date.now() - iterStart);
        } catch (error) {
          errors.push(error as Error);
        }
      }

      const duration = Date.now() - startTime;
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

      expect(errors.length).toBe(0);
      expect(avgLatency).toBeLessThan(100);
      expect(p95Latency).toBeLessThan(200); // P95 latency should be < 200ms
      expect(duration).toBeLessThan(60000); // Total should complete in < 60s
    });

    it('should maintain metrics accuracy under load', () => {
      const iterations = 200;
      metrics.reset();

      for (let i = 0; i < iterations; i++) {
        generateAll(mockOpenAPIDoc);
        metrics.incrementCounter('test_counter');
        metrics.recordHistogram('test_latency', Math.random() * 50);
      }

      const counterValue = metrics.getCounter('test_counter');
      const histogramStats = metrics.getHistogramStats('test_latency');

      expect(counterValue).toBe(iterations);
      expect(histogramStats.count).toBe(iterations);
      expect(histogramStats.avg).toBeGreaterThan(0);
    });
  });

  describe('Memory Leak Detection', () => {
    it('should not leak memory across many generations', () => {
      const iterations = 1000;
      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < iterations; i++) {
        generateAll(mockOpenAPIDoc);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      const memoryIncreasePerIteration = memoryIncrease / iterations;

      // Memory increase should be minimal (< 1KB per iteration)
      expect(memoryIncreasePerIteration).toBeLessThan(1024);
    });

    it('should handle metrics memory growth under load', () => {
      const iterations = 10000;
      metrics.reset();

      for (let i = 0; i < iterations; i++) {
        metrics.incrementCounter(`counter_${i % 100}`); // Rotate through 100 different counters
        metrics.recordHistogram(`histogram_${i % 50}`, Math.random() * 100);
      }

      const summary = metrics.getSummary();
      expect(summary.length).toBeGreaterThan(0);
      
      // Memory should still be reasonable
      const memoryUsage = process.memoryUsage().heapUsed;
      expect(memoryUsage).toBeLessThan(500 * 1024 * 1024); // < 500MB
    });
  });

  describe('Concurrent Load Tests', () => {
    it('should handle concurrent generation requests', async () => {
      const concurrency = 10;
      const requestsPerWorker = 20;
      const totalRequests = concurrency * requestsPerWorker;
      const errors: Error[] = [];
      const startTime = Date.now();

      const workers = Array.from({ length: concurrency }, async () => {
        const workerErrors: Error[] = [];
        for (let i = 0; i < requestsPerWorker; i++) {
          try {
            generateAll(mockOpenAPIDoc);
          } catch (error) {
            workerErrors.push(error as Error);
          }
        }
        return workerErrors;
      });

      const results = await Promise.all(workers);
      results.forEach(workerErrors => errors.push(...workerErrors));

      const duration = Date.now() - startTime;
      const throughput = totalRequests / (duration / 1000); // requests per second

      expect(errors.length).toBe(0);
      expect(throughput).toBeGreaterThan(10); // Should handle > 10 req/sec
      expect(duration).toBeLessThan(30000); // Should complete in < 30s
    });

    it('should handle burst traffic patterns', async () => {
      const burstSize = 50;
      const burstCount = 5;
      const burstInterval = 100; // ms between bursts
      const errors: Error[] = [];

      for (let burst = 0; burst < burstCount; burst++) {
        const burstPromises = Array.from({ length: burstSize }, () => {
          return new Promise<void>((resolve) => {
            try {
              generateAll(mockOpenAPIDoc);
              resolve();
            } catch (error) {
              errors.push(error as Error);
              resolve();
            }
          });
        });

        await Promise.all(burstPromises);
        
        if (burst < burstCount - 1) {
          await new Promise(resolve => setTimeout(resolve, burstInterval));
        }
      }

      expect(errors.length).toBe(0);
    });
  });

  describe('Resource Exhaustion Tests', () => {
    it('should handle large numbers of feature flag checks', () => {
      const iterations = 10000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        featureFlags.isEnabled('typescript-generation');
        featureFlags.isEnabled('python-generation');
        featureFlags.isEnabled('experimental-generators');
      }

      const duration = Date.now() - startTime;
      const avgLatency = duration / (iterations * 3);

      expect(avgLatency).toBeLessThan(0.1); // Should be very fast (< 0.1ms per check)
    });

    it('should handle circuit breaker status checks under load', () => {
      const iterations = 10000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        gracefulDegradation.getCircuitBreakerStatus();
      }

      const duration = Date.now() - startTime;
      const avgLatency = duration / iterations;

      expect(avgLatency).toBeLessThan(1); // Should be fast (< 1ms per check)
    });
  });

  describe('Degradation Under Load', () => {
    it('should maintain graceful degradation under load', async () => {
      const iterations = 100;
      const failureRate = 0.1; // 10% failure rate
      let successCount = 0;
      let partialSuccessCount = 0;
      let failureCount = 0;

      for (let i = 0; i < iterations; i++) {
        try {
          generateAll(mockOpenAPIDoc);
          successCount++;
        } catch (error) {
          failureCount++;
        }
      }

      // Under normal conditions, should have high success rate
      const successRate = successCount / iterations;
      expect(successRate).toBeGreaterThan(0.95);
    });

    it('should handle feature flag changes during load', () => {
      const iterations = 1000;
      const errors: Error[] = [];

      for (let i = 0; i < iterations; i++) {
        // Toggle feature flags periodically
        if (i % 100 === 0) {
          const currentState = featureFlags.isEnabled('typescript-generation');
          featureFlags.registerFlag('typescript-generation', {
            enabled: !currentState,
            description: 'Test',
          });
        }

        try {
          generateAll(mockOpenAPIDoc);
        } catch (error) {
          errors.push(error as Error);
        }
      }

      // Should handle flag changes gracefully
      expect(errors.length).toBeLessThan(iterations * 0.1); // < 10% error rate
    });
  });

  describe('SLO Compliance Tests', () => {
    it('should meet P95 latency SLO under load', () => {
      const iterations = 500;
      const sloP95 = 5000; // 5 seconds SLO
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        generateAll(mockOpenAPIDoc);
        latencies.push(Date.now() - start);
      }

      const sortedLatencies = latencies.sort((a, b) => a - b);
      const p95 = sortedLatencies[Math.floor(iterations * 0.95)];

      expect(p95).toBeLessThan(sloP95);
    });

    it('should meet success rate SLO under load', () => {
      const iterations = 1000;
      const sloSuccessRate = 0.999; // 99.9% success rate
      const successCount = { value: 0 };

      for (let i = 0; i < iterations; i++) {
        try {
          generateAll(mockOpenAPIDoc);
          successCount.value++;
        } catch (error) {
          // Count as failure
        }
      }

      const actualSuccessRate = successCount.value / iterations;
      expect(actualSuccessRate).toBeGreaterThanOrEqual(sloSuccessRate);
    });
  });

  describe('Recovery Tests', () => {
    it('should recover from temporary overload', async () => {
      // Simulate overload with many concurrent requests
      const overloadRequests = 200;
      const normalRequests = 50;
      
      // Overload phase
      const overloadPromises = Array.from({ length: overloadRequests }, () => {
        return generateAll(mockOpenAPIDoc);
      });
      
      await Promise.all(overloadPromises);
      
      // Recovery phase - should still work normally
      const recoveryErrors: Error[] = [];
      for (let i = 0; i < normalRequests; i++) {
        try {
          generateAll(mockOpenAPIDoc);
        } catch (error) {
          recoveryErrors.push(error as Error);
        }
      }

      expect(recoveryErrors.length).toBe(0);
    });

    it('should reset circuit breakers after recovery period', async () => {
      const config = {
        maxRetries: 1,
        circuitBreakerThreshold: 3,
        circuitBreakerTimeout: 100, // Short timeout for testing
      };
      gracefulDegradation.configure(config);

      // Trigger circuit breaker
      const failingHandler = {
        name: 'test-handler',
        critical: false,
        execute: () => {
          throw new Error('Test failure');
        },
      };

      for (let i = 0; i < 5; i++) {
        await gracefulDegradation.executeWithDegradation([failingHandler]);
      }

      expect(gracefulDegradation.getCircuitBreakerStatus().get('test-handler')?.open).toBe(true);

      // Wait for recovery
      await new Promise(resolve => setTimeout(resolve, 150));

      // Circuit breaker should be reset
      expect(gracefulDegradation.getCircuitBreakerStatus().get('test-handler')).toBeUndefined();
    });
  });
});
