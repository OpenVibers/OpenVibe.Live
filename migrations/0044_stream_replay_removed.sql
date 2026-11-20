-- phase: expand
-- A stream whose replay was deleted (2026-11-20, the owner on the home's Recently Online: "Not recorded … All VODs should
-- be recorded by default … this is a bug"): RePlayer009's 18-minute stream was recorded (VOD 6632) and its streamer
-- deleted the replay 13 minutes later; Media then had nothing for the stream and the card said "Not recorded". Live's
-- delete route now notes it here, and the card says "Replay deleted by the streamer" (or "Replay removed" when a
-- moderator removed it).
ALTER TABLE streams ADD COLUMN IF NOT EXISTS replay_removed_at text COLLATE "C";   -- ov_now(), like ended_at
ALTER TABLE streams ADD COLUMN IF NOT EXISTS replay_removed_by text COLLATE "C" CHECK (replay_removed_by IN ('streamer', 'moderator'));
