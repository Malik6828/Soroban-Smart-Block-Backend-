# Contract ABI Submission API

All paths are relative to `/api/v1`. The submission feature is default-off. Requests are accepted only when the `contractAbiSubmissions` feature flag is enabled, both migration tables are available, and the requested network matches the active indexed profile.

The existing `POST /contracts` maintainer write now requires `X-Admin-Token`; public/team writes must use the moderated submission endpoint below. Existing contract read endpoints are unchanged.

The legacy `PUT` and `DELETE /contracts/{address}/abi` manual-cache mutations also require `X-Admin-Token`. They do not publish to the registry; public/team ABI content must use submissions.

## Submit

`POST /contracts/abi-submissions`

Headers: `X-Api-Key: <team-api-key>`, `Content-Type: application/json`

Rate limit: 20 requests per 15 minutes per source IP, in addition to the normal API-key tier limiter. The body is limited to 64 KiB after JSON parsing.

```json
{
  "address": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "network": "testnet",
  "name": "Example Router",
  "description": "Community ABI submission for the router contract.",
  "abi": {
    "functions": [
      {
        "name": "transfer",
        "inputs": [
          { "name": "to", "type": "Address" },
          { "name": "amount", "type": "i128" }
        ],
        "outputs": [{ "type": "bool" }],
        "humanTemplate": "Transferred {amount} to {to}"
      }
    ]
  },
  "abiVersion": "1.2.0",
  "version": "v2",
  "wasmHash": "0123456789abcdef",
  "protocolKey": "example-router",
  "deployedAtLedger": 123456
}
```

`address`, `network`, and at least one ABI function or event are required. Network is one of `testnet`, `mainnet`, or `devnet`; the current deployment only accepts the active indexed profile. ABI functions and events require unique identifier-style names and bounded input/output arrays. Functions are checked against indexed transaction function names; optional event definitions are checked against indexed `Event.topicSymbol` values. At least one submitted function or event must have indexed evidence. Unknown fields are rejected. `canonicalAddress` and `abiHash` are intentionally not accepted; canonical linkage and ABI hashes are controlled by the registry publisher.

New content returns `201` with `{"submission": <record>, "duplicate": false}`. A replay by the same API-key developer returns `200` with the original record and `duplicate: true`. Replays do not create additional audit events.

A submission record includes `id`, `address`, `network`, `submittedBy`, `payload`, `contentHash`, `status`, `validatedAt`, `validationLedger`, review fields, publication timestamp, and creation/update timestamps. `contentHash` is a server-calculated SHA-256 digest of canonical JSON.

## Review queue

All endpoints below require `X-Admin-Token` and are additionally guarded by the shared admin rate limiter.

- `GET /admin/contract-abi-submissions?status=pending&page=1&limit=25` lists records and transition events. `status` may be `pending`, `approved`, `rejected`, or `published`; `limit` is 1-100. Response includes `items`, `pagination`, and `freshness` (`asOf`, `lastValidatedAt`, `oldestValidatedAt`, `maxStalenessSeconds`). Each item also includes its own `validatedAt` and `validationLedger`.
- `GET /admin/contract-abi-submissions/{id}` returns one record with its ordered transition history.
- `POST /admin/contract-abi-submissions/{id}/approve` accepts `{"reviewNote":"Verified against indexed calls"}`; the note is optional.
- `POST /admin/contract-abi-submissions/{id}/reject` requires `{"reviewNote":"Reason for rejection"}`.
- `POST /admin/contract-abi-submissions/{id}/publish` has no body. It revalidates indexed activity and atomically publishes the ABI and metadata into the contract registry.

A submission cannot be approved/rejected after leaving `pending`, nor published before approval. These cases return `409`.

## Error taxonomy

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_SUBMISSION` | Invalid or unknown submission fields |
| 400 | `INVALID_QUERY` | Invalid moderation-list parameters |
| 400 | `INVALID_REVIEW` | Missing/invalid review note |
| 401 | Existing admin/API-key auth code | Missing or invalid credentials |
| 404 | `FEATURE_DISABLED` | Feature flag is off |
| 404 | Standard not-found error | Submission ID does not exist |
| 413 | `PAYLOAD_TOO_LARGE` | Canonical submission body exceeds 64 KiB |
| 422 | `NETWORK_DATA_UNAVAILABLE` | Requested network is not the active indexed profile |
| 422 | Standard validation error | No submitted function is present in indexed activity |
| 429 | `RATE_LIMITED` | Public submission IP limit exceeded |
| 409 | Standard conflict error | State transition is not permitted |
| 503 | `SCHEMA_UNAVAILABLE` | Required migration tables are absent |
| 503 | `FEATURE_UNAVAILABLE` | Feature availability could not be established |
| 5xx | Standard server error | Database or unexpected service failure; no unpublished ABI is exposed |

See [the operating runbook](runbook.md) for enablement, diagnostics, and rollback.
