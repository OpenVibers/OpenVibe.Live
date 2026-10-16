-- phase: expand
-- Arena v4 (2026-10-16, the owner: "drama alert type competitive shit … based on streamer activity"): the Arena Alert
-- desk's stories, viewers' reactions to them, the weekly Clout Rankings and Lolcow Index snapshots, and the streamers
-- who keep themselves out (server/arena/drama.js).
--
-- A story is one measured event (a rage quit, a viewer crash, a meltdown heard on mic, a beef verdict…): its facts as
-- measured, a template headline at once and an AI rewrite later, how much it moves the Lolcow Index (cow_points) and
-- the Clout Rankings (clout_points). dedupe_key keeps one story per event however often the detectors run.
CREATE TABLE IF NOT EXISTS arena_drama (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind          text COLLATE "C" NOT NULL,
    user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    stream_id     bigint,
    vod_id        bigint,
    sec           bigint,
    dedupe_key    text COLLATE "C" NOT NULL UNIQUE,
    facts_json    text COLLATE "C" NOT NULL DEFAULT '{}',
    quote         text COLLATE "C",
    headline      text COLLATE "C" NOT NULL,
    blurb         text COLLATE "C",
    alert         integer NOT NULL DEFAULT 1 CHECK (alert BETWEEN 1 AND 5),
    cow_points    double precision NOT NULL DEFAULT 0,
    clout_points  double precision NOT NULL DEFAULT 0,
    ai            integer NOT NULL DEFAULT 0,
    status        text COLLATE "C" NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'hidden')),
    happened_at   text COLLATE "C" NOT NULL,
    created_at    text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS idx_arena_drama_recent ON arena_drama (status, happened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_arena_drama_user ON arena_drama (user_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_drama_other ON arena_drama (other_user_id);

-- One reaction per viewer per story (voter_key as arena_beef_hype: the person, else a salted address hash).
CREATE TABLE IF NOT EXISTS arena_drama_reactions (
    drama_id   bigint NOT NULL REFERENCES arena_drama(id) ON DELETE CASCADE,
    voter_key  text COLLATE "C" NOT NULL,
    reaction   text COLLATE "C" NOT NULL CHECK (reaction IN ('fire', 'skull', 'clown', 'w', 'l')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (drama_id, voter_key)
);

-- The rankings as they stood at the start of each week (Monday, UTC), so this week's moves can be shown.
CREATE TABLE IF NOT EXISTS arena_clout_weeks (
    week       text COLLATE "C" NOT NULL,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clout_rank integer NOT NULL,
    clout      double precision NOT NULL,
    cow        double precision NOT NULL,
    facts_json text COLLATE "C",
    PRIMARY KEY (week, user_id)
);

-- Streamers who keep themselves out of the Arena: no story is written about them and their old ones are hidden.
CREATE TABLE IF NOT EXISTS arena_opt_outs (
    user_id    bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    created_at text COLLATE "C" DEFAULT ov_now()
);
