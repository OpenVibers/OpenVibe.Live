-- phase: contract
-- after: 0002
-- Vibe coding feeds are OpenVibe.Chat's since 2026-10-24 (Chat#144, its server/feeds/; the owner: "migrate that whole
-- entire feature so it's built into the openvibe.chat system"). Chat's scripts/import-live-feeds.js copied Live's feed
-- on 2026-10-25 (slot 1: its newest 5,000 of 42,620 events, scrubbed, verified id for id) and the raw export is kept in
-- /var/backups/openvibe/live-vibe-coding-2026-10-25.jsonl. Live#351 deleted everything that read these tables (its
-- publisher socket and routes answer 410), so the N-1 release names neither (test/vibe-coding-moved.test.js).
-- The slots' old settings stay inside managed_streams.broadcast_settings, read by nothing; they go with the next
-- rewrite of that column.
DROP TABLE IF EXISTS vibe_coding_events;
DROP TABLE IF EXISTS vibe_coding_sessions;
