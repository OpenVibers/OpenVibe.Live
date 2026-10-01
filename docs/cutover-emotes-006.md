# Cutover: migration 006_drop_emotes (T3 N+3)

PR #1 (merge `70b67309`, "T3 N+3: drop Live's emotes copy (Chat owns it)") adds the destructive migration
`006_drop_emotes` ([server/db/migrations.js](../server/db/migrations.js)): on the first boot of the new release
Live runs `DROP TABLE IF EXISTS emotes` on its SQLite database and records `006_drop_emotes` as `applied` in
`schema_migrations`. A database without the table (a fresh install) records it as `adopted` and drops nothing.
The same PR removes `emotes` from [server/db/schema.sql](../server/db/schema.sql) and the two inline emotes
migrations from [server/db/database.js](../server/db/database.js), so nothing recreates the table.

## Preconditions

- **The production release `fb3957f` no longer reads Live's `emotes`.** It is the N-1 release for this deploy;
  `test/n-1.test.js` replays its recorded statements against the new schema and
  `test/chat-staged-tables.test.js` fails on any `server/` or `scripts/` read or write of the table. The
  old emote routes (`server/emotes/routes.js`) were deleted in N+1 (`8654ef6`).
- **OpenVibe.Chat owns and serves emotes.** nginx sends `openvibe.live/api/emotes` to Chat; the dashboard,
  channel page and upload UI call Chat's `/api/chat/channels/:id/…` and `/api/emotes`; Live reads only through
  Chat's internal read API ([docs/chat-system.md](chat-system.md), "The six chat tables are Chat's").
- **No copy into Chat is needed, and none must be made.** Chat's `emotes` already holds Live's rows: before the
  T3 flip, Live's relay snapshotted `live.db`, imported the snapshot into Chat and relayed every later change
  (`chat-tables-sync.js`, deleted in `8654ef6`); the flip of all six tables to Chat on 2026-09-29 14:46 UTC
  happened after dual-read parity. Since then every emote upload, edit and delete has been written by Chat
  only, so Live's table is a stale snapshot from the flip. Copying it back into Chat would undo the changes
  made since. Both databases were also backed up at the flip (`/var/lib/openvibe-backups/t3-20260929T144556Z`).
- `ov access run openvibe-ovh health live` answers `ready` before you start.

## Order

1. `ov access run openvibe-ovh db-backup`: back up the databases now. Note the Live backup's stamp
   (`<backupDir>/live/<YYYYMMDD-HHMMSS>/live.db`, recorded in `<stateDir>/backups/live.jsonl`) and check that it is
   `ok: true`. This is the only way back to a database that still has the table.
2. `ov access run openvibe-ovh health live`: `ready`.
3. `ov access run openvibe-ovh deploy live -- --wait-idle`: ships the range since the running release (it
   includes `70b67309`). The first boot runs 006.
4. `ov access run openvibe-ovh health live`: `ready`.

## How to check success

- **Ledger.** `GET https://openvibe.live/api/admin/diagnostics` (admin session) → `migrations` has
  `{ "id": "006_drop_emotes", "mode": "applied" }`; no entry is `failed`. The boot log
  (`ov access run openvibe-ovh logs live`) has `[DB] migration 006_drop_emotes applied in …ms` once, and a later
  restart does not print it again.
- **The table is gone.** On the host, read-only:
  `sqlite3 -readonly <Live's data dir>/live.db "SELECT name FROM sqlite_master WHERE name = 'emotes'"` prints
  nothing, and `"SELECT id, mode FROM schema_migrations WHERE id = '006_drop_emotes'"` prints
  `006_drop_emotes|applied`.
- **Emotes still render from Chat.** `curl -s https://openvibe.live/api/emotes` (served by Chat) lists the
  emotes; on a watch page with channel emotes, chat shows a sent emote code as its image, and the emote panel
  lists the channel's and the global emotes. Nothing in Live's logs mentions `no such table: emotes`.

## Rollback

