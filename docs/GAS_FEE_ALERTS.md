# Gas Fee Alerts

## Current Phase

This phase evaluates API-key-owned threshold rules against completed hourly gas-fee snapshots. Rule creation and management are feature-flagged and rate-limited. A first snapshot establishes the baseline; subsequent above/below crossings create a durable event with previous/current stroop values and rising/falling trend context. Per-rule, per-bucket event keys prevent duplicate trigger records across retries. Events are listable through the API below and enqueued to verified, immediate `gas_fee_alert` webhook subscriptions owned by the same developer. Delivery uses the shared webhook worker, SSRF checks, signatures, bounded retry policy, and subscription/event idempotency keys. Batch webhook subscriptions are not supported for gas alert delivery in this phase.

## Data Model

`_gas_fee_alert_rules` stores the owning developer, explicit Stellar network, direction (`high` or `low`), threshold in integer stroops, cooldown, activation state, and evaluation state. `_gas_analytics_snapshots.fee_sum_stroops` stores the exact aggregate alongside existing presentation-oriented numeric averages. Evaluation divides the exact sum by transaction count using integer arithmetic. `_gas_fee_alert_events` stores durable crossing events, a unique rule/bucket idempotency key, and the outbox dispatch marker. Each `_webhook_deliveries` row references the durable gas event and carries a unique subscription/event idempotency key; the shared retry worker reconstructs the payload from the event record. PostgreSQL checks on rules enforce supported networks, direction, decimal threshold syntax, and bounded cooldown. The composite indexes support network evaluation and owner-scoped management.

The new table has no foreign key to API keys because developer identities are managed by the API-key subsystem, not by a relational user table. API operations always scope reads and writes by the authenticated `developerId`; client-supplied owner identifiers are not accepted.

## Design Trade-offs

Evaluation uses the existing completed hourly fee aggregate rather than alerting on each transaction. This keeps transient per-transaction spikes from firing a network-level threshold and reuses the existing indexed fee source, but it intentionally trades away real-time latency. Exact stroop sums are persisted separately because the existing snapshot's floating-point average is not suitable for threshold comparisons. The per-rule cursor records the last evaluated bucket; a first observation establishes a baseline, and only a subsequent threshold crossing fires.

The system guarantees a durable, deduplicated event record and at-least-once webhook attempts. A unique rule/bucket key prevents duplicate source events, and a unique subscription/event key plus the HTTP `Idempotency-Key` header lets receivers deduplicate retry-after-timeout cases. Exactly-once effects require receiver support and are not claimed. Per-developer ownership is derived from active API keys, and unverified, expired, revoked, or batch subscriptions are deliberately excluded.

## API

All paths are under `/api/v1/gas`, require a valid `X-Api-Key` header, and share a limit of 60 requests per IP per 15 minutes. They require the global `gasFeeAlerts` feature flag; evaluation also honors per-developer overrides.

### Create a rule

`POST /fee-alert-rules`

```json
{
  "network": "mainnet",
  "direction": "high",
  "thresholdStroops": "1000000",
  "cooldownSeconds": 900
}
```

`network` is `mainnet`, `testnet`, or `devnet`; `direction` is `high` or `low`. `thresholdStroops` must be a positive base-10 integer of at most 78 digits. `cooldownSeconds` is 1 through 604800 and defaults to 900. Success returns `201` with the persisted rule.

### List rules

`GET /fee-alert-rules?network=mainnet&limit=50`

Returns `{ "rules": [...], "count": n }`. `limit` is 1 through 100 and defaults to 50. Results are restricted to the authenticated developer and requested network.

### List crossing events

`GET /fee-alert-events?network=mainnet&limit=50`

Returns `{ "events": [...], "count": n }`, ordered by bucket end time. Events include previous/current fee values in stroops, threshold, direction, trend, and dispatch timestamp. Results are restricted to the authenticated developer and requested network.

### Webhook delivery

Register and verify a webhook subscription with `eventType` set to `gas_fee_alert` and `deliveryStrategy` set to `immediate`. Only verified subscriptions belonging to an active API key owned by the rule's developer receive the event. Gas alerts are not sent to batch subscriptions in this phase.

The signed request body is:

```json
{
  "event": {
    "id": "rule-id:2026-09-28T10:00:00.000Z",
    "eventType": "gas_fee_alert",
    "network": "mainnet",
    "occurredAt": "2026-09-28T11:00:00.000Z",
    "ruleId": "rule-id",
    "direction": "high",
    "thresholdStroops": "200",
    "previousFeeStroops": "100",
    "currentFeeStroops": "300",
    "trend": "rising"
  },
  "attempt": 1
}
```

