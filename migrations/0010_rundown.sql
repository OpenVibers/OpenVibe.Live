-- phase: expand
-- The Rundown (2026-10-19, replaces the Arena's drama desk; the owner: "gathers topics and stuff the streamers talk
-- about and is less about competing with eachother and more about talking shit and fleshing out stories and creating
-- content for people to look through"). server/rundown/desk.js reads streams' speech-to-text (stream_timeline_events,
-- kind 'speech') a stretch at a time and has OpenVibe.AI pull out what each streamer talked about.
--
-- A segment is one stretch of one stream about one thing: its topic, a headline, what they said, their take, the desk's
-- quip and up to two of their own lines (verbatim, checked against the transcript), with the streamers they named by
-- their whole name. A topic gathers every segment about the same subject, across streams and streamers, with a summary
-- the desk rewrites as takes arrive. An episode is one finished stream written up (title, logline, recap, chapters).
-- rundown_progress is how far the desk has read each stream; rundown_reactions are readers' reactions. status: live, hidden
-- (staff took it down) or out (its streamer keeps themselves out; coming back makes it live again, never a hidden one).
CREATE TABLE IF NOT EXISTS rundown_topics (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            text COLLATE "C" NOT NULL UNIQUE,
    title           text COLLATE "C" NOT NULL,
    kind            text COLLATE "C" NOT NULL DEFAULT 'other',
    headline        text COLLATE "C",
    summary         text COLLATE "C",
    summary_takes   integer NOT NULL DEFAULT 0,
    summary_at      text COLLATE "C",
    takes           integer NOT NULL DEFAULT 0,
    streamers       integer NOT NULL DEFAULT 0,
    first_seen_at   text COLLATE "C" NOT NULL,
    last_seen_at    text COLLATE "C" NOT NULL,
    status          text COLLATE "C" NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'hidden'))
);
CREATE INDEX IF NOT EXISTS idx_rundown_topics_recent ON rundown_topics (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS rundown_segments (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id   bigint NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id    bigint REFERENCES rundown_topics(id) ON DELETE SET NULL,
    start_sec   double precision NOT NULL,
    end_sec     double precision NOT NULL,
    title       text COLLATE "C" NOT NULL,
    what        text COLLATE "C" NOT NULL,
    take        text COLLATE "C",
    quip        text COLLATE "C",
    score       integer NOT NULL DEFAULT 1 CHECK (score BETWEEN 1 AND 5),
    quotes_json text COLLATE "C" NOT NULL DEFAULT '[]',
    mentions    bigint[] NOT NULL DEFAULT '{}',
    vod_id      bigint,
    said_at     text COLLATE "C" NOT NULL,
    status      text COLLATE "C" NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'hidden', 'out')),
    created_at  text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS idx_rundown_segments_recent ON rundown_segments (status, said_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_rundown_segments_topic ON rundown_segments (topic_id, said_at DESC);
CREATE INDEX IF NOT EXISTS idx_rundown_segments_user ON rundown_segments (user_id, said_at DESC);
CREATE INDEX IF NOT EXISTS idx_rundown_segments_stream ON rundown_segments (stream_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_rundown_segments_mentions ON rundown_segments USING gin (mentions);

CREATE TABLE IF NOT EXISTS rundown_episodes (
    stream_id     bigint PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         text COLLATE "C" NOT NULL,
    logline       text COLLATE "C",
    recap         text COLLATE "C",
    chapters_json text COLLATE "C" NOT NULL DEFAULT '[]',
    vod_id        bigint,
    minutes       integer,
    aired_at      text COLLATE "C" NOT NULL,
    status        text COLLATE "C" NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'hidden', 'out')),
    created_at    text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS idx_rundown_episodes_recent ON rundown_episodes (status, aired_at DESC);
CREATE INDEX IF NOT EXISTS idx_rundown_episodes_user ON rundown_episodes (user_id, aired_at DESC);

CREATE TABLE IF NOT EXISTS rundown_progress (
    stream_id   bigint PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    read_to_sec double precision NOT NULL DEFAULT -1,
    done        integer NOT NULL DEFAULT 0,
    updated_at  text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE IF NOT EXISTS rundown_reactions (
    item_type  text COLLATE "C" NOT NULL CHECK (item_type IN ('segment', 'episode')),
    item_id    bigint NOT NULL,
    voter      text COLLATE "C" NOT NULL,
    reaction   text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (item_type, item_id, voter)
);
