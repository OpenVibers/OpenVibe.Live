-- phase: contract
-- after: 0009
-- Live's own money ledger (plan 2026-10-22, J1). OpenVibe.Billing is the only ledger since the cutover of 2026-10-17:
-- every checkout, donation, cashout, subscription and balance is a Billing call (Live#182), the home's money counts
-- come from Billing (Live#184), and the tips Live shows are in channel_tips (0009, applied 2026-10-17 02:04 UTC, which
-- copied the donations this ledger held). Since then nothing under server/ reads or writes these tables or the users
-- money columns (test/money-tables-gone.test.js; the remaining mentions blank or omit the columns in answers), and a
-- person's money history comes from Billing for export and deletion (Billing#77, Network#264). The last write to any
-- of them was 2026-08-27.
-- vpn_approvals goes too: Live#303 removed its routes on 2026-10-22, and it never had a row on PostgreSQL.
-- Rollback: the operator's pg_dump of these tables and columns, taken before the deploy.
-- users is busy: wait at most 5 s for its lock rather than queue every reader behind the ALTER (a timeout fails the
-- boot, and the deploy keeps the running release).
SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP COLUMN IF EXISTS openvibe_bucks_balance;
ALTER TABLE users DROP COLUMN IF EXISTS openvibe_bucks_cashout_balance;
ALTER TABLE users DROP COLUMN IF EXISTS openvibe_coins_balance;

DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS payment_orders;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS vpn_approvals;
