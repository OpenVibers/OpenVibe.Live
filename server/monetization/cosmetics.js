/**
 * OpenVibe.Live — Cosmetics System
 * Global cosmetic items (name effects, particles, hats, voices), equipped globally for chat/overlay.
 *
 * Who owns them (ADR-054 §8): OpenVibe.Inventory, since 2026-10-09. They are live.* items issued by service:live with
 * Live's item ids as aliases; this module reads and writes them through ./inventory-client.js, acting for the person
 * with Live's own token. Live keeps only the catalog below (its renderers: CSS classes, particle glyphs, hats, speech
 * presets). Live's old user_cosmetics / user_equipped / user_equipped_tag are read by nothing (test/cosmetics-tables-gone).
 * (The openvibe-quest game-item bridge, activate/return-to-game and its internal unlock route, was deleted with
 * X-Internal-Key in plan T2: the quest game no longer runs anywhere.)
 */
const inventory = require('./inventory-client');

const KIND = { name_effect: 'live.name_effect', particle: 'live.particle', hat: 'live.hat', voice: 'live.voice' };
/** An Inventory outage in a read: nothing, never an error in chat. */
const quietly = async (fn, fallback) => { try { return await fn(); } catch (err) { if (!(err instanceof inventory.InventoryUnavailable)) console.warn(`[Cosmetics] ${err.message}`); return fallback; } };
/** An Inventory refusal or outage in a write: the error the routes already show. */
const writeError = (err) => ({ error: err instanceof inventory.InventoryUnavailable ? 'Cosmetics are briefly unavailable; try again in a moment' : (err.message || 'Refused') });

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

// ── Get all unlocked cosmetics for a user ────────────────────
async function getUnlocked(userId) {
    return await quietly(async () => {
        const subject = await inventory.subjectOf(userId);
        if (!subject) return [];
        const owned = await inventory.owned(subject);
        return [...owned].filter(([alias]) => COSMETICS[alias]).map(([alias, i]) => ({ item_id: alias, category: COSMETICS[alias].category, unlocked_at: i.acquired_at }));
    }, []);
}

// ── Get equipped cosmetics for a user ────────────────────────
async function getEquipped(userId) {
    return await quietly(async () => {
        const subject = await inventory.subjectOf(userId);
        return subject ? await inventory.equipped(subject) : {};
    }, {});
}

/** What a chat line carries for one { slot → item id } set: { nameFX, particleFX, hatFX, voiceFX } (each optional). */
function profileOf(equipped) {
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

// ── Get full cosmetic profile (for chat messages) ────────────
async function getCosmeticProfile(userId) {
    return profileOf(await getEquipped(userId));
}

/**
 * Many people's chat profiles at once (OpenVibe.Chat's decor lookups, up to 500 ids): { userId → profile }. One
 * Inventory read per 100 people instead of one per person, so a full chat history stays inside Live's read budget.
 */
async function getCosmeticProfiles(userIds) {
    const out = {};
    for (const id of userIds) out[id] = {};
    await quietly(async () => {
        const subjects = new Map();
        for (const id of userIds) { const s = await inventory.subjectOf(id); if (s) subjects.set(id, s); }
        const sets = await inventory.equippedMany([...new Set(subjects.values())]);
        for (const [id, s] of subjects) out[id] = profileOf(sets.get(s) || {});
    }, null);
    return out;
}

/**
 * Where each item can be earned: { itemId → 'quest' } for the items Live lets OpenVibe.Quest give as quest rewards
 * (Inventory's definition grantors, ADR-054 §3). Inventory down: {} (the shop just says nothing about earning).
 */
async function earnable() {
    return await quietly(async () => {
        const { byAlias } = await inventory.catalog();
        const out = {};
        for (const [alias, d] of byAlias) if (COSMETICS[alias] && (d.grantors || []).includes('service:quest')) out[alias] = 'quest';
        return out;
    }, {});
}

// ── Check if user owns a cosmetic ────────────────────────────
async function ownsCosmetic(userId, itemId) {
    return (await getUnlocked(userId)).some((u) => u.item_id === itemId);
}

// ── Unlock a cosmetic (add to collection) ────────────────────
async function unlockCosmetic(userId, itemId) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'Unknown cosmetic' };
    if (await ownsCosmetic(userId, itemId)) return { error: 'Already unlocked' };
    try {
        const subject = await inventory.subjectOf(userId);
        if (!subject) return { error: 'This account has no OpenVibe subject yet; sign in again' };
        await inventory.grant(subject, itemId, `live:${userId}:${itemId}`);
        return { success: true, item: cosmetic };
    } catch (err) { return writeError(err); }
}

// ── Remove a cosmetic from collection ────────────────────────
async function revokeCosmetic(userId, itemId) {
    try {
        const subject = await inventory.subjectOf(userId);
        const held = subject ? (await inventory.owned(subject)).get(itemId) : null;
        if (held) await inventory.revoke(held.instance_id, 'revoked on OpenVibe.Live');
        if (subject) inventory.forget(subject);
        return { success: true };
    } catch (err) { return writeError(err); }
}

// ── Equip a cosmetic ─────────────────────────────────────────
async function equipCosmetic(userId, itemId, { isAdmin = false } = {}) {
    const cosmetic = COSMETICS[itemId];
    if (!cosmetic) return { error: 'Unknown cosmetic' };
    if (!await ownsCosmetic(userId, itemId)) {
        if (isAdmin) {
            // Admin bypass: auto-unlock the cosmetic, then equip
            await unlockCosmetic(userId, itemId);
        } else {
            return { error: 'You don\'t own this cosmetic' };
        }
    }
    const slot = CATEGORY_SLOT[cosmetic.category];
    try {
        const subject = await inventory.subjectOf(userId);
        const held = subject ? (await inventory.owned(subject)).get(itemId) : null;
        if (!held) return { error: 'You don\'t own this cosmetic' };
        await inventory.equip(subject, KIND[cosmetic.category], slot, held.instance_id);
        return { success: true, slot, item: cosmetic };
    } catch (err) { return writeError(err); }
}

// ── Unequip a slot ───────────────────────────────────────────
async function unequipSlot(userId, slot) {
    if (!['name_effect', 'particle', 'hat', 'voice'].includes(slot)) return { error: 'Invalid slot' };
    try {
        const subject = await inventory.subjectOf(userId);
        if (subject) await inventory.equip(subject, KIND[slot], slot, null);
        return { success: true, slot };
    } catch (err) { return writeError(err); }
}

// ── Get full inventory + equipped for UI ─────────────────────
async function getFullInventory(userId) {
    const unlocked = await getUnlocked(userId);
    const equipped = await getEquipped(userId);

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
    getUnlocked,
    getEquipped,
    getCosmeticProfile,
    getCosmeticProfiles,
    ownsCosmetic,
    unlockCosmetic,
    revokeCosmetic,
    equipCosmetic,
    unequipSlot,
    getFullInventory,
    earnable,
};
