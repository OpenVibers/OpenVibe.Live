'use strict';
/**
 * The staged chat tables (roadmap C-04; OpenVibe.Chat docs/staged-tables-cutover.md): who writes
 * channel_moderators, channel_moderation_settings, emotes, user_tags, chat_ai_summaries and
 * chat_timeline_events, one table at a time.
 *
 * authority(table) is 'live' or 'chat', from app_state `chat_table_authority` (JSON; a table not in
 * it is 'live', so deploying this changes nothing). It is always 'live' unless CHAT_AUTHORITY=chat:
 * without it Live runs chat itself and OpenVibe.Chat is out of the picture.
 *
 *   'live'  Live writes its table, as before (write() runs Live's own function). Every change is
 *           captured and relayed to Chat's copy (chat-tables-sync.js). With the table's dual-read
 *           flag (app_state `chat_table_dual_read`), Live's reads of it are also compared with Chat's
 *           copy and mismatches are counted; Live's answers never change.
 *   'chat'  Chat writes it. write() hands the writer's call to Chat over the bridge (POST
 *           /internal/live/calls, chat.live_bridge.write, awaited, with an idempotency key) and
 *           applies the rows Chat answers to Live's table, which is from then on the read mirror
 *           Chat keeps current (POST /internal/chat-effects/mirror). Live's readers do not change.
 *
 * Moving a table is setAuthority() (POST /internal/chat-tables/:table with X-Internal-Key), never
 * automatic. The table's writers wait while it runs. To 'chat': Live's queued changes reach Chat,
 * Chat takes the table, Live stops writing it. Back to 'live': Chat sends Live every change it made
 * to the table and gives it back, then Live writes it again. Running it again is safe and brings Live
 * and Chat back into agreement after a failed attempt.
 *
 * Nothing here starts at require time; init() (server start, CHAT_AUTHORITY=chat only) installs the
 * capture, the dual read and the relay. A restore drill never calls it.
 */
const crypto = require('crypto');
const db = require('../db/database');
const { isRemote, CHAT_URL } = require('./chat-authority');

// The staged tables and their keys (Chat's STAGED_KEYS).
const TABLES = {
    channel_moderators: ['id'],
    channel_moderation_settings: ['channel_id'],
    emotes: ['id'],
    user_tags: ['id'],
    chat_ai_summaries: ['id'],
    chat_timeline_events: ['id'],
};
// Live's writes to them: database.js function → table. Chat's database.js has the same functions.
// user_tags has no writer in Live (chat tags are read-only since the game moved to OpenVibe.Games).
const OPS = {
    addChannelModerator: 'channel_moderators',
    removeChannelModerator: 'channel_moderators',
    upsertChannelModerationSettings: 'channel_moderation_settings',
    setChannelAlertSound: 'channel_moderation_settings',
    createEmote: 'emotes',
    updateEmote: 'emotes',
    deleteEmote: 'emotes',
    setEmoteMedia: 'emotes',
    upsertChatAiSummary: 'chat_ai_summaries',
    addChatTimelineEvents: 'chat_timeline_events',
};

const AUTHORITY_KEY = 'chat_table_authority';
const DUAL_READ_KEY = 'chat_table_dual_read';
const AUDIENCE = 'openvibe.chat';
const BOOT = `tables-${crypto.randomUUID()}`;

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// ── Authority and dual-read flags ───────────────────────────────

