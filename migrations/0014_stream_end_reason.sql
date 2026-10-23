-- phase: expand
-- Why a stream ended (plan 2026-10-22, track C2: where first-time streamers drop). A streamer whose first stream ran
-- under a minute either stopped it or lost it; the stream row could not say which. db.endStream(id, reason) records the
-- first reason given: streamer, staff, broadcaster_left, ingest_ended, heartbeat_lost, dead_air. NULL for streams that
-- ended before this column, and for an end path that names none.
ALTER TABLE streams ADD COLUMN IF NOT EXISTS end_reason text;
