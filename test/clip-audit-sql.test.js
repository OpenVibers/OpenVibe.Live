'use strict';

// C01: the clip audit's SQL must stay a read-only, aggregate-only look at production.
//
// The three files in scripts/diagnostics/ are run by hand against production (ov_live, ov_media,
// ov_chat). They may only ever read: one READ ONLY transaction per file, a statement timeout, and
// nothing that names a person — no titles, no user ids, no emails, no IPs. This test runs them on
// the test database (PGlite) against fixture rows and proves all three things.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'diagnostics');
const FILES = ['clip-audit-live.sql', 'clip-audit-media.sql', 'clip-audit-chat.sql'];

// A marker planted in the fixtures: it must never come back out of a query.
const MARKER = 'PERSONAL-MARKER-DO-NOT-LEAK';

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const code = (sql) => sql.split('\n').filter((l) => l.trim() && !/^\s*--/.test(l)).join('\n');

// ── 1. shape of every file ────────────────────────────────────────────────────
for (const f of FILES) {
    const sql = read(f);
    assert.ok(/SET\s+statement_timeout\s*=\s*'20s'\s*;/i.test(sql), `${f}: a 20s statement timeout`);
    assert.ok(/BEGIN\s+READ\s+ONLY\s*;/i.test(sql), `${f}: a READ ONLY transaction`);
    assert.ok(/\bCOMMIT\s*;/i.test(sql), `${f}: it commits`);
    assert.ok(!/(?:^|[^a-z_])(insert|update|delete|create|alter|drop|truncate|copy|grant|revoke|vacuum)\s/i.test(code(sql)),
        `${f}: the file only reads`);
    // Personal columns never leave. A user id may appear, but only inside a count.
    const banned = ['email', 'username', 'title', 'description', 'password', 'secret', 'token', 'api_key',
        'subject_id', 'user_agent', 'referer', 'country', 'city'];
    for (const col of banned) {
        const re = new RegExp('\\b' + col + '\\b', 'i');
        assert.ok(!re.test(code(sql)), `${f}: no ${col} column`);
    }
    for (const col of ['user_id', 'channel_user_id', 'anon_id']) {
        const re = new RegExp('\\b' + col + '\\b', 'i');
        for (const line of code(sql).split('\n')) {
            if (!re.test(line)) continue;
            assert.ok(/count\s*\(\s*distinct/i.test(line), `${f}: ${col} only inside count(distinct ...)`);
        }
    }
}

// ── 2. run them on the test database ──────────────────────────────────────────
const db = globalThis.__ovLiveTestDb;

// PGlite returns one result for a single statement, an array for several.
const asRows = (res) => (Array.isArray(res) ? res.flatMap((r) => (r && r.rows) || []) : (res && res.rows) || []);

async function run(sql) {
    // One statement per exec, so BEGIN READ ONLY really is a read-only transaction.
    const statements = sql.split('\n').filter((l) => l.trim() && !/^\s*--/.test(l)).join('\n').split(';')
        .map((s) => s.trim()).filter(Boolean);
    const rows = [];
    for (const stmt of statements) {
        if (/^BEGIN\s+READ\s+ONLY/i.test(stmt)) { await db.exec(stmt); continue; }
        const isSelect = /^\s*(select|with)\b/i.test(stmt);
        if (isSelect) rows.push(...((await db.prepare(stmt).all()) || []));
        else await db.exec(stmt);
    }
    return rows;
}

async function main() {
    if (!db || typeof db.exec !== 'function') {
        console.log('clip audit SQL: skipped (no PGlite database in this run)');
        return;
    }
    // Fixtures: Media's clip table, Media's visitor counter and Chat's messages. Live's own tables
    // (app_state, streams, stream_analytics, clip_ai_state) already exist in the test database.
    await db.exec(`
        DROP TABLE IF EXISTS public.clips;
        DROP TABLE IF EXISTS public.content_visits;
        DROP TABLE IF EXISTS public.chat_messages;
        CREATE TABLE public.clips (
            id bigint PRIMARY KEY, vod_id bigint, stream_id bigint, user_id bigint,
            title text, description text, start_time double precision, end_time double precision,
            duration_seconds double precision, is_public bigint, visibility text, status text,
            view_count bigint, auto_generated bigint, created_at text, unique_views bigint,
            ai_transcript text, ai_overview text);
        CREATE TABLE public.content_visits (
            content_type text, content_id bigint, visitor text, first_at text, last_at text, visits bigint);
        CREATE TABLE public.chat_messages (
            id bigint PRIMARY KEY, stream_id bigint, user_id bigint, anon_id text, message text,
            message_type text, is_deleted bigint, is_filtered bigint, timestamp text);
        -- Created a few days ago, whatever the day the suite runs (fixed October dates fell out of the audit's 30 days).
        INSERT INTO public.clips VALUES
            (1, 10, 100, 7, 'MARKER-title', 'MARKER-description', 0, 25, 25, 1, 'public', 'ready', 12, 1, to_char(now() - interval '5 days', 'YYYY-MM-DD HH24:MI:SS'), 12, 'hello there friends', 'a short clip'),
            (2, 10, 100, 7, 'MARKER-title', 'MARKER-description', 20, 45, 25, 1, 'public', 'ready', 3, 1, to_char(now() - interval '4 days', 'YYYY-MM-DD HH24:MI:SS'), 3, 'hello there friends', 'a short clip'),
            (3, 11, 101, 8, 'MARKER-title', 'MARKER-description', 0, 25, 25, 1, 'public', 'ready', 0, 1, to_char(now() - interval '3 days', 'YYYY-MM-DD HH24:MI:SS'), 0, NULL, NULL),
            (4, 12, 102, 9, 'MARKER-title', 'MARKER-description', 0, 30, 30, 1, 'public', 'ready', 5, 0, to_char(now() - interval '2 days', 'YYYY-MM-DD HH24:MI:SS'), 5, NULL, NULL);
        INSERT INTO public.content_visits VALUES
            ('clip', 1, 'visitor-1', '2026-10-01 11:00:00', '2026-10-02 11:00:00', 2),
            ('clip', 1, 'visitor-2', '2026-10-02 11:00:00', '2026-10-02 12:00:00', 1),
            ('clip', 4, 'visitor-3', '2026-10-04 11:00:00', '2026-10-05 11:00:00', 1);
        INSERT INTO public.chat_messages VALUES
            (1, 100, 7, 'anon-1', 'hi', 'message', 0, 0, '2026-10-01 10:00:00'),
            (2, 100, 8, 'anon-2', 'MARKER-message', 'message', 0, 0, '2026-10-01 10:00:05'),
            (3, 101, 9, 'anon-3', 'yo', 'message', 1, 0, '2026-10-01 10:00:10');
        INSERT INTO app_state (key, value) VALUES ('auto_clip_log',
            '[{"ts": 1767225600000, "vod_id": 10, "stream_id": 100, "start_time": 0, "title": "MARKER-title", "clip_id": 1},
              {"ts": 1767225600000, "vod_id": 11, "stream_id": 101, "start_time": 0, "title": "MARKER-title", "clip_id": 2}]')
            ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    `);

    // The live file reads Live's own tables; give them a row each.
    await db.exec(`
        INSERT INTO users (username, password_hash)
            SELECT 'clip-audit-fixture', 'not-a-password'
            WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'clip-audit-fixture');
        INSERT INTO streams (user_id, title, is_live, viewer_count, peak_viewers, started_at)
            SELECT id, 'MARKER-title', 0, 2, 5, '2026-10-01 09:00:00' FROM users WHERE username = 'clip-audit-fixture';
        INSERT INTO stream_analytics (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages, clips_created)
            SELECT id, 2, 5, 3, 120, 1 FROM streams WHERE title = 'MARKER-title' LIMIT 1
            ON CONFLICT (stream_id) DO NOTHING;
        INSERT INTO clip_ai_state (clip_id, ai_overview_short, transcript_status)
            VALUES (900, 'MARKER-description', 'ready')
            ON CONFLICT (clip_id) DO NOTHING;
    `);

    const before = await db.prepare('SELECT count(*)::int AS n FROM public.clips').all();
    const beforeClips = before[0].n;

    const live = await run(read('clip-audit-live.sql'));
    const media = await run(read('clip-audit-media.sql'));
    const chat = await run(read('clip-audit-chat.sql'));
    const all = [...live, ...media, ...chat];

    // Nothing personal came out.
    const dumped = JSON.stringify(all);
    assert.ok(!dumped.includes(MARKER), 'no personal text came out of the audit');
    for (const bad of ['MARKER-title', 'MARKER-description', 'MARKER-message']) {
        assert.ok(!dumped.includes(bad), `no ${bad} came out of the audit`);
    }

    // The answers the audit exists for are there.
    const perDay = all.filter((r) => r.section === 'auto_clips_per_day');
    assert.strictEqual(perDay.length, 3, 'the automatic clips per day are counted');
    const kind = all.find((r) => r.section === 'clips_by_kind');
    assert.ok(kind && Number(kind.clips) >= 3, 'automatic and human clips are counted by kind');
    const never = all.find((r) => r.section === 'auto_clips_never_watched');
    assert.ok(never && Number(never.never_watched) >= 1, 'the clips nobody watched are counted');
    const overlap = all.find((r) => r.section === 'auto_clip_overlap');
    assert.ok(overlap && Number(overlap.overlapping_pairs) >= 1, 'overlapping cuts are counted');
    const repeats = all.find((r) => r.section === 'auto_clip_semantic_repeats');
    assert.ok(repeats && Number(repeats.distinct_fingerprints) >= 1, 'semantic repeats are counted separately');
    assert.ok(all.filter((r) => r.section === 'chat_buckets').length >= 1, 'the chat buckets are counted');
    const log = all.find((r) => r.section === 'auto_clip_log_shape');
    assert.ok(log && Number(log.entries) === 2, 'the clip log is counted');

    // The files' own transaction shape: a READ ONLY transaction refuses a write.
    await db.exec('BEGIN READ ONLY');
    let refused = false;
    try { await db.exec('CREATE TABLE clip_audit_write_probe (id int)'); }
    catch (e) { refused = /read-only/i.test(String(e && e.message)); }
    await db.exec('ROLLBACK').catch(() => {});
    assert.ok(refused, 'a READ ONLY transaction refuses a write');

    // Nothing was written: the fixtures are exactly as they were.
    const after = await db.prepare('SELECT count(*)::int AS n FROM public.clips').all();
    assert.strictEqual(after[0].n, beforeClips, 'the audit wrote nothing');

    // Clean up the fixtures this file added.
    await db.exec(`
        DROP TABLE IF EXISTS public.clips;
        DROP TABLE IF EXISTS public.content_visits;
        DROP TABLE IF EXISTS public.chat_messages;
        DELETE FROM app_state WHERE key = 'auto_clip_log';
        DELETE FROM stream_analytics WHERE stream_id = 900;
        DELETE FROM clip_ai_state WHERE clip_id = 900;
        DELETE FROM streams WHERE title = 'MARKER-title';
        DELETE FROM users WHERE username = 'clip-audit-fixture';
    `);

    console.log('clip audit SQL: read-only, aggregate-only, no personal columns — all checks passed');
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
