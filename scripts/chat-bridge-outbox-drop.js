#!/usr/bin/env node
/**
 * The contract step for Live's old chat bridge (roadmap T3 J2): Live now delivers to OpenVibe.Chat through
 * its typed ingress only, and nothing under server/ reads or writes chat_bridge_outbox. Run it once the
 * release before (which still wrote the outbox) is out of rollback range.
 *
 *   node scripts/chat-bridge-outbox-drop.js [--db <live.db>]
 *        # dry run (the default): what is still queued, by op and boot; changes nothing
 *   node scripts/chat-bridge-outbox-drop.js --deliver [--db <live.db>]
 *        # hands every queued row to Chat's bridge receiver (POST /internal/live/calls, Live's service token
 *        # for audience openvibe.chat, capability chat.live_bridge.write — Chat serves it until its J3), in
 *        # the order and boot they were written, each with its idempotency key live:<row id> so Chat applies
 *        # a write at most once; acknowledged rows are deleted
 *   node scripts/chat-bridge-outbox-drop.js --apply [--backup <file.db>] [--db <live.db>]
 *        # an online backup first (default <database dir>/backups/live-pre-chat-bridge-drop-<time>.db, mode
 *        # 0600), then server/db/migrations.js operator migration op_002_drop_chat_bridge_outbox, which
 *        # refuses while any chat write (op = 'db') is still queued
 *
 * --deliver needs Live's environment (OV_CHAT_INTERNAL_URL, OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID/
 * SECRET). Printed: counts, ops and row ids only, never message text.
 * Default database: $DB_PATH, else data/live.db under $DATA_DIR or the working directory (server/paths.js).
 * In production run it from /opt/openvibe.live/current as the service user (data -> ../../shared/data).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ID = 'op_002_drop_chat_bridge_outbox';
const TABLE = 'chat_bridge_outbox';
const BATCH = 200;

function parseArgs(argv) {
    const opts = { mode: 'dry', db: null, backup: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--apply') opts.mode = 'apply';
        else if (a === '--deliver') opts.mode = 'deliver';
        else if (a === '--dry-run') opts.mode = 'dry';
        else if (a === '--db') opts.db = next();
        else if (a === '--backup') opts.backup = next();
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown option ${a}`);
    }
    return opts;
}

const hasTable = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);

/** What is still queued: { exists, total, writes, byOp: { op: n }, boots }. Reads only. */
function counts(db) {
    if (!hasTable(db)) return { exists: false, total: 0, writes: 0, byOp: {}, boots: 0 };
    const byOp = {};
    for (const r of db.prepare(`SELECT op, COUNT(*) AS n FROM ${TABLE} GROUP BY op`).all()) byOp[r.op] = r.n;
    const total = Object.values(byOp).reduce((a, b) => a + b, 0);
    const boots = db.prepare(`SELECT COUNT(DISTINCT boot) AS n FROM ${TABLE}`).get().n;
    return { exists: true, total, writes: byOp.db || 0, byOp, boots };
}

function report(c, log) {
    if (!c.exists) { log(`${TABLE}: absent`); return; }
    log(`${TABLE}: ${c.total} row(s) from ${c.boots} boot(s); chat writes (op = 'db') Chat has not acknowledged: ${c.writes}`);
    for (const [op, n] of Object.entries(c.byOp)) log(`  ${op}: ${n}`);
}

/**
 * Deliver every queued row the way the old bridge did. post(path, body) → Chat's JSON answer (throws with
 * err.status on a non-2xx). Stops at the first transport/5xx error (rerun later); a row Chat refuses on its
 * own (400/413 for a one-row batch) can never be delivered and is left for the operator, not deleted.
 * → { delivered, refused: [ids], error }
 */
async function deliver(db, post, log = () => {}) {
    const out = { delivered: 0, refused: [], error: null };
    if (!hasTable(db)) return out;
    const rows = db.prepare(`SELECT id, boot, ref, op, args FROM ${TABLE} ORDER BY id`).all();
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`);
    let i = 0;
    let limit = BATCH;
    while (i < rows.length) {
        const boot = rows[i].boot;
        const batch = [];
        for (let j = i; j < rows.length && rows[j].boot === boot && batch.length < limit; j++) batch.push(rows[j]);
        const ops = [];
        for (const r of batch) {
            let args;
            try { args = JSON.parse(r.args); } catch { args = null; }
            if (!Array.isArray(args)) { out.refused.push(r.id); continue; }
            ops.push({ seq: r.id, op: r.op, args, ref: r.ref, key: `live:${r.id}` });
        }
        try {
            const res = ops.length ? await post('/internal/live/calls', { boot, ops }) : { results: [] };
            const refusedSeq = new Set(((res && res.results) || []).filter((x) => !x.ok).map((x) => x.seq));
            db.transaction(() => {
                for (const o of ops) {
                    if (refusedSeq.has(o.seq)) { out.refused.push(o.seq); continue; }
                    del.run(o.seq);
                    out.delivered++;
                }
            })();
            i += batch.length;
            limit = BATCH;
        } catch (err) {
            if ((err.status === 400 || err.status === 413) && batch.length > 1) { limit = 1; continue; }
            if (err.status === 400 || err.status === 413) { out.refused.push(batch[0].id); i += 1; continue; }
            out.error = err.message;
            log(`stopped: ${err.message} (rerun --deliver later)`);
            break;
        }
    }
    return out;
}

/** The old bridge's request: Live's service token for audience openvibe.chat, one retry on a 401. */
function chatPost() {
    const principal = require('../server/net/network-principal');
    const { CHAT_URL } = require('../server/chat/chat-authority');
    const post = async (p, body, retried = false) => {
        const res = await fetch(`${CHAT_URL}${p}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await principal.serviceHeaders('openvibe.chat')) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 && !retried) { principal.invalidate('openvibe.chat'); return post(p, body, true); }
        if (!res.ok) { const err = new Error(`Chat ${res.status}`); err.status = res.status; throw err; }
        return res.json();
    };
    return post;
}

async function backup(db, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await db.backup(file);
    fs.chmodSync(file, 0o600);
    return file;
}

async function main(argv = process.argv.slice(2), log = console.log) {
    const opts = parseArgs(argv);
    if (opts.help) { log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
    const Database = require('better-sqlite3');
    const DB_PATH = path.resolve(opts.db || require('../server/paths').dbPath());
    const db = new Database(DB_PATH, { readonly: opts.mode === 'dry', fileMustExist: true });
    try {
        report(counts(db), log);
        if (opts.mode === 'dry') return 0;
        if (opts.mode === 'deliver') {
            const r = await deliver(db, chatPost(), log);
            log(`delivered ${r.delivered}; refused by Chat (left in place): ${r.refused.length ? r.refused.join(', ') : 'none'}`);
            report(counts(db), log);
            return r.error ? 1 : 0;
        }
        const file = opts.backup || path.join(path.dirname(DB_PATH), 'backups', `live-pre-chat-bridge-drop-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
        log(`backup: ${await backup(db, file)}`);
        const res = require('../server/db/migrations').runOperator(db, ID);
        log(`${ID}: ${res.outcome}${res.error ? ` (${res.error})` : ''}`);
        return res.outcome === 'failed' ? 1 : 0;
    } finally { db.close(); }
}

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { ID, counts, deliver, parseArgs, main };
