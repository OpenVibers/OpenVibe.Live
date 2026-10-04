# Cutover: drop Live's `chat_bridge_outbox` (T3 J2, operator migration)

This PR ("Deliver chat only through Chat's ingress and drop the bridge outbox") deletes Live's old ordered-calls
chat bridge ([server/chat/chat-remote.js](../server/chat/chat-remote.js), `POST /internal/live/calls`) and leaves
[server/chat/chat-delivery.js](../server/chat/chat-delivery.js) as the only path into OpenVibe.Chat, through Chat's
typed ingress. It adds the operator migration **`op_002_drop_chat_bridge_outbox`**
([server/db/migrations.js](../server/db/migrations.js)) and the script that runs it,
[scripts/chat-bridge-outbox-drop.js](../scripts/chat-bridge-outbox-drop.js).

Unlike the boot migrations (`001…006`), `op_002` is **not** applied on boot: the release before this one still
writes `chat_bridge_outbox`, so the table may only be dropped once that release is out of rollback range
(ADR-028). The operator runs the script by hand after this release has been stable for the rollback window.

`chat_bridge_outbox` is Live's own SQLite table, so this cutover is on Live's `live.db`, not on the shared
PostgreSQL. The script has three modes:

- **(default) dry run** — prints the queued rows by op and boot; changes nothing.
- **`--deliver`** — hands every queued row to Chat's bridge receiver (`POST /internal/live/calls`, Live's
  service token for audience `openvibe.chat`, capability `chat.live_bridge.write`), in the order and boot the
  old bridge wrote them, each with idempotency key `live:<row id>` so Chat applies a write at most once.
  Acknowledged rows are deleted; a row Chat refuses is left for the operator; a transport error stops the run
  to be rerun later.
- **`--apply`** — takes an online backup of `live.db`, then runs `op_002`, which
  **refuses while any unacknowledged chat write (`op = 'db'`) is still queued**, so a write the old release queued is never lost.

## Order

1. Confirm this release is the running one and has been through the rollback window:
   `ov access run openvibe-ovh health live` answers `ready` and `ov access run openvibe-ovh releases live`
   shows the new release as current (the old writer no longer in rollback range).
2. Stop nothing; `--deliver` and `--apply` run against the live database. From the release directory as the
   service user: `node scripts/chat-bridge-outbox-drop.js` (dry run) — note the counts.
3. If the dry run shows queued chat writes: `node scripts/chat-bridge-outbox-drop.js --deliver` and rerun the
   dry run until it reports **0** chat writes (`op = 'db'`). Rows Chat refused stay and are reported with their
   ids; take those to the operator (they are not deleted).
4. `node scripts/chat-bridge-outbox-drop.js --apply` — writes
   `<database dir>/backups/live-pre-chat-bridge-drop-<time>.db` (mode 0600) and runs the drop. The ledger
   outcome is printed (`applied`, or `adopted` on a database that never had the table, `already` on a repeat).

## Backup

- The script takes its own `live.db` backup before it drops anything and prints the path (step 4). Restoring
  that file is the way back to a database that still holds the table's rows.
- A wider snapshot is also taken by the host: `ov access run openvibe-ovh db-backup` records Live's
  `<backupDir>/live/<YYYYMMDD-HHMMSS>/live.db` with `ok: true` in `<stateDir>/backups/live.jsonl`. Either copy
  is enough; keep the script's own file as it is the exact pre-drop state.

## How to check success (verification)

- **Delivery first.** After `--deliver`, the dry run prints `chat writes (op = 'db') Chat has not
  acknowledged: 0`. The delivered messages appear in Chat (reload a watch page: they load from Chat).
- **Drop applied.** `--apply` prints `op_002_drop_chat_bridge_outbox: applied`, and the read-only check on the
  host prints nothing for the table and `applied` for the ledger row:

```sh
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT name FROM sqlite_master WHERE name = 'chat_bridge_outbox'"        # → nothing
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT id, mode FROM schema_migrations WHERE id = 'op_002_drop_chat_bridge_outbox'"  # → op_002_…|applied
```

- **Nothing else broke.** `ov access run openvibe-ovh health live` answers `ready`; restarting Live does not
  print the migration again, and its logs contain no `no such table: chat_bridge_outbox`. Live's chat still
  delivers: send a chat message and see it in the Chat-served history, and the deploy-notice path still fires.
- **Idempotent.** Rerunning `--apply` prints `already` and drops nothing further.

## Rollback / restore

Dropping the table is destructive and a code rollback does **not** bring it back — the previous release runs
fine without the table (it is a chat send queue, not state). Only restore if a queued chat write turns out to
have been needed:

1. `ov access run openvibe-ovh rollback live` (back to the previous release).
2. Stop Live and copy the script's backup (or the host `db-backup`) `live.db` over Live's database, as the
   service user, with the original owner and mode and no stale `-wal`/`-shm` beside it; start Live.
3. `ov access run openvibe-ovh health live`: `ready`, then `--deliver` to flush the restored queue.

Restoring also discards every other Live write made since the backup, so prefer leaving the table dropped.
Stop Live only for the copy; `--deliver`/`--apply` themselves run online.

## Rehearsal

The migration and the delivery/drop contract are exercised by [test/chat-bridge-removed.test.js](../test/chat-bridge-removed.test.js)
against an in-memory SQLite database: it builds `chat_bridge_outbox`, checks that `op_002` refuses while a chat
write is queued, that `deliver()` sends queued rows in order per boot with keys `live:<id>` and deletes only
what Chat acknowledged, and that the drop then applies (and is `already` on a second run). The PR's PostgreSQL
migrations (`migrations/`) are unchanged, so the harness base/migrate steps apply nothing new; the command below
is the runbook's part.

```rehearse
seed: none
migrations: migrations
node test/chat-bridge-removed.test.js
```
