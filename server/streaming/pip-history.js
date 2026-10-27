/**
 * pip-history.js — when each picture-in-picture was on screen during a live stream, so its VOD can draw it again
 * (owner, 2026-10-26: "the VODs system should support and handle the PIPs a streamer had configured during that vod").
 *
 * Every TICK_MS, for each live stream whose slot lists PIPs (stream_pips), each PIP whose stream is live is a span in
 * stream_history, kind 'pip', in the host stream's time:
 *   at_sec   when it came on screen: its stream's start, or the tick before it was first seen (a PIP added mid-stream)
 *   end_sec  the last tick it was seen (a span stops growing when its stream ends or the streamer removes it)
 *   detail   { source_stream_id, source_msid, title, username, x, y, w, muted }: what to draw and where it started
 * A span grows while the same stream stays in the same place; a new stream of the source (a restart) or a new place
 * starts a new span. Server/media-proxy/vods.js turns a VOD's spans into the PIP VODs to play over it.
 */
'use strict';

const db = require('../db/database');
const history = require('./stream-history');

const TICK_MS = 30 * 1000;
let started = false;

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/** One pass: extend or open a span for each PIP live over each live stream. */
async function tick(nowMs = Date.now()) {
    let hosts = [];
    try {
        hosts = await db.all(`SELECT s.id, s.started_at, s.managed_stream_id FROM streams s
            WHERE s.is_live = 1 AND s.managed_stream_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM stream_pips p WHERE p.managed_stream_id = s.managed_stream_id)`);
    } catch (err) {
        console.warn('[PiP history] hosts not read:', err.message);
        return 0;
    }
    let written = 0;
    for (const host of hosts) {
        const start = history.epochMs(host.started_at);
        if (start == null) continue;
        const nowSec = Math.max(0, Math.round((nowMs - start) / 100) / 10);
        const live = (await db.getPipsForManagedStream(host.managed_stream_id)).filter((p) => p.live && p.stream_id);
        if (!live.length) continue;
        const open = await db.all(`SELECT id, at_sec, end_sec, detail FROM stream_history
            WHERE stream_id = ? AND kind = 'pip' AND end_sec >= ? ORDER BY id DESC LIMIT 50`, [host.id, nowSec - (TICK_MS * 1.5) / 1000]);
        for (const pip of live) {
            const g = pip.defaults || {};
            const row = open.find((r) => {
                const d = parse(r.detail);
                return Number(d.source_stream_id) === pip.stream_id && near(d.x, g.x) && near(d.y, g.y) && near(d.w, g.w);
            });
            if (row) {
                await db.run('UPDATE stream_history SET end_sec = ? WHERE id = ?', [nowSec, row.id]);
                written += 1;
                continue;
            }
            let sourceStart = null;
            try { sourceStart = history.epochMs((await db.get('SELECT started_at FROM streams WHERE id = ?', [pip.stream_id]))?.started_at); } catch { /* */ }
            const sourceSec = sourceStart == null ? 0 : (sourceStart - start) / 1000;
            const at = Math.max(0, Math.round(Math.max(sourceSec, nowSec - TICK_MS / 1000) * 10) / 10);
            await db.run(`INSERT INTO stream_history (stream_id, kind, at_sec, end_sec, detail) VALUES (?, 'pip', ?, ?, ?)`, [host.id, Math.min(at, nowSec), nowSec, JSON.stringify({
                source_stream_id: pip.stream_id, source_msid: pip.source_msid, title: pip.title, username: pip.username,
                x: g.x, y: g.y, w: g.w, muted: pip.muted,
            })]);
            written += 1;
        }
    }
    return written;
}

/** A stream's PIP spans, oldest first: [{ at, end, source_stream_id, source_msid, title, username, x, y, w, muted }]. */
async function spansOf(streamId) {
    let rows = [];
    try { rows = await db.all(`SELECT at_sec, end_sec, detail FROM stream_history WHERE stream_id = ? AND kind = 'pip' ORDER BY at_sec ASC, id ASC LIMIT 500`, [streamId]); } catch { return []; }
    return rows.map((r) => {
        const d = parse(r.detail);
        return {
            at: Number(r.at_sec), end: r.end_sec == null ? Number(r.at_sec) : Number(r.end_sec),
            source_stream_id: Number(d.source_stream_id) || null, source_msid: Number(d.source_msid) || null,
            title: d.title || null, username: d.username || null,
            x: Number(d.x), y: Number(d.y), w: Number(d.w), muted: d.muted !== false,
        };
    }).filter((s) => s.source_stream_id && s.end > s.at);
}

function start() {
    if (started || require('../drill').enabled) return;
    started = true;
    require('../utils/jobs').every('pip-history', TICK_MS, () => tick(), { initialDelayMs: 20 * 1000, jitterMs: 2000 });
}

module.exports = { tick, spansOf, start, TICK_MS };
