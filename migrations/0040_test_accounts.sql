-- phase: expand
-- Test accounts (probe and older manual test accounts, OpenVibe.Network users.is_test). Live keeps the flag on the
-- local user row so its public people surfaces (Recently Online, the directory, the home digest and the people
-- counts) can leave them out in SQL. The projection cache keeps it too, so the sync can follow linked accounts by
-- subject. Additive: an older release never reads either column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test bigint NOT NULL DEFAULT 0;
ALTER TABLE subject_projection ADD COLUMN IF NOT EXISTS is_test bigint NOT NULL DEFAULT 0;
