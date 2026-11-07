-- phase: expand
-- Agent Streams S6: the chat plays mode of an agent stream. The owner sets the time box (5 to 30 minutes) and
-- the cap (money), presses Go to arm the session, and the desk reports the queue the overlay shows (its top
-- three, with their votes) and the current request.
--
-- Expand only: the columns are optional and an older release ignores them. A stream that is not a chat plays
-- stream keeps the defaults and behaves exactly as before.

ALTER TABLE agent_streams ADD COLUMN plays_time_box_minutes integer NOT NULL DEFAULT 10;
ALTER TABLE agent_streams ADD COLUMN plays_cap_cents integer NOT NULL DEFAULT 0;
ALTER TABLE agent_streams ADD COLUMN plays_armed_at timestamptz;
ALTER TABLE agent_streams ADD COLUMN plays_spent_cents integer NOT NULL DEFAULT 0;
ALTER TABLE agent_streams ADD COLUMN plays_wiped_at timestamptz;
ALTER TABLE agent_streams ADD COLUMN plays_queue jsonb;

-- The controls of S5 gain the S6 one: Wipe now stops the run and resets the sandbox.
DO $$ BEGIN
    ALTER TABLE agent_stream_controls DROP CONSTRAINT IF EXISTS agent_stream_controls_control_check;
    ALTER TABLE agent_stream_controls ADD CONSTRAINT agent_stream_controls_control_check
        CHECK (control IN ('pause', 'curtain', 'mute', 'end', 'wipe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The sandbox workers (S6): the network-isolated workers that would run a chat plays request. A worker
-- checks in for the person it works for and is healthy while it keeps checking in. None exists yet, so the
-- chat plays mode is refused until one does.
CREATE TABLE IF NOT EXISTS agent_sandbox_workers (
    id           text COLLATE "C" PRIMARY KEY,             -- sbw_<ULID>
    subject      text COLLATE "C" NOT NULL,               -- the person the worker works for (usr_…)
    service      text COLLATE "C" NOT NULL,               -- the service that owns the worker (codes, actor, …)
    endpoint     text COLLATE "C",                        -- where the worker listens, when it has one
    status       text COLLATE "C" NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'stopped')),
    last_seen_at bigint NOT NULL,
    created_at   bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sandbox_workers_subject ON agent_sandbox_workers (subject);
