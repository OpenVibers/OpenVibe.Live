-- phase: expand
-- no-transaction
-- The home hero's day/week/month/previous-week memory counts (server/db/database.js winCount) filter
-- stream_memories by created_at 4 times per stats read: 3,306 + 3,306 + ... calls at 68 ms mean on 2026-11-08,
-- each a 22 MB sequential scan. created_at has no index; a plain btree serves the >= and BETWEEN ranges.
CREATE INDEX CONCURRENTLY IF NOT EXISTS stream_memories_created_at ON stream_memories (created_at);
