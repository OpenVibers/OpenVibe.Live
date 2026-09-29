'use strict';
// roadmap T3: the six chat tables (channel_moderators, channel_moderation_settings, emotes,
// user_tags, chat_ai_summaries, chat_timeline_events) are OpenVibe.Chat's, and this release deletes
// the staged machinery this file exercised (chat-tables.js, chat-tables-sync.js, the
// /internal/chat-tables* routes, the staged branch of the read mirror, the app_state keys and the
// chat_staged_outbox/chat_dual_read_stats tables). There is nothing left here to check; the file
// only reports that it is retired, and is listed with the machinery for physical removal under
// "For Opus" (file deletion is not available in this run).
console.log('T3 staged chat tables: skipped (roadmap T3: Chat owns the six tables)');
