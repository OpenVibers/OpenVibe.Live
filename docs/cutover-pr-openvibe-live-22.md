# Cutover: channel ↔ Bot robot binding (PR #22, `channels.bot_robot_id`)

PR #22 (`c3e93a4`, "Bind a channel to a Bot robot and expose botembed behind LIVE_BOTEMBED") is a data change:
it adds one nullable column to Live's own SQLite database.

- [server/db/schema.sql](../server/db/schema.sql) declares `channels.bot_robot_id TEXT` (after
  `active_control_config_id`).
- [server/db/database.js](../server/db/database.js) adds the same column idempotently on boot
  (`ALTER TABLE channels ADD COLUMN bot_robot_id TEXT` when `PRAGMA table_info(channels)` lacks it) and accepts
  `bot_robot_id` in `updateChannel`'s allowlist.
- [server/bot/embed.js](../server/bot/embed.js) and [server/bot/routes.js](../server/bot/routes.js) read and write it
  behind `LIVE_BOT_EMBED` (off by default): with the flag off the `PUT /api/streams/channel/:username/bot` route answers
  404 and the channel JSON has no `bot_embed` key; the stored id is kept.
- [server/web/serializers.js](../server/web/serializers.js) never leaks `bot_robot_id` on public channel rows; it is only
  surfaced as `bot_embed` on `GET /api/streams/channel/:username` (see [README.md](../README.md), "Bot panel embed").

The change is **additive and non-destructive**: a new nullable column, no rewrite, backfill or delete, no read of any
existing row, and no PostgreSQL migration (Live's `channels` table is SQLite). Every existing query, the previous release
and a rollback all ignore the extra column, so the deploy carries no data-movement step.

## Preconditions

- `ov access run openvibe-ovh health live` answers `ready` before you start.
- The range from the running release to this head carries no other data change; auto-finish refuses such a range,
  deploy those commits through their own runbook first.
- The flag order below: **Bot deployed first**. `GET /panel/<robot id>/embed` must exist in OpenVibe.Bot and its
  `BOT_EMBED_ORIGINS` must include this site's origins, or the embed frame stays empty.

## Order

1. **Back up.** `ov access run openvibe-ovh db-backup`: back up the databases now and check the Live backup's stamp
   (`<backupDir>/live/<YYYYMMDD-HHMMSS>/live.db`, `ok: true` in `<stateDir>/backups/live.jsonl`). This is the way back to
   a database without the column; the deploy's own pre-deploy backup also runs because `server/db/schema.sql` changed.
2. **Deploy with the flag off** (the default). `ov access run openvibe-ovh deploy live -- --wait-idle`: ships the range
   since the running release and restarts, gated on `/api/ready`. Boot adds the column; no data moves.
3. **Verify** (below), then, later and separately on the owner's go, **turn the flag on**: Bot deployed → set
   `LIVE_BOT_EMBED=1` in `/etc/openvibe/live.env` → `ov access run openvibe-ovh restart live` while no one is live →
   bind a channel. Step 3 is not part of this deploy.

## How to check success (verification)

- **Boot log.** `ov access run openvibe-ovh logs live 200` prints `[DB] Added bot_robot_id column to channels` once on
  the first boot of the new release and never again; no `no such column: bot_robot_id` and no migration `failed`.
- **Column present.** On the host, read-only:
  `sqlite3 -readonly <Live's data dir>/live.db "SELECT name FROM pragma_table_info('channels') WHERE name = 'bot_robot_id'"`
  prints `bot_robot_id`, and every other column is unchanged.
- **App still serves.** `ov access run openvibe-ovh health live` is `ready`; `GET https://openvibe.live/api/streams/channel/<a live channel>`
  returns 200 and, with the flag off, carries no `bot_embed` key (and never a `bot_robot_id`). With the flag on, the owner
  binds with `PUT /api/streams/channel/:username/bot {"robot_id":"rob_…"}` and the same GET shows
  `bot_embed: { enabled: true, robot_id, url }`.
- `test/bot-embed-binding.test.js` covers the route and the channel JSON (the pipeline's verify runs it).

## Rollback / restore

`ov access run openvibe-ovh rollback live` alone is enough: the previous release's code does not read, write or serialize
`bot_robot_id`, so it runs against this database unchanged, and the dropped-flag state is simply the default. Then
`ov access run openvibe-ovh health live` must be `ready`. No restore is needed — the column is additive and unused.

If a restore is ever wanted anyway (to a database literally without the column), the owner restores the step 1 backup with
the previous release: `ov rollback live`; on the host stop Live, copy the backup's `live.db` over Live's database (as the
service user, owner and mode as before, no stale `-wal`/`-shm` beside it), start Live, `health live`. Restoring also
discards every other Live write made since step 1, so prefer the plain rollback: the extra column affects nothing that
runs.

## Rehearsal

The harness runs `ov rehearse OpenVibe.Live 22` on its scratch PostgreSQL (main's migrations, the repository's fixtures,
this PR's migrations, then the block below). This PR adds no migration under `migrations/` (the column is SQLite and
added inline), so the rehearsal's migrate step applies nothing on the second run; the commands confirm the change is
present and parses.

```rehearse
# The column is SQLite-only (schema.sql + the idempotent ADD COLUMN in database.js): the scratch PostgreSQL
# holds only the analytics slice, so these check the change is declared, added idempotently and exposed.
node --check server/bot/embed.js
node --check server/bot/routes.js
grep -q 'bot_robot_id TEXT' server/db/schema.sql
grep -q 'ADD COLUMN bot_robot_id TEXT' server/db/database.js
grep -q "LIVE_BOT_EMBED === '1'" server/bot/embed.js
grep -q "bot_robot_id" server/web/serializers.js
```

REHEARSAL: green
