-- phase: expand
-- Picture-in-picture: the streams drawn over a slot's stream, each where its streamer put it and movable by every viewer
-- (owner, 2026-10-26: "the streamer should be able to configure PIPs enabled for a stream, and it should be able to use
-- other streams (maybe not even just that streamer, like any streams on the site) and should be able to set their
-- default position/size while also allowing users to adjust them"). One row per PIP, up to three per slot:
--   managed_stream_id  the slot whose viewers see the PIP
--   source_msid        the slot drawn over it: one of the streamer's own, or anyone's; it shows while that slot is live
--   position           the order the streamer listed them in (the first is also the N-1 pip_source_msid)
--   x, y, w            where it starts, as fractions of the player (left, top, width), like pip_defaults
--   muted              1: the PIP starts without sound (the stream underneath already carries the voice)
-- managed_streams.pip_source_msid and pip_defaults stay for the N-1 release (the first PIP is mirrored there), and a
-- contract migration drops them later.
CREATE TABLE IF NOT EXISTS stream_pips (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    managed_stream_id bigint NOT NULL,
    source_msid bigint NOT NULL,
    position bigint NOT NULL DEFAULT 0,
    x double precision NOT NULL DEFAULT 0.72,
    y double precision NOT NULL DEFAULT 0.70,
    w double precision NOT NULL DEFAULT 0.25,
    muted bigint NOT NULL DEFAULT 1,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE (managed_stream_id, source_msid),
    CHECK (managed_stream_id <> source_msid),
    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
    FOREIGN KEY (source_msid) REFERENCES managed_streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stream_pips_source ON stream_pips (source_msid);

-- The one PIP a slot could have until now.
INSERT INTO stream_pips (managed_stream_id, source_msid, x, y, w)
SELECT m.id, m.pip_source_msid,
       LEAST(1, GREATEST(0, COALESCE((NULLIF(m.pip_defaults, '')::json ->> 'x')::double precision, 0.72))),
       LEAST(1, GREATEST(0, COALESCE((NULLIF(m.pip_defaults, '')::json ->> 'y')::double precision, 0.70))),
       LEAST(0.6, GREATEST(0.08, COALESCE((NULLIF(m.pip_defaults, '')::json ->> 'w')::double precision, 0.25)))
FROM managed_streams m
WHERE m.pip_source_msid IS NOT NULL AND m.pip_source_msid <> m.id
  AND EXISTS (SELECT 1 FROM managed_streams s WHERE s.id = m.pip_source_msid)
ON CONFLICT (managed_stream_id, source_msid) DO NOTHING;
