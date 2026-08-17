/**
 * OpenVibe.Live — Legacy User Migration
 *
 * Automatically ports a single user's data from the RS-Companion SQLite DB
 * into OpenVibeGame tables when they register with a legacy verification key.
 *
 * Called from the auth registration route — no manual migration script needed.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const RS_DB_PATH = process.env.RS_COMPANION_DB_PATH || '';

let rsDb = null;
let available = false;

/**
 * Open (read-only) connection to the RS-Companion DB.
 * Called once on first use, cached for the lifetime of the process.
 */
function getRsDb() {
    if (rsDb) return rsDb;
    if (!RS_DB_PATH) return null;

    const resolved = path.resolve(RS_DB_PATH);
    if (!fs.existsSync(resolved)) {
        console.warn(`[LegacyMigration] RS-Companion DB not found at ${resolved}`);
        return null;
    }

    try {
        rsDb = new Database(resolved, { readonly: true });
        available = true;
        console.log(`[LegacyMigration] RS-Companion DB opened: ${resolved}`);
        return rsDb;
    } catch (err) {
        console.error(`[LegacyMigration] Failed to open RS-Companion DB: ${err.message}`);
        return null;
    }
}

/**
 * Check whether legacy migration is available (RS DB configured + exists).
 */
function isAvailable() {
    if (available) return true;
    return !!getRsDb();
}

/**
 * Migrate a single legacy user's data into OpenVibeGame.
 *
 * @param {object} openvibeDb  - The OpenVibe.Live better-sqlite3 Database instance
 * @param {number} openvibeUserId - The new OpenVibe.Live user ID
 * @param {string} username - The username (used to find the RS-Companion record)
 * @returns {{ success: boolean, message: string, stats?: object }}
 */
