/**
 * Legacy HoboQuest remnants are read-only in Live.
 *
 * OpenVibe.Games owns the game (and imports Live's legacy game_* rows). Live's chat profile card
 * used the old game engine's getPlayer(), which INSERTed a placeholder game_players row for every
 * profile anyone opened (production had 70, the newest days old). The engine, its item tables and
 * the RS-Companion import script are gone; the profile card reads db.getLegacyGameProfile(), which
 * never writes; the game's chat tags left with it (nothing equipped one since).
 *
 *   node test/legacy-game-readonly.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
const auth = require('../server/auth/auth');
auth.optionalAuth = (req, res, next) => next();
auth.requireAuth = (req, res) => res.status(401).json({ error: 'Authentication required' });

(async () => {
    await db.initDb();
    const raw = db.getDb();
    for (const [id, name] of [[1, 'veteran'], [2, 'newcomer']]) {
        await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, 'x', 'user')`).run(id, name, name, `${name}@x`);
    }

    // game_players ships with the schema as a frozen legacy table (OpenVibe.Games imports its rows);
    // a fresh install has none, so there is nothing to show and Live itself creates nothing.
    const count = async () => (await raw.prepare('SELECT COUNT(*) AS n FROM game_players').get()).n;
    assert.strictEqual(await db.getLegacyGameProfile(2), null);
    assert.strictEqual(await count(), 0, 'Live never creates the game tables');

    // A legacy player's row, in the shape the old game kept.
    await raw.prepare('INSERT INTO game_players (user_id, mining_xp, combat_xp, total_coins_earned) VALUES (1, 2500, 100, 42)').run();

    const g = await db.getLegacyGameProfile(1);
    assert.strictEqual(g.mining_level, 11, 'levels use the game\'s formula (sqrt(xp/25)+1)');
    assert.strictEqual(g.combat_level, 3);
    assert.strictEqual(g.smithing_level, 1, 'a skill with no xp counts as level 1');
    assert.strictEqual(g.total_level, 11 + 3 + 6, 'eight skills summed, like the old getPlayer()');
    assert.strictEqual(g.total_coins_earned, 42);

    // The profile-card reader (what Live's removed route and OpenVibe.Chat both called) never adds a row.
    assert.strictEqual(await db.getLegacyGameProfile(2), null, 'no legacy game block for someone who never played');
    assert.strictEqual(g.total_level, 20, 'a legacy player still shows their skills');
    assert.strictEqual(await count(), 1, 'reading a profile created no game_players row');

    // Chat tags left with the game: nothing equipped one since, and Live no longer reads them (ADR-054 §8).
    assert.ok(!fs.existsSync(path.join(ROOT, 'server/chat/tags.js')), 'server/chat/tags.js is retired');

    // The engine is gone and nothing reaches for it.
    assert.ok(!fs.existsSync(path.join(ROOT, 'server/game')), 'server/game/ is retired');
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.js') && /require\(['"][./]*\/?game\/(game-engine|tags|items|cosmetics)['"]\)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
        }
    };
    walk(path.join(ROOT, 'server'));
    walk(path.join(ROOT, 'scripts'));
    assert.deepStrictEqual(offenders, []);
    const serverSrc = [];
    const collect = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) collect(p); else if (e.name.endsWith('.js')) serverSrc.push(fs.readFileSync(p, 'utf8')); } };
    collect(path.join(ROOT, 'server'));
    assert.ok(!serverSrc.some((s) => /INSERT[^;`'"]*INTO\s+game_players/i.test(s)), 'no server code inserts game_players rows');

    quiet('legacy-game-readonly: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    process.exit(1);
});
