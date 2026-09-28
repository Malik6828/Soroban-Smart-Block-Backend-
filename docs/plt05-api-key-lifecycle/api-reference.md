# PLT05 — API Key Lifecycle Management Portal: API Reference

All endpoints are mounted under `/api/v1/developer/keys` alongside the existing key CRUD endpoints.

---

## Scope Syntax and Semantics

A **scope** is a colon-separated `resource:action` string that restricts what a key can access.

Valid scope tokens:

| Scope               | Category  | Description                                              |
|---------------------|-----------|----------------------------------------------------------|
| `transactions:read` | core      | Read transaction history and details                     |
| `events:read`       | core      | Read contract events                                     |
| `contracts:read`    | core      | Read contract registry and metadata                      |
| `contracts:write`   | core      | Register or update contract ABIs                         |
| `tokens:read`       | core      | Read SEP-41 token information                            |
| `wallets:read`      | core      | Read wallet/account history                              |
| `search:read`       | core      | Use the autocomplete/search endpoints                    |
| `analytics:read`    | analytics | Read analytics reports and data lake queries             |
| `analytics:write`   | analytics | Write/trigger analytics pipeline jobs                    |
| `dex:read`          | defi      | Read DEX swap analysis                                   |
| `mev:read`          | defi      | Read MEV detection results                               |
| `sandbox:read`      | dev       | Read sandbox simulation results                          |
| `sandbox:write`     | dev       | Execute sandbox simulations                              |
| `developer:read`    | account   | Read developer account and key metadata                  |
| `developer:write`   | account   | Modify developer account settings                        |
| `admin:read`        | admin     | Admin read access                                        |
| `admin:write`       | admin     | Admin write access                                       |
| `*`                 | special   | Wildcard — grants all scopes                             |

Multiple scopes are combined in a comma-separated string: `transactions:read,events:read,contracts:read`

A key with `scope = null` has no restriction and behaves as if it holds all permissions (backward-compatible with keys created before PLT05).

---

## Endpoints

---

### `GET /scopes`

List all valid scope tokens with descriptions.

**Response 200:**
```json
{
  "data": [
    { "scope": "transactions:read", "description": "Read transaction history and details", "category": "core" },
    { "scope": "events:read", "description": "Read contract events", "category": "core" },
    { "scope": "*", "description": "Wildcard — grants all scopes", "category": "special" }
  ],
  "total": 18
}
```

---

### `GET /scope-presets`

List all scope presets (built-in and custom).

**Response 200:**
```json
{
  "data": [
    {
      "id": "c8f2e2b0-1234-7abc-89de-000000000001",
      "name": "read_only",
      "description": "Read-only access to all public endpoints",
      "scopes": ["transactions:read", "events:read", "contracts:read", "tokens:read", "wallets:read"],
      "is_builtin": true,
      "created_at": "2026-09-28T00:00:00.000Z"
    },
    {
      "id": "c8f2e2b0-1234-7abc-89de-000000000002",
      "name": "standard",
      "description": "Standard developer access",
      "scopes": ["transactions:read", "events:read", "contracts:read", "tokens:read", "wallets:read", "search:read", "analytics:read"],
      "is_builtin": true,
      "created_at": "2026-09-28T00:00:00.000Z"
    },
    {
      "id": "c8f2e2b0-1234-7abc-89de-000000000003",
      "name": "full_access",
      "description": "Full API access",
      "scopes": ["*"],
      "is_builtin": true,
      "created_at": "2026-09-28T00:00:00.000Z"
    }
  ]
}
```

---

### `POST /scope-presets`

Create a custom scope preset.

**Request body:**
```json
{
  "name": "analytics_only",
  "description": "Access limited to analytics endpoints",
  "scopes": ["analytics:read", "transactions:read"]
}
```

Field constraints:
- `name`: 1–64 chars, lowercase alphanumeric + underscores (`^[a-z0-9_]+$`)
- `description`: 1–512 chars
- `scopes`: non-empty array of valid scope tokens

**Response 201:**
```json
{
  "id": "01924f9b-a123-7000-b456-000000000099",
  "name": "analytics_only",
  "description": "Access limited to analytics endpoints",
  "scopes": ["analytics:read", "transactions:read"],
  "isBuiltin": false
}
```

**Error responses:**

| Status | Condition                              |
|--------|----------------------------------------|
| `400`  | Validation failed (name format, scopes)|
| `409`  | Preset name already exists             |

```json
// 400 — invalid scope
{
  "error": "Invalid scopes",
  "details": "One or more scope tokens are not recognised. Call GET /scopes for the full list."
}

// 409 — duplicate name
{
  "error": "A scope preset with that name already exists"
}
```

---

### `GET /stats`

Returns lifecycle statistics for all API keys belonging to a developer.

**Query parameters:**
- `developerId` (required) — the developer's ID

**Response 200:**
```json
{
  "totalKeys": 8,
  "activeKeys": 5,
  "revokedKeys": 2,
  "expiredKeys": 1,
  "keysNeedingRotation": 1,
  "averageKeyAgeDays": 47.3
}
```

**Error responses:**

| Status | Condition                |
|--------|--------------------------|
| `400`  | `developerId` missing    |
| `404`  | Developer not found       |

