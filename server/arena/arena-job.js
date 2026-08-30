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
const CLOCK_MS = 60 * 1000;
let _timer = null;
let _clock = null;
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
    // The ears: every 15 s the listener reads live transcripts for name-drops (beefs) and topic talk.
    try { require('./listener').start(); } catch (e) { console.warn('[Arena] listener not started:', e.message); }
    // Clocks + the board: forfeit beefs whose clock ran out, settle bounties, scan new chat into
    // topic moments, discover new subjects from what was said (AI, ≤ 1 call / 5 min), rewrite lore.
    _clock = setInterval(() => housekeeping().catch(e => console.warn('[Arena] housekeeping:', e.message)), CLOCK_MS);
    if (_clock.unref) _clock.unref();
    setTimeout(() => housekeeping().catch(() => {}), 20_000).unref?.();
    console.log('[Arena] job started (personas every 20 min; listener every 15 s; clocks + chat scan every 60 s; discovery ≤ every 5 min; lore on new moments)');
}

async function housekeeping() {
    if (!arena.arenaEnabled()) return;
    const beef = require('./beef'), board = require('./board');
    try { beef.tick(); } catch (e) { console.warn('[Arena] beef tick:', e.message); }
    try { board.resolveExpired(); } catch (e) { console.warn('[Arena] resolve:', e.message); }
    try { const r = board.scanChat(); if (r.moments) console.log(`[Arena] chat scan: ${r.moments} moment(s) from ${r.scanned} message(s)`); } catch (e) { console.warn('[Arena] chat scan:', e.message); }
    try { await board.discoverTopics(); } catch (e) { console.warn('[Arena] discover:', e.message); }   // every 5 min, only with new material
    try { await board.loreSweep(3); } catch (e) { console.warn('[Arena] lore:', e.message); }           // only topics with ≥ 3 new moments
    try { await require('./chatters').cardSweep(); } catch (e) { console.warn('[Arena] yap cards:', e.message); } // ≤ 4 chatters per minute, level ≥ 3, once a day each
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_clock) { clearInterval(_clock); _clock = null; }
    try { require('./listener').stop(); } catch { /* */ }
}

module.exports = { start, stop, tick, housekeeping };
