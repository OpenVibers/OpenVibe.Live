#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Live's two SQLite databases into its PostgreSQL schema (plan T4, ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6). Run at the cutover, with the service stopped.
 *
 *   node scripts/migrate-to-postgres.js --sqlite <live.db> [--analytics <analytics.db>] [--pglite] [--json]
 *
 *   --sqlite     Live's main database (production: /opt/openvibe.live/shared/data/live.db). Opened read-only.
 *   --analytics  the page-analytics database (default: analytics.db under DATA_DIR, when it exists): its analytics_*
 *                tables go into the same PostgreSQL database (migrations/0001_analytics.sql). Opened read-only.
 *   --pglite     a dry run in an in-memory PostgreSQL: migrations applied, every table imported and verified.
 *   --json       the report as JSON.
 *
 * Without --pglite it applies migrations/ as the owner on DATABASE_DIRECT_URL (the serving DATABASE_URL goes through
 * PgBouncer in transaction mode, which cannot hold the import's transaction) and copies into emptied tables, so a
 * rehearsal is repeatable. Exit 0 only if every table verified (row count and a checksum of every row).
 *
 * What is imported is what migrations/0002_live.sql creates: a SQLite table the schema left out (the frozen vods/clips/
 * pastes tables, OpenVibe.Chat's tables, retired features, the SQLite ledger) is not read. event_outbox rows come along
 * (production's had none unsent when the schema was generated; sent rows are pruned after a week as before), and so do
 * the inbox's idempotency_receipts, so a redelivered event is still recognised.
 */
const path = require('path');
const { createDb, importSqlite } = require('openvibe-sdk/db');
// cleaningOptions is sqlite-cli.js's export, beside openvibe-sdk/db's entry (the package exports map does not list it).
const { cleaningOptions } = require(path.join(path.dirname(require.resolve('openvibe-sdk/db')), 'sqlite-cli.js'));

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// importSqlite's per-table options. A SQLite column the schema dropped would be listed here (dropColumns); none is.
const TABLES = {};
// SQLite tables migrations/0002_live.sql leaves out (its header says why); importSqlite reads none of them.
const SKIP_SOURCE = [
    // frozen since C-73: OpenVibe.Media and OpenVibe.Community own the data
    'vods', 'clips', 'pastes', 'paste_likes', 'paste_comments', 'comments',
    // owned by OpenVibe.Chat since T3 (Live keeps no copy)
    'channel_moderators', 'channel_moderation_settings', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events', 'chat_dual_read_stats',
    // SQLite-only machinery: the SQLite migration ledger and the T3 chat staging/bridge queues
    'schema_migrations', 'chat_staged_outbox', 'chat_bridge_outbox',
    // retired features no server code names (the legacy game, canvas, arena v1/v2, chatter profiles): their rows stay
    // in the archived SQLite file
    'game_world_state', 'game_inventory', 'game_bank', 'game_structures', 'game_farm_plots', 'game_recipes', 'game_effects',
    'game_battle_stats', 'game_dungeon_runs', 'game_leaderboard', 'game_fish_collection', 'game_daily_quest_progress',
    'game_daily_quest_claims', 'game_achievements', 'tag_guardian_defeats', 'canvas_settings', 'canvas_tiles', 'canvas_actions',
    'canvas_snapshots', 'canvas_region_locks', 'canvas_bans', 'canvas_user_overrides', 'arena_battles', 'arena_votes',
    'arena_talk_topics', 'arena_talk', 'arena_talk_hype', 'arena_talk_sessions', 'arena_talk_session_topics',
    'arena_talk_session_hype', 'arena_topics', 'arena_topic_progress', 'arena_topic_members', 'arena_topic_hype',
    'arena_topic_sides', 'arena_viewer_clout', 'arena_beef_sides', 'arena_topic_moments', 'chatter_profiles', 'chatter_xp_log',
    'chatter_subjects', 'arena_topic_threads', 'arena_achievements', 'arena_events', 'arena_tier_paid', 'promo_claims',
    'moderation_events_backfill',
];
// The analytics database has only openvibe-shared's analytics tables (and its old per-IP rate counters, which
// PostgreSQL has no table for: the rate check keeps them in memory, and IPs are never carried over).
const ANALYTICS_SKIP_SOURCE = ['analytics_rate_tracking'];

/** Migrate `owner` (a createDb() handle, the owner role) and copy both SQLite files into it → { ok, reports }. */
async function importInto(owner, { sqlite, analytics = null, log = { log() {}, warn: console.warn, error: console.error } }) {
    await owner.migrate({ dir: MIGRATIONS, log });
    const reports = [];
    const main = await cleaningOptions(owner, TABLES);
    const r1 = await importSqlite({ sqlite, db: owner, truncate: true, tables: main.tables, skipSource: SKIP_SOURCE, log });
    reports.push({ source: sqlite, ...r1, cleaned: main.cleaned() });
    if (analytics) {
        const an = await cleaningOptions(owner, {});
        const r2 = await importSqlite({ sqlite: analytics, db: owner, truncate: true, tables: an.tables, skipSource: ANALYTICS_SKIP_SOURCE, log });
        reports.push({ source: analytics, ...r2, cleaned: an.cleaned() });
    }
    return { ok: reports.every((r) => r.ok), reports };
}

async function main(argv = process.argv.slice(2), out = console.log) {
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const flag = (name) => argv.includes(`--${name}`);
    if (!opt('sqlite')) throw new Error('--sqlite <live.db> is required (production: /opt/openvibe.live/shared/data/live.db)');
    const sqlite = path.resolve(opt('sqlite'));
    // OpenVibe.Host's `ovhost data switch live` passes only --sqlite (its backup copy of live.db); the analytics file is
    // read where it is, under the unit's DATA_DIR, while the service is stopped.
    const fs = require('fs');
    const defaultAnalytics = path.join(path.resolve(process.env.DATA_DIR || 'data'), 'analytics.db');
    const analytics = opt('analytics') ? path.resolve(opt('analytics')) : (fs.existsSync(defaultAnalytics) ? defaultAnalytics : null);
    const quiet = { log() {}, warn: console.warn, error: console.error };
    let owner;
    if (flag('pglite')) owner = createDb({ pglite: true, service: 'live-import', log: quiet });
    else {
        if (!process.env.DATABASE_DIRECT_URL) throw new Error('DATABASE_DIRECT_URL is not set: the import runs as the owner on a direct connection');
        owner = createDb({ url: process.env.DATABASE_DIRECT_URL, service: 'live-import', max: 2, queryTimeoutMs: 3600e3, log: quiet });
    }
    try {
        const t0 = Date.now();
        const result = await importInto(owner, { sqlite, analytics, log: quiet });
        if (flag('json')) out(JSON.stringify({ into: owner.store, ...result }, null, 2));
        else {
            for (const r of result.reports) {
                out(`import ${r.source} → ${owner.store}: ${r.ok ? 'OK' : 'PROBLEMS'}`);
                for (const t of r.tables) out(`  ${t.table.padEnd(34)} ${String(t.rows).padStart(9)} rows  ${t.checksum || '-'}`);
                for (const c of r.cleaned) out(`  cleaned: ${c.column}: ${c.values} value(s) with a NUL or an unpaired surrogate`);
                for (const p of r.problems) out(`  problem: ${p.table}: ${p.problem}`);
            }
            out(`${result.ok ? 'OK' : 'PROBLEMS'} in ${Math.round((Date.now() - t0) / 1000)} s`);
        }
        return result.ok ? 0 : 1;
    } finally {
        await owner.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES, SKIP_SOURCE, ANALYTICS_SKIP_SOURCE, MIGRATIONS, importInto };
