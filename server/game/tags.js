/**
 * OpenVibeGame — Tags System
 * Modular chat tags that display next to usernames.
 * Users can own multiple tags, equip one at a time, and buy new tags
 * from the Tag Master NPC after defeating the Tag Guardian.
 */
const db = require('../db/database');

// ── Tag Catalog ──────────────────────────────────────────────
// Tags are visual badges shown next to usernames in chat.
// category: 'special' = cannot be bought, only granted
//           'shop'    = purchasable from Tag Master NPC
//           'achievement' = earned via game milestones
const TAGS = {
    // ── Special (granted, not purchasable) ───────────────────
    cfo:            { name: 'CFO',           emoji: '💼', color: '#f59e0b', bgColor: '#451a03', desc: 'Chief Financial Officer — legacy RS-Companion VIP', category: 'special', tier: 5 },
    founder:        { name: 'Founder',       emoji: '⭐', color: '#facc15', bgColor: '#422006', desc: 'Original OpenVibe.Live founder',                    category: 'special', tier: 5 },
    legacy:         { name: 'Legacy',        emoji: '🏛️', color: '#a78bfa', bgColor: '#1e1b4b', desc: 'Migrated from RS-Companion',                      category: 'special', tier: 3 },
    alpha_tester:   { name: 'Alpha Tester',  emoji: '🧪', color: '#34d399', bgColor: '#022c22', desc: 'Tested during alpha phase',                       category: 'special', tier: 3 },
    mod:            { name: 'Mod',           emoji: '🛡️', color: '#60a5fa', bgColor: '#172554', desc: 'Platform moderator',                              category: 'special', tier: 4 },
    admin:          { name: 'Admin',         emoji: '⚡', color: '#f87171', bgColor: '#450a0a', desc: 'Platform administrator',                           category: 'special', tier: 5 },
    streamer:       { name: 'Streamer',      emoji: '📡', color: '#c084fc', bgColor: '#3b0764', desc: 'Verified streamer',                               category: 'special', tier: 4 },
    vip:            { name: 'VIP',           emoji: '👑', color: '#fbbf24', bgColor: '#78350f', desc: 'Very Important Person',                            category: 'special', tier: 4 },
    developer:      { name: 'Dev',           emoji: '🔧', color: '#38bdf8', bgColor: '#0c4a6e', desc: 'Platform developer',                              category: 'special', tier: 5 },

    // ── Shop Tags (purchasable from Tag Master NPC) ──────────
    noob:           { name: 'Noob',          emoji: '🐣', color: '#86efac', bgColor: '#052e16', desc: 'Everyone starts somewhere',                        category: 'shop', tier: 1, cost: 50 },
    chatterbox:     { name: 'Chatterbox',    emoji: '💬', color: '#93c5fd', bgColor: '#1e3a5f', desc: 'Professional yapper',                              category: 'shop', tier: 1, cost: 100 },
    warrior:        { name: 'Warrior',       emoji: '⚔️', color: '#fca5a5', bgColor: '#450a0a', desc: 'Battle-hardened fighter',                          category: 'shop', tier: 2, cost: 250 },
    miner:          { name: 'Miner',         emoji: '⛏️', color: '#d4d4d8', bgColor: '#27272a', desc: 'Deep rock delver',                                category: 'shop', tier: 2, cost: 250 },
    angler:         { name: 'Angler',        emoji: '🎣', color: '#7dd3fc', bgColor: '#0c4a6e', desc: 'Master of the rod',                                category: 'shop', tier: 2, cost: 250 },
    lumberjack:     { name: 'Lumberjack',    emoji: '🪓', color: '#a3e635', bgColor: '#1a2e05', desc: 'Timber specialist',                                category: 'shop', tier: 2, cost: 250 },
    farmer:         { name: 'Farmer',        emoji: '🌾', color: '#fde68a', bgColor: '#451a03', desc: 'Crop connoisseur',                                 category: 'shop', tier: 2, cost: 250 },
    chef:           { name: 'Chef',          emoji: '👨‍🍳', color: '#fdba74', bgColor: '#431407', desc: 'Culinary master',                                 category: 'shop', tier: 2, cost: 300 },
    merchant:       { name: 'Merchant',      emoji: '🏪', color: '#fcd34d', bgColor: '#78350f', desc: 'Shrewd trader',                                    category: 'shop', tier: 3, cost: 500 },
    explorer:       { name: 'Explorer',      emoji: '🧭', color: '#6ee7b7', bgColor: '#022c22', desc: 'Seen it all',                                      category: 'shop', tier: 3, cost: 500 },
    assassin:       { name: 'Assassin',      emoji: '🗡️', color: '#a78bfa', bgColor: '#1e1b4b', desc: 'Silent and deadly',                               category: 'shop', tier: 3, cost: 750 },
    overlord:       { name: 'Overlord',      emoji: '🔱', color: '#e879f9', bgColor: '#4a044e', desc: 'Rules with an iron fist',                          category: 'shop', tier: 4, cost: 1500 },
    legend:         { name: 'Legend',         emoji: '🏆', color: '#fbbf24', bgColor: '#451a03', desc: 'Etched in history',                                category: 'shop', tier: 5, cost: 5000 },
    void_walker:    { name: 'Void Walker',   emoji: '🕳️', color: '#818cf8', bgColor: '#0f0f23', desc: 'From beyond the abyss',                           category: 'shop', tier: 5, cost: 10000 },

    // ── Achievement Tags (earned, not purchasable) ───────────
    dragon_slayer:  { name: 'Dragonslayer',  emoji: '🐉', color: '#ef4444', bgColor: '#450a0a', desc: 'Slew a dragon',                                    category: 'achievement', tier: 4 },
    dungeon_master: { name: 'Dungeon Master',emoji: '🏰', color: '#c084fc', bgColor: '#3b0764', desc: 'Won 50 dungeon fights',                            category: 'achievement', tier: 4 },
    fish_lord:      { name: 'Fish Lord',     emoji: '🐟', color: '#22d3ee', bgColor: '#083344', desc: 'Caught every fish species',                         category: 'achievement', tier: 4 },
    big_spender:    { name: 'Big Spender',   emoji: '💰', color: '#fbbf24', bgColor: '#78350f', desc: 'Spent 50,000 gold total',                           category: 'achievement', tier: 3 },
    survivor:       { name: 'Survivor',      emoji: '💪', color: '#4ade80', bgColor: '#052e16', desc: 'Won 100 PvP battles',                               category: 'achievement', tier: 4 },
};

