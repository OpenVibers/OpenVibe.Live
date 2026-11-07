-- phase: expand
-- Agent streams, S5 (design 2026-11-06, plan-state-2026-10-22/AGENT-STREAMS-S5-COPILOT-DESIGN-2026-11-06.md):
-- Co-pilot. The stream's mode can be `copilot` (Contracts 0.303.0, live.agent-stream@1), which implies Narrated and
-- turns on the chat digest reads and polls on OpenVibe.Chat. The owner and the channel's moderators have four
-- controls (pause, curtain, mute, end); every press is logged with who pressed it.
--
-- The pause is the task's service reading it and stopping at the next safe point: `paused`, `paused_by` and
-- `paused_by_role` travel in the state the desk polls. A moderator may not resume a pause the owner set.
--
-- The task's service declares it can read a digest (`copilot_ready`): Codes and Actor do, a desk does not. Co-pilot
-- needs a public or unlisted stream, a ready service and the narrated voice.
--
-- ADD-only: an older release ignores the columns and the table.
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS copilot_ready boolean NOT NULL DEFAULT false;
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS paused_by text;
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS paused_by_role text CHECK (paused_by_role IN ('owner', 'moderator'));
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- Every control the owner and the channel's moderators pressed over a Co-pilot stream, and who pressed it.
CREATE TABLE IF NOT EXISTS agent_stream_controls (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL REFERENCES managed_streams(id) ON DELETE CASCADE,
    control text NOT NULL CHECK (control IN ('pause', 'curtain', 'mute', 'end')),
    by_handle text NOT NULL,
    by_role text NOT NULL CHECK (by_role IN ('owner', 'moderator')),
    paused boolean,                                   -- for a pause: true = paused, false = resumed
    paused_by text,                                   -- whose pause is in force after this press
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_stream_controls_stream ON agent_stream_controls (managed_stream_id, id DESC);
