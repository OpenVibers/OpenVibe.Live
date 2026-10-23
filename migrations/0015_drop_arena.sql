-- phase: contract
-- after: 0008
-- The Arena's tables (Arena cleanup, step 3). The Rundown replaced the Arena on 2026-10-19; Live#264 (deployed that
-- day) deleted server/arena and AI#130 retired the live.arena.* workflows, so nothing in Live or any other service
-- reads or writes these since (test/arena-tables-gone.test.js). 0008 (arena_drama, arena_drama_reactions,
-- arena_clout_weeks) was applied 2026-10-16 18:34 UTC, so the migrator runs this after 2026-10-23 18:34 UTC.
--
-- arena_opt_outs stays: it is the Rundown's list of streamers who keep themselves out (server/rundown/read.js,
-- desk.js), named for the Arena. arena_voice_daily_max stays a Rundown setting.
-- Production on 2026-10-23: 59 drama stories, 519 mic moments, 38 profiles, 884 XP log rows (1.6 MB with the rest);
-- the job cursors (arena_backfill_cursor_*) and the Arena's own settings (arena_bot_usernames,
-- arena_discover_window_min) are 22 site_settings rows nothing reads. Rollback: the operator's pg_dump of these
-- tables, taken before the deploy.
DROP TABLE IF EXISTS arena_drama_reactions;
DROP TABLE IF EXISTS arena_drama;
DROP TABLE IF EXISTS arena_clout_weeks;
DROP TABLE IF EXISTS arena_beef_hype;
DROP TABLE IF EXISTS arena_beefs;
DROP TABLE IF EXISTS arena_mic_moments;
DROP TABLE IF EXISTS arena_profiles;
DROP TABLE IF EXISTS arena_trash_levels;
DROP TABLE IF EXISTS arena_xp_log;

DELETE FROM site_settings WHERE key LIKE 'arena\_backfill\_cursor\_%' OR key IN ('arena_bot_usernames', 'arena_discover_window_min');
