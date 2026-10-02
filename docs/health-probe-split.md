# Health Probe Split: `/healthz` Liveness + `/readyz` Readiness

**Issue**: #918  
**Status**: Implemented  
**Date**: 2026-09-30  
**Author**: Engineering

---

## Problem

The Dockerfile `HEALTHCHECK` and every Docker Compose service `healthcheck` were
pointing at `/health` — an endpoint that executes live DB round-trips on both
`prismaRead` and `prismaWrite`, measures replica lag, calls `getLatestLedger()` on
the Stellar RPC, and pings Redis — **every 10–30 seconds per container**.

### Consequences

| Problem | Impact |
|---------|--------|
| A transient DB or RPC blip marks the container `unhealthy` | Docker/Compose restarts a perfectly-healthy process, creating the outage it was designed to prevent |
| Every API/indexer container adds constant probe load | Amplified N-times in multi-container deployments against the same RPC endpoint |
| Restart loops during dependency maintenance windows | Any planned DB failover or RPC rate-limit event caused rolling container restarts |

k8s already split this correctly (`/healthz` liveness vs `/readyz` readiness via
`livenessProbe` / `readinessProbe`). Docker and Compose did not, so this PR brings
parity.

---

## Design

### Probe Taxonomy

| Endpoint | Question answered | I/O? | Used by |
|----------|------------------|------|---------|
| `GET /healthz` | Is this *process* alive? Should the container runtime restart it? | **None** | Docker `HEALTHCHECK`, Compose `healthcheck`, k8s `livenessProbe` |
| `GET /livez` | Is this process alive? (instrumented alias) | None | k8s `livenessProbe`, monitoring dashboards |
| `GET /readyz` | Can this process safely receive traffic? | In-memory readiness state (no active probing) | k8s `readinessProbe`, load-balancer health check, Compose `depends_on: service_healthy` |
| `GET /health` | Full dependency status (human-readable) | Reads in-memory readiness state (no active I/O by default) | Operators, dashboards, manual debugging |
| `GET /health/detailed` | Live dependency probe (DB + RPC + cache) | Yes — live probes | Operators during incident response |

### `/healthz` Contract

- Returns `200 OK` + `{"status":"alive","timestamp":"...","uptime":<seconds>}` when the
  process event loop is responsive.
- Returns `503 Service Unavailable` + `{"status":"dead","reason":"shutting_down"}` when
  graceful shutdown has begun.
- **No external I/O is performed**. The implementation calls only `getLivenessStatus()`,
  which reads `process.uptime()` and `Date.now()`.
- Latency budget: p99 < 10ms (enforced by `tests/healthz-benchmark.test.ts`).

### `/readyz` Contract

- Returns `200 OK` when all dependencies in `readiness.ts` are marked ready **and**
  analytics aggregation jobs are not stale.
- Returns `503 Service Unavailable` with a `blockers` array naming every failing
  dependency.
- The readiness state is updated by `markReady()` / `markNotReady()` calls during
  startup and background health probes — **not** by inline DB queries on every probe.
- Controlled by `HEALTH_PROBE_DEPENDENCIES` flag (default `true`). When set to `false`,
  `/readyz` still reads the in-memory readiness state but does not perform any active
  dependency probing (future extension point).

### Metrics

Both endpoints emit:

| Metric | Type | Labels |
|--------|------|--------|
| `health_probe_requests_total` | Counter | `endpoint`, `status_code` |
| `health_probe_duration_seconds` | Histogram | `endpoint` |

OTel mirrors: `health.probe.requests` (Counter), `health.probe.duration` (Histogram).

These feed SLO dashboards and alert on probe error budget burn.

---

## Alternatives Rejected

### Alternative 1: Add a `/ping` endpoint that returns `200 OK` immediately

Rejected because it bypasses the shutdown signal entirely — a process that received
`SIGTERM` and is draining connections would still respond `200`, preventing the
container runtime from waiting for graceful shutdown to complete before replacing the
container.

### Alternative 2: Change `/health` to be process-only

Rejected because `/health` is used by human operators and monitoring dashboards that
expect the full dependency breakdown. Changing its semantics would be a breaking
change for every existing integration.

### Alternative 3: Conditional I/O via query param (`?probe=liveness`)

Rejected because Docker `HEALTHCHECK` and Compose `healthcheck` cannot set query
parameters in `wget` without a shell wrapper, and the single-endpoint approach violates
the principle of least surprise.

---

## Rollback Plan

If this change introduces unexpected behavior:

1. Revert `Dockerfile` HEALTHCHECK to `/health`:  
   `HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1`

2. Revert `docker-compose.yml` healthchecks from `/healthz` to `/health` on all
   API/indexer services.

3. The `/healthz` endpoint itself is purely additive — it can remain registered in
   `app.ts` without causing any issue. Only the Docker/Compose probe pointers need
   reverting.

Rollback does **not** require a code change to `src/` — only config/infra files.

---

## Data Model

No database schema changes. No new dependencies introduced.

---

## Security

- `/healthz` is unauthenticated by design (same as `/health`, `/livez`, `/readyz`).  
  Health endpoints intentionally do not expose secrets or internal state that could
  assist an attacker.
- The response body contains only: `status` (enum), `timestamp` (ISO-8601), `uptime`
  (integer seconds). No IP addresses, user data, or configuration values are leaked.
- The endpoint is excluded from the rate-limit middleware (same exemption as `/livez`
  and `/readyz`) to prevent the probe from triggering its own rate-limit.

---

## Cost Analysis

| Before | After | Delta |
|--------|-------|-------|
| `/health` probe every 10s per container: 2× `SELECT 1` (read + write), 1× replica lag query, 1× `getLatestLedger()` RPC call, 1× Redis `PING` | `/healthz` probe every 10s per container: 0 DB queries, 0 RPC calls | **−5 DB/RPC calls per container per 10s** |
| 3 API containers + 2 indexer containers = 5 containers × 5 ops/probe = **25 ops/10s = 150 ops/min** | 0 ops/min from liveness probes | **−150 DB+RPC ops/min** |

In a 10-node Compose cluster: ~1500 unnecessary DB+RPC ops/min eliminated.
