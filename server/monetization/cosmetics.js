/**
 * OpenVibe.Live — Cosmetics System
 * Global cosmetic items (name effects, particles, hats, voices)
 * Unlocked via OpenVibeGame items, equipped globally for chat/overlay.
 * Can be converted back to game items for trading.
 */
const db = require('../db/database');
const http = require('http');

// openvibe-quest internal API base (server-to-server on localhost)
const LEGACY_QUEST_API = 'http://127.0.0.1:3200';

// ── Cosmetic Catalog (defines all cosmetics and their CSS/rendering data) ───
const COSMETICS = {
    // ── Name Effects ─────────────────────────────────────
    fx_rainbow:  { name: 'Rainbow Name',  emoji: '🌈', category: 'name_effect', tier: 1, cssClass: 'name-fx-rainbow',  desc: 'Rainbow cycling colors' },
    fx_fire:     { name: 'Fire Name',     emoji: '🔥', category: 'name_effect', tier: 1, cssClass: 'name-fx-fire',     desc: 'Blazing flames' },
    fx_ice:      { name: 'Ice Name',      emoji: '❄️', category: 'name_effect', tier: 1, cssClass: 'name-fx-ice',      desc: 'Frosty glow' },
    fx_golden:   { name: 'Golden Name',   emoji: '👑', category: 'name_effect', tier: 2, cssClass: 'name-fx-golden',   desc: 'Golden shine' },
    fx_neon:     { name: 'Neon Name',     emoji: '💡', category: 'name_effect', tier: 2, cssClass: 'name-fx-neon',     desc: 'Neon pulse' },
    fx_galaxy:   { name: 'Galaxy Name',   emoji: '🌌', category: 'name_effect', tier: 3, cssClass: 'name-fx-galaxy',   desc: 'Cosmic swirl' },
    fx_void:     { name: 'Void Name',     emoji: '🕳️', category: 'name_effect', tier: 4, cssClass: 'name-fx-void',    desc: 'Warps spacetime' },
    // RS-Companion legacy name effects
    fx_toxic:    { name: 'Toxic Name',    emoji: '☠️', category: 'name_effect', tier: 1, cssClass: 'name-fx-toxic',    desc: 'Toxic drip' },
    fx_blood:    { name: 'Blood Name',    emoji: '🩸', category: 'name_effect', tier: 3, cssClass: 'name-fx-blood',    desc: 'Dripping blood' },
    fx_shadow:   { name: 'Shadow Name',   emoji: '🌑', category: 'name_effect', tier: 3, cssClass: 'name-fx-shadow',   desc: 'Dark shadow' },
    fx_glitch:   { name: 'Glitch Name',   emoji: '📟', category: 'name_effect', tier: 3, cssClass: 'name-fx-glitch',   desc: 'Digital glitch' },
    fx_hologram: { name: 'Hologram Name', emoji: '🔮', category: 'name_effect', tier: 4, cssClass: 'name-fx-hologram', desc: 'Holographic shimmer' },
    fx_divine:   { name: 'Divine Name',   emoji: '✝️', category: 'name_effect', tier: 5, cssClass: 'name-fx-divine',   desc: 'Divine radiance' },

    // ── Particle Effects ─────────────────────────────────
    px_sparkle:  { name: 'Sparkle',       emoji: '✨', category: 'particle', tier: 1, cssClass: 'px-sparkle',  chars: '✦✧⋆',    desc: 'Sparkle particles' },
    px_hearts:   { name: 'Hearts',        emoji: '💖', category: 'particle', tier: 1, cssClass: 'px-hearts',   chars: '♥♡❤',    desc: 'Heart particles' },
    px_flames:   { name: 'Flames',        emoji: '🔥', category: 'particle', tier: 2, cssClass: 'px-flames',   chars: '🔥🔸⚡',  desc: 'Flame embers' },
    px_stars:    { name: 'Stars',         emoji: '⭐', category: 'particle', tier: 2, cssClass: 'px-stars',    chars: '★☆✩',    desc: 'Orbiting stars' },
    px_void:     { name: 'Void',          emoji: '🕳️', category: 'particle', tier: 3, cssClass: 'px-void',    chars: '◉◎⊙',    desc: 'Dark matter' },

    // ── Hats ─────────────────────────────────────────────
    hat_basic_cap:  { name: 'Basic Cap',    emoji: '🧢', category: 'hat', tier: 1, hatChar: '🧢', desc: 'Simple cap' },
    hat_cowboy:     { name: 'Cowboy Hat',   emoji: '🤠', category: 'hat', tier: 2, hatChar: '🤠', desc: 'Yeehaw' },
    hat_wizard:     { name: 'Wizard Hat',   emoji: '🧙', category: 'hat', tier: 3, hatChar: '🧙', animated: 'float',  desc: 'Magical' },
    hat_crown:      { name: 'Royal Crown',  emoji: '👑', category: 'hat', tier: 4, hatChar: '👑', animated: 'pulse',  desc: 'Royalty' },
    hat_halo:       { name: 'Halo',         emoji: '😇', category: 'hat', tier: 5, hatChar: '😇', animated: 'float',  desc: 'Angelic' },
    hat_void_crown: { name: 'Void Crown',   emoji: '🕳️', category: 'hat', tier: 6, hatChar: '🕳️', animated: 'warp', desc: 'From the dungeon depths' },

    // ── Voices (TTS style — cosmetic, actual TTS is client-side SpeechSynthesis) ──
    voice_default:  { name: 'Default Voice',  emoji: '🔊', category: 'voice', tier: 0, desc: 'Standard TTS' },
    voice_deep:     { name: 'Deep Voice',     emoji: '🎵', category: 'voice', tier: 1, pitch: 0.6, rate: 0.9, desc: 'Low and rumbly' },
    voice_chipmunk: { name: 'Chipmunk Voice', emoji: '🐿️', category: 'voice', tier: 1, pitch: 1.8, rate: 1.3, desc: 'Squeaky and fast' },
    voice_robot:    { name: 'Robot Voice',    emoji: '🤖', category: 'voice', tier: 2, pitch: 0.8, rate: 1.0, desc: 'Monotone machine' },
    voice_whisper:  { name: 'Whisper Voice',  emoji: '🤫', category: 'voice', tier: 2, pitch: 1.1, rate: 0.7, desc: 'Quiet and eerie' },
    voice_demon:    { name: 'Demon Voice',    emoji: '😈', category: 'voice', tier: 3, pitch: 0.3, rate: 0.6, desc: 'From the underworld' },

    // ── RS-Companion Legacy Voices ───────────────────────
    gary:               { name: 'Gary',              emoji: '🔊', category: 'voice', tier: 1, pitch: 1.0, rate: 1.0,  desc: 'Standard voice' },
    brenda:             { name: 'Brenda',            emoji: '👩', category: 'voice', tier: 1, pitch: 1.2, rate: 1.0,  desc: 'Friendly female' },
    chadbot:            { name: 'ChadBot',           emoji: '💪', category: 'voice', tier: 1, pitch: 0.5, rate: 0.8,  desc: 'Deep bro voice' },
    karen:              { name: 'Karen',             emoji: '💅', category: 'voice', tier: 1, pitch: 1.3, rate: 1.1,  desc: 'Manager-seeking' },
    squeakmaster:       { name: 'SqueakMaster',      emoji: '🐭', category: 'voice', tier: 1, pitch: 1.9, rate: 1.4,  desc: 'Ultra-squeaky' },
    bigchungus:         { name: 'BigChungus',        emoji: '🐰', category: 'voice', tier: 1, pitch: 0.3, rate: 0.7,  desc: 'Absolute unit' },
    tweaker:            { name: 'Tweaker',           emoji: '⚡', category: 'voice', tier: 1, pitch: 1.4, rate: 1.8,  desc: 'Fast & nervous' },
    grandpa:            { name: 'Grandpa',           emoji: '👴', category: 'voice', tier: 1, pitch: 0.7, rate: 0.7,  desc: 'Old & wise' },
    crackhead:          { name: 'CrackheadCarl',     emoji: '💊', category: 'voice', tier: 2, pitch: 1.5, rate: 1.6,  desc: 'Manic energy' },
    ghostgirl:          { name: 'GhostGirl',         emoji: '👻', category: 'voice', tier: 2, pitch: 1.6, rate: 0.8,  desc: 'Eerie whisper' },
    robotoverlord:      { name: 'RobotOverlord',     emoji: '🤖', category: 'voice', tier: 2, pitch: 0.4, rate: 0.9,  desc: 'Machine overlord' },
    sassybitch:         { name: 'SassyBitch',        emoji: '💁', category: 'voice', tier: 2, pitch: 1.3, rate: 1.2,  desc: 'Sassy attitude' },
    demon:              { name: 'Demon (Legacy)',    emoji: '👹', category: 'voice', tier: 2, pitch: 0.2, rate: 0.5,  desc: 'Demonic (espeak)' },
    helium:             { name: 'Helium',            emoji: '🎈', category: 'voice', tier: 1, pitch: 2.0, rate: 1.5,  desc: 'Squeaky helium' },
    britbong:           { name: 'BritBong',          emoji: '🇬🇧', category: 'voice', tier: 1, pitch: 1.0, rate: 0.9,  desc: 'British accent' },
    yeehaw:             { name: 'YeeHaw',            emoji: '🤠', category: 'voice', tier: 1, pitch: 0.8, rate: 0.9,  desc: 'Southern drawl' },
    nyc:                { name: 'NYC',               emoji: '🗽', category: 'voice', tier: 1, pitch: 1.1, rate: 1.3,  desc: 'New York accent' },
    french:             { name: 'French',            emoji: '🇫🇷', category: 'voice', tier: 1, pitch: 1.1, rate: 0.8,  desc: 'French accent' },
    chatterbox:         { name: 'Chatterbox',        emoji: '💬', category: 'voice', tier: 3, pitch: 1.2, rate: 1.4,  desc: 'Achievement voice' },
    fisherman:          { name: 'Fisherman',         emoji: '🎣', category: 'voice', tier: 3, pitch: 0.9, rate: 0.85, desc: 'Achievement voice' },
    gc_smooth_operator: { name: 'Smooth Operator',   emoji: '🎤', category: 'voice', tier: 3, pitch: 0.9, rate: 0.95, desc: 'Google Cloud' },
    gc_silicon_sally:   { name: 'Silicon Sally',     emoji: '🎤', category: 'voice', tier: 3, pitch: 1.2, rate: 1.0,  desc: 'Google Cloud' },
    gc_brit_butler:     { name: 'British Butler',    emoji: '🎤', category: 'voice', tier: 3, pitch: 0.85, rate: 0.9, desc: 'Google Cloud' },
    gc_lady_london:     { name: 'Lady London',       emoji: '🎤', category: 'voice', tier: 3, pitch: 1.15, rate: 0.95,desc: 'Google Cloud' },
    gc_mumbai_mike:     { name: 'Mumbai Mike',       emoji: '🎤', category: 'voice', tier: 3, pitch: 1.0, rate: 1.05, desc: 'Google Cloud' },
    gc_down_under:      { name: 'Down Under',        emoji: '🎤', category: 'voice', tier: 3, pitch: 0.95, rate: 1.0, desc: 'Google Cloud' },
    gc_sheila:          { name: 'Sheila',            emoji: '🎤', category: 'voice', tier: 3, pitch: 1.25, rate: 1.05,desc: 'Google Cloud' },
    gc_studio_f:        { name: 'Studio Female',     emoji: '🎙️', category: 'voice', tier: 4, pitch: 1.1, rate: 0.9,  desc: 'Google Studio' },
    gc_studio_m:        { name: 'Studio Male',       emoji: '🎙️', category: 'voice', tier: 4, pitch: 0.85, rate: 0.9, desc: 'Google Studio' },
    pl_joanna_std:      { name: 'Joanna',            emoji: '🎤', category: 'voice', tier: 3, pitch: 1.1, rate: 1.0,  desc: 'Amazon Polly' },
    pl_matthew_std:     { name: 'Matthew',           emoji: '🎤', category: 'voice', tier: 3, pitch: 0.9, rate: 1.0,  desc: 'Amazon Polly' },
    pl_amy_std:         { name: 'Amy',               emoji: '🎤', category: 'voice', tier: 3, pitch: 1.15, rate: 1.0, desc: 'Amazon Polly' },
    pl_brian_std:       { name: 'Brian',             emoji: '🎤', category: 'voice', tier: 3, pitch: 0.85, rate: 0.95,desc: 'Amazon Polly' },
    pl_olivia_std:      { name: 'Olivia',            emoji: '🎤', category: 'voice', tier: 3, pitch: 1.2, rate: 1.0,  desc: 'Amazon Polly' },
    pl_danielle_long:   { name: 'Danielle',          emoji: '🎤', category: 'voice', tier: 4, pitch: 1.1, rate: 0.85, desc: 'Polly Long-form' },
    pl_gregory_long:    { name: 'Gregory',           emoji: '🎤', category: 'voice', tier: 4, pitch: 0.8, rate: 0.85, desc: 'Polly Long-form' },
    pl_gregory_neural:  { name: 'Gregory Neural',    emoji: '🧠', category: 'voice', tier: 4, pitch: 0.85, rate: 0.9, desc: 'Polly Neural' },
    pl_ruth_long:       { name: 'Ruth',              emoji: '🎤', category: 'voice', tier: 4, pitch: 1.0, rate: 0.85, desc: 'Polly Long-form' },
    pl_arthur_neural:   { name: 'Arthur Neural',     emoji: '🧠', category: 'voice', tier: 5, pitch: 0.9, rate: 0.85, desc: 'Polly Neural' },
    vs_mine_dwarf_lord: { name: 'Dwarf Lord',        emoji: '⛏️', category: 'voice', tier: 5, pitch: 0.5, rate: 0.7,  desc: 'Skill mastery' },
};

