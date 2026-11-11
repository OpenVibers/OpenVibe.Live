-- phase: expand
-- The streamer's default place for a robot's controls may also be 'compact': a row under the video (ask 353,
-- 2026-11-11). The release before this reads an unknown value as 'panel' (server/bot/embed.js controlMode), so it
-- keeps working on a channel that chose the row.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_bot_controls_mode;
ALTER TABLE channels ADD CONSTRAINT channels_bot_controls_mode CHECK (bot_controls_mode IS NULL OR bot_controls_mode IN ('overlay', 'compact', 'panel'));