// ── Tag Guardian (NPC boss you must defeat to access the tag shop) ──
const TAG_GUARDIAN = {
    name: 'Tag Guardian',
    emoji: '🏷️',
    hp: 80,
    atk: 18,
    def: 8,
    xp: 50,
    gold: 30,
    desc: 'A mysterious warrior who guards the Tag Master\'s shop. Defeat them to prove your worth.',
    combatLevel: 3, // minimum combat level to challenge
};

// ── Ensure DB tables ─────────────────────────────────────────
function ensureTagTables() {
    const d = db.getDb();
    d.exec(`
        CREATE TABLE IF NOT EXISTS user_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tag_id TEXT NOT NULL,
            source TEXT DEFAULT 'shop',
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, tag_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS user_equipped_tag (
            user_id INTEGER NOT NULL PRIMARY KEY,
            tag_id TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tag_guardian_defeats (
            user_id INTEGER NOT NULL PRIMARY KEY,
            defeated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    try { d.exec('CREATE INDEX IF NOT EXISTS idx_user_tags_user ON user_tags(user_id)'); } catch { }
}

// ── Tag Guardian Combat ──────────────────────────────────────

/**
 * Check if the user has already defeated the Tag Guardian.
 */
function hasDefeatedGuardian(userId) {
    const d = db.getDb();
    return !!d.prepare('SELECT 1 FROM tag_guardian_defeats WHERE user_id = ?').get(userId);
}

/**
 * Fight the Tag Guardian. Turn-based combat similar to dungeon monsters.
 * Returns { success, won, log, xp?, gold? }
 */
function fightGuardian(userId) {
    const d = db.getDb();

    if (hasDefeatedGuardian(userId)) {
        return { error: 'You have already defeated the Tag Guardian. The shop is open to you.' };
    }

    // Check combat level
    const player = d.prepare('SELECT hp, attack, defense, combat_xp FROM game_players WHERE user_id = ?').get(userId);
    if (!player) return { error: 'No game character found. Enter the game first.' };

    const combatLevel = xpToLevel(player.combat_xp);
    if (combatLevel < TAG_GUARDIAN.combatLevel) {
        return { error: `Need Combat Lv ${TAG_GUARDIAN.combatLevel} to challenge the Tag Guardian. (You're Lv ${combatLevel})` };
    }

    const guardian = { ...TAG_GUARDIAN };
    // Scale slightly with player level for fairness
    const scale = 1 + (combatLevel - 1) * 0.03;
    guardian.hp = Math.round(guardian.hp * scale);
    guardian.atk = Math.round(guardian.atk * scale);

    let playerHp = player.hp;
    let guardianHp = guardian.hp;
    const log = [];
    let round = 0;

    while (playerHp > 0 && guardianHp > 0 && round < 20) {
        round++;
        // Player attacks
        const pDmg = Math.max(1, Math.round(player.attack * (0.8 + Math.random() * 0.4) - guardian.def * 0.3));
        guardianHp -= pDmg;
        log.push({ type: 'player_attack', dmg: pDmg, guardianHp: Math.max(0, guardianHp) });
        if (guardianHp <= 0) break;
        // Guardian attacks
        const gDmg = Math.max(1, Math.round(guardian.atk * (0.8 + Math.random() * 0.4) - player.defense * 0.3));
        playerHp -= gDmg;
        log.push({ type: 'guardian_attack', dmg: gDmg, playerHp: Math.max(0, playerHp) });
    }

    // Update player HP
    d.prepare('UPDATE game_players SET hp = ? WHERE user_id = ?').run(Math.max(0, playerHp), userId);

    if (guardianHp <= 0) {
        // Victory — record the defeat and grant XP/gold
        d.prepare('INSERT OR IGNORE INTO tag_guardian_defeats (user_id) VALUES (?)').run(userId);
        // Grant XP via direct update (combat_xp)
        d.prepare('UPDATE game_players SET combat_xp = combat_xp + ? WHERE user_id = ?').run(guardian.xp, userId);
        // Gold is OpenCoins now — credit the network wallet (idempotent: one-time defeat).
        require('../monetization/wallet-client')
            .credit(userId, guardian.gold, 'Tag Guardian defeated', `live:guardian_defeat:${userId}`)
            .catch((e) => console.warn('[Tags] guardian gold credit failed:', e.message));

        return {
            success: true,
            won: true,
            log,
            xp: guardian.xp,
            gold: guardian.gold,
            message: 'The Tag Guardian falls! The Tag Master\'s shop is now open to you. 🏷️',
        };
    }

    // Defeat — player can try again after healing
    return {
        success: true,
        won: false,
        log,
        message: 'The Tag Guardian overwhelms you... heal up and try again.',
    };
}

// ── Tag Queries ──────────────────────────────────────────────

/**
 * Get all tags owned by a user.
 */
function getUserTags(userId) {
    const d = db.getDb();
    const rows = d.prepare('SELECT tag_id, source, granted_at FROM user_tags WHERE user_id = ?').all(userId);
    return rows.map(r => ({
        ...r,
        ...(TAGS[r.tag_id] || { name: r.tag_id, emoji: '🏷️', color: '#999', bgColor: '#333', desc: 'Unknown tag', category: 'special', tier: 0 }),
        tagId: r.tag_id,
    }));
}

/**
 * Get the user's currently equipped tag (or null).
 */
function getEquippedTag(userId) {
    const d = db.getDb();
    const row = d.prepare('SELECT tag_id FROM user_equipped_tag WHERE user_id = ?').get(userId);
    if (!row) return null;
    const tag = TAGS[row.tag_id];
    if (!tag) return null;
    return { tagId: row.tag_id, ...tag };
}

/**
 * Get tag profile for chat message attachment.
 * Returns { tagId, name, emoji, color, bgColor } or null.
 */
function getTagProfile(userId) {
    return getEquippedTag(userId);
}

/**
 * Grant a tag to a user (for special/achievement tags).
 */
function grantTag(userId, tagId, source = 'system') {
    const tag = TAGS[tagId];
    if (!tag) return { error: 'Unknown tag' };
    const d = db.getDb();
    try {
        d.prepare('INSERT OR IGNORE INTO user_tags (user_id, tag_id, source) VALUES (?, ?, ?)').run(userId, tagId, source);
        return { success: true, tag: { tagId, ...tag } };
    } catch (err) {
        return { error: err.message };
    }
}

/**
 * Revoke a tag from a user.
 */
function revokeTag(userId, tagId) {
    const d = db.getDb();
    // Unequip if currently equipped
    d.prepare('DELETE FROM user_equipped_tag WHERE user_id = ? AND tag_id = ?').run(userId, tagId);
    d.prepare('DELETE FROM user_tags WHERE user_id = ? AND tag_id = ?').run(userId, tagId);
    return { success: true };
}

/**
 * Buy a tag from the Tag Master shop.
 * Requires: guardian defeated, tag is shop category, enough gold, not already owned.
 */
async function buyTag(userId, tagId) {
    const tag = TAGS[tagId];
    if (!tag) return { error: 'Unknown tag' };
    if (tag.category !== 'shop') return { error: 'This tag cannot be purchased' };
    if (!tag.cost) return { error: 'This tag has no price' };

    if (!hasDefeatedGuardian(userId)) {
        return { error: 'You must defeat the Tag Guardian before shopping here!' };
    }

    const d = db.getDb();
    const existing = d.prepare('SELECT 1 FROM user_tags WHERE user_id = ? AND tag_id = ?').get(userId, tagId);
    if (existing) return { error: 'You already own this tag' };

    // Spend from the network OpenCoins wallet (idempotent per user+tag).
    try {
        const wallet = require('../monetization/wallet-client');
        const result = await wallet.debit(userId, tag.cost, `Tag purchase: ${tagId}`, `live:tag_purchase:${userId}:${tagId}`);
        if (!result) return { error: 'OpenCoins wallet unavailable — link your OpenVibe.Network account' };
    } catch (e) {
        if (e && e.status === 409) return { error: `Not enough OpenCoins. Need ${tag.cost}.` };
        return { error: 'Purchase failed — wallet unavailable' };
    }

    d.prepare('INSERT INTO user_tags (user_id, tag_id, source) VALUES (?, ?, ?)').run(userId, tagId, 'shop');
    return { success: true, tag: { tagId, ...tag }, cost: tag.cost };
}

/**
 * Equip a tag (must own it).
 */
function equipTag(userId, tagId) {
    const tag = TAGS[tagId];
    if (!tag) return { error: 'Unknown tag' };

    const d = db.getDb();
    const owned = d.prepare('SELECT 1 FROM user_tags WHERE user_id = ? AND tag_id = ?').get(userId, tagId);
    if (!owned) return { error: 'You don\'t own this tag' };

    d.prepare('INSERT OR REPLACE INTO user_equipped_tag (user_id, tag_id) VALUES (?, ?)').run(userId, tagId);
    return { success: true, tag: { tagId, ...tag } };
}

/**
 * Unequip the current tag.
 */
function unequipTag(userId) {
    const d = db.getDb();
    d.prepare('DELETE FROM user_equipped_tag WHERE user_id = ?').run(userId);
    return { success: true };
}

/**
 * Get the shop catalog (only shop-category tags).
 */
function getShopTags() {
    return Object.entries(TAGS)
        .filter(([_, t]) => t.category === 'shop')
        .map(([id, t]) => ({ tagId: id, ...t }))
        .sort((a, b) => a.cost - b.cost);
}

/**
 * Get all tags for the catalog/wiki view (all categories).
 */
function getAllTags() {
    return Object.entries(TAGS).map(([id, t]) => ({ tagId: id, ...t }));
}

// ── XP helper (duplicated locally to avoid circular dep) ─────
function xpToLevel(xp) {
    return Math.floor(Math.sqrt((xp || 0) / 25)) + 1;
}

module.exports = {
    TAGS,
    TAG_GUARDIAN,
    ensureTagTables,
    // Guardian
    hasDefeatedGuardian,
    fightGuardian,
    // Tag CRUD
    getUserTags,
    getEquippedTag,
    getTagProfile,
    grantTag,
    revokeTag,
    buyTag,
    equipTag,
    unequipTag,
    // Shop
    getShopTags,
    getAllTags,
};
