-- phase: expand
-- Flagged speech (plan §AD.11 item 3, 2026-11-15): a transcribed window of a recording whose words read as one of
-- OpenVibe.AI's hard-floor lines. AI delivers such a window flagged instead of dropping it (AI #597); Live counts it
-- (live_transcript_floor_flags_total) and keeps it here for staff to review: which recording, which second, which
-- line. Never the words: staff open the recording at that second.
--
-- One row per window and line (a retried window is the same row). status: open until staff look; cleared (nothing
-- wrong) or handled (staff acted: the recording removed, the channel banned, a report filed). A moderation record:
-- kept when the person's account is deleted, like bans (server/auth/account-data.js RETAIN).
CREATE TABLE IF NOT EXISTS transcript_flags (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source      text COLLATE "C" NOT NULL,                  -- 'vod:<id>', 'clip:<id>', or the recording's path
    kind        text COLLATE "C" NOT NULL CHECK (kind IN ('vod', 'clip', 'media')),
    item_id     text COLLATE "C",                           -- the VOD or clip id on OpenVibe.Media, when known
    user_id     bigint,                                     -- the channel's owner, when known
    path        text COLLATE "C",                           -- the recording's path (never a signed URL's query)
    start_sec   integer NOT NULL,
    rule        text COLLATE "C" NOT NULL,
    status      text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'handled')),
    reviewed_by bigint REFERENCES users(id) ON DELETE SET NULL,  -- the staff member who looked
    reviewed_at text COLLATE "C",
    created_at  text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_flags_window ON transcript_flags (source, start_sec, rule);
CREATE INDEX IF NOT EXISTS transcript_flags_open ON transcript_flags (created_at DESC) WHERE status = 'open';
