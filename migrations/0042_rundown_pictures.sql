-- phase: expand
-- The Rundown's episode pictures (owner, 2026-11-12: "use their stream to generate an image … so the rundown has
-- its own image based on what happened"). One editorial illustration per episode, made by OpenVibe.AI's image
-- route from the episode's own words (title, topics, takes and recap), stored in OpenVibe.Media.
--
-- One row per stream; the episode's picture is the row with status 'done'. The job (server/rundown/pictures.js)
-- claims a due row, asks AI once with an Idempotency-Key, and settles it: done, refused (the words are explicit
-- or involve a minor: no picture, the stream thumbnail stays the fallback), failed (attempts used up) or pending
-- with a backoff. A monthly cap is checked against cost_usd; a refusal never retries, so a flagged episode cannot
-- loop.
CREATE TABLE IF NOT EXISTS rundown_pictures (
    stream_id       bigint PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    user_id         bigint NOT NULL,
    status          text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'refused', 'failed')),
    source_text     text COLLATE "C",
    prompt_hash     text COLLATE "C",
    model           text COLLATE "C",
    size            text COLLATE "C",
    media_key       text COLLATE "C",
    media_url       text COLLATE "C",
    cost_usd        double precision NOT NULL DEFAULT 0,
    attempts        integer NOT NULL DEFAULT 0,
    idem_key        text COLLATE "C",
    next_attempt_at text COLLATE "C" DEFAULT ov_now(),
    error           text COLLATE "C",
    created_at      text COLLATE "C" DEFAULT ov_now(),
    updated_at      text COLLATE "C" DEFAULT ov_now(),
    done_at         text COLLATE "C"
);

CREATE INDEX IF NOT EXISTS idx_rundown_pictures_due ON rundown_pictures (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_rundown_pictures_done ON rundown_pictures (status, done_at);
