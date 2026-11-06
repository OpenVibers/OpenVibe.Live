-- phase: expand
-- Agent streams, S2 (design 2026-11-06, plan-state-2026-10-22/AGENT-STREAMS-S2-DESIGN-2026-11-06.md): the steps an
-- agent posts while it works, so the player can draw the overlay (the task, the current step and a timeline) and the
-- recording can carry chapters.
--
-- A step belongs to the agent stream (managed_streams.id), not to one live session: the steps outlive the WHIP session
-- and travel with the VOD. `at` is when the step began (the agent may say so; the server's own clock is used when it
-- does not), `created_at` is when Live stored it — that is the clock the one-a-second limit reads, so a desk that
-- backdates a step cannot post faster than a person can read it.
--
-- ADD-only: an older release ignores the table; nothing else changes.
CREATE TABLE IF NOT EXISTS agent_stream_steps (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL REFERENCES managed_streams(id) ON DELETE CASCADE,
    at timestamptz NOT NULL,
    title text NOT NULL,
    status text NOT NULL CHECK (status IN ('started', 'passed', 'failed', 'skipped')),
    detail text,
    tests_passed integer,
    tests_failed integer,
    cost_usd numeric(12, 6),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The page's "steps after this id" poll and the card's "last N, oldest first" read.
CREATE INDEX IF NOT EXISTS agent_stream_steps_stream ON agent_stream_steps (managed_stream_id, id);
-- A chapter is a step whose status is 'started'; its time is `at`.
CREATE INDEX IF NOT EXISTS agent_stream_steps_started ON agent_stream_steps (managed_stream_id, at) WHERE status = 'started';
