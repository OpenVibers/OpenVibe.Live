-- phase: contract
-- after: 0002
-- ADR-054 §8: Live's cosmetics live in OpenVibe.Inventory since 2026-10-09 14:53 UTC. The import was applied and verified
-- row for row first (8 people, 153 unlocks, 16 slots), and since Live#54 nothing in Live reads or writes these three
-- (test/cosmetics-tables-gone.test.js). user_equipped_tag held 0 rows: the legacy game that wrote it is gone.
-- The N-1 release (Live#54) names none of them. Rollback: OpenVibe.Inventory holds every row (its scripts/import-live.js
-- --verify compared them); the operator-side dump taken before the deploy restores the tables if ever needed.
DROP TABLE IF EXISTS user_equipped_tag;
DROP TABLE IF EXISTS user_equipped;
DROP TABLE IF EXISTS user_cosmetics;
