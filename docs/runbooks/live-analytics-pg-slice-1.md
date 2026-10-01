# Cutover runbook: page analytics on PostgreSQL, slice 1

PR #2 (merge `7deab36`, [ADR](../adr-live-postgres-slice-1.md)) adds a PostgreSQL store for page
analytics behind `ANALYTICS_DRIVER`. It ships in two separate steps:

- **A. Deploy with the gate off.** The code goes live, analytics stay in SQLite, no data moves. This is
  the deploy the harness's `cutover` manifest covers.
- **B. Turn the gate on.** Later, on the owner's go, as its own change. Not part of A.

Rehearsal name: `live-analytics-pg-slice-1` (the harness records it in
`ds/deploy/rehearsals/live-analytics-pg-slice-1.json` once the checks below are green).

## Why A moves no data

- `server/analytics/store.js:8`: the driver defaults to `sqlite`. The only PostgreSQL branch is
  `store.js:15-34`, and `openvibe-sdk/db` and `openvibe-shared/analytics/pg` are required inside it
  (`:17-18`), so with the gate off they are not even loaded and no connection is opened.
- `store.js:36-46`: the SQLite store is what `server/index.js` built before PR #2: the same
  `paths.analyticsDbPath()`, WAL, the same `AnalyticsTracker` from the same `openvibe-shared` v2.3.1,
  `retention: false`, and the same prune. `ready()` is a no-op (`store.js:44`, awaited at
  `server/index.js:1122`).
- Nothing migrates at boot. The only `.migrate(` call is `scripts/analytics-pg-migrate.js:13`, which runs
  by hand with `DATABASE_DIRECT_URL`. ovhost's Live config takes its pre-deploy backup only on
  `server/db/migrations.js` or `server/db/schema.sql` changes and runs nothing from `migrations/`.
- Restore drills always use their own SQLite file, whatever the driver says (`store.js:14-15`).
- It fails safe. If `live.env` did say `ANALYTICS_DRIVER=postgres`, boot would throw before
  `/api/ready` answers 200: at `store.js:16` without `DATABASE_URL`, or at `store.js:26` because the
  tables were never migrated. ovhost then switches `current` back (exit 3).

## A. Deploy with the gate off

What the deploy does: `package-lock.json` changed (adds `pg`), so `npm ci` runs into the new release
before anything is interrupted. `server/` changed, so the service restarts, gated on `/api/ready`.
`--wait-idle` holds the restart until nobody is live.

Preconditions:

1. No freeze, and a green verify of the head being deployed.
2. The range from the running release to that head carries no other data change. Auto-finish refuses a
   range like that; deploy those commits through their own runbook first.
3. `/etc/openvibe/live.env` does not set `ANALYTICS_DRIVER=postgres`. Count it, never print it:
   `sudo grep -c '^ANALYTICS_DRIVER=postgres' /etc/openvibe/live.env` must print `0`. If nobody can check,
   the fail-safe above still holds.

Steps:

```bash
ov access run openvibe-ovh health live                  # must be ready before you start
ov access run openvibe-ovh deploy live -- --wait-idle
ov access run openvibe-ovh health live                  # ready again
ov access run openvibe-ovh logs live 200
```

Check the logs. None of these may appear: `ANALYTICS_DRIVER must be`,
`DATABASE_URL is required`, `analytics_events`, `[Analytics] Shutdown:`, a PostgreSQL connection error from `live-analytics`.
`/api/admin/analytics?hours=1` (admin) shows pageviews after the switch, so SQLite is still recording.

## Rollback

```bash
ov access run openvibe-ovh rollback live
ov access run openvibe-ovh health live
```

This selects the previous release with its own `node_modules`. Rolling back is safe for analytics because
this release writes `analytics.db` with the same tracker and the same `openvibe-shared` version, and wrote
nothing to PostgreSQL. `live.db` is not touched by PR #2. `test/rollback-newer-writes.test.js` still
covers booting last week's release on this release's `live.db`.

## B. Turn the gate on (later, separate)

Not part of A, and it needs the owner's go. Rehearse it on a restored copy first.

1. **Roles.** A schema owner for `DATABASE_DIRECT_URL` and a runtime role for `DATABASE_URL` with DML only:
   the runtime never creates tables (`store.js:25`). The OpenVibe.Host PostgreSQL procedure provisions
   them.
2. **Migrate.** From the current release on the host, with `DATABASE_DIRECT_URL` set for this one
   command, run `npm run migrate:analytics-pg`. It must print `migrations applied: 1; held: 0`, and a
   second run must print `applied: 0`. The migration is expand-only (`CREATE … IF NOT EXISTS`).
3. **History.** This slice does not import `analytics.db`. Keep that file. If dashboards must stay
   continuous, import the history before switching (a separate, rehearsed step).
4. **Switch.** In `live.env`, set `ANALYTICS_DRIVER=postgres` and `DATABASE_URL`, then
   `ov access run openvibe-ovh restart live` while nobody is live. Then run `health live` and check the
   logs for the errors listed under A. Admin analytics should show new pageviews, and the count of
   `analytics_events` rows for `service = 'live'` should grow.
5. **Off again.** Remove `ANALYTICS_DRIVER` (or set it to `sqlite`) and restart. Analytics go back to
   `analytics.db`. Rows recorded in PostgreSQL during the window stay there and are not merged back. The
   tables are additive, so there is nothing to undo.

## Rehearsal `live-analytics-pg-slice-1`

Green when all of these pass on the head being deployed:

- `npm test` (the harness verify): the full suite, with the SQLite default checked by
  `test/analytics-store.test.js`.
- `test/analytics-pg.test.js` against the SDK's disposable PostgreSQL (`OV_TEST_PG_DIRECT_URL` set, so it
  does not skip). It must print
  `analytics PostgreSQL: migration, record, privacy, reads, and prune passed`. This covers the migration
  (applied once, then idempotent), recording, privacy (no IP, user id or city stored), reads and prune.
- `test/rollback-newer-writes.test.js`.
