-- phase: expand
-- The AI's used moments, durable (item 151, C06 of the clip-quality research). The paste job and both clip cutters
-- share one record of every moment they turned into something, so none picks the same spot or the same scene twice
-- (server/ai/moment-registry.js). It was a JSON list in app_state, capped at 800 entries: on a busy week the oldest
-- fell out early and a repeat came back. Here every moment is a row: the same-recording check (no two within two
-- minutes) is an indexed lookup, the scene and speech checks read the last 14 days, and rows go after 90 days.
-- The entries in app_state 'ai_used_moments' move in once, on first use.
CREATE TABLE IF NOT EXISTS ai_moments (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       text NOT NULL,                 -- 'clip' | 'paste' | 'moment'
    vod_id     text,                          -- the Media recording, as a string id
    stream_id  text,
    at_sec     integer,                       -- the moment's second in that recording or stream
    sig        text,                          -- the short scene signature
    scene      text,                          -- the normalized description (600 chars)
    speech     text,                          -- what was said around it, normalized (600 chars)
    embedding  jsonb,                         -- an optional frame embedding (at most 1024 numbers)
    title      text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_moments_vod ON ai_moments (vod_id, at_sec) WHERE vod_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_moments_stream ON ai_moments (stream_id, at_sec) WHERE stream_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_moments_created ON ai_moments (created_at DESC);
