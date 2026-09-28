/**
 * OpenTelemetry metrics for SDK generation pipeline.
 * Tracks generation performance, errors, and SLO compliance.
 */

// Simple in-memory metrics for now (OpenTelemetry SDK would be added for production)
interface MetricCounter {
  name: string;
  value: number;
  labels: Record<string, string>;
}

interface MetricHistogram {
  name: string;
  values: number[];
  labels: Record<string, string>;
}

class SDKMetrics {
  private counters: Map<string, MetricCounter[]> = new Map();
  private histograms: Map<string, MetricHistogram[]> = new Map();

  incrementCounter(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    const existing = this.counters.get(key) || [];
    const counter = existing.find(c => c.name === name);
    
    if (counter) {
      counter.value += value;
    } else {
      existing.push({ name, value, labels });
    }
    
    this.counters.set(key, existing);
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    const existing = this.histograms.get(key) || [];
    const histogram = existing.find(h => h.name === name);
    
    if (histogram) {
      histogram.values.push(value);
    } else {
      existing.push({ name, values: [value], labels });
    }
    
    this.histograms.set(key, existing);
  }

  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = this.getMetricKey(name, labels);
    const counters = this.counters.get(key) || [];
    const counter = counters.find(c => c.name === name);
    return counter?.value || 0;
  }

  getHistogramStats(name: string, labels: Record<string, string> = {}): { count: number; min: number; max: number; avg: number } {
    const key = this.getMetricKey(name, labels);
    const histograms = this.histograms.get(key) || [];
    const histogram = histograms.find(h => h.name === name);
    
    if (!histogram || histogram.values.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0 };
    }
    
    const values = histogram.values;
    return {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }

  private getMetricKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}:${labelStr}`;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  getSummary(): string {
    const summary: string[] = [];
    
    for (const [key, counters] of this.counters) {
      for (const counter of counters) {
        const labels = Object.entries(counter.labels).map(([k, v]) => `${k}="${v}"`).join(' ');
        summary.push(`${counter.name}{${labels}} ${counter.value}`);
      }
    }
    
    for (const [key, histograms] of this.histograms) {
      for (const histogram of histograms) {
        const stats = this.getHistogramStats(histogram.name, histogram.labels);
        const labels = Object.entries(histogram.labels).map(([k, v]) => `${k}="${v}"`).join(' ');
        summary.push(`${histogram.name}{${labels}} count=${stats.count} min=${stats.min} max=${stats.max} avg=${stats.avg.toFixed(2)}`);
      }
    }
    
    return summary.join('\n');
  }
}

// Singleton instance
export const metrics = new SDKMetrics();

// Metric names as constants
export const METRIC_NAMES = {
  GENERATION_SUCCESS: 'sdk_generation_success_total',
  GENERATION_FAILURE: 'sdk_generation_failure_total',
  GENERATION_DURATION: 'sdk_generation_duration_seconds',
  FILES_GENERATED: 'sdk_files_generated_total',
  FILES_WRITTEN: 'sdk_files_written_total',
  DRIFT_DETECTED: 'sdk_drift_detected_total',
  BREAKING_CHANGES: 'sdk_breaking_changes_total',
  ADDITIVE_CHANGES: 'sdk_additive_changes_total',
  OPERATIONS_GENERATED: 'sdk_operations_generated_total',
  MODELS_GENERATED: 'sdk_models_generated_total',
} as const;