// Category → slot name mapping
const CATEGORY_SLOT = {
    name_effect: 'name_effect',
    particle: 'particle',
    hat: 'hat',
    voice: 'voice',
};

// ── Ensure tables exist (called at startup) ──────────────────
function ensureTables() {
    const d = db.getDb();
    d.exec(`
        CREATE TABLE IF NOT EXISTS user_cosmetics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            category TEXT NOT NULL,
            unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, item_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS user_equipped (
            user_id INTEGER NOT NULL,
            slot TEXT NOT NULL,
            item_id TEXT NOT NULL,
            PRIMARY KEY (user_id, slot),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
}

// ── Get all unlocked cosmetics for a user ────────────────────
function getUnlocked(userId) {
    const d = db.getDb();
    return d.prepare('SELECT item_id, category, unlocked_at FROM user_cosmetics WHERE user_id = ?').all(userId);
}

// ── Get equipped cosmetics for a user ────────────────────────
function getEquipped(userId) {
    const d = db.getDb();
    const rows = d.prepare('SELECT slot, item_id FROM user_equipped WHERE user_id = ?').all(userId);
    const equipped = {};
    for (const r of rows) equipped[r.slot] = r.item_id;
    return equipped;
}

// ── Get full cosmetic profile (for chat messages) ────────────
function getCosmeticProfile(userId) {
    const equipped = getEquipped(userId);
    const result = {};
    if (equipped.name_effect && COSMETICS[equipped.name_effect]) {
        const c = COSMETICS[equipped.name_effect];
        result.nameFX = { itemId: equipped.name_effect, cssClass: c.cssClass };
    }
    if (equipped.particle && COSMETICS[equipped.particle]) {
        const c = COSMETICS[equipped.particle];
        result.particleFX = { itemId: equipped.particle, cssClass: c.cssClass, chars: c.chars };
    }
    if (equipped.hat && COSMETICS[equipped.hat]) {
        const c = COSMETICS[equipped.hat];
        result.hatFX = { itemId: equipped.hat, hatChar: c.hatChar, cssClass: c.hatChar, animated: c.animated };
    }
    if (equipped.voice && COSMETICS[equipped.voice]) {
        const c = COSMETICS[equipped.voice];
        result.voiceFX = { itemId: equipped.voice, pitch: c.pitch, rate: c.rate };
    }
    return result;
}

// ── Check if user owns a cosmetic ────────────────────────────
function ownsCosmetic(userId, itemId) {
    const d = db.getDb();
    return !!d.prepare('SELECT 1 FROM user_cosmetics WHERE user_id = ? AND item_id = ?').get(userId, itemId);
}

// ── Unlock a cosmetic (add to collection) ────────────────────
function unlockCosmetic(userId, itemId) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'Unknown cosmetic' };
    if (ownsCosmetic(userId, itemId)) return { error: 'Already unlocked' };
    const d = db.getDb();
    d.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(userId, itemId, cosmetic.category);
    return { success: true, item: cosmetic };
}

// ── Remove a cosmetic from collection ────────────────────────
function revokeCosmetic(userId, itemId) {
    const d = db.getDb();
    // Unequip first if equipped
    const cosmetic = COSMETICS[itemId];
    if (cosmetic) {
        const slot = CATEGORY_SLOT[cosmetic.category];
        d.prepare('DELETE FROM user_equipped WHERE user_id = ? AND slot = ? AND item_id = ?').run(userId, slot, itemId);
    }
    d.prepare('DELETE FROM user_cosmetics WHERE user_id = ? AND item_id = ?').run(userId, itemId);
    return { success: true };
}

// ── Equip a cosmetic ─────────────────────────────────────────
function equipCosmetic(userId, itemId, { isAdmin = false } = {}) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'Unknown cosmetic' };
    if (!ownsCosmetic(userId, itemId)) {
        if (isAdmin) {
            // Admin bypass: auto-unlock the cosmetic, then equip
            unlockCosmetic(userId, itemId);
        } else {
            return { error: 'You don\'t own this cosmetic' };
        }
    }
    const slot = CATEGORY_SLOT[cosmetic.category];
    const d = db.getDb();
    d.prepare('INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)').run(userId, slot, itemId);
    return { success: true, slot, item: cosmetic };
}

// ── Unequip a slot ───────────────────────────────────────────
function unequipSlot(userId, slot) {
    if (!['name_effect', 'particle', 'hat', 'voice'].includes(slot)) return { error: 'Invalid slot' };
    const d = db.getDb();
    d.prepare('DELETE FROM user_equipped WHERE user_id = ? AND slot = ?').run(userId, slot);
    return { success: true, slot };
}

// ── Helper: call openvibe-quest internal API ─────────────────────
function questApi(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(`${LEGACY_QUEST_API}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': 'openvibe-internal-2026',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            timeout: 5000,
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => chunks += c);
            res.on('end', () => {
                try { resolve(JSON.parse(chunks)); } catch { resolve({}); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('openvibe-quest timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

// ── Activate: consume game item → unlock global cosmetic ─────
async function activateFromGame(userId, itemId) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'This item has no global cosmetic' };
    if (ownsCosmetic(userId, itemId)) return { error: 'Already unlocked globally' };

    // Ask openvibe-quest to check & consume game inventory item
    try {
        const result = await questApi('POST', '/api/internal/inventory/consume', { userId, itemId, quantity: 1 });
        if (result.error) return { error: result.error };
    } catch {
        return { error: 'Game server unavailable — try again later' };
    }

    // Unlock the cosmetic in openvibelive's DB
    const d = db.getDb();
    d.prepare('INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)').run(userId, itemId, cosmetic.category);
    return { success: true, message: `Unlocked ${cosmetic.name} globally!`, item: cosmetic };
}

// ── Deactivate: revoke global cosmetic → add back to game inventory ──
async function deactivateToGame(userId, itemId) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'Unknown cosmetic' };
    if (!ownsCosmetic(userId, itemId)) return { error: 'You don\'t own this cosmetic' };

    // Add item back to openvibe-quest game inventory
    try {
        const result = await questApi('POST', '/api/internal/inventory/add', { userId, itemId, quantity: 1 });
        if (result.error) return { error: result.error };
    } catch {
        return { error: 'Game server unavailable — try again later' };
    }

    const d = db.getDb();
    // Unequip if equipped
    const slot = CATEGORY_SLOT[cosmetic.category];
    d.prepare('DELETE FROM user_equipped WHERE user_id = ? AND slot = ? AND item_id = ?').run(userId, slot, itemId);
    // Remove from cosmetics
    d.prepare('DELETE FROM user_cosmetics WHERE user_id = ? AND item_id = ?').run(userId, itemId);

    return { success: true, message: `Converted ${cosmetic.name} back to game item` };
}

// ── Get full inventory + equipped for UI ─────────────────────
function getFullInventory(userId) {
    const unlocked = getUnlocked(userId);
    const equipped = getEquipped(userId);

    // Build categorized list
    const categories = { name_effect: [], particle: [], hat: [], voice: [] };
    for (const u of unlocked) {
        const c = COSMETICS[u.item_id];
        if (!c) continue;
        categories[c.category]?.push({
            ...c,
            itemId: u.item_id,
            equipped: equipped[CATEGORY_SLOT[c.category]] === u.item_id,
        });
    }
    // Sort each by tier
    for (const cat of Object.values(categories)) cat.sort((a, b) => a.tier - b.tier);
    return { categories, equipped };
}

module.exports = {
    COSMETICS,
    ensureTables,
    getUnlocked,
    getEquipped,
    getCosmeticProfile,
    ownsCosmetic,
    unlockCosmetic,
    revokeCosmetic,
    equipCosmetic,
    unequipSlot,
    activateFromGame,
    deactivateToGame,
    getFullInventory,
};