`ov access run openvibe-ovh rollback live` alone does **not** bring the table back: it switches to the previous
release's code against the same database, and `fb3957f` does not need the table, so it runs, but the
dropped rows are gone. To get Live's `emotes` copy back (there is no reason to expect it to be needed: Chat
serves emotes and holds newer rows than this copy), the owner restores the step 1 backup with the previous
release:

1. `ov access run openvibe-ovh rollback live` (back to the previous release).
2. On the host: stop Live, copy the step 1 backup's `live.db` over Live's database (as the service user, owner
   and mode as before, with no stale `-wal`/`-shm` beside it), start Live.
3. `ov access run openvibe-ovh health live`: `ready`.

Restoring the backup also discards every other Live write made between step 1 and the restore, so prefer
leaving the table dropped: a missing `emotes` table affects nothing that runs.

## Rehearsal

Rehearsal `live-emotes-006`, 2026-10-01, Node 22.22.1 (production's; the shared `node_modules` has
`better-sqlite3` built for it), on exports of the two commits in `/tmp/ov-emotes-006/{old,new}`
(`git archive 70b6730^1` = `51f772b`, `git archive 70b6730`). `rehearse.js` opens `DATA_DIR`'s `live.db` through
the given release's `db.initDb()` — the call `server/index.js` boots with, schema plus `migrations.run()` —
then seeds (`seed`: 2 users, 3 emotes, then writes every table's row count to `DATA_DIR/counts.json`) or reports
(`check`: the 006 ledger row, whether `emotes` exists, every other table's count against `counts.json`).

```
$ export PATH=~/.local/share/fnm/node-versions/v22.22.1/installation/bin:$PATH; R=/tmp/ov-emotes-006
$ DATA_DIR=$R/data node rehearse.js $R/old seed        # pre-PR code, 70b6730^1
[DB] Rebuilt emotes table: code uniqueness is now per-channel
seeded: emotes=3 users=2 tables=82
ledger: 001_vibes_decimal_to_bits,002_pastes_ai_columns,004_hot_path_indexes,005_drop_chat_staged_tables
$ DATA_DIR=$R/data node rehearse.js $R/new check       # new code, 70b6730: first boot
[DB] migration 006_drop_emotes applied in 1ms
006 ledger rows: [{"id":"006_drop_emotes","mode":"applied"}]
emotes table exists: false
other tables compared: 80, count changes: none, missing: none
schema_migrations rows: 4 -> 5
$ DATA_DIR=$R/data node rehearse.js $R/new check       # second boot: no-op (no "applied" line)
006 ledger rows: [{"id":"006_drop_emotes","mode":"applied"}]
emotes table exists: false
other tables compared: 80, count changes: none, missing: none
schema_migrations rows: 4 -> 5
$ DATA_DIR=$R/fresh node rehearse.js $R/new check      # fresh database
006 ledger rows: [{"id":"006_drop_emotes","mode":"adopted"}]
emotes table exists: false
```

`npm test` at `70b6730` (Node 22.22.1):

```
$ cd $R/new && set -o pipefail && npm test            # the git-less export
✓ account-data.test.js / ✓ chat-staged-tables.test.js / ✓ destructive-migrations.test.js
✓ frozen-tables.test.js / ✓ n-1.test.js
✗ drill-mode.test.js       Error: Command failed: git rev-parse --short=12 HEAD (not a git repository)
✗ release-events.test.js   git rev-parse: '' does not match /^[0-9a-f]{40}$/
152/157 test files passed, 3 skipped (… rollback-newer-writes.test.js: skipped (no git history …))
$ # the three git-dependent files, in the git worktree at 70b6730 (NODE_PATH = the same node_modules)
$ node test/drill-mode.test.js            → drill-mode: all checks passed (21 passed, 0 failed)
$ node test/release-events.test.js        → release events: … — all checks passed
$ node test/rollback-newer-writes.test.js → rollback with newer writes: the release of ae589aca works on this release's database, and back again
```

The two failures in the export are only the missing `.git`; in the git checkout all three pass (drill-mode's
symlink check also needs the checkout's `data/` to exist, as it does in production). The other two skips are
environmental (no PostgreSQL URL, no local model).

REHEARSAL: green
