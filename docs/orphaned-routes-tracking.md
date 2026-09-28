# Orphaned Routes Reduction Tracker

Tracks the effort to mount or delete router files in `src/api/` that are
neither mounted (directly or transitively) in `src/api/router.ts` nor
allowlisted in `scripts/validate-routes.ts` (`PENDING_SCHEMA_ROUTERS`).

## Enforcement

- CI runs `npm run validate-routes:ci` (`--max-orphans 0`) on every push/PR.
- CI fails when **orphaned routers > 0** or when **exact route conflicts** exist.
- The validator follows relative imports transitively from `router.ts`, so
  routers composed inside other routers count as mounted.
- Budget is defined in `package.json` (`validate-routes:ci`) and `scripts/validate-routes.ts` (`ORPHANED_ROUTER_BUDGET`).
- Run locally: `npm run validate-routes` or `npm run validate-routes:ci` (both enforce budget 0).

## Current status (2026-09-28)

| Metric                       | Count |
| ---------------------------- | ----- |
| Mounted routers              | 123   |
| Pending-schema (allowlisted) | 15    |
| **Orphaned routers**         | **0** |
| Exact route conflicts        | 0     |
| CI budget                    | 0     |

## Orphaned routers — mount or delete

All previously orphaned routes have been resolved:

| Router file               | Decision | Status  | Notes                                 |
| ------------------------- | -------- | ------- | ------------------------------------- |
| `agents.ts`               | Mount    | Mounted | Mounted under `/agents`               |
| `analytics-query.ts`      | Mount    | Mounted | Mounted under `/analytics/query`      |
| `dashboards.ts`           | Mount    | Mounted | Mounted under `/dashboards`           |
| `flash-loans.ts`          | Mount    | Mounted | Mounted under `/mev/flash-loans`      |
| `forecast.ts`             | Delete   | Deleted | Superseded by `predict.ts`            |
| `freeze.ts`               | Mount    | Mounted | Mounted under `/freeze`               |
| `gas.ts`                  | Mount    | Mounted | Mounted under `/gas`                  |
| `identity.ts`             | Mount    | Mounted | Mounted under `/identity`             |
| `predict.ts`              | Mount    | Mounted | Mounted under `/predict`              |
| `propagation.ts`          | Mount    | Mounted | Mounted under `/propagation`          |
| `ramp.ts`                 | Mount    | Mounted | Mounted under `/ramp`                 |
| `sandwich.ts`             | Mount    | Mounted | Mounted under `/mev/sandwich`         |
| `sdks.ts`                 | Mount    | Mounted | Mounted under `/sdks`                 |
| `search-routes.ts`        | Delete   | Deleted | Superseded by `search.ts`             |
| `token-holders.ts`        | Mount    | Mounted | Mounted under `/token-holders`        |
| `audit-report.ts`         | Mount    | Mounted | Mounted under `/audit-reports`        |
| `graph.ts`                | Mount    | Mounted | Mounted under `/graph`                |
| `verification-results.ts` | Mount    | Mounted | Mounted under `/verification-results` |