Requests include `X-Webhook-Timestamp`, `X-Webhook-Signature`, and a stable `Idempotency-Key` for the subscription/event pair. Receivers should deduplicate by that key. Transient network and HTTP errors follow the shared immediate-delivery retry policy (five attempts with capped exponential backoff); SSRF blocks are terminal. Subscription delivery history is available from the existing webhook delivery-history API.

### Update a rule

`PATCH /fee-alert-rules/{id}` accepts one or more of `thresholdStroops`, `cooldownSeconds`, and `isActive`. Changing the threshold resets the previously observed fee so the next evaluation can establish a fresh baseline. Rules owned by another developer return `404`.

### Delete a rule

`DELETE /fee-alert-rules/{id}` returns `204`; a missing or non-owned rule returns `404`.

## Rollout and Recovery

1. Apply migrations with `npm run prisma:deploy` and regenerate the Prisma client.
2. Confirm the `gasFeeAlerts` flag reports available, then enable it through the admin feature-flag API. It is disabled by default.
3. Verify rule CRUD with a scoped API key; register and verify an immediate webhook subscription filtered to `gas_fee_alert`; confirm the gas analytics and shared webhook workers are running.
4. To roll back exposure, disable `gasFeeAlerts` first. Keep the tables and pending events intact while investigating; do not drop data during an application rollback.

## Error Taxonomy and Recovery

| Condition | API/worker behavior | Operator action |
| --- | --- | --- |
| `SCHEMA_UNAVAILABLE` | API returns `503`; scheduler is not started | Apply migrations, regenerate Prisma client, confirm feature-flag availability |
| `FEATURE_DISABLED` | API returns `404`; evaluator and outbox stay gated | Enable the global flag after verifying the rollout target |
| `FEATURE_UNAVAILABLE` | API returns `503` when flag state cannot be checked | Check feature-flag storage and application logs; retry after recovery |
| `RATE_LIMITED` | API returns `429` | Reduce request rate or review the per-IP limiter configuration |
| Invalid request or persisted threshold | Request validation rejects input; evaluator skips and logs corrupt stored rules | Correct client input or deactivate/repair the affected rule |
| SSRF rejection | Webhook delivery is terminally failed and audited | Correct the subscription destination after security review |
| HTTP/network failure | Shared webhook retry worker uses bounded backoff; delivery eventually becomes terminal after its configured attempt limit | Inspect delivery history and destination health; re-enable the subscription after recovery |

The dashboard and Prometheus rules are in `grafana/dashboards/gas-fee-alerts.json` and `prometheus/alerts.yml`. The current delivery-attempt objective is 99.5% successful attempts over 30 days. The p99 100ms target is monitored but not demonstrated under sustained production-scale load; hourly snapshot evaluation means it is not currently achievable for the whole event-to-client path. No claim of the 100,000-connection or 30-minute 10x load acceptance is made by these metrics.

The migration is additive and does not modify existing alert tables or API payloads. Removing the feature later requires a separately reviewed data-retention decision before dropping `_gas_fee_alert_rules`.

The PostgreSQL concurrency and injected-write-failure integration test runs in CI with `GAS_FEE_ALERTS_INTEGRATION=1`. To run it locally, point `DATABASE_URL` at a disposable migrated PostgreSQL database and set that variable before running `npx vitest run tests/integration/gas-fee-alerts.integration.test.ts`.

## Telemetry and Error Behavior

Rule and event-list operations emit `gas_fee_alert_api_operations_total` and the OpenTelemetry counter `gas.fee_alert.api.operations`, labeled by bounded operation and outcome values. Snapshot evaluation emits `gas_fee_alert_evaluator_operations_total` and `gas.fee_alert.evaluator.operations`; outbox enqueue emits `gas_fee_alert_outbox_operations_total` and `gas.fee_alert.outbox.operations`; durable fan-out emits `gas_fee_alert_delivery_operations_total` and `gas.fee_alert.delivery.operations`. A missing migration returns `503 SCHEMA_UNAVAILABLE`; a disabled flag returns `404 FEATURE_DISABLED`; unavailable flag evaluation returns `503 FEATURE_UNAVAILABLE`; rate limiting returns `429 RATE_LIMITED`. Evaluation runs when the hourly gas analytics job processes the most recently completed hour. Delivery polling uses the shared webhook worker, with attempts tracked in `_webhook_deliveries`; SSRF blocks are terminal and transient failures follow the shared five-attempt retry policy. Delivery SLO dashboards and Prometheus fast/slow burn rules are committed. The 100ms target is monitored but not validated under sustained load; 90-day replay, chaos tests, ordering guarantees, and production-scale load budgets remain outstanding.