---

### `POST /bulk-revoke`

Atomically revoke multiple keys. All revocations succeed or all fail.

**Request body:**
```json
{
  "developerId": "dev_abc123",
  "keyIds": ["key_1", "key_2", "key_3"],
  "reason": "Credential exposure — rotate all keys"
}
```

Field constraints:
- `keyIds`: 1–100 key IDs
- `reason`: optional, max 256 chars

**Response 200:**
```json
{
  "revokedCount": 3,
  "revokedIds": ["key_1", "key_2", "key_3"]
}
```

When some keys were not found or already revoked, a `skipped` array is included:
```json
{
  "revokedCount": 2,
  "revokedIds": ["key_1", "key_2"],
  "skipped": ["key_already_revoked"]
}
```

**Error responses:**

| Status | Condition                              |
|--------|----------------------------------------|
| `400`  | Validation failed                      |
| `404`  | Developer not found or no active keys  |

---

### `GET /:id/lifecycle`

Get lifecycle metadata for a specific key.

**Query parameters:**
- `developerId` (required) — verifies ownership

**Response 200:**
```json
{
  "id": "key_abc123",
  "scope": "transactions:read,events:read,contracts:read",
  "description": "Main production key for the data pipeline",
  "environment": "production",
  "tags": ["prod", "data-pipeline", "q4-2026"],
  "rotationPolicyDays": 90,
  "lastRotatedAt": "2026-07-01T12:00:00.000Z",
  "lastSeenIp": "203.0.113.42"
}
```

Fields with no value are returned as `null`. `tags` defaults to `[]`.

**Error responses:**

| Status | Condition                           |
|--------|-------------------------------------|
| `404`  | Key not found or not owned by developer |

---

### `PATCH /:id/lifecycle`

Update lifecycle metadata for a key. All fields are optional — only provided fields are updated.

**Query parameters:**
- `developerId` (required) — verifies ownership

**Request body (all fields optional):**
```json
{
  "scope": "transactions:read,events:read",
  "description": "Restricted key for read-only dashboard",
  "environment": "production",
  "tags": ["dashboard", "read-only"],
  "rotation_policy_days": 60
}
```

Field constraints:
- `scope`: max 1024 chars; must contain only valid scope tokens
- `description`: max 2048 chars
- `environment`: `"production"` | `"sandbox"` | `"test"`
- `tags`: array of strings, max 20 items, each max 64 chars
- `rotation_policy_days`: integer 1–3650 or `null` to disable

**Response 200:**
```json
{
  "id": "key_abc123",
  "updated": true
}
```

**Error responses:**

| Status | Condition                                      |
|--------|------------------------------------------------|
| `400`  | Validation failed                              |
| `400`  | Invalid scope token(s)                         |
| `400`  | No lifecycle fields provided                   |
| `404`  | Key not found or not owned by developer        |

```json
// 400 — invalid scope
{
  "error": "Invalid scope",
  "details": "One or more scope tokens are not recognised. Call GET /keys/scopes for the full list."
}

// 400 — no fields provided
{
  "error": "No lifecycle fields provided to update"
}
```

---

### `GET /:id/audit`

Paginated audit history for a specific key (all rotations in which the key was either the source or the result).

**Query parameters:**
- `developerId` (required) — verifies ownership
- `limit` (optional, default 50, max 200)
- `offset` (optional, default 0)

**Response 200:**
```json
{
  "data": [
    {
      "id": "audit_xyz",
      "developerId": "dev_abc123",
      "oldKeyId": "key_old",
      "newKeyId": "key_abc123",
      "reason": "rotation_policy",
      "ipAddress": "198.51.100.7",
      "userAgent": "soroban-cli/1.2.0",
      "wasSuccessful": true,
      "errorMessage": null,
      "metadata": { "rotationType": "self_service" },
      "rotatedAt": "2026-07-01T12:00:00.000Z",
      "actorType": "developer",
      "actorId": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

`actorType` values: `"developer"` | `"admin"` | `"automated"`

**Error responses:**

| Status | Condition                                      |
|--------|------------------------------------------------|
| `404`  | Key not found or not owned by developer        |

---

### `POST /:id/expire`

Manually expire a key immediately. Sets `expires_at` to the current timestamp and `status` to `"expired"`. Use this to gracefully retire a key without revoking it (e.g. during a planned rotation).

**Query parameters:**
- `developerId` (required) — verifies ownership

**Response 200:**
```json
{
  "id": "key_abc123",
  "expired": true,
  "expiresAt": "2026-09-28T11:15:03.902Z"
}
```

**Error responses:**

| Status | Condition                                    |
|--------|----------------------------------------------|
| `404`  | Key not found or not owned by developer      |
| `409`  | Key is already revoked                       |

```json
// 409
{
  "error": "Key is already revoked and cannot be expired"
}
```

---

## Common Error Codes

| HTTP Status | Meaning                                                             |
|-------------|---------------------------------------------------------------------|
| `400`       | Request validation failed — check the `details` field for specifics |
| `404`       | Resource not found (key, developer, or preset)                      |
| `409`       | Conflict — e.g. duplicate preset name or key already revoked        |
| `500`       | Unexpected server error — check server logs                         |
