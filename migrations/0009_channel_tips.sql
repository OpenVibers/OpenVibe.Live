-- phase: expand
-- Every tip a channel received, whatever carried it, as Live shows it (server/monetization/channel-tips.js): Vibes
-- donated on the site, tips on the streamer's own PowerChat, and tips OpenVibe.Tips announces after Billing settled
-- them. The stream leaderboard, after-stream recaps, VOD pages and the home's "Vibes tipped" and supporters read this,
-- not the money ledger: under BILLING_AUTHORITY=billing Live's `transactions` stops at the cutover and Billing is the
-- ledger, and PowerChat and Tips tips were never in it. Display rows only; no balance is derived from them.
--
-- from_user_id is the supporter's Live account when they have one; `username` is the name shown for a supporter who
-- has none (PowerChat, Tips), NULL otherwise (the account's current name is read instead). amount is in Vibes, NULL
-- when the supporter hid it (Tips privacy.hide_amount). ref is the tip's own id, so recording it twice keeps one row:
-- live-txn:<transactions.id>, billing-txn:<Billing transaction id>, powerchat:<event id>, tips:<delivery key>.
CREATE TABLE IF NOT EXISTS channel_tips (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    to_user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    username     text COLLATE "C",
    stream_id    bigint REFERENCES streams(id) ON DELETE SET NULL,
    amount       bigint CHECK (amount IS NULL OR amount >= 0),
    source       text COLLATE "C" NOT NULL CHECK (source IN ('vibes', 'powerchat', 'tips')),
    ref          text COLLATE "C" NOT NULL UNIQUE,
    created_at   text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS idx_channel_tips_recent ON channel_tips (created_at);
CREATE INDEX IF NOT EXISTS idx_channel_tips_channel ON channel_tips (to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_tips_stream ON channel_tips (stream_id) WHERE stream_id IS NOT NULL;

-- The donations Live's ledger already holds (on-site Vibes and site-routed PowerChat tips).
INSERT INTO channel_tips (to_user_id, from_user_id, stream_id, amount, source, ref, created_at)
SELECT t.to_user_id, t.from_user_id, t.stream_id, t.amount, 'vibes', 'live-txn:' || t.id, COALESCE(t.created_at, ov_now())
  FROM transactions t
 WHERE t.type = 'donation' AND t.to_user_id IS NOT NULL AND t.amount >= 0
   AND COALESCE(t.status, 'completed') NOT IN ('failed', 'refunded', 'pending')
ON CONFLICT (ref) DO NOTHING;
