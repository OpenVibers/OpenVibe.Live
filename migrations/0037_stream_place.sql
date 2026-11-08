-- phase: expand
-- A broadcast may name the verified Tours place from which it starts. This stays on the
-- session, so later VOD and clip reads can keep the same location after the stream ends.
ALTER TABLE streams ADD COLUMN place_name text;
ALTER TABLE streams ADD COLUMN place_url text;
ALTER TABLE streams ADD CONSTRAINT streams_place_link CHECK (
    (place_name IS NULL AND place_url IS NULL) OR
    (length(place_name) BETWEEN 1 AND 120 AND place_url ~ '^https://openvibe\.tours/place/[a-z0-9-]+-plc_[0-9A-HJKMNP-TV-Z]{26}$')
);
