# Contract ABI Submission Registry Design

## Scope

Teams submit contract ABI and descriptive metadata for review. Nothing reaches the published registry until an administrator approves and explicitly publishes it. Existing contract reads remain unchanged. The legacy direct maintainer registration write is now admin-token gated; unauthenticated callers must use the moderated submission workflow.

## Data model

- `_contract_abi_submissions` stores one immutable payload per `(address, network, submitted_by, content_hash)` and its current lifecycle status.
- `content_hash` is SHA-256 over recursively key-sorted JSON. Replaying the same payload for the same API-key developer returns the existing submission. A different team can submit the same content independently.
- `_contract_abi_submission_events` is append-only and records actor, reason, timestamp, and each state transition. Database constraints reject unknown states and impossible transitions.
- `validated_at` and `validation_ledger` identify the indexed evidence watermark. List responses include an `asOf` time and staleness seconds; each item carries its own evidence timestamp and ledger.
- Submission rows are retained with their moderation history. There is no user-facing delete operation. Retention or privacy requests require a reviewed, audited operational procedure; registry rows are not removed as part of application rollback.

## State machine

```text
(new) -> pending -> approved -> published
                  \-> rejected
```

Review and publication use conditional updates in PostgreSQL transactions. A review can only move `pending` to `approved` or `rejected`. Publication can only move `approved` to `published`; the contract record, network deployment, final state, and history event commit together. Repeated decisions return conflict and cannot overwrite the first decision.

## Validation and publication

The API requires an API key, accepts only a supported network, and currently requires that network to match the active indexed profile. This is necessary because indexed activity is stored in that profile's database and the event table does not carry an independent network column. ABI function names are checked against indexed transactions; supplied ABI event names are checked against indexed `Event.topicSymbol` values. At least one submitted function or event must be observed for the address. Validation is repeated from the primary database during publication so replica lag cannot create false evidence and a stale submission cannot bypass the live check.

The publisher resolves an existing `(address, network)` deployment to its canonical contract when one exists. A submitter cannot select a canonical address. ABI hashes are computed by the server. Network-scoped ABI data is written to `ContractNetwork`; canonical metadata is updated only when the submission address is the canonical address.

No network fetch is performed. This avoids SSRF and makes the validation evidence auditable and repeatable from the indexed ledger database. The trade-off is that a contract with no indexed function call cannot be submitted yet.

## Feature flag and failure behavior

`contractAbiSubmissions` is default-off and requires both new tables. The public routes also require a valid API key and a strict per-IP limiter. Admin routes use `adminAuth` and the central admin limiter. Feature-flag storage, schema discovery, or workflow storage failures fail closed; published contract reads are not dependent on this feature and continue to work.

Invalid payloads return 400/413, unsupported evidence returns 422, illegal state changes return 409, missing records return 404, and persistence/feature availability failures return 503 through the standard error handler. There is no fallback that writes an unreviewed ABI to the registry.

## Observability and SLOs

The workflow emits structured request-correlated logs, `contract_abi_submission_operations_total`, and `contract_abi_submission_validation_duration_seconds` through the repository's existing Prometheus client/`/metrics` path. Metrics use only bounded operation/outcome labels; contract addresses, developer IDs, and submission IDs are never metric labels. The current OpenTelemetry SDK is trace-only; this increment does not claim OTLP metric export because the repository has no metrics exporter configured and adding one requires the documented dependency review/approval.

- Availability SLO: at least 99.5% successful service operations over 30 days, excluding invalid requests, deliberate feature-off responses, and rate limits. The monthly error budget is 0.5%.
- Validation latency SLO: p99 at or below 250 ms in the PostgreSQL soak workload.
- Integrity objective: zero registry writes from non-approved submissions; exercised by state-transition tests and PostgreSQL fault injection.

The Prometheus alert rules and Grafana dashboard are committed beside the service. A consumed error budget freezes rollout until the runbook's recovery checks pass.

## Capacity and data quality

The committed soak drives the real submission service against PostgreSQL at 1 submission/second for 30 minutes (10x the documented 0.1/s projected peak). It enforces zero failures, p99 <= 250 ms, at least 90% of target throughput, and <=128 MiB retained heap growth. Pull requests run a 60-second smoke; the scheduled/manual workflow runs 30 minutes. The smoke is not a substitute for the full soak report.

The application rejects malformed, oversized, duplicate-function-name syntax, unsupported network values, and submissions without observed call evidence. PostgreSQL uniqueness and transition constraints are the final duplicate/state corruption gates. Validation watermark is refreshed at submit and publish; consumers can detect age and ledger progress from the response.

## Alternatives considered

- Direct public writes to `Contract`/`ContractNetwork`: rejected because it makes unreviewed content immediately visible and has no auditable decision history.
- Reuse the manually cached ABI endpoint: rejected because its cache is not a moderation record and does not atomically publish to the registry.
- Fetch RPC/Horizon URLs supplied by clients: rejected because it creates SSRF and network-identity risks; indexed database evidence is already available.
- Caller-supplied canonical address: rejected because it could attach metadata to and overwrite another contract's registry record.

## Migration and rollback

The migration is additive and creates only new tables/indexes. Apply through the existing `prisma migrate deploy` path. Roll back application behavior by disabling the feature flag; keep the additive tables and audit history. Do not drop or rewrite submission data as part of code rollback. Any eventual table removal requires a separately reviewed export and data-preservation plan.
