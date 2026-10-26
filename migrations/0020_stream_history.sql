-- phase: expand
-- What happened during a live stream, kept so a seek, a clip or a transcript can use it later
-- (server/streaming/stream-history.js; owner, 2026-10-26: "save the historical events/changes that happen during a
-- livestream so that we can use that data when the user seeks"). One row per event, at_sec in stream time (seconds since
-- streams.started_at):
--   part       a recording part: at_sec when it started, end_sec when it stopped, vod_id its VOD, detail
--              {"part":2,"why":"..."}. A stream whose broadcaster reconnects is recorded in parts, each its own VOD, so
--              stream time minus a part's at_sec is that VOD's time.
--   shape      the broadcaster's picture changed size: detail {"width":1280,"height":720}, vod_id the part recording it.
--   reconnect  the broadcaster came back after dropping: detail {"gap_s":4.2}.
-- A new table, so the N-1 release neither reads nor writes it.
CREATE TABLE IF NOT EXISTS stream_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream_id bigint NOT NULL,
    kind text COLLATE "C" NOT NULL,
    at_sec double precision NOT NULL,
    end_sec double precision,
    vod_id bigint,
    detail text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stream_history_stream ON stream_history (stream_id, at_sec);
CREATE INDEX IF NOT EXISTS idx_stream_history_vod ON stream_history (vod_id) WHERE vod_id IS NOT NULL;
