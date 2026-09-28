# SDK Generation Pipeline - SLOs and Error Budgets

## Overview

This document defines Service Level Objectives (SLOs) and error budgets for the SDK generation pipeline, ensuring production-grade reliability and performance.

## Service Level Indicators (SLIs)

### 1. Generation Success Rate
- **Metric**: `sdk_generation_success_total / (sdk_generation_success_total + sdk_generation_failure_total)`
- **Measurement**: Per CI run, aggregated over 30-day rolling window
- **Target**: 99.9% (allows 43.2 minutes of downtime/month)

### 2. Generation Latency
- **Metric**: `sdk_generation_duration_seconds` histogram
- **Measurement**: P95 latency per generation
- **Target**: < 5 seconds for full SDK generation

### 3. Drift Detection Rate
- **Metric**: `sdk_drift_detected_total` / total generation attempts
- **Measurement**: Per CI run
- **Target**: < 1% (drift should be caught in PRs, not main branch)

### 4. Breaking Change Detection Accuracy
- **Metric**: Correct classification of breaking vs additive changes
- **Measurement**: Manual audit of classification accuracy
- **Target**: 100% accuracy (no false negatives/positives)

## Service Level Objectives (SLOs)

| SLI | Objective | Error Budget | Measurement Window |
|-----|-----------|--------------|-------------------|
| Generation Success Rate | 99.9% | 0.1% (43.2 min/month) | 30-day rolling |
| Generation Latency (P95) | < 5s | N/A (latency target) | 30-day rolling |
| Drift Detection Rate | < 1% | 1% | 30-day rolling |
| Breaking Change Accuracy | 100% | 0% | Per release |

## Error Budget Calculation

### Monthly Error Budget
- **Total time**: 30 days × 24 hours × 60 minutes = 43,200 minutes
- **Error budget (0.1%)**: 43.2 minutes
- **Daily error budget**: 1.44 minutes
- **Per-run error budget**: 0.0016 minutes (0.096 seconds)

### Error Budget Burn Rate
- **Burn rate 1x**: Consuming error budget at expected rate
- **Burn rate 2x**: Consuming error budget twice as fast as expected
- **Burn rate 10x**: Consuming error budget 10x as fast (critical)

## Error Budget Policy

### When Error Budget is Healthy (> 50% remaining)
- Normal deployment cadence
- Standard monitoring and alerting
- Proactive performance improvements

### When Error Budget is Depleting (25-50% remaining)
- Reduced deployment frequency
- Enhanced monitoring and alerting
- Root cause analysis for recent failures
- Consider feature freeze for non-critical changes

### When Error Budget is Critical (< 25% remaining)
- **Stop all non-essential deployments**
- Increased monitoring frequency
- On-call escalation
- Post-mortem required for each incident
- Only critical bug fixes allowed

### When Error Budget is Exhausted (0% remaining)
- **Complete deployment freeze**
- Emergency incident response
- Full post-mortem and action plan
- Management approval required for any changes
- SLO reconsideration if targets are unrealistic

## Alerting Thresholds

### Critical Alerts (Page On-Call)
- Generation success rate < 99% for 5 minutes
- Generation latency P95 > 10s for 5 minutes
- Error budget burn rate > 5x for 10 minutes

### Warning Alerts (Email/Slack)
- Generation success rate < 99.5% for 15 minutes
- Generation latency P95 > 7s for 15 minutes
- Error budget burn rate > 2x for 30 minutes
- Drift detection rate > 0.5% for 1 hour

### Info Alerts (Dashboard Only)
- Generation latency P95 > 5s for 30 minutes
- Drift detection rate > 0.1% for 24 hours

## Dashboard Configuration

### Grafana Dashboard Panels

#### Panel 1: Generation Success Rate
- **Query**: `rate(sdk_generation_success_total[5m]) / (rate(sdk_generation_success_total[5m]) + rate(sdk_generation_failure_total[5m]))`
- **Type**: Gauge
- **Thresholds**: 
  - Green: ≥ 99.9%
  - Yellow: 99.5% - 99.9%
  - Red: < 99.5%

