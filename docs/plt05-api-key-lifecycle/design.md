# PLT05 — API Key Lifecycle Management Portal: Design Document

## Problem Statement

The existing API key system (`src/api/developer/keys.ts`) provides CRUD operations and a self-service rotation flow, but gives developers no tools to:

- Restrict a key to a specific subset of the API surface (scope)
- Distinguish between production, sandbox, and test keys (environment)
- Annotate keys with free-form metadata (tags, description)
- Enforce automatic rotation reminder policies (rotation_policy_days)
- Query audit history per key rather than per developer
- Revoke a large batch of keys atomically in a security incident

PLT05 adds these capabilities as opt-in lifecycle metadata on top of the existing model, leaving the existing authentication flow unchanged.

---

## Data Model Additions

### `_dev_api_keies` — new columns

| Column                | Type              | Default        | Purpose                                              |
|-----------------------|-------------------|----------------|------------------------------------------------------|
| `scope`               | `VARCHAR(1024)`   | `NULL`         | Comma-separated permission scopes. NULL = no restriction. |
| `last_seen_ip`        | `VARCHAR(64)`     | `NULL`         | Last IP to successfully use this key (updated by auth middleware). |
| `description`         | `TEXT`            | `NULL`         | Human-readable purpose of the key.                   |
| `environment`         | `VARCHAR(32)`     | `'production'` | `'production'` \| `'sandbox'` \| `'test'`           |
| `tags`                | `JSONB`           | `'[]'`         | Array of string tags for search and organisation.    |
| `rotation_policy_days`| `INT`             | `NULL`         | When set, the background checker warns if the key is older than this threshold. |
| `last_rotated_at`     | `TIMESTAMP`       | `NULL`         | Populated when a rotation is performed.              |

### `_key_rotation_audits` — new columns

| Column      | Type           | Default        | Purpose                                           |
|-------------|----------------|----------------|---------------------------------------------------|
| `actor_type`| `VARCHAR(32)`  | `'developer'`  | Who performed the action: `developer`, `admin`, `automated`. |
| `actor_id`  | `VARCHAR(128)` | `NULL`         | ID of the actor when it differs from the key owner. |

### `_key_scope_presets` — new table

Stores reusable collections of scopes that developers can apply to keys. Three built-in presets are seeded: `read_only`, `standard`, `full_access`. Custom presets can be created via the API.

---

## API Surface

All endpoints are mounted at `/api/v1/developer/keys` (the lifecycle router is added alongside the existing `keysRouter`).

| Method   | Path                    | Description                                    |
|----------|-------------------------|------------------------------------------------|
| `GET`    | `/scopes`               | List all valid scope tokens with descriptions  |
| `GET`    | `/scope-presets`        | List built-in + custom scope presets           |
| `POST`   | `/scope-presets`        | Create a custom scope preset                   |
| `GET`    | `/stats`                | Lifecycle statistics for a developer           |
| `POST`   | `/bulk-revoke`          | Atomically revoke multiple keys                |
| `GET`    | `/:id/lifecycle`        | Get lifecycle metadata for one key             |
| `PATCH`  | `/:id/lifecycle`        | Update lifecycle fields for one key            |
| `GET`    | `/:id/audit`            | Paginated audit history for one key            |
| `POST`   | `/:id/expire`           | Manually expire a key immediately              |

---

## Scope Syntax and Semantics

Scopes use the format `resource:action`:

- `transactions:read` — read-only access to transaction data
- `contracts:write` — permission to register or update contract ABIs
- `*` — wildcard: all permissions granted

Multiple scopes are combined as a comma-separated string stored in the `scope` column: `transactions:read,events:read,contracts:read`.

Enforcement is **declarative and advisory** in this release. The `checkScopeAuthorized()` function in `src/services/api-key-lifecycle.ts` is exported for use by individual route handlers that wish to enforce scope. The authentication middleware itself does not yet enforce scope, preserving backward compatibility with existing keys (which have `scope = NULL`, meaning no restriction).

---

## Security Considerations

### Scope enforcement

Because existing keys have `scope = NULL`, the `checkScopeAuthorized(null, required)` call returns `true` — granting full access. This preserves backward compatibility. New keys created with an explicit scope will be restricted accordingly once route handlers call `checkScopeAuthorized`.

### Audit trail

Every key rotation already writes a `KeyRotationAudit` row. PLT05 extends this with `actor_type` and `actor_id` so that admin-triggered and automated rotations are distinguishable from developer-initiated ones. The `GET /:id/audit` endpoint exposes per-key audit history.

### Bulk revoke atomicity

`POST /bulk-revoke` wraps all updates in a single Prisma transaction so partial revocation is impossible — either all listed keys are revoked or none are.

### Raw SQL usage

The new lifecycle columns are accessed via `$executeRawUnsafe` and `$queryRawUnsafe` rather than the Prisma client, because the client types are generated from the schema at build time and won't reflect the new columns until `prisma generate` is run in CI. Parameterised queries are used throughout; no string interpolation of user input occurs.

---

## Trade-offs Considered

### Alternative: Full RBAC system

A full role-based access control system would assign named roles (e.g. `viewer`, `analyst`, `operator`) to keys, with roles mapped to sets of permissions. This is more expressive but significantly more complex to implement and migrate. The scope approach is simpler and sufficient for the current use case, and can be migrated to role-based mapping later.

### Alternative: OAuth 2.0 scopes

Standard OAuth 2.0 scope strings (e.g. `openid profile`) are well-understood by third-party tooling. However, this codebase uses opaque API keys rather than bearer tokens; introducing OAuth machinery for scoping alone would require a significant rearchitecture of the authentication layer. The current approach reuses the existing key format and infrastructure.

### Alternative: JSON permissions object

The existing `permissions` column is already a `JSONB` field. Scope could have been stored there. Keeping scope as a separate column makes querying, indexing, and validation significantly simpler, and avoids conflating two different concepts (legacy permissions vs. the new scope system).

---

## Rejected Alternatives

- **Auto-rotation**: The rotation-policy checker intentionally only warns; auto-rotation would silently invalidate production keys, which could cause outages. A future issue can add opt-in auto-rotation with a notification phase.
- **Scope hierarchy / inheritance**: Hierarchical scopes (e.g. `contracts` implies both `contracts:read` and `contracts:write`) add complexity. Flat enumeration is simpler and auditable.
- **Storing scope as an array column**: A `TEXT[]` column would require `ANY` syntax for queries. A comma-separated string is simpler for the API contract and human-readable in the database.
