/**
 * Legacy HoboQuest remnants are read-only in Live.
 *
 * OpenVibe.Games owns the game (and imports Live's legacy game_* rows). Live's chat profile card
 * used the old game engine's getPlayer(), which INSERTed a placeholder game_players row for every
 * profile anyone opened (production had 70, the newest days old). The engine, its item tables and
 * the RS-Companion import script are gone; the profile card reads db.getLegacyGameProfile(), which
 * never writes, and chat tags come from the read-only server/chat/tags.js.
 *
 *   node test/legacy-game-readonly.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-legacy-game-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const auth = require('../server/auth/auth');
auth.optionalAuth = (req, res, next) => next();
auth.requireAuth = (req, res) => res.status(401).json({ error: 'Authentication required' });

for (const [id, name] of [[1, 'veteran'], [2, 'newcomer']]) {
    raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'user')`).run(id, name, name, `${name}@x`);
}

(async () => {
    // A fresh install has no game_players table at all: nothing to show, nothing created.
    assert.strictEqual(db.getLegacyGameProfile(2), null);
    assert.ok(!raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'game_players'").get(), 'Live never creates the game tables');

    // Production has the legacy table (the shape the old schema created, without smithing_xp).
    raw.exec(`CREATE TABLE game_players (user_id INTEGER PRIMARY KEY, x REAL, y REAL, mining_xp INTEGER DEFAULT 0, fishing_xp INTEGER DEFAULT 0,
        woodcut_xp INTEGER DEFAULT 0, farming_xp INTEGER DEFAULT 0, combat_xp INTEGER DEFAULT 0, crafting_xp INTEGER DEFAULT 0,
        agility_xp INTEGER DEFAULT 0, total_coins_earned INTEGER DEFAULT 0)`);
    raw.prepare('INSERT INTO game_players (user_id, mining_xp, combat_xp, total_coins_earned) VALUES (1, 2500, 100, 42)').run();
    const count = () => raw.prepare('SELECT COUNT(*) AS n FROM game_players').get().n;

    const g = db.getLegacyGameProfile(1);
    assert.strictEqual(g.mining_level, 11, 'levels use the game\'s formula (sqrt(xp/25)+1)');
    assert.strictEqual(g.combat_level, 3);
    assert.strictEqual(g.smithing_level, 1, 'a column the old table lacks counts as level 1');
    assert.strictEqual(g.total_level, 11 + 3 + 6, 'eight skills summed, like the old getPlayer()');
    assert.strictEqual(g.total_coins_earned, 42);

    // The chat profile card (Live's route and the one OpenVibe.Chat reads) never adds a row.
    const express = require('express');
    const app = express();
    app.use('/api/chat', require('../server/chat/routes'));
    const server = http.createServer(app).listen(0);
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
        }).on('error', reject);
    });
    let r = await get('/api/chat/user/newcomer/profile');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.game, undefined, 'no legacy game block for someone who never played');
    assert.strictEqual(count(), 1, 'and viewing their profile created no game_players row');
    r = await get('/api/chat/user/veteran/profile');
    assert.strictEqual(r.json.game.total_level, 20, 'a legacy player still shows their skills');
    assert.strictEqual(count(), 1);
    server.close();

    // Chat tags: read-only, and still shown.
    const tags = require('../server/chat/tags');
    tags.ensureTagTables();
    raw.prepare("INSERT INTO user_tags (user_id, tag_id, source) VALUES (1, 'legacy', 'migration')").run();
    raw.prepare("INSERT INTO user_equipped_tag (user_id, tag_id) VALUES (1, 'legacy')").run();
    assert.strictEqual(tags.getTagProfile(1).name, 'Legacy');
    assert.strictEqual(tags.getTagProfile(2), null);
    for (const writer of ['grantTag', 'revokeTag', 'buyTag', 'equipTag', 'unequipTag', 'fightGuardian']) {
        assert.strictEqual(tags[writer], undefined, `tags.${writer} is gone (the game owns tag grants now)`);
    }

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

    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('legacy-game-readonly: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    process.exit(1);
});
