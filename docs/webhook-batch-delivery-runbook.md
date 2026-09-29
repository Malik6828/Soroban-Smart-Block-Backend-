# Webhook Batch Delivery Runbook

## Service Contract

Batch subscriptions are opt-in. Defaults remain `immediate`, with a batch size
of 100 and a collection window of 50 ms. Batch size is bounded to 2-500 events,
serialized body size to 1 MB, collection window to 0-60,000 ms, and queued
events to 50,000 per subscription. Events are ordered per contract by ledger
sequence, transaction hash, and event ID. Delivery is at-least-once; consumers
must deduplicate requests using the stable `Idempotency-Key` header.

## SLOs And Error Budget

- Batch delivery-attempt success: at least 99.9% over a rolling 30-day window.
- Event-to-client latency: p99 below 100 ms, measured from ledger close to a
  successful destination response. Destination latency and indexer lag are
  included; this is a target and must be verified under representative load.
- Error budget: 0.1% failed attempts over 30 days. Prometheus alerts on a
  14.4x fast burn; Grafana shows success ratio, remaining budget, p99 latency,
  batch size, outcomes, and outbox depth.

The Prometheus metrics are `webhook_batch_operations_total`,
`webhook_event_to_delivery_seconds`, `webhook_delivery_duration_seconds`,
`webhook_batch_events`, and `webhook_outbox_events`. The OpenTelemetry SDK
exports the matching instruments to `$OTLP_ENDPOINT/v1/metrics`; traces use
`$OTLP_ENDPOINT/v1/traces`.

## Deploy And Enable

1. Back up PostgreSQL and deploy the additive schema with `npm run prisma:deploy`.
2. Confirm `_webhook_outbox_events` exists and the application is healthy.
3. Configure Prometheus to scrape the application `/metrics` endpoint and load
   `prometheus/alerts.yml` as alert rules.
4. Import `grafana/dashboards/webhook-batch-delivery.json` into Grafana using
   the Prometheus data source. The current Compose stack does not automate
   these Prometheus/Grafana steps.
5. Enable the flag through the admin feature-flag API:

   ```http
   PUT /api/v1/admin/feature-flags/webhookBatchDelivery
   Content-Type: application/json

   {"defaultEnabled": true}
   ```

   This API requires an admin role. Confirm `available: true` and `enabled:
   true` from `GET /api/v1/admin/feature-flags` before creating a batch
   subscription.
6. Create a batch subscription with `deliveryStrategy: "batch"`. Start with a
   low batch size and short window; change values only with the dashboard open.
7. Call `GET /webhooks/:id/preview` and confirm `rawBody` contains `batchId`,
   `idempotencyKey`, `events`, and `attempt`; verify its signature using the
   subscription secret. Trigger matching indexed events and confirm delivery
   history reports the same idempotency key.

For contributor verification, `npm run test:ci` applies pending migrations,
checks test-file and exclusion ratchets, runs the full suite and coverage
thresholds, and verifies the ABI coverage gate. The repository's full CI also
runs build/typecheck, lint, security audit, and Prometheus rule validation.

## Run And Diagnose

- Inspect the dashboard and alerts before increasing batch size or window.
- `webhook_outbox_events` above 40,000 is critical. Inspect destination health,
  subscription activity, and retry times before the 50,000 per-subscription
  ceiling is reached.
- `GET /webhooks/:id/deliveries` returns status, attempt, idempotency key,
  HTTP status, retry time, and error code. It intentionally excludes stored
  batch payloads.
- `SSRF_BLOCKED`: destination or redirect resolved to a prohibited address;
  update the URL and complete verification again. This is terminal.
- `HTTP_NON_2XX`: receiver returned a non-success status; the dispatcher
   retries indefinitely using capped exponential backoff. Correct the receiver
   or deactivate the subscription to stop retries.
- `NETWORK_ERROR`: request failed or timed out; inspect destination and
   network health. Retries retain batch membership and idempotency key and
   continue indefinitely until delivery or explicit cancellation.
- `PAYLOAD_TOO_LARGE`: a single event exceeded 1 MB; it is terminal and visible
  in delivery history. Reduce the decoded event size at source or use
  immediate delivery for that subscription.
- `WEBHOOK_OUTBOX_CAPACITY_EXCEEDED`: producer backpressure is active. The
  persisted event remains in the event table; resolve the slow destination and
  allow indexer retry before manually moving its checkpoint.
- `BATCH_QUEUE_NOT_DRAINED`: switching to immediate was rejected. Let existing
  batches succeed or reach terminal status, then retry the mode change.
- `IMMEDIATE_DELIVERIES_NOT_DRAINED`: switching from immediate to batch was
   rejected while immediate attempts remain pending; wait for them to settle.
- `FEATURE_DISABLED` or `SCHEMA_UNAVAILABLE`: confirm the migration and flag
   state before retrying batch subscription changes.

Partial collector failure does not block delivery. Prometheus metrics remain
available on `/metrics`; OTLP export failure is reported by the SDK and does
not alter the outbox state.

## Rollback And Recovery

1. Disable the flag with the admin API (`{"defaultEnabled": false}`). New batch
   subscriptions are rejected. Existing queued batches continue draining with
   their original membership and idempotency key.
2. Existing batch subscriptions fall back to immediate delivery when no older
   batch remains for the same contract. Do not switch a subscription to
   immediate while its queue is non-empty; the API returns 409.
3. Keep the migration applied. Rolling back application code before queued
   deliveries drain can strand batch payloads; do not drop outbox columns or
   tables as part of an emergency rollback.
4. If a process exits during delivery, the lease expires after 60 seconds and
   retry processing reclaims the persisted delivery. A receiver may see a
   duplicate when it accepted a request but the sender did not record the
   response; deduplicate by idempotency key.
5. For database recovery, restore from the normal PostgreSQL backup procedure.
   Event snapshots and delivery rows are retained for at least 90 days.

## Known Validation Gaps

The repository currently has no provisioned Prometheus/Grafana services, no
10x-peak 30-minute load runner, no 100,000-connection runner, and no arbitrary
checkpoint replay API. The SLO values above are goals, not measured guarantees.
These gaps must be closed before claiming the issue's full Definition of Done.