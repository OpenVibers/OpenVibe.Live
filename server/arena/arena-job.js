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
const CLOCK_MS = 60 * 1000;
let _timer = null;
let _clock = null;
let _busy = false;

// Personas and portraits are no longer generated: the Arena shows only what was said on mic.
// The periodic tick now judges past speech (backfill) so the feed reflects the record, and
// catches up anything the live listener missed.
async function tick() {
    if (_busy || !arena.arenaEnabled() || !arena.aiOn()) return;
    _busy = true;
    try { await require('./backfill').run(); } catch (e) { console.warn('[Arena] backfill:', e.message); }
    finally { _busy = false; }
}

function start() {
    if (_timer) return;
    arena.ensureTables();
    _timer = setInterval(() => tick().catch(e => console.warn('[Arena] job:', e.message)), INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    setTimeout(() => tick().catch(() => {}), 90_000).unref?.();
    // The ears: every 15 s the listener reads live transcripts — name-drops → beef judge, free talk → mic judge.
    try { require('./listener').start(); } catch (e) { console.warn('[Arena] listener not started:', e.message); }
    // Clocks: forfeit beefs whose clock ran out, hard-end the ones past 24 h.
    _clock = setInterval(() => housekeeping().catch(e => console.warn('[Arena] housekeeping:', e.message)), CLOCK_MS);
    if (_clock.unref) _clock.unref();
    setTimeout(() => housekeeping().catch(() => {}), 20_000).unref?.();
    console.log('[Arena] job started (backfill of past speech every 20 min; listener every 15 s; beef clocks every 60 s) — Battle Cam mode: pure mic');
}

async function housekeeping() {
    if (!arena.arenaEnabled()) return;
    // Clocks only: forfeit beefs whose clock ran out, hard-end the ones past 24 h. There is no chat
    // scan, no discovery and no lore — the Arena is pure mic (listener.js).
    try { require('./beef').tick(); } catch (e) { console.warn('[Arena] beef tick:', e.message); }
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_clock) { clearInterval(_clock); _clock = null; }
    try { require('./listener').stop(); } catch { /* */ }
}

module.exports = { start, stop, tick, housekeeping };
