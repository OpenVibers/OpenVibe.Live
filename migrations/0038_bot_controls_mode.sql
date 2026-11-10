-- phase: expand
-- A channel bound to an OpenVibe.Bot robot carries the streamer's default place for the robot's controls:
-- 'overlay' puts them over the video, 'panel' under it (the previous behaviour). A viewer may choose either,
-- or hide them, for themselves; this is only the default until they do.
ALTER TABLE channels ADD COLUMN bot_controls_mode text COLLATE "C" DEFAULT 'panel';
ALTER TABLE channels ADD CONSTRAINT channels_bot_controls_mode CHECK (bot_controls_mode IS NULL OR bot_controls_mode IN ('overlay', 'panel'));
