-- phase: contract
-- after: 0002
-- Plan T15 B9: robots are OpenVibe.Bot's. Live's control configs became Bot robots on 2026-10-07 (Bot's
-- live_conversions records configs 8, 9 and 14; config 13 had no buttons, so there was nothing to convert), and
-- Live#119 (deployed 2026-10-14) deleted everything that read these: server/controls (the control socket, its
-- stream-key and api_keys auth, the button and whitelist routes), the ONVIF camera routes and client. Since then
-- nothing in Live, and no other service, reads them (test/controls-tables-gone.test.js); a channel bound to a robot
-- embeds Bot's panel (channels.bot_robot_id). The N-1 release names none of them.
-- Production on 2026-10-21: 4 configs, 25 buttons, 1 whitelist row, 11,806 per-stream copies of buttons, no cameras,
-- no presets and no api_keys. Rollback: the robots are in ov_bot; the operator-side dump taken before the deploy
-- restores the tables and columns if ever needed.
-- streams is busy: wait at most 5 s for its lock rather than queue every reader behind the ALTER (a timeout fails
-- the boot, and the deploy keeps the running release).
SET LOCAL lock_timeout = '5s';

ALTER TABLE channels DROP COLUMN IF EXISTS control_mode;
ALTER TABLE channels DROP COLUMN IF EXISTS anon_controls_enabled;
ALTER TABLE channels DROP COLUMN IF EXISTS control_rate_limit_ms;
ALTER TABLE channels DROP COLUMN IF EXISTS active_control_config_id;
ALTER TABLE channels DROP COLUMN IF EXISTS video_click_enabled;
ALTER TABLE channels DROP COLUMN IF EXISTS video_click_rate_limit_ms;
ALTER TABLE managed_streams DROP COLUMN IF EXISTS control_config_id;
ALTER TABLE streams DROP COLUMN IF EXISTS control_config_id;

DROP TABLE IF EXISTS stream_controls;
DROP TABLE IF EXISTS camera_presets;
DROP TABLE IF EXISTS camera_profiles;
DROP TABLE IF EXISTS control_config_buttons;
DROP TABLE IF EXISTS control_whitelist;
DROP TABLE IF EXISTS control_configs;
DROP TABLE IF EXISTS api_keys;