#### Panel 2: Generation Latency
- **Query**: `histogram_quantile(0.95, rate(sdk_generation_duration_seconds_bucket[5m]))`
- **Type**: Graph
- **Thresholds**:
  - Green: < 5s
  - Yellow: 5s - 10s
  - Red: > 10s

#### Panel 3: Error Budget Remaining
- **Query**: Calculated from success rate vs SLO
- **Type**: Stat
- **Thresholds**:
  - Green: > 50%
  - Yellow: 25% - 50%
  - Red: < 25%

#### Panel 4: Drift Detection Rate
- **Query**: `rate(sdk_drift_detected_total[1h]) / rate(sdk_generation_success_total[1h])`
- **Type**: Graph
- **Thresholds**:
  - Green: < 0.1%
  - Yellow: 0.1% - 0.5%
  - Red: > 0.5%

#### Panel 5: Files Generated per Run
- **Query**: `rate(sdk_files_generated_total[5m])`
- **Type**: Graph
- **Thresholds**: Monitor for anomalies

#### Panel 6: Breaking vs Additive Changes
- **Query**: Compare `sdk_breaking_changes_total` vs `sdk_additive_changes_total`
- **Type**: Graph
- **Thresholds**: Breaking changes should be rare

## Monitoring Implementation

### Prometheus Metrics Export

The SDK generation pipeline exports metrics in Prometheus format:

```typescript
// Export metrics for Prometheus scraping
export function getPrometheusMetrics(): string {
  const metrics: string[] = [];
  
  // Counters
  metrics.push(`# TYPE sdk_generation_success_total counter`);
  metrics.push(`# HELP sdk_generation_success_total Total successful SDK generations`);
  metrics.push(`sdk_generation_success_total ${metrics.getCounter(METRIC_NAMES.GENERATION_SUCCESS)}`);
  
  metrics.push(`# TYPE sdk_generation_failure_total counter`);
  metrics.push(`# HELP sdk_generation_failure_total Total failed SDK generations`);
  metrics.push(`sdk_generation_failure_total ${metrics.getCounter(METRIC_NAMES.GENERATION_FAILURE)}`);
  
  // Histograms would be exported as bucket format in production
  
  return metrics.join('\n');
}
```

### OpenTelemetry Integration

For production, integrate with OpenTelemetry:

```typescript
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

const meter = metrics.getMeter('sdk-generator');

const generationSuccess = meter.createCounter('sdk_generation_success_total');
const generationFailure = meter.createCounter('sdk_generation_failure_total');
const generationDuration = meter.createHistogram('sdk_generation_duration_seconds');
```

## Incident Response

### Severity Levels

**SEV1 (Critical)**
- SDK generation completely broken
- No SDKs can be generated
- Error budget burn rate > 10x
- Response time: 15 minutes

**SEV2 (High)**
- Generation success rate < 95%
- Performance degradation > 2x
- Error budget burn rate > 5x
- Response time: 30 minutes

**SEV3 (Medium)**
- Generation success rate < 99%
- Performance degradation > 1.5x
- Error budget burn rate > 2x
- Response time: 1 hour

**SEV4 (Low)**
- Minor performance issues
- Elevated drift detection rate
- Error budget burn rate > 1x
- Response time: 4 hours

### Post-Mortem Requirements

For any SEV1 or SEV2 incident:
1. Timeline of events
2. Root cause analysis
3. Impact assessment (error budget consumed)
4. Action items to prevent recurrence
5. Follow-up meeting scheduled
6. Documentation updated

## SLO Review Process

SLOs are reviewed quarterly:
- Assess achievability of current targets
- Review error budget consumption patterns
- Adjust targets based on business requirements
- Update alerting thresholds if needed
- Review and improve monitoring coverage

## Continuous Improvement

### Regular Actions
- Weekly: Review error budget consumption
- Monthly: Analyze patterns in failures
- Quarterly: SLO review and adjustment
- Annually: Full monitoring architecture review

### Improvement Metrics
- Mean Time To Detect (MTTD) issues
- Mean Time To Resolve (MTTR) incidents
- False positive rate on alerts
- Coverage of monitoring (SLIs vs services)
