-- phase: expand
-- Agent Streams S7 (design 2026-11-06, AGENT-STREAMS-S7-REACH-DESIGN): schedules for public agent streams.
--
-- An owner schedules a public agent stream: a time, a task template and the mode. The schedule shows on the
-- channel's Agents tab and in Today 24 hours before its time. When the time comes, the owner's desk claims it: Live
-- creates the stream and hands the desk its publish ticket. A desk that is not online does not claim, and Live
-- records the schedule as missed with 'desk_offline' ("didn't start: the desk was offline") and starts nothing. A
-- chatplays schedule never starts on its own; it waits for the owner's Go (the S6 rule).
--
-- agent_desks is the desk heartbeat: a desk says it is online every 30 s, so the sweep can tell 'the desk was
-- offline' apart from 'the desk was online but the task was not ready'. A heartbeat is a fact, not a stream: it
-- carries no ticket and no secret.
--
-- agent_schedule_reminders is opt-in: a follower who asks for a reminder gets one Today notification. The row names
-- the person, and the schedule's public view carries only the count.
--
-- Expand only: every table is new and an older release ignores all of it.
CREATE TABLE IF NOT EXISTS agent_stream_schedules (
    id               text COLLATE "C" PRIMARY KEY,       -- scd_<ULID>
    user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    managed_stream_id bigint REFERENCES managed_streams(id) ON DELETE SET NULL,
    title            text COLLATE "C" NOT NULL,
    task             jsonb NOT NULL,
    mode             text COLLATE "C" NOT NULL DEFAULT 'watch' CHECK (mode IN ('watch', 'narrated', 'copilot', 'chatplays')),
    visibility       text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (visibility IN ('private', 'unlisted', 'public')),
    starts_at        timestamptz NOT NULL,
    state            text COLLATE "C" NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled', 'live', 'ended', 'missed', 'cancelled')),
    missed_reason    text COLLATE "C" CHECK (missed_reason IN ('desk_offline', 'task_not_ready', 'waits_for_go')),
    waits_for_go     boolean NOT NULL DEFAULT false,
    started_at       timestamptz,
    ended_at         timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_stream_schedules_due ON agent_stream_schedules (starts_at) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS agent_stream_schedules_user ON agent_stream_schedules (user_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_schedules_stream ON agent_stream_schedules (managed_stream_id) WHERE managed_stream_id IS NOT NULL;

-- The desk's heartbeat: online means 'heard from within the last three minutes'.
CREATE TABLE IF NOT EXISTS agent_desks (
    user_id      bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    version      text COLLATE "C"
);

-- A follower's opt-in to a schedule's reminder. The subject is the follower's Network subject, so a schedule's
-- reminder survives a Live account rename; the public view carries the count only.
CREATE TABLE IF NOT EXISTS agent_schedule_reminders (
    schedule_id text COLLATE "C" NOT NULL REFERENCES agent_stream_schedules(id) ON DELETE CASCADE,
    subject_id  text COLLATE "C" NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (schedule_id, subject_id)
);
