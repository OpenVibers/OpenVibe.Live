-- phase: expand
-- The audiences of The Rundown (design 2026-11-06, plan-state-2026-10-22/RUNDOWN-CONTROLS-AND-BROWSE-DESIGN-2026-11-06.md).
--
-- Who sees a streamer's Rundown is one setting, not four: Everyone, Anyone with the link, Specific people or Only me.
-- Those are the sharing system's own audiences (openvibe-sdk/share, share.v1), and the episode's own setting lives
-- there, in the share row of kind 'rundown-episode' (server/rundown/sharing.js). This table holds only what the
-- sharing system does not know:
--
--   vod_audience   what the recording decides, as the last thing Live heard about it. Live applies the rule itself:
--                  the episode's audience is the stricter of its own setting and this (Only me, then Specific people,
--                  then Anyone with the link, then Everyone). A change made through Live's own pages is applied in the
--                  same request (server/media-proxy/vods.js); a change made elsewhere arrives as Media's
--                  media.object.visibility_changed event; until that lands the episode page re-checks the recording
--                  through media-client (cached 60 s, server/rundown/visibility.js).
--
-- Expand only: a stream with no row is Everyone, so every older release and every older row keeps working.
CREATE TABLE IF NOT EXISTS rundown_visibility (
    stream_id    bigint PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    vod_audience text COLLATE "C" NOT NULL DEFAULT 'public',
    vod_members   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (vod_audience IN ('public','link','people','private')),
    updated_at   text COLLATE "C" DEFAULT ov_now()
);

-- The streamer's own default for the episodes written up for them ("My Rundown" settings). Nobody has a row until
-- they change it: no row is Everyone.
CREATE TABLE IF NOT EXISTS rundown_prefs (
    user_id          bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_audience text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (default_audience IN ('public','link','people','private')),
    updated_at       text COLLATE "C" DEFAULT ov_now()
);

-- A write-up the streamer deleted. The desk must not write that stream up again on its own; only the streamer asking
-- for it ("Write this stream up again") clears the row.
CREATE TABLE IF NOT EXISTS rundown_deleted (
    stream_id  bigint PRIMARY KEY REFERENCES streams(id) ON DELETE CASCADE,
    user_id    bigint NOT NULL,
    deleted_at text COLLATE "C" DEFAULT ov_now()
);
