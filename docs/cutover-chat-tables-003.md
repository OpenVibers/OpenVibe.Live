# Cutover: drop Live's copies of OpenVibe.Chat's chat tables (T3 final step, boot migration)

Live keeps no references to the twelve chat tables OpenVibe.Chat owns — `chat_messages`,
`dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`, `tts_voice_overrides`,
`channel_sounds`, `relay_users`, `hidden_relay_users`, `pending_ip_messages`, `stream_first_chats`
and `moderation_actions` — and does not create them. Boot migration **`007_drop_chat_tables`**
([server/db/migrations.js](../server/db/migrations.js)) drops them, with their indexes, on the next
boot after deploy.

Chat imported these tables with ids kept at the 2026-09-23 cutover and has been their only writer
since; Live's readers and writers are gone (PRs #28–#32 and the release that carries this migration,
#33). #33 is the production release, and its N-1 fixtures no longer run SQL over the tables
([test/n-1.test.js](../test/n-1.test.js)), so — unlike the earlier operator step `op_003` — the drop
is an ordinary boot migration (ADR-028, `test/fixtures/destructive-migrations.json`). The tables are
Live's own SQLite tables in `live.db`, not the shared PostgreSQL.

The previous operator migration `op_003_drop_chat_tables` and its script
[scripts/chat-tables-drop.js](../scripts/chat-tables-drop.js) are removed: they existed only while
the release before still read the tables. An operator who already ran `op_003` needs nothing — the
tables are gone, so `007` is adopted; a database that never ran it drops them on the next boot. An
`op_003_drop_chat_tables` row left in `schema_migrations` is harmless (the ledger ignores ids no
current migration uses).

## Order

1. Deploy this release. `initDb()` runs `007_drop_chat_tables` on the first boot and records
   `applied` (or `adopted` when none of the twelve exists, e.g. a fresh database or one where
   `op_003` already ran).
2. `ov access run openvibe-ovh health live` answers `ready` and a restart prints no `no such table`
   for any of the twelve. No operator action is needed; there is no script to run.

## Backup

- The host's snapshots (`ov access run openvibe-ovh db-backup`) taken before the deploy are the way
  back to a database that still holds the rows. Taking one before deploying this release is
  recommended, as for any contract step.
- The rows themselves live in OpenVibe.Chat, which imported them with ids kept — the backup is the
  operator's safety net, not their home.

## How to check success

- **Drop applied.** The read-only check on the host prints nothing for the tables and `applied` for
  the ledger row:

```sh
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT name FROM sqlite_master WHERE name IN ('chat_messages','dm_conversations','dm_participants','dm_messages','dm_blocks','tts_voice_overrides','channel_sounds','relay_users','hidden_relay_users','pending_ip_messages','stream_first_chats','moderation_actions')"   # → nothing
sqlite3 -readonly <Live's data dir>/live.db \
  "SELECT id, mode FROM schema_migrations WHERE id = '007_drop_chat_tables'"  # → 007_drop_chat_tables|applied
```

- **Nothing else broke.** `ov access run openvibe-ovh health live` answers `ready`; home stats and the
  admin chat console still answer (from Chat), and a chat line still reaches the watch page.
- **Idempotent.** A later boot keeps the ledger row and drops nothing further.

## Rollback / restore

Dropping the tables is destructive and a code rollback does not bring them back — the previous
release runs fine without them (it reads them only on paths production does not take). Restore only
if the backup turns out to be needed: roll back the release (`ov access run openvibe-ovh rollback
live`), stop Live, copy the host `db-backup` `live.db` over Live's database as the service user with
the original owner and mode and no stale `-wal`/`-shm` beside it, and start Live. Restoring also
discards every other Live write made since the backup, so prefer leaving the tables dropped.

## Rehearsal

[test/chat-tables-dropped.test.js](../test/chat-tables-dropped.test.js) checks the static guard
(nothing under `server/` names any of the twelve, the drop migration's own `DROP` statements
excepted), that a fresh schema creates none of them, and that the boot migration drops legacy copies
on a database that has them (`applied`) and is adopted on a fresh one. `test/n-1.test.js` proves the
previous release still prepares every statement it runs on a database this release migrated.
