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
