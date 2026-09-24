'use strict';
/**
 * Chat tags: the badge shown next to a username in chat (read-only).
 *
 * The tags came from the legacy HoboQuest game that ran inside Live (Tag Guardian fights, the Tag
 * Master shop, achievement grants). OpenVibe.Games owns that game now, so Live no longer writes any
 * of it: this module only reads what a user owns and has equipped, for chat lines, chat history
 * and OpenVibe.Chat's decor lookups. The tables stay, so existing equipped tags keep showing.
 */
const db = require('../db/database');

// ── Tag catalog ──────────────────────────────────────────────
// category: 'special' (granted), 'shop' (was sold by the Tag Master NPC), 'achievement' (game milestone)
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

function ensureTagTables() {
    db.getDb().exec(`
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
    `);
    try { db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_user_tags_user ON user_tags(user_id)'); } catch { /* */ }
}

/** Every tag a user owns. */
function getUserTags(userId) {
    const rows = db.getDb().prepare('SELECT tag_id, source, granted_at FROM user_tags WHERE user_id = ?').all(userId);
    return rows.map((r) => ({
        ...r,
        ...(TAGS[r.tag_id] || { name: r.tag_id, emoji: '🏷️', color: '#999', bgColor: '#333', desc: 'Unknown tag', category: 'special', tier: 0 }),
        tagId: r.tag_id,
    }));
}

/** The user's equipped tag, or null. */
function getEquippedTag(userId) {
    const row = db.getDb().prepare('SELECT tag_id FROM user_equipped_tag WHERE user_id = ?').get(userId);
    if (!row) return null;
    const tag = TAGS[row.tag_id];
    return tag ? { tagId: row.tag_id, ...tag } : null;
}

/** What a chat line carries: { tagId, name, emoji, color, bgColor, … } or null. */
function getTagProfile(userId) {
    return getEquippedTag(userId);
}

/** The whole catalog. */
function getAllTags() {
    return Object.entries(TAGS).map(([id, t]) => ({ tagId: id, ...t }));
}

module.exports = { TAGS, ensureTagTables, getUserTags, getEquippedTag, getTagProfile, getAllTags };
