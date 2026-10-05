# Cutover: drop Live's copies of OpenVibe.Chat's chat tables (T3 final step, operator migration)

This change removes Live's last references to the twelve chat tables OpenVibe.Chat owns —
`chat_messages`, `dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`,
`tts_voice_overrides`, `channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`,
`stream_first_chats` and `moderation_actions` — stops creating them, and adds the operator migration
**`op_003_drop_chat_tables`** ([server/db/migrations.js](../server/db/migrations.js)) plus the script
that runs it, [scripts/chat-tables-drop.js](../scripts/chat-tables-drop.js).

Chat imported these tables with ids kept at the 2026-09-23 cutover and has been their only writer
since; Live's readers and writers are gone (PRs #28–#32 and the release that carries this migration).
Unlike the boot migrations, `op_003` is **not** applied on boot: the release before this one still runs
SQL over the tables (test/n-1.test.js), so they may only be dropped once that release is out of
rollback range (ADR-028, `test/fixtures/destructive-migrations.json`). The tables are Live's own
SQLite tables in `live.db`, not the shared PostgreSQL.

## Order

1. Confirm this release is the running one and has been through the rollback window:
   `ov access run openvibe-ovh health live` answers `ready` and the release list shows it as current
   (the previous release no longer in rollback range).
2. From the release directory as the service user, dry run: `node scripts/chat-tables-drop.js` — it
   prints which of the twelve tables exist and how many rows each holds; changes nothing.
3. `node scripts/chat-tables-drop.js --apply` — writes
   `<database dir>/backups/live-pre-chat-tables-drop-<time>.db` (mode 0600) and runs `op_003`, which
   drops the twelve tables and their indexes. The ledger outcome is printed (`applied`, or `already`
   on a repeat).

## Backup

- The script takes its own `live.db` backup before it drops anything and prints the path. Restoring
  that file is the way back to a database that still holds the rows.
- The host's wider snapshots (`ov access run openvibe-ovh db-backup`) are an alternative. The rows
  themselves live in OpenVibe.Chat, which imported them with ids kept — the backup is the operator's
  safety net, not their home.

## How to check success

- **Drop applied.** `--apply` prints `op_003_drop_chat_tables: applied`, and the read-only check on the
  host prints nothing for the tables and `applied` for the ledger row:

```sh
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT name FROM sqlite_master WHERE name IN ('chat_messages','dm_conversations','dm_participants','dm_messages','dm_blocks','tts_voice_overrides','channel_sounds','relay_users','hidden_relay_users','pending_ip_messages','stream_first_chats','moderation_actions')"   # → nothing
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT id, mode FROM schema_migrations WHERE id = 'op_003_drop_chat_tables'"  # → op_003_…|applied
```

- **Nothing else broke.** `ov access run openvibe-ovh health live` answers `ready`; a restart prints no
  `no such table` for any of the twelve, home stats and the admin chat console still answer (from
  Chat), and a chat line still reaches the watch page.
- **Idempotent.** Rerunning `--apply` prints `already` and drops nothing further.

## Rollback / restore

Dropping the tables is destructive and a code rollback does not bring them back — the previous release
runs fine without them (it reads them only on the paths production does not take). Restore only if the
backup turns out to be needed: roll back the release (`ov access run openvibe-ovh rollback live`), stop
Live, copy the script's backup (or the host `db-backup`) `live.db` over Live's database as the service
user with the original owner and mode and no stale `-wal`/`-shm` beside it, and start Live. Restoring
also discards every other Live write made since the backup, so prefer leaving the tables dropped.

## Rehearsal

[test/chat-tables-dropped.test.js](../test/chat-tables-dropped.test.js) checks the static guard
(nothing under `server/` names any of the twelve, the drop migration's own statements excepted), that a
fresh schema creates none of them, that a boot neither creates nor drops them, and that `op_003`
drops legacy copies and is idempotent on a second run. `test/n-1.test.js` proves the previous release
still prepares every statement it runs on a database this release migrated (which is why the drop must
not run at boot).
