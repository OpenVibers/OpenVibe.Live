#!/usr/bin/env node
/**
 * OpenVibeGame — Migration Script
 * Ports player data from RS-Companion SQLite DB into OpenVibeGame tables
 *
 * RS-Companion users have TEXT user_ids (e.g. "12345" from RobotStreamer)
 * OpenVibe.Live users have INTEGER ids with usernames
 *
 * Strategy: Match by username (case-insensitive). For each matched user,
 * port XP, inventory, bank, recipes, battle stats, farm plots.
 *
 * Usage:
 *   node scripts/migrate-rs-companion.js <path-to-rs-companion.db>
 *
 * Run AFTER the OpenVibeGame schema has been initialized (start the server once first).
 */

const Database = require('better-sqlite3');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────
const rsDbPath = process.argv[2];
if (!rsDbPath) {
    console.error('Usage: node scripts/migrate-rs-companion.js <path-to-rs-companion.db>');
    process.exit(1);
}
const openvibeDbPath = path.resolve(__dirname, '../data/live.db');

console.log(`[Migration] RS-Companion DB: ${rsDbPath}`);
console.log(`[Migration] OpenVibe.Live DB: ${openvibeDbPath}`);

// ── Open databases ───────────────────────────────────────────
const rsDb = new Database(rsDbPath, { readonly: true });
const openvibeDb = new Database(openvibeDbPath);
openvibeDb.pragma('journal_mode = WAL');

// ── Ensure game tables exist ─────────────────────────────────
const fs = require('fs');
const schema = fs.readFileSync(path.resolve(__dirname, '../server/game/schema.sql'), 'utf8');
openvibeDb.exec(schema);

// ── Build username → openvibe user id map ────────────────────────
const openvibeUsers = openvibeDb.prepare('SELECT id, username, display_name FROM users').all();
const openvibeMap = new Map(); // lowercase username → openvibe user id
for (const u of openvibeUsers) {
    openvibeMap.set(u.username.toLowerCase(), u.id);
    if (u.display_name) openvibeMap.set(u.display_name.toLowerCase(), u.id);
}
console.log(`[Migration] ${openvibeUsers.length} OpenVibe.Live users loaded`);

// ── Fetch RS-Companion users ─────────────────────────────────
const rsUsers = rsDb.prepare('SELECT * FROM users').all();
console.log(`[Migration] ${rsUsers.length} RS-Companion users found`);

let matched = 0, skipped = 0;
const userMap = new Map(); // rs user_id → openvibe user id

for (const rsu of rsUsers) {
    const openvibeId = openvibeMap.get(rsu.username.toLowerCase());
    if (!openvibeId) { skipped++; continue; }
    userMap.set(rsu.user_id, openvibeId);
    matched++;
}
console.log(`[Migration] Matched ${matched} users, skipped ${skipped}`);

// ── Helper: upsert game_players ──────────────────────────────
const upsertPlayer = openvibeDb.prepare(`
    INSERT INTO game_players (user_id, display_name, mining_xp, fishing_xp, woodcut_xp, farming_xp, combat_xp, crafting_xp, total_coins_earned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
        mining_xp = MAX(game_players.mining_xp, excluded.mining_xp),
        fishing_xp = MAX(game_players.fishing_xp, excluded.fishing_xp),
        woodcut_xp = MAX(game_players.woodcut_xp, excluded.woodcut_xp),
        farming_xp = MAX(game_players.farming_xp, excluded.farming_xp),
        combat_xp = MAX(game_players.combat_xp, excluded.combat_xp),
        crafting_xp = MAX(game_players.crafting_xp, excluded.crafting_xp),
        total_coins_earned = MAX(game_players.total_coins_earned, excluded.total_coins_earned)
`);

// ── Helper: upsert inventory ─────────────────────────────────
const upsertInv = openvibeDb.prepare(`
    INSERT INTO game_inventory (user_id, item_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
`);

// ── Helper: upsert bank ─────────────────────────────────────
const upsertBank = openvibeDb.prepare(`
    INSERT INTO game_bank (user_id, item_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
`);

// ── Helper: upsert recipes ──────────────────────────────────
const upsertRecipe = openvibeDb.prepare(`
    INSERT OR IGNORE INTO game_recipes (user_id, recipe_id) VALUES (?, ?)
`);

