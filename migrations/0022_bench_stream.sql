-- phase: expand
CREATE TABLE live_bench_polls (
    id bigserial PRIMARY KEY,
    streamer_id bigint NOT NULL REFERENCES users(id),
    stream_id bigint NOT NULL REFERENCES streams(id),
    round_id text NOT NULL UNIQUE,
    kind_id text NOT NULL,
    prompt text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'open', 'closing', 'closed', 'failed')),
    duration_seconds integer NOT NULL,
    closes_at timestamptz,
    entries jsonb,
    vote_counts jsonb,
    judgement_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_bench_polls_by_streamer ON live_bench_polls (streamer_id, id DESC);
CREATE UNIQUE INDEX live_bench_one_active_per_streamer ON live_bench_polls (streamer_id) WHERE status IN ('pending', 'open', 'closing');
CREATE TABLE live_bench_votes (
    poll_id bigint NOT NULL REFERENCES live_bench_polls(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id),
    choice text NOT NULL CHECK (choice IN ('left', 'right', 'tie')),
    PRIMARY KEY (poll_id, user_id)
);
