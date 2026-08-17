#!/usr/bin/env node
/**
 * OpenVibeGame — Supplementary Migration: Cosmetics, Voices, Effects
 *
 * Ports Patrick's RS-Companion active effects, unlocked voices,
 * and cosmetic items into the OpenVibeGame cosmetics system.
 *
 * This script:
 * 1. Activates all fx_* / px_* items in inventory as global cosmetics
 * 2. Adds all RS unlocked voices as global cosmetics
 * 3. Equips the active effects (fx_neon name, px_void particle)
 * 4. Equips the selected voice (crackhead)
 * 5. Sets game_players name_effect and particle_effect columns
 *
 * Safe to run multiple times (uses INSERT OR IGNORE / ON CONFLICT).
 *
 * Usage:
 *   node scripts/migrate-cosmetics.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const RS_DB_PATH = '/home/deck/.config/rs-companion/rs-companion.db';
const OV_DB_PATH = path.resolve(__dirname, '../data/live.db');

console.log('[Migration] RS-Companion DB:', RS_DB_PATH);
console.log('[Migration] OpenVibe.Live DB:', OV_DB_PATH);

const rsDb = new Database(RS_DB_PATH, { readonly: true });
const openvibeDb = new Database(OV_DB_PATH);
openvibeDb.pragma('journal_mode = WAL');

// ── Build username → openvibe user id map ────────────────────────
const openvibeUsers = openvibeDb.prepare('SELECT id, username FROM users').all();
const openvibeMap = new Map();
for (const u of openvibeUsers) {
    openvibeMap.set(u.username.toLowerCase(), u.id);
}
console.log('[Migration] ' + openvibeUsers.length + ' OpenVibe.Live users loaded');

// ── Fetch RS users ───────────────────────────────────────────
const rsUsers = rsDb.prepare('SELECT user_id, username FROM users').all();
const userMap = new Map(); // rs user_id → openvibe user id
let matched = 0;
for (const rsu of rsUsers) {
    const openvibeId = openvibeMap.get(rsu.username.toLowerCase());
    if (openvibeId) {
        userMap.set(rsu.user_id, openvibeId);
        matched++;
    }
}
console.log('[Migration] Matched ' + matched + ' users\n');

// ── Prepared statements ──────────────────────────────────────
const upsertCosmetic = openvibeDb.prepare(
    'INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, category) VALUES (?, ?, ?)'
);
const upsertEquipped = openvibeDb.prepare(
    'INSERT OR REPLACE INTO user_equipped (user_id, slot, item_id) VALUES (?, ?, ?)'
);
const updatePlayerEffect = openvibeDb.prepare(
    'UPDATE game_players SET name_effect = ?, particle_effect = ? WHERE user_id = ?'
);

// ── RS voice_id → cosmetic category mapping ──────────────────
// All RS voice IDs are stored directly as cosmetic item_ids
const VOICE_CATEGORY = 'voice';

// ── Run migration ────────────────────────────────────────────
const migrate = openvibeDb.transaction(() => {
    let cosmeticCount = 0;
    let voiceCount = 0;
    let equipCount = 0;

    for (const [rsId, openvibeId] of userMap) {
        // ── 1. Activate fx_* and px_* items from inventory as cosmetics ──
        const fxItems = openvibeDb.prepare(
            "SELECT item_id FROM game_inventory WHERE user_id = ? AND (item_id LIKE 'fx_%' OR item_id LIKE 'px_%') AND quantity > 0"
        ).all(openvibeId);

        for (const item of fxItems) {
            const category = item.item_id.startsWith('fx_') ? 'name_effect' : 'particle';
            const result = upsertCosmetic.run(openvibeId, item.item_id, category);
            if (result.changes > 0) cosmeticCount++;
        }

        // ── 2. Port unlocked voices from RS to cosmetics ─────────
        let rsVoices = [];
        try {
            rsVoices = rsDb.prepare('SELECT voice_id FROM user_voices WHERE user_id = ?').all(rsId);
        } catch (e) { /* table may not exist */ }

        for (const v of rsVoices) {
            const result = upsertCosmetic.run(openvibeId, v.voice_id, VOICE_CATEGORY);
            if (result.changes > 0) voiceCount++;
        }

        // ── 3. Port active effects to equipped and player columns ──
        let activeEffects = [];
        try {
            activeEffects = rsDb.prepare('SELECT * FROM active_effects WHERE user_id = ?').all(rsId);
        } catch (e) { /* table may not exist */ }

        let nameEffect = null;
        let particleEffect = null;

        for (const eff of activeEffects) {
            try {
                const data = JSON.parse(eff.data || '{}');
                if (eff.effect_type === 'name_fx' && data.itemId) {
                    nameEffect = data.itemId;
                    // Ensure cosmetic exists
                    upsertCosmetic.run(openvibeId, data.itemId, 'name_effect');
                    // Equip it
                    upsertEquipped.run(openvibeId, 'name_effect', data.itemId);
                    equipCount++;
                } else if (eff.effect_type === 'particle_fx' && data.itemId) {
                    particleEffect = data.itemId;
                    upsertCosmetic.run(openvibeId, data.itemId, 'particle');
                    upsertEquipped.run(openvibeId, 'particle', data.itemId);
                    equipCount++;
                }
            } catch (e) {
                console.warn('[Migration] Failed to parse effect data for user ' + rsId + ':', e.message);
            }
        }

        // Update game_players columns
        if (nameEffect || particleEffect) {
            updatePlayerEffect.run(nameEffect, particleEffect, openvibeId);
        }

        // ── 4. Port selected voice to equipped ───────────────────
        let selectedVoice = null;
        try {
            const sel = rsDb.prepare('SELECT voice_id FROM user_voice_selection WHERE user_id = ?').get(rsId);
            if (sel) selectedVoice = sel.voice_id;
        } catch (e) { /* table may not exist */ }

        if (selectedVoice) {
            // Ensure voice cosmetic exists
            upsertCosmetic.run(openvibeId, selectedVoice, VOICE_CATEGORY);
            // Equip it
            upsertEquipped.run(openvibeId, 'voice', selectedVoice);
            equipCount++;
        }

        console.log('[Migration] User ' + rsId + ' → OpenVibe #' + openvibeId +
            ': ' + fxItems.length + ' effects, ' + rsVoices.length + ' voices' +
            ', equipped: name=' + (nameEffect || 'none') +
            ', particle=' + (particleEffect || 'none') +
            ', voice=' + (selectedVoice || 'none'));
    }

    console.log('\n[Migration] Summary:');
    console.log('  Cosmetics activated: ' + cosmeticCount);
    console.log('  Voices ported: ' + voiceCount);
    console.log('  Equipped items: ' + equipCount);
});

try {
    migrate();
    console.log('\n[Migration] Done!');
} catch (err) {
    console.error('\n[Migration] Failed:', err.message);
    process.exit(1);
} finally {
    rsDb.close();
    openvibeDb.close();
}
