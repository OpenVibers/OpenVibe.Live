# Live PostgreSQL migration: slice 1

Status: implementation slice, 2026-09-30. The default remains SQLite.

## Decision

Move page analytics first, behind `ANALYTICS_DRIVER=postgres`. It is Live's second SQLite database and already has a PostgreSQL implementation in the pinned `openvibe-shared` release. Its request-facing `record()` stays synchronous while the PostgreSQL tracker buffers writes; only the three analytics read routes and the retention job need to await database work. This makes the slice deployable independently of the 2,000-plus synchronous calls to Live's primary database.

`ANALYTICS_DRIVER` defaults to `sqlite`. With `postgres`, `DATABASE_URL` connects the runtime tracker to PostgreSQL. Run `DATABASE_DIRECT_URL=... npm run migrate:analytics-pg` with the schema owner before enabling it. The migration is versioned and checked by the SDK. Startup checks that `analytics_events` exists; the runtime role never creates tables. `LIVE_DRILL` uses its isolated SQLite analytics file regardless of the driver setting and starts no analytics timers or outbound calls. Existing SQLite analytics data is not imported by this slice; preserve the file and import its history before a production analytics switch if historical dashboards must be continuous.

## Target architecture

The primary Live database will use `openvibe-sdk/db` with `DATABASE_URL`, versioned PostgreSQL migrations on `DATABASE_DIRECT_URL`, and async methods retaining the current exported names. Generate its schema from a booted SQLite database, omit the frozen tables, and move all boot-time DDL into migrations. PostgreSQL analytics then shares that database and migration ledger. Live's outbox and inbox use SDK PostgreSQL implementations; page analytics uses `openvibe-shared/analytics/pg`. The cutover imports and verifies data through the Host switch procedure. The SQLite file remains the rollback copy for the agreed window.

## Next slices

1. Land the remaining Chat table retirement and settle money ownership before generating the primary schema, so deleted tables are never imported.
2. Add the primary database's async driver and generated schema in a separately tested slice; convert one bounded caller group at a time, including its transactions and route handlers. Keep SQLite as the default until every caller is async.
3. Convert the outbox/inbox, analytics history, drill guard, readiness, remaining callers, and tests; rehearse the import with row counts and checksums before the Host cutover.

The source survey is `openvibe/agents/jobs/brief-t4-live-pg.out.md`. The PostgreSQL analytics test runs against `OV_TEST_PG_DIRECT_URL`; it skips when the disposable service is unavailable.
