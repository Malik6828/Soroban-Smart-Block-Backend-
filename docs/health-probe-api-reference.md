# API Reference: Health Probe Endpoints

**Issue**: #918  
**Base URL**: `http://localhost:3000` (or your configured `PORT`)

---

## `GET /healthz`

**Purpose**: Cheap Docker/Compose liveness probe. Answers: *should the container
runtime restart this process?*

**I/O**: None. Process-only. Safe to call at any frequency.

### Response: 200 OK (process alive)

```json
{
  "status": "alive",
  "timestamp": "2026-09-30T08:28:00.481Z",
  "uptime": 3742
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"alive"` | Always `"alive"` when the process is running |
| `timestamp` | ISO-8601 string | Current time in UTC |
| `uptime` | integer (seconds) | Process uptime since start |

### Response: 503 Service Unavailable (shutting down)

```json
{
  "status": "dead",
  "reason": "shutting_down",
  "timestamp": "2026-09-30T08:30:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"dead"` | Process is draining, container may be replaced |
| `reason` | `"shutting_down"` | Graceful shutdown in progress |
| `timestamp` | ISO-8601 string | Current time in UTC |

---

## `GET /livez`

**Purpose**: Instrumented liveness alias. Same semantics as `/healthz`, emits
identical probe metrics with `endpoint="/livez"` label.

**I/O**: None.

### Response: 200 OK

```json
{
  "status": "alive",
  "timestamp": "2026-09-30T08:28:00.481Z",
  "uptime": 3742
}
```

### Response: 503 Service Unavailable (shutting down)

```json
{
  "status": "dead",
  "reason": "shutting_down"
}
```

---

## `GET /readyz`

**Purpose**: Readiness probe. Answers: *can this process safely receive traffic?*
Returns 200 only when all declared dependencies are ready and analytics jobs are
not stale.

**I/O**: Reads in-memory readiness state only (no active DB/RPC probing in the
probe path). State is updated by background startup and health checks.

### Response: 200 OK (ready)

```json
{
  "status": "ready",
  "timestamp": "2026-09-30T08:28:00.481Z",
  "dependencies": {
    "db": true,
    "cache": true,
    "rpc": true,
    "indexer": true,
    "coldStorage": true,
    "p2p": true,
    "worker": true
  },
  "analytics": {
    "feeAggregation": { "stale": false, "ageSeconds": 47 },
    "gasAnalytics": { "stale": false, "ageSeconds": 23 }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ready"` | Service can receive traffic |
| `timestamp` | ISO-8601 string | Current time in UTC |
| `dependencies` | object | Per-dependency readiness (all must be `true`) |
| `analytics.feeAggregation` | object | Fee aggregation job staleness |
| `analytics.gasAnalytics` | object | Gas analytics job staleness |

### Response: 503 Service Unavailable (not ready)

```json
{
  "status": "not_ready",
  "timestamp": "2026-09-30T08:28:00.481Z",
  "dependencies": {
    "db": false,
    "cache": true,
    "rpc": true,
    "indexer": true,
    "coldStorage": true,
    "p2p": true,
    "worker": true
  },
  "blockers": ["db"],
  "analytics": {
    "feeAggregation": { "stale": false, "ageSeconds": 12 },
    "gasAnalytics": { "stale": false, "ageSeconds": 8 }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"not_ready"` | Service should not receive traffic yet |
| `blockers` | string[] | Names of dependencies that are not ready |

### Response: 503 Service Unavailable (shutting down)

```json
{
  "status": "not_ready",
  "reason": "shutting_down"
}
```

---

## `GET /health`

**Purpose**: Full health status for operators and monitoring dashboards. Reads
in-memory readiness state (no active I/O by default).

See existing documentation — this endpoint is unchanged by #918.

---

## `GET /health/detailed`

**Purpose**: Performs live probes against DB, RPC, and cache. Use for incident
investigation, not for automated probing.

See existing documentation — this endpoint is unchanged by #918.

---

## Probe Metrics

All three endpoints (`/healthz`, `/livez`, `/readyz`) emit Prometheus metrics:

```
# HELP health_probe_requests_total Total number of health probe requests by endpoint and status
# TYPE health_probe_requests_total counter
health_probe_requests_total{endpoint="/healthz",status_code="200"} 1450
health_probe_requests_total{endpoint="/readyz",status_code="200"} 1450
health_probe_requests_total{endpoint="/livez",status_code="200"} 12

# HELP health_probe_duration_seconds Duration of health probe responses in seconds by endpoint
# TYPE health_probe_duration_seconds histogram
health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.0001"} 143
health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.001"} 1449
health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.01"} 1450
```

OTel metrics (for OTLP exporters):
- `health.probe.requests` (Counter) — labels: `endpoint`, `status_code`
- `health.probe.duration` (Histogram, unit: `s`) — labels: `endpoint`

---

## Docker Compose Integration

### Liveness check (container-level, default profile)

```yaml
healthcheck:
  test: ['CMD-SHELL', 'wget -qO- http://localhost:${PORT:-3000}/healthz || exit 1']
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

### Readiness gate for `depends_on`

Use `/readyz` for services that need to wait until dependencies (DB, cache, RPC)
are confirmed ready before accepting traffic:

```yaml
depends_on:
  api-testnet:
    condition: service_healthy
```

The `service_healthy` condition maps to the `healthcheck` result, which uses
`/healthz`. For a true readiness gate (DB + all deps ready), use an init container
that polls `/readyz`:

```yaml
wait-for-ready:
  image: curlimages/curl:8.9.1
  command: >
    sh -c 'until curl -sf http://api-testnet:3000/readyz; do sleep 2; done'
  depends_on:
    api-testnet:
      condition: service_started
```

---

## k8s Integration

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 30
  timeoutSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```
