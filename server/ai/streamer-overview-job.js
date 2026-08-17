/**
 * streamer-overview-job.js — keeps each streamer's aggregate AI overview (shown on
 * the home "Recently Online" cards) fresh, based on their historical memories, VODs,
 * and pastes.
 *
 * Cadence (enforced in SQL by getStreamersNeedingOverview):
 *   - A "decent" overview (>= DECENT_LEN chars) is refreshed at most once per 12h.
 *   - A sparse/missing overview is retried hourly until it fills out.
 * Only streamers with some signal (memories or VODs) are considered, and it no-ops
 * entirely until AI is enabled in openvibe.tools/admin → AI.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');

const DECENT_LEN = 220;      // chars — below this an overview is treated as "sparse"
const BATCH = 4;             // max streamers refreshed per tick (bounds cost/CPU)
const INTERVAL_MS = 20 * 60 * 1000; // poll cadence; per-streamer timing is in SQL

let _timer = null;
let _busy = false;

async function tick() {
    if (_busy || !ai.isEnabled()) return;
    _busy = true;
    try {
        const due = db.getStreamersNeedingOverview({ decentLen: DECENT_LEN, limit: BATCH }) || [];
        for (const row of due) {
            try { await ai.generateStreamerOverview(row.user_id); }
            catch (e) { console.warn('[AI] streamer overview:', e.message); }
        }
        if (due.length) console.log(`[AI] Streamer-overview job refreshed ${due.length} streamer(s)`);
    } finally {
        _busy = false;
    }
}

function start() {
    if (_timer) return;
    _timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
    // Kick a first pass a minute after boot so new/sparse streamers fill in quickly.
    setTimeout(() => { tick().catch(() => {}); }, 60 * 1000);
    console.log('[AI] Streamer-overview job started (12h refresh; hourly while sparse)');
}

module.exports = { start, tick };
