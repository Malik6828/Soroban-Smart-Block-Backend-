# Runbook: Health Probe Endpoints

**Issue**: #918  
**Endpoints**: `/healthz`, `/livez`, `/readyz`, `/health`

---

## Overview

This runbook covers operating, debugging, and recovering the health probe system
introduced in #918. The probe split separates **liveness** (process alive?) from
**readiness** (traffic safe?), eliminating restart loops caused by transient
dependency blips.

---

## Normal Operation

### Verify all probes respond correctly

```bash
# Liveness — should return 200 + {"status":"alive",...}
curl -s http://localhost:3000/healthz | jq .

# Alternative liveness alias
curl -s http://localhost:3000/livez | jq .

# Readiness — should return 200 + {"status":"ready",...}
curl -s http://localhost:3000/readyz | jq .

# Full dependency health (reads in-memory state, no live probes)
curl -s http://localhost:3000/health | jq .

# Detailed live-probe health (hits DB + RPC — use sparingly)
curl -s http://localhost:3000/health/detailed | jq .
```

### Check probe metrics

```bash
# Check healthz probe request count and duration
curl -s http://localhost:3000/metrics | grep health_probe

# Expected output:
# health_probe_requests_total{endpoint="/healthz",status_code="200"} 42
# health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.001"} 41
# health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.01"} 42
```

---

## Incident Scenarios

### Scenario 1: Container marked unhealthy but process is running

**Symptom**: `docker inspect <container>` shows `"Health":{"Status":"unhealthy"}`.
The container may restart.

**Diagnosis**:
```bash
# Check what the current healthcheck command is
docker inspect <container> | jq '.[0].Config.Healthcheck'

# If it shows /health instead of /healthz, the image is pre-#918
# Check the image label
docker inspect <container> | jq '.[0].Image'

# Manually run the healthcheck to see why it fails
docker exec <container> wget --no-verbose --tries=1 --spider http://localhost:3000/healthz

# Check recent health probe logs
docker inspect --format='{{json .State.Health}}' <container> | jq .
```

**Resolution**:
1. If running an old image: rebuild and redeploy with the new Dockerfile.
2. If the process is shutting down legitimately: `503` is correct behavior; wait for
   the replacement container to start.
3. If `/healthz` itself returns `503` unexpectedly, check the app logs for shutdown
   signal delivery:
   ```bash
   docker logs <container> --tail 50
   ```

---

### Scenario 2: Container healthy but receiving traffic it cannot serve

**Symptom**: API returns 5xx for DB-dependent endpoints, but container is `healthy`.

**Explanation**: By design, `/healthz` is process-only and will return `200` even if
the database is unreachable. This is correct liveness behavior — the process should
not be restarted due to a DB outage.

**Check readiness** (this is what load-balancers and k8s readiness probes use):
```bash
curl -s http://localhost:3000/readyz | jq .
# If not_ready, check .blockers for the failing dependency
```

**Check detailed live health** (actual DB + RPC ping):
```bash
curl -s http://localhost:3000/health/detailed | jq .dependencies
```

**In k8s**: The `readinessProbe` on `/readyz` will already have removed the pod from
the load-balancer rotation. Check pod readiness:
```bash
kubectl get pods
kubectl describe pod <pod-name>
```

**In Docker Compose**: The indexer `depends_on: api-testnet: condition: service_healthy`
uses the healthcheck on `api-testnet`, which is now `/healthz`. If you need readiness
ordering based on DB availability, add a separate readiness check:
```bash
# Wait for the API to be ready (DB + all deps)
until curl -sf http://localhost:3000/readyz; do sleep 2; done
```

---

### Scenario 3: `/readyz` returns 503 unexpectedly

**Symptom**: `curl -s http://localhost:3000/readyz` returns `503`.

**Diagnosis**:
```bash
# Check which dependencies are blocking
curl -s http://localhost:3000/readyz | jq '{status,blockers}'

# Common blockers:
#   "db"       — DB connection not yet established (startup) or DB unreachable
#   "cache"    — Redis not connected (will auto-recover when Redis comes back)
#   "rpc"      — Stellar RPC not reachable
#   "indexer"  — Indexer suffered a fatal failure (see /health/detailed)
#   "fee_aggregation_stale" — Fee aggregation job hasn't run recently
#   "gas_analytics_stale"   — Gas analytics job hasn't run recently

# Check detailed health for root cause
curl -s http://localhost:3000/health/detailed | jq .dependencies
```

**Recovery**:
- `db` blocker: ensure PostgreSQL is running and the `DATABASE_URL` is correct.
  The readiness state auto-recovers once `markReady('db')` is called after a
  successful DB check.
- `cache` blocker: ensure Redis is running. Cache falls back to in-memory — the API
  continues serving requests but rate limiting may be less accurate.
- `fee_aggregation_stale` / `gas_analytics_stale`: the scheduled jobs may be stuck.
  Check `cron_job_runs_total{job="feeAggregation"}` in Prometheus and look for
  consecutive failures in logs.

---

### Scenario 4: `/healthz` latency is high (> 10ms p99)

**Symptom**: `health_probe_duration_seconds_bucket{endpoint="/healthz",le="0.01"}` shows
the p99 crossing the 10ms budget. CI benchmark `tests/healthz-benchmark.test.ts` fails.

**Cause**: `/healthz` should only run `getLivenessStatus()` which reads `Date.now()` and
`process.uptime()`. High latency indicates:
- Event loop blockage by another request handler
- V8 GC pause (check `nodejs_gc_duration_seconds_sum` in `/metrics`)
- CPU starvation (container resource limits too tight)

**Diagnosis**:
```bash
# Check event loop lag
curl -s http://localhost:3000/metrics | grep nodejs_eventloop_lag

# Check GC pressure
curl -s http://localhost:3000/metrics | grep nodejs_gc

# Check CPU usage
docker stats <container> --no-stream
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PROBE_DEPENDENCIES` | `true` | When `false`, `/readyz` relies solely on in-memory readiness state without active probing. `/healthz` is always I/O-free regardless of this flag. |
| `HEALTHZ_LATENCY_P99_BUDGET_MS` | `10` | p99 latency ceiling (ms) enforced by the `/healthz` benchmark CI test. |

---

## Feature Flag: `HEALTH_PROBE_DEPENDENCIES`

**Default**: `true` (enabled)

When set to `false`:
- `/readyz` reads the in-memory `readiness.ts` state but does not perform active
  dependency probing in the probe path.
- This is the correct setting for deployments where readiness state is managed
  externally (e.g., k8s init containers that mark deps ready after they pass
  independent health checks).
- `/healthz` is always process-only and is unaffected by this flag.

```bash
# Disable active dependency probing in /readyz
HEALTH_PROBE_DEPENDENCIES=false

# Example: local dev where DB availability is managed separately
docker compose up --env-file .env.local
```

---

## SLO Targets

| Probe | Availability SLO | Latency SLO (p99) |
|-------|-----------------|-------------------|
| `/healthz` | 99.9% | < 10ms |
| `/readyz` | 99.5% | < 50ms |
| `/health` | 99.0% | < 200ms |

Dashboards: query `health_probe_requests_total` and `health_probe_duration_seconds`
from Prometheus/Grafana.

Error budget alert (Prometheus example):
```yaml
- alert: HealthzProbeLatencyHigh
  expr: histogram_quantile(0.99, rate(health_probe_duration_seconds_bucket{endpoint="/healthz"}[5m])) > 0.01
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "/healthz p99 latency exceeds 10ms budget"
```
