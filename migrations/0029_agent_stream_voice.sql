-- phase: expand
-- Agent streams, S4 (design 2026-11-06, plan-state-2026-10-22/AGENT-STREAMS-S4-VOICE-DESIGN-2026-11-06.md): the
-- agent's voice. A stream in narrated mode speaks at moments the agent picks, and the desk makes the sound.
--
-- The voice settings live beside the agent stream (not on managed_streams, whose rows go to channel pages):
-- which Chat voice to use, which personality to write in, whether the voice is muted (the owner's kill switch and
-- the moderators' one), whether the person has opted into their own cloned voice, and whether the allowance ran
-- out ("voice paused: allowance spent").
--
-- A line is what the desk reads: one or two sentences, at most 220 characters, plain text. The lines are kept so the
-- overlay can caption them and the recording can carry them as WebVTT.
--
-- ADD-only: an older release ignores the columns and the table; nothing else changes.
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS voice text;
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS personality text NOT NULL DEFAULT 'calm' CHECK (personality IN ('calm', 'hype', 'dry', 'roast'));
-- The kill switch: the owner mutes the voice here, and a channel moderator can mute it too.
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS voice_muted boolean NOT NULL DEFAULT false;
-- The person's own cloned voice, only with their explicit opt-in (voice_own_consent_at is when they said yes).
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS voice_own boolean NOT NULL DEFAULT false;
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS voice_own_consent_at timestamptz;
-- Set when the person's allowance ran out; the stream then shows "voice paused: allowance spent".
ALTER TABLE agent_streams ADD COLUMN IF NOT EXISTS voice_paused text;

CREATE TABLE IF NOT EXISTS agent_stream_lines (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL REFERENCES managed_streams(id) ON DELETE CASCADE,
    step_id bigint REFERENCES agent_stream_steps(id) ON DELETE SET NULL,
    at timestamptz NOT NULL,
    text text NOT NULL,
    personality text NOT NULL CHECK (personality IN ('calm', 'hype', 'dry', 'roast')),
    voice text,
    kind text NOT NULL DEFAULT 'step' CHECK (kind IN ('step', 'failure', 'result', 'idle')),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The desk's "lines after this id" poll and the recording's caption read.
CREATE INDEX IF NOT EXISTS agent_stream_lines_stream ON agent_stream_lines (managed_stream_id, id);
