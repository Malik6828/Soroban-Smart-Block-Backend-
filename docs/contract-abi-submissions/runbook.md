# Contract ABI Submission Operations Runbook

## Prerequisites and enablement

1. Start the Postgres service and apply additive migrations with `npx prisma migrate deploy` (Compose migration init containers do this automatically).
2. Verify `GET /health` is healthy and check that the feature flag reports its required tables available.
3. Keep `contractAbiSubmissions` disabled until the migration is applied and the deployment has passed route, integration, and soak CI.
4. Enable `contractAbiSubmissions` through the authenticated admin feature-flag API. It defaults to off. Do not enable by environment-specific flags.
5. Submit one test ABI using a team API key and a contract with an indexed function call. Verify the evidence ledger, then review and publish with a separate admin identity.
6. Confirm the per-network ABI is visible through `GET /contracts/{address}/abi` or the registry API and the Prometheus dashboard is receiving data.

The legacy direct metadata write, `POST /api/v1/contracts`, and manual ABI cache mutations, `PUT`/`DELETE /api/v1/contracts/{address}/abi`, require `X-Admin-Token`. These routes do not replace the review workflow; do not remove their guards as a compatibility workaround.

## Manual verification

Use environment variables supplied by your approved secret manager; do not put API/admin keys in shell history, tickets, or this repository.

```sh
curl --fail-with-body -X POST "$API_URL/api/v1/contracts/abi-submissions" \
  -H "X-Api-Key: $TEAM_API_KEY" -H 'Content-Type: application/json' \
  --data-binary @submission.json

curl --fail-with-body "$API_URL/api/v1/admin/contract-abi-submissions?status=pending" \
  -H "X-Admin-Token: $ADMIN_API_KEY"

curl --fail-with-body -X POST "$API_URL/api/v1/admin/contract-abi-submissions/$SUBMISSION_ID/approve" \
  -H "X-Admin-Token: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  --data '{"reviewNote":"Checked indexed functions and metadata"}'

curl --fail-with-body -X POST "$API_URL/api/v1/admin/contract-abi-submissions/$SUBMISSION_ID/publish" \
  -H "X-Admin-Token: $ADMIN_API_KEY"
```

For CI, set `CONTRACT_ABI_INTEGRATION=1` against the migrated `pgvector/pgvector:pg16` service and run `npm run test:full`. The integration case injects a PostgreSQL trigger failure and verifies rollback plus successful retry. The scheduled soak command and budgets are in `.github/workflows/soak.yml` and `tests/load/contract-abi-submissions-soak.ts`.

## Alerts and SLOs

Import `grafana/dashboards/contract-abi-submissions.json` into the deployment's Grafana instance and select its Prometheus datasource. This repository does not provision Grafana/Prometheus services in Compose; the dashboard file is the deployment artifact, while alert rules live in `prometheus/alerts.yml` and are checked by the Prometheus lint CI job.

- Availability target: 99.5% successful gated/workflow operations over 30 days; monthly error budget 0.5%. Invalid requests, planned flag-off requests, missing migration tables, expected state conflicts, and unsupported evidence are not server failures.
- Evidence-validation p99 target: <= 250 ms under the committed PostgreSQL load harness.
- Integrity invariant: zero registry writes for submissions that are not approved; real-Postgres fault injection checks that contract, deployment, status, and event writes roll back together.

A budget alert or p99 alert pauses rollout. Disable the flag before investigating if any published registry value may be incorrect.

## Diagnosis and recovery

- `FEATURE_DISABLED` (404): verify the environment/developer flag evaluation; the safe default is off.
- `SCHEMA_UNAVAILABLE` (503): do not enable the feature. Inspect migration history and apply the migration with the normal deploy process. Do not hand-edit the database.
- `FEATURE_UNAVAILABLE` or sustained operation `outcome="error"`: inspect structured logs by request ID, then database connectivity/pool health. Public reads and previously published registry ABIs do not depend on the submission service.
- `NETWORK_DATA_UNAVAILABLE` (422): submissions only target the active indexed network. Do not bypass by changing a caller-provided canonical address.
- No indexed-function evidence (422): verify the address, network profile, indexer lag, and transaction function names. The service intentionally does not fetch arbitrary RPC/Horizon URLs.
- `409` on review/publish: fetch the current record and ordered event history. Decisions are compare-and-set; do not retry a different decision over an existing state.
- ABI missing after publication: inspect transaction state and history. Registry upserts and the `approved -> published` event share one DB transaction; a failed transaction should leave the submission approved and safe to retry.
- Unexpected metadata or suspected data corruption: disable the feature flag, preserve database logs and submission/event rows, inspect the server-generated content hash and published deployment, then restore the prior ABI from the reviewed source record. Do not delete history.

## Rollback and migration safety

1. Disable `contractAbiSubmissions` using the admin feature-flag API. This immediately blocks new submissions and moderation actions; published registry data remains readable.
2. If the application release must be reverted, redeploy the previous application version while leaving the additive tables in place. No destructive rollback migration is needed or permitted for this release.
3. Compare published `ContractNetwork.abi` and canonical `Contract.abi` values to the submission's immutable payload and event history before any manual correction. Record correction actor, reason, and timestamp in the incident record.
4. Keep submission rows and append-only history during rollback. Any future retention/deletion change requires an export, verified backup, dry run, and separate approved migration.
5. Re-enable only after the database, indexer watermark, feature flag availability, fault-injection integration test, and full soak pass.

## Capacity and retention

CI runs a 60-second pull-request smoke and a 30-minute scheduled/manual soak at 1 submission/s, defined as 10x the initial projected 0.1 submission/s peak. Hard budgets are zero failures, >=90% target rate, p99 <=250 ms, and <=128 MiB retained heap growth. Review the uploaded soak report before release. These CI results demonstrate the harness workload on the CI PostgreSQL replica; remeasure against production-equivalent resources before setting a production traffic ceiling.

Submissions and their moderation events are retained indefinitely by this migration. There is no automated archival or deletion policy in this increment; adding one requires a separately tested, data-preserving design.
