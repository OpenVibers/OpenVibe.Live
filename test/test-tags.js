/**
 * Tags System — Unit Tests
 *
 * Stand-alone test file using Node assert.
 * Creates a temporary SQLite DB in /tmp/ so no production data is touched.
 *
 * Run: node test/test-tags.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ── Set up a temporary DB before requiring any modules ───────
const tmpDb = `/tmp/openvibe-tags-test-${Date.now()}.db`;
process.env.DB_PATH = tmpDb;

const Database = require('better-sqlite3');

// We need to bootstrap the minimum schema that the tags module expects:
// users table + game_players table
function setupTestDb() {
    const d = new Database(tmpDb);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    d.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT,
            openvibe_coins_balance INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS game_players (
            user_id INTEGER PRIMARY KEY,
            display_name TEXT,
            hp INTEGER DEFAULT 100,
            attack INTEGER DEFAULT 10,
            defense INTEGER DEFAULT 5,
            combat_xp INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);
    d.close();
}

setupTestDb();

// Now require the modules (they'll use the test DB via DB_PATH env)
const db = require('../server/db/database');
db.initDb();   // runs schema.sql — adds full platform tables on top of our seed

const tags = require('../server/game/tags');
tags.ensureTagTables();

// ── Test Helpers ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        errors.push({ name, error: e });
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

function describe(section, fn) {
    console.log(`\n─── ${section} ───`);
    fn();
}

// ── Create test users ────────────────────────────────────────
function createTestUser(username, coins = 0) {
    const d = db.getDb();
    d.prepare('INSERT INTO users (username, display_name, openvibe_coins_balance) VALUES (?, ?, ?)').run(username, username, coins);
    const user = d.prepare('SELECT id FROM users WHERE username = ?').get(username);
    d.prepare('INSERT OR IGNORE INTO game_players (user_id, display_name, combat_xp) VALUES (?, ?, ?)').run(user.id, username, 0);
    return user.id;
}

// ══════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════

const userId1 = createTestUser('TestUser1', 10000);
const userId2 = createTestUser('TestUser2', 100);
const userId3 = createTestUser('PatrickTest', 5000);

describe('Tag Catalog', () => {
    test('TAGS object has expected entries', () => {
        assert.ok(tags.TAGS.cfo, 'CFO tag exists');
        assert.ok(tags.TAGS.noob, 'Noob tag exists');
        assert.ok(tags.TAGS.legend, 'Legend tag exists');
        assert.ok(tags.TAGS.legacy, 'Legacy tag exists');
    });

    test('getShopTags returns only shop-category tags', () => {
        const shopTags = tags.getShopTags();
        assert.ok(shopTags.length > 0, 'Some shop tags exist');
        for (const t of shopTags) {
            assert.strictEqual(t.category, 'shop', `${t.tagId} is shop category`);
            assert.ok(typeof t.cost === 'number' && t.cost > 0, `${t.tagId} has a price`);
        }
    });

    test('getAllTags returns all categories', () => {
        const all = tags.getAllTags();
        const categories = new Set(all.map(t => t.category));
        assert.ok(categories.has('special'), 'Has special tags');
        assert.ok(categories.has('shop'), 'Has shop tags');
        assert.ok(categories.has('achievement'), 'Has achievement tags');
    });

    test('shop tags are sorted by cost ascending', () => {
        const shopTags = tags.getShopTags();
        for (let i = 1; i < shopTags.length; i++) {
            assert.ok(shopTags[i].cost >= shopTags[i - 1].cost, 'Sorted by cost');
        }
    });
});

describe('Grant & Equip', () => {
    test('grantTag gives a tag to a user', () => {
        const result = tags.grantTag(userId1, 'cfo', 'test');
        assert.ok(result.success, 'Grant succeeded');
        assert.strictEqual(result.tag.tagId, 'cfo');
    });

    test('getUserTags returns the granted tag', () => {
        const owned = tags.getUserTags(userId1);
        assert.strictEqual(owned.length, 1);
        assert.strictEqual(owned[0].tagId, 'cfo');
    });

    test('grantTag is idempotent (INSERT OR IGNORE)', () => {
        const result = tags.grantTag(userId1, 'cfo', 'test');
        assert.ok(result.success);
        const owned = tags.getUserTags(userId1);
        assert.strictEqual(owned.length, 1, 'Still only 1 tag');
    });

    test('equipTag works', () => {
        const result = tags.equipTag(userId1, 'cfo');
        assert.ok(result.success);
        assert.strictEqual(result.tag.name, 'CFO');
    });

    test('getEquippedTag returns the equipped tag', () => {
        const eq = tags.getEquippedTag(userId1);
        assert.ok(eq, 'Tag is equipped');
        assert.strictEqual(eq.tagId, 'cfo');
        assert.strictEqual(eq.name, 'CFO');
        assert.strictEqual(eq.emoji, '💼');
    });

    test('getTagProfile returns the same as getEquippedTag', () => {
        const profile = tags.getTagProfile(userId1);
        assert.ok(profile);
        assert.strictEqual(profile.tagId, 'cfo');
    });

    test('equipTag fails if user doesn\'t own the tag', () => {
        const result = tags.equipTag(userId2, 'cfo');
        assert.ok(result.error, 'Should fail');
        assert.ok(result.error.includes("don't own"), result.error);
    });

    test('unequipTag removes equipped tag', () => {
        const result = tags.unequipTag(userId1);
        assert.ok(result.success);
        const eq = tags.getEquippedTag(userId1);
        assert.strictEqual(eq, null, 'No tag equipped');
    });

    test('revokeTag removes a tag', () => {
        tags.equipTag(userId1, 'cfo');  // re-equip first
        const result = tags.revokeTag(userId1, 'cfo');
        assert.ok(result.success);
        const owned = tags.getUserTags(userId1);
        assert.strictEqual(owned.length, 0, 'No tags owned');
        const eq = tags.getEquippedTag(userId1);
        assert.strictEqual(eq, null, 'Unequipped on revoke');
    });
});

describe('Tag Shop (Buy)', () => {
    test('buyTag fails without defeating guardian', () => {
        const result = tags.buyTag(userId1, 'noob');
        assert.ok(result.error);
        assert.ok(result.error.includes('Tag Guardian'), result.error);
    });

    test('manually mark guardian defeated, then buy works', () => {
        const d = db.getDb();
        d.prepare('INSERT OR IGNORE INTO tag_guardian_defeats (user_id) VALUES (?)').run(userId1);

        const result = tags.buyTag(userId1, 'noob');
        assert.ok(result.success, 'Buy succeeded');
        assert.strictEqual(result.tag.tagId, 'noob');
        assert.strictEqual(result.cost, 50);
    });

    test('buying deducts coins', () => {
        const user = db.getUserById(userId1);
        assert.strictEqual(user.openvibe_coins_balance, 10000 - 50);
    });

    test('buyTag fails if already owned', () => {
        const result = tags.buyTag(userId1, 'noob');
        assert.ok(result.error);
        assert.ok(result.error.includes('already own'), result.error);
    });

    test('buyTag fails for special category tags', () => {
        const d = db.getDb();
        d.prepare('INSERT OR IGNORE INTO tag_guardian_defeats (user_id) VALUES (?)').run(userId2);

        const result = tags.buyTag(userId2, 'cfo');
        assert.ok(result.error);
        assert.ok(result.error.includes('cannot be purchased'), result.error);
    });

    test('buyTag fails with insufficient gold', () => {
        const result = tags.buyTag(userId2, 'legend'); // costs 5000, user2 has 100
        assert.ok(result.error);
        assert.ok(result.error.includes('Not enough'), result.error);
    });

    test('buyTag fails for unknown tagId', () => {
        const result = tags.buyTag(userId1, 'nonexistent_tag');
        assert.ok(result.error);
        assert.ok(result.error.includes('Unknown'), result.error);
    });
});

describe('Tag Guardian Combat', () => {
    test('fightGuardian fails without game character', () => {
        // Create a user with no game_players row
        const d = db.getDb();
        d.prepare('INSERT INTO users (username, display_name, openvibe_coins_balance) VALUES (?, ?, ?)').run('NoGameChar', 'NoGameChar', 0);
        const noGameUser = d.prepare('SELECT id FROM users WHERE username = ?').get('NoGameChar');

        const result = tags.fightGuardian(noGameUser.id);
        assert.ok(result.error);
        assert.ok(result.error.includes('No game character'), result.error);
    });

    test('fightGuardian fails if combat level too low', () => {
        // userId2 has 0 combat_xp → level 1, needs level 3
        const result = tags.fightGuardian(userId2);
        assert.ok(result.error);
        assert.ok(result.error.includes('Combat Lv'), result.error);
    });

    test('fightGuardian works with sufficient combat level', () => {
        // Give userId3 enough combat XP for level 3: level = floor(sqrt(xp/25)) + 1
        // Level 3: floor(sqrt(xp/25)) = 2, sqrt(xp/25)>=2, xp/25>=4, xp>=100
        const d = db.getDb();
        d.prepare('UPDATE game_players SET combat_xp = 200, attack = 50, defense = 20 WHERE user_id = ?').run(userId3);

        const result = tags.fightGuardian(userId3);
        assert.ok(result.success, 'Fight initiated');
        assert.ok(result.log.length > 0, 'Has combat log');
        assert.ok(typeof result.won === 'boolean', 'Has won/lost result');
    });

    test('hasDefeatedGuardian returns correct status for user without defeat', () => {
        // userId2 never fought
        assert.strictEqual(tags.hasDefeatedGuardian(userId2), false);
    });

    test('fightGuardian returns already-defeated message if already won', () => {
        if (tags.hasDefeatedGuardian(userId3)) {
            const result = tags.fightGuardian(userId3);
            assert.ok(result.error);
            assert.ok(result.error.includes('already defeated'), result.error);
        }
    });
});

describe('Multiple Tags', () => {
    test('user can own multiple tags', () => {
        tags.grantTag(userId1, 'legacy', 'test');
        tags.grantTag(userId1, 'alpha_tester', 'test');
        const owned = tags.getUserTags(userId1);
        // Already owns noob from buy test
        assert.ok(owned.length >= 3, `Owns ${owned.length} tags`);
    });

    test('can switch between equipped tags', () => {
        tags.equipTag(userId1, 'noob');
        let eq = tags.getEquippedTag(userId1);
        assert.strictEqual(eq.tagId, 'noob');

        tags.equipTag(userId1, 'legacy');
        eq = tags.getEquippedTag(userId1);
        assert.strictEqual(eq.tagId, 'legacy');

        tags.equipTag(userId1, 'alpha_tester');
        eq = tags.getEquippedTag(userId1);
        assert.strictEqual(eq.tagId, 'alpha_tester');
    });
});

describe('TAG_GUARDIAN constant', () => {
    test('has required fields', () => {
        const g = tags.TAG_GUARDIAN;
        assert.ok(g.name, 'Has name');
        assert.ok(g.hp > 0, 'Has HP');
        assert.ok(g.atk > 0, 'Has attack');
        assert.ok(g.combatLevel > 0, 'Has combat level requirement');
    });
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`);
console.log(`  Tags Tests: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════`);

if (errors.length > 0) {
    console.log('\nFailures:');
    for (const e of errors) {
        console.log(`  ${e.name}:`);
        console.log(`    ${e.error.stack || e.error.message}`);
    }
}

// Cleanup
try { fs.unlinkSync(tmpDb); } catch {}
try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
try { fs.unlinkSync(tmpDb + '-shm'); } catch {}

process.exit(failed > 0 ? 1 : 0);