function readJson(key) {
    try {
        const v = db.getState(key);
        const o = v ? JSON.parse(v) : {};
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
}
let cache = { at: 0, authority: {}, dual: {} };
function flags() {
    if (Date.now() - cache.at > 1000) cache = { at: Date.now(), authority: readJson(AUTHORITY_KEY), dual: readJson(DUAL_READ_KEY) };
    return cache;
}
/** What app_state says, whether or not CHAT_AUTHORITY=chat. */
function stored(table) { return flags().authority[table] === 'chat' ? 'chat' : 'live'; }
/** Who writes the table now. */
function authority(table) { return isRemote() && stored(table) === 'chat' ? 'chat' : 'live'; }
function dualRead(table) { return isRemote() && flags().dual[table] === true; }

function saveFlag(key, table, value) {
    const cur = readJson(key);
    if (value === undefined || value === null || value === false || value === 'live') delete cur[table];
    else cur[table] = value;
    db.setState(key, JSON.stringify(cur));
    cache.at = 0;
}
function setDualRead(table, on) {
    if (!TABLES[table]) throw httpError(404, `${table} is not a staged table`);
    saveFlag(DUAL_READ_KEY, table, on ? true : undefined);
    return dualRead(table);
}

// ── Chat's bridge ───────────────────────────────────────────────

/** One op on Chat's bridge → its result; throws with Chat's refusal. A lost answer is retried once with the same key. */
async function callChat(op, args, { key = null, timeoutMs = 10000 } = {}) {
    const principal = require('../net/network-principal');
    const body = JSON.stringify({ boot: BOOT, ops: [{ seq: 1, op, args, ...(key ? { key } : {}) }] });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
            res = await fetch(`${CHAT_URL}/internal/live/calls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await principal.serviceHeaders(AUDIENCE)) },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            lastErr = httpError(503, `OpenVibe.Chat unreachable: ${err.message}`);
            if (!key) break;   // only an idempotent op is sent twice
            continue;
        }
        if (res.status === 401 && attempt === 0) { principal.invalidate(AUDIENCE); continue; }
        if (!res.ok) throw httpError(502, `OpenVibe.Chat answered ${res.status}`);
        const out = await res.json();
        const r = out && Array.isArray(out.results) ? out.results[0] : null;
        if (!r) throw httpError(502, 'OpenVibe.Chat gave no result');
        if (!r.ok) throw httpError(409, `OpenVibe.Chat refused ${op === 'db' ? args[0] : op}: ${r.error}`);
        return r.result;
    }
    throw lastErr;
}

// ── Writes ──────────────────────────────────────────────────────

const handoffs = new Map();   // table → promise of the running handoff

/**
 * Live's write to a staged table, wherever the table is written: `op` is the database.js function
 * (OPS), `args` its arguments, the answer what that function returns. Await it.
 */
async function write(op, ...args) {
    const table = OPS[op];
    if (!table) throw new Error(`${op} is not a staged-table write`);
    const running = handoffs.get(table);
    if (running) await running.catch(() => {});
    if (authority(table) === 'live') return db[op](...args);
    const r = await callChat('db', [op, ...args], { key: `staged:${crypto.randomUUID()}` });
    // Live's copy follows at once (Chat's mirror sends the same rows again later).
    if (r && Array.isArray(r.mirror) && r.mirror.length) {
        const out = require('./live-context-routes').applyMirror(r.mirror);
        if (out.skipped.length) console.warn(`[ChatTables] ${op}: ${out.skipped.length} row(s) of Chat's answer not applied here:`, JSON.stringify(out.skipped.slice(0, 2)));
    }
    return r ? r.value : null;
}

/** Whether Live takes Chat's mirror rows for this table (Chat writes it, or it is being handed back). */
function acceptsMirror(table) {
    return !!TABLES[table] && isRemote() && (stored(table) === 'chat' || handoffs.has(table));
}

// ── The handoff ─────────────────────────────────────────────────

/**
 * Hand `table` to `target`. `force` (back to 'live' only): Live takes the table without asking Chat —
 * for when Chat is down; first send Chat's queued changes (OpenVibe.Chat scripts/mirror-flush.js) and
 * set Chat's side (scripts/table-authority.js set <table> live --force), docs/staged-tables-cutover.md.
 */
async function setAuthority(table, target, { by = 'operator', force = false } = {}) {
    if (!TABLES[table]) throw httpError(404, `${table} is not a staged table`);
    if (target !== 'live' && target !== 'chat') throw httpError(400, 'authority is "live" or "chat"');
    if (force && target !== 'live') throw httpError(400, 'force is only for taking a table back');
    if (!isRemote()) throw httpError(409, 'CHAT_AUTHORITY is not "chat": Live runs chat and writes every staged table itself');
    if (handoffs.has(table)) throw httpError(409, `a handoff of ${table} is already running`);
    const sync = require('./chat-tables-sync');
    let finish;
    handoffs.set(table, new Promise((resolve) => { finish = resolve; }));
    const before = stored(table);
    const started = Date.now();
    try {
        if (target === 'chat') {
            await sync.drain(table);                              // 1. Live's changes are in Chat's copy
            const r = await callChat('setTableAuthority', [table, 'chat'], { timeoutMs: 20000 });   // 2. Chat writes it
            if (!r || r.authority !== 'chat') throw httpError(502, `OpenVibe.Chat did not take ${table}`);
            saveFlag(AUTHORITY_KEY, table, 'chat');               // 3. Live stops writing it
            sync.setCapture(table, false);
        } else {
            if (force) {
                console.warn(`[ChatTables] ${table}: taken back without asking OpenVibe.Chat (force, ${by})`);
            } else {
                const r = await callChat('setTableAuthority', [table, 'live'], { timeoutMs: 30000 });   // 1–2. Chat's changes are here; Chat stops
                if (!r || r.authority !== 'live') throw httpError(502, `OpenVibe.Chat did not give ${table} back`);
            }
            sync.setCapture(table, true);                          // 3. Live writes it again
            saveFlag(AUTHORITY_KEY, table, undefined);
        }
        console.log(`[ChatTables] ${table}: ${before} → ${target} (${by}${force ? ', forced' : ''}, ${Date.now() - started} ms)`);
        return { table, before, authority: target };
    } catch (err) {
        console.warn(`[ChatTables] ${table}: handoff to ${target} failed, still ${stored(table)}: ${err.message}`);
        throw err;
    } finally {
        handoffs.delete(table);
        finish();
    }
}

// ── Status ──────────────────────────────────────────────────────

/** Every staged table: who writes it (here and, when asked and reachable, in Chat), flags, the relay, the dual-read counts. */
async function status({ askChat = true } = {}) {
    const sync = require('./chat-tables-sync');
    let chat = null;
    // (a restore drill asks no other service anything)
    if (askChat && isRemote() && !require('../drill').enabled) {
        try { chat = await callChat('tableAuthority', [], { timeoutMs: 3000 }); } catch (err) { chat = { error: err.message }; }
    }
    const tables = {};
    for (const t of Object.keys(TABLES)) {
        tables[t] = {
            authority: authority(t),
            stored: stored(t),
            chat_authority: chat && !chat.error ? chat[t] || null : null,
            dual_read: dualRead(t),
            handoff_running: handoffs.has(t),
            outbox_pending: sync.pending(t),
            dual_read_stats: sync.dualReadStats(t),
        };
        if (tables[t].chat_authority && tables[t].chat_authority !== tables[t].authority) tables[t].disagree = true;
    }
    return { chat_authority: isRemote() ? 'chat' : 'live', chat_error: chat && chat.error ? chat.error : null, relay: sync.relayStats(), tables };
}

/** Server start (CHAT_AUTHORITY=chat only): capture, dual read, relay. */
function init() {
    if (!isRemote()) return false;
    require('./chat-tables-sync').start();
    return true;
}

module.exports = {
    TABLES, OPS, AUTHORITY_KEY, DUAL_READ_KEY,
    authority, stored, dualRead, setDualRead, acceptsMirror,
    write, setAuthority, status, init, callChat,
    _resetCache() { cache.at = 0; },
};