// ── Helper: upsert battle stats ─────────────────────────────
const upsertBattle = openvibeDb.prepare(`
    INSERT INTO game_battle_stats (user_id, battles_won, battles_lost, total_stolen, total_lost, kill_streak, best_streak, kills, deaths)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
        battles_won = MAX(game_battle_stats.battles_won, excluded.battles_won),
        battles_lost = MAX(game_battle_stats.battles_lost, excluded.battles_lost),
        total_stolen = MAX(game_battle_stats.total_stolen, excluded.total_stolen),
        total_lost = MAX(game_battle_stats.total_lost, excluded.total_lost),
        best_streak = MAX(game_battle_stats.best_streak, excluded.best_streak),
        kills = MAX(game_battle_stats.kills, excluded.kills),
        deaths = MAX(game_battle_stats.deaths, excluded.deaths)
`);

// ══════════════════════════════════════════════════════════════
//  MIGRATE
// ══════════════════════════════════════════════════════════════

const migrateAll = openvibeDb.transaction(() => {
    let playerCount = 0, invCount = 0, bankCount = 0, recipeCount = 0, battleCount = 0;

    // ── 1. Players (XP from skill profiles) ──────────────────
    for (const [rsId, openvibeId] of userMap) {
        const rsu = rsDb.prepare('SELECT * FROM users WHERE user_id = ?').get(rsId);
        if (!rsu) continue;

        // Gather XP from profiles
        const fish = rsDb.prepare('SELECT fish_xp FROM fish_profile WHERE user_id = ?').get(rsId);
        const mine = rsDb.prepare('SELECT mine_xp FROM mine_profile WHERE user_id = ?').get(rsId);
        const wc = rsDb.prepare('SELECT wc_xp FROM woodcut_profile WHERE user_id = ?').get(rsId);

        // Combat XP from dungeon stats
        let combatXp = 0;
        try {
            const dung = rsDb.prepare('SELECT dungeon_xp FROM dungeon_stats WHERE user_id = ?').get(rsId);
            if (dung) combatXp = dung.dungeon_xp || 0;
        } catch {}

        // General XP → crafting XP (repurpose)
        const craftXp = Math.floor((rsu.xp || 0) * 0.3);

        upsertPlayer.run(
            openvibeId,
            rsu.username,
            mine?.mine_xp || 0,
            fish?.fish_xp || 0,
            wc?.wc_xp || 0,
            0, // farming_xp (no direct equivalent)
            combatXp,
            craftXp,
            Math.floor(rsu.coins || 0)
        );
        playerCount++;
    }
    console.log(`[Migration] Ported ${playerCount} player profiles`);

    // ── 2. Inventory ─────────────────────────────────────────
    for (const [rsId, openvibeId] of userMap) {
        const items = rsDb.prepare('SELECT item_id, quantity FROM inventory WHERE user_id = ?').all(rsId);
        for (const item of items) {
            if (item.quantity > 0) {
                upsertInv.run(openvibeId, item.item_id, item.quantity);
                invCount++;
            }
        }
    }
    console.log(`[Migration] Ported ${invCount} inventory entries`);

    // ── 3. Bank ──────────────────────────────────────────────
    let hasBankItems = false;
    try { rsDb.prepare('SELECT 1 FROM bank_items LIMIT 1').get(); hasBankItems = true; } catch {}

    if (hasBankItems) {
        for (const [rsId, openvibeId] of userMap) {
            const items = rsDb.prepare('SELECT item_id, quantity FROM bank_items WHERE user_id = ?').all(rsId);
            for (const item of items) {
                if (item.quantity > 0) {
                    upsertBank.run(openvibeId, item.item_id, item.quantity);
                    bankCount++;
                }
            }
        }
    }
    console.log(`[Migration] Ported ${bankCount} bank entries`);

    // ── 4. Unlocked Recipes ──────────────────────────────────
    let hasRecipes = false;
    try { rsDb.prepare('SELECT 1 FROM unlocked_recipes LIMIT 1').get(); hasRecipes = true; } catch {}

    if (hasRecipes) {
        for (const [rsId, openvibeId] of userMap) {
            const recipes = rsDb.prepare('SELECT recipe_id FROM unlocked_recipes WHERE user_id = ?').all(rsId);
            for (const r of recipes) {
                upsertRecipe.run(openvibeId, r.recipe_id);
                recipeCount++;
            }
        }
    }
    console.log(`[Migration] Ported ${recipeCount} recipe unlocks`);

    // ── 5. Battle Stats ──────────────────────────────────────
    let hasBattle = false;
    try { rsDb.prepare('SELECT 1 FROM battle_stats LIMIT 1').get(); hasBattle = true; } catch {}

    if (hasBattle) {
        for (const [rsId, openvibeId] of userMap) {
            const bs = rsDb.prepare('SELECT * FROM battle_stats WHERE user_id = ?').get(rsId);
            if (!bs) continue;
            upsertBattle.run(
                openvibeId,
                bs.battles_won || 0, bs.battles_lost || 0,
                bs.total_stolen || 0, bs.total_lost || 0,
                bs.kill_streak || 0, bs.best_streak || 0,
                bs.kills || 0, bs.deaths || 0
            );
            battleCount++;
        }
    }
    console.log(`[Migration] Ported ${battleCount} battle stat entries`);

    // ── 6. Coins bonus (RS-Companion coins → OpenVibe.Live coins) ──
    let coinsMigrated = 0;
    for (const [rsId, openvibeId] of userMap) {
        const rsu = rsDb.prepare('SELECT coins FROM users WHERE user_id = ?').get(rsId);
        if (!rsu || !rsu.coins || rsu.coins <= 0) continue;
        const bonus = Math.floor(rsu.coins);
        if (bonus > 0) {
            openvibeDb.prepare('UPDATE users SET openvibe_coins_balance = openvibe_coins_balance + ? WHERE id = ?').run(bonus, openvibeId);
            coinsMigrated++;
        }
    }
    console.log(`[Migration] Awarded coin bonuses to ${coinsMigrated} users`);

    // ── 7. Cosmetics (activate fx_*/px_* from inventory) ─────
    let cosmeticCount = 0;
    for (const [rsId, openvibeId] of userMap) {
        const fxItems = openvibeDb.prepare(
            "SELECT item_id FROM game_inventory WHERE user_id = ? AND (item_id LIKE 'fx_%' OR item_id LIKE 'px_%') AND quantity > 0"
        ).all(openvibeId);
        for (const item of fxItems) {
            const cat = item.item_id.startsWith('fx_') ? 'name_effect' : 'particle';
            const r = openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeId, item.item_id, cat);
            if (r.changes > 0) cosmeticCount++;
        }
    }
    console.log(`[Migration] Activated ${cosmeticCount} cosmetics`);

    // ── 8. Unlocked voices → user_cosmetics ──────────────────
    let voiceCount = 0;
    let hasVoices = false;
    try { rsDb.prepare('SELECT 1 FROM user_voices LIMIT 1').get(); hasVoices = true; } catch {}

    if (hasVoices) {
        for (const [rsId, openvibeId] of userMap) {
            const voices = rsDb.prepare('SELECT voice_id FROM user_voices WHERE user_id = ?').all(rsId);
            for (const v of voices) {
                const r = openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeId, v.voice_id, 'voice');
                if (r.changes > 0) voiceCount++;
            }
        }
    }
    console.log(`[Migration] Ported ${voiceCount} voice unlocks`);

    // ── 9. Active effects → equipped cosmetics ───────────────
    let equipCount = 0;
    let hasEffects = false;
    try { rsDb.prepare('SELECT 1 FROM active_effects LIMIT 1').get(); hasEffects = true; } catch {}

    if (hasEffects) {
        for (const [rsId, openvibeId] of userMap) {
            const effects = rsDb.prepare('SELECT * FROM active_effects WHERE user_id = ?').all(rsId);
            for (const eff of effects) {
                try {
                    const data = JSON.parse(eff.data || '{}');
                    if (eff.effect_type === 'name_fx' && data.itemId) {
                        openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeId, data.itemId, 'name_effect');
                        openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeId, 'name_effect', data.itemId);
                        openvibeDb.prepare('UPDATE game_players SET name_effect = ? WHERE user_id = ?').run(data.itemId, openvibeId);
                        equipCount++;
                    } else if (eff.effect_type === 'particle_fx' && data.itemId) {
                        openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeId, data.itemId, 'particle');
                        openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeId, 'particle', data.itemId);
                        openvibeDb.prepare('UPDATE game_players SET particle_effect = ? WHERE user_id = ?').run(data.itemId, openvibeId);
                        equipCount++;
                    }
                } catch (e) { /* malformed JSON */ }
            }
        }
    }

    // ── 10. Selected voice → equipped ────────────────────────
    let hasVoiceSel = false;
    try { rsDb.prepare('SELECT 1 FROM user_voice_selection LIMIT 1').get(); hasVoiceSel = true; } catch {}

    if (hasVoiceSel) {
        for (const [rsId, openvibeId] of userMap) {
            const sel = rsDb.prepare('SELECT voice_id FROM user_voice_selection WHERE user_id = ?').get(rsId);
            if (sel) {
                openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeId, sel.voice_id, 'voice');
                openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeId, 'voice', sel.voice_id);
                equipCount++;
            }
        }
    }
    console.log(`[Migration] Equipped ${equipCount} active cosmetics`);
});

// ── Run ──────────────────────────────────────────────────────
try {
    migrateAll();
    console.log('\n[Migration] ✅ Migration complete!');
} catch (err) {
    console.error('\n[Migration] ❌ Migration failed:', err.message);
    process.exit(1);
} finally {
    rsDb.close();
    openvibeDb.close();
}