function migrateUser(openvibeDb, openvibeUserId, username) {
    const rs = getRsDb();
    if (!rs) {
        return { success: false, message: 'RS-Companion DB not available' };
    }

    try {
        // Find the RS-Companion user by username (case-insensitive)
        const rsu = rs.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
        if (!rsu) {
            return { success: false, message: `No RS-Companion user found for "${username}"` };
        }

        const rsId = rsu.user_id;
        const stats = { player: false, inventory: 0, bank: 0, recipes: 0, battle: false, coins: 0 };

        // Run all migrations in a single transaction
        const doMigrate = openvibeDb.transaction(() => {

            // ── 1. Player profile (XP from skill systems) ────────
            const fish = safeGet(rs, 'SELECT fish_xp FROM fish_profile WHERE user_id = ?', rsId);
            const mine = safeGet(rs, 'SELECT mine_xp FROM mine_profile WHERE user_id = ?', rsId);
            const wc   = safeGet(rs, 'SELECT wc_xp FROM woodcut_profile WHERE user_id = ?', rsId);

            let combatXp = 0;
            try {
                const dung = rs.prepare('SELECT dungeon_xp FROM dungeon_stats WHERE user_id = ?').get(rsId);
                if (dung) combatXp = dung.dungeon_xp || 0;
            } catch {}

            const craftXp = Math.floor((rsu.xp || 0) * 0.3);

            openvibeDb.prepare(`
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
            `).run(
                openvibeUserId,
                rsu.username,
                mine?.mine_xp || 0,
                fish?.fish_xp || 0,
                wc?.wc_xp || 0,
                0, // farming_xp (no direct equivalent)
                combatXp,
                craftXp,
                Math.floor(rsu.coins || 0)
            );
            stats.player = true;

            // ── 2. Inventory ─────────────────────────────────────
            const items = safeAll(rs, 'SELECT item_id, quantity FROM inventory WHERE user_id = ?', rsId);
            for (const item of items) {
                if (item.quantity > 0) {
                    openvibeDb.prepare(`
                        INSERT INTO game_inventory (user_id, item_id, quantity)
                        VALUES (?, ?, ?)
                        ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
                    `).run(openvibeUserId, item.item_id, item.quantity);
                    stats.inventory++;
                }
            }

            // ── 3. Bank ──────────────────────────────────────────
            const bankItems = safeAll(rs, 'SELECT item_id, quantity FROM bank_items WHERE user_id = ?', rsId);
            for (const item of bankItems) {
                if (item.quantity > 0) {
                    openvibeDb.prepare(`
                        INSERT INTO game_bank (user_id, item_id, quantity)
                        VALUES (?, ?, ?)
                        ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
                    `).run(openvibeUserId, item.item_id, item.quantity);
                    stats.bank++;
                }
            }

            // ── 4. Unlocked Recipes ──────────────────────────────
            const recipes = safeAll(rs, 'SELECT recipe_id FROM unlocked_recipes WHERE user_id = ?', rsId);
            for (const r of recipes) {
                openvibeDb.prepare('INSERT OR IGNORE INTO game_recipes (user_id, recipe_id) VALUES (?, ?)').run(openvibeUserId, r.recipe_id);
                stats.recipes++;
            }

            // ── 5. Battle Stats ──────────────────────────────────
            const bs = safeGet(rs, 'SELECT * FROM battle_stats WHERE user_id = ?', rsId);
            if (bs) {
                openvibeDb.prepare(`
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
                `).run(
                    openvibeUserId,
                    bs.battles_won || 0, bs.battles_lost || 0,
                    bs.total_stolen || 0, bs.total_lost || 0,
                    bs.kill_streak || 0, bs.best_streak || 0,
                    bs.kills || 0, bs.deaths || 0
                );
                stats.battle = true;
            }

            // ── 6. Coins bonus ───────────────────────────────────
            const coins = Math.floor(rsu.coins || 0);
            if (coins > 0) {
                openvibeDb.prepare('UPDATE users SET openvibe_coins_balance = openvibe_coins_balance + ? WHERE id = ?').run(coins, openvibeUserId);
                stats.coins = coins;
            }

            // ── 7. Cosmetics (fx_*, px_* items → user_cosmetics) ─
            const fxItems = openvibeDb.prepare(
                "SELECT item_id FROM game_inventory WHERE user_id = ? AND (item_id LIKE 'fx_%' OR item_id LIKE 'px_%') AND quantity > 0"
            ).all(openvibeUserId);
            for (const item of fxItems) {
                const cat = item.item_id.startsWith('fx_') ? 'name_effect' : 'particle';
                openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeUserId, item.item_id, cat);
                stats.cosmetics = (stats.cosmetics || 0) + 1;
            }

            // ── 8. Unlocked voices → user_cosmetics ─────────────
            const rsVoices = safeAll(rs, 'SELECT voice_id FROM user_voices WHERE user_id = ?', rsId);
            for (const v of rsVoices) {
                openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeUserId, v.voice_id, 'voice');
                stats.voices = (stats.voices || 0) + 1;
            }

            // ── 9. Active effects → equipped cosmetics ──────────
            const activeEffects = safeAll(rs, 'SELECT * FROM active_effects WHERE user_id = ?', rsId);
            for (const eff of activeEffects) {
                try {
                    const data = JSON.parse(eff.data || '{}');
                    if (eff.effect_type === 'name_fx' && data.itemId) {
                        openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeUserId, data.itemId, 'name_effect');
                        openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeUserId, 'name_effect', data.itemId);
                        openvibeDb.prepare('UPDATE game_players SET name_effect = ? WHERE user_id = ?').run(data.itemId, openvibeUserId);
                    } else if (eff.effect_type === 'particle_fx' && data.itemId) {
                        openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeUserId, data.itemId, 'particle');
                        openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeUserId, 'particle', data.itemId);
                        openvibeDb.prepare('UPDATE game_players SET particle_effect = ? WHERE user_id = ?').run(data.itemId, openvibeUserId);
                    }
                } catch (e) { /* malformed JSON */ }
            }

            // ── 10. Selected voice → equipped ───────────────────
            const selVoice = safeGet(rs, 'SELECT voice_id FROM user_voice_selection WHERE user_id = ?', rsId);
            if (selVoice) {
                openvibeDb.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(openvibeUserId, selVoice.voice_id, 'voice');
                openvibeDb.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(openvibeUserId, 'voice', selVoice.voice_id);
            }
        });

        doMigrate();

        const summary = [
            stats.player ? 'XP' : null,
            stats.inventory > 0 ? `${stats.inventory} items` : null,
            stats.bank > 0 ? `${stats.bank} bank items` : null,
            stats.recipes > 0 ? `${stats.recipes} recipes` : null,
            stats.battle ? 'battle stats' : null,
            stats.coins > 0 ? `${stats.coins} coins` : null,
            stats.cosmetics > 0 ? `${stats.cosmetics} cosmetics` : null,
            stats.voices > 0 ? `${stats.voices} voices` : null,
        ].filter(Boolean).join(', ');

        console.log(`[LegacyMigration] ✅ Migrated "${username}" (RS id=${rsId}) → OpenVibe id=${openvibeUserId}: ${summary}`);
        return { success: true, message: `Legacy data migrated: ${summary}`, stats };

    } catch (err) {
        console.error(`[LegacyMigration] ❌ Failed for "${username}":`, err.message);
        return { success: false, message: `Migration error: ${err.message}` };
    }
}

// ── Safe query helpers (gracefully handle missing tables) ────

function safeGet(db, sql, ...params) {
    try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function safeAll(db, sql, ...params) {
    try { return db.prepare(sql).all(...params) || []; } catch { return []; }
}

/**
 * Clean up — close the RS-Companion DB connection.
 */
function close() {
    if (rsDb) {
        try { rsDb.close(); } catch {}
        rsDb = null;
        available = false;
    }
}

module.exports = { migrateUser, isAvailable, close };
