/**
 * arena-job.js — keeps Arena personas (and, when enabled, portraits) warm for the roster
 * so the tab loads instantly instead of generating on first view.
 *
 * Every 20 min: refresh up to BATCH stale personas (24 h TTL) for the highest-ranked
 * fighters first, and up to IMAGE_BATCH stale portraits (7 d TTL). Bounded per tick so a
 * big roster cannot burn the AI budget in one go; no-ops entirely while AI is off or over
 * budget (the shared gate in server/ai/llm.js).
 */
'use strict';

const arena = require('./arena-service');

const INTERVAL_MS = 20 * 60 * 1000;
const BATCH = 6;
const IMAGE_BATCH = 2;
let _timer = null;
let _busy = false;

async function tick() {
    if (_busy || !arena.arenaEnabled() || !arena.aiOn()) return;
    _busy = true;
    try {
        const db = require('../db/database');
        const roster = arena.loadRoster();
        let personas = 0, images = 0;
        for (const userId of roster.order) {
            if (personas >= BATCH && (images >= IMAGE_BATCH || !arena.imageGenAvailable())) break;
            const row = db.get('SELECT persona_generated_at, image_generated_at, image_path FROM arena_profiles WHERE user_id = ?', [userId]) || {};
            const personaStale = !row.persona_generated_at || Date.now() - Date.parse(row.persona_generated_at + 'Z') > 24 * 60 * 60 * 1000;
            if (personaStale && personas < BATCH) {
                try { await arena.generatePersona(userId); personas++; } catch (e) { console.warn('[Arena] job persona:', e.message); }
            }
            const imageStale = !row.image_path || !row.image_generated_at || Date.now() - Date.parse(row.image_generated_at + 'Z') > 7 * 24 * 60 * 60 * 1000;
            if (imageStale && images < IMAGE_BATCH && arena.imageGenAvailable()) {
                try { await arena.generateImage(userId); images++; } catch (e) { console.warn('[Arena] job image:', e.message); }
            }
            if (!arena.aiOn()) break; // budget ran out mid-tick
        }
        if (personas || images) console.log(`[Arena] job: ${personas} persona(s), ${images} portrait(s) refreshed`);
    } finally {
        _busy = false;
    }
}

function start() {
    if (_timer) return;
    arena.ensureTables();
    _timer = setInterval(() => tick().catch(e => console.warn('[Arena] job:', e.message)), INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    setTimeout(() => tick().catch(() => {}), 90_000).unref?.();
    // Live trash-talk sessions read the transcript every 15 s (no-op when none are live).
    try { require('./talk-session').start(); } catch (e) { console.warn('[Arena] session ticker not started:', e.message); }
    console.log('[Arena] job started (every 20 min; session ticker every 15 s)');
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick };
