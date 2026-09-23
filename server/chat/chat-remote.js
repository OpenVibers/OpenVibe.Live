'use strict';
/**
 * The chat server, when OpenVibe.Chat runs it (CHAT_AUTHORITY=chat, see chat-authority.js).
 *
 * require('./chat/chat-server') returns this object instead of a ChatServer, so every module that
 * talks to chat keeps working unchanged:
 *   - calls that push to browsers (broadcastToStream, forwardToGlobal, sendDm, TTS, channel sounds,
 *     disconnectUser, sendUserUpdate …) are queued, in order, and sent to Chat's
 *     POST /internal/live/calls in small batches (service token for audience openvibe.chat,
 *     capability chat.live_bridge.write);
 *   - the chat-table writes Live's other modules make (db.saveChatMessage from AI viewers, relays,
 *     donations; /api/mod deletes and queues; moderation log) are forwarded the same way, because
 *     Chat owns those tables. Updates and deletes also run on Live's mirror at once so their
 *     return values (deleted ids) are right; inserts run only in Chat and return a placeholder id
 *     (≤ -2^40) that Chat maps to the real one for every later call of this boot. Forwarded writes
 *     are kept in chat_bridge_outbox until Chat acknowledges them, so a restart or a Chat outage
 *     loses none;
 *   - synchronous reads (connection counts, viewer counts, slow modes, a connected user's address)
 *     come from a presence snapshot polled from Chat's GET /internal/live/presence every few seconds.
 */
const crypto = require('crypto');
const db = require('../db/database');
const principal = require('../net/network-principal');
const { CHAT_URL } = require('./chat-authority');

const AUDIENCE = 'openvibe.chat';
const BOOT = crypto.randomUUID();
const REF_BASE = 2 ** 40;
const BATCH = 200;
const PRESENCE_MS = 3000;
const EPHEMERAL_TTL_MS = 30000;    // a broadcast older than this is dropped, not delivered late
const MAX_QUEUE = 20000;

// Chat-table writes Live still makes, and whether they also run on Live's mirror right away.
// Inserts never run here (their ids are Chat's): the caller gets a placeholder.
const FORWARDED_DB = {
    saveChatMessage: 'insert',
    logModerationAction: 'insert',
    holdMessageForApproval: 'insert',
    hideRelayUser: 'insert',
    createChannelSound: 'insert',
    mergeChatMessageMetadata: 'local',
    deleteChatMessage: 'local',
    deleteUserChatMessages: 'local',
    deleteAnonChatMessages: 'local',
    deleteRelayUserMessages: 'local',
    deleteChatMessagesByTimeRange: 'local',
    reviewPendingIpMessage: 'local',
    approveAllFromIp: 'local',
    denyAllFromIp: 'local',
    recordRelayUser: 'local',
    unhideRelayUser: 'local',
    unhideRelayUserByIdentity: 'local',
    recordFirstChat: 'local',
    setTtsVoiceOverride: 'local',
    deleteTtsVoiceOverride: 'local',
    setChannelSoundEmote: 'local',
    deleteChannelSound: 'local',
    renameChannelSoundCommand: 'local',
    updateChannelSoundEmoteRefs: 'local',
};

// Live-owned data Chat caches, written by Live's own routes (dashboard, /api/channels, /api/mod):
// after the write, Chat is told to reload it instead of waiting for its cache to expire.
const OBSERVED_DB = {
    addChannelModerator: (a) => ['channel', a[0]],
    removeChannelModerator: (a) => ['channel', a[0]],
    upsertChannelModerationSettings: (a) => ['channel', a[0]],
    setChannelAlertSound: (a) => ['channel', a[0]],
    approveIp: (a) => ['approvals', a[0]],
    revokeIpApproval: (a) => ['approvals', a[0]],
    forgiveBan: () => ['bans', null],
};

function create(ChatServer) {
    // A local ChatServer that never listens: its address and anon-number helpers are Live's own
    // (call-server uses them for voice calls, and Chat asks Live for anon numbers).
    const local = new ChatServer();
    const queue = [];            // { seq, op, args, ref, durableId, at }
    let seq = 0;
    let refCounter = 0;
    let busy = false;
    let inflight = 0;            // ops at the head of the queue that are being sent right now
    let batchLimit = BATCH;      // 1 after Chat refused a batch as a whole (too large / malformed)
    let backoffUntil = 0;
    let flushTimer = null;
    let presenceTimer = null;
    let started = false;
    let presence = { total: 0, streams: {}, slow_mode: {}, users: [], anons: [], at: null };
    const slowModeByStream = new Map();
    const stats = { sent: 0, failed: 0, dropped: 0, lastError: null };

    function ensureOutbox() {
        db.getDb().exec(`CREATE TABLE IF NOT EXISTS chat_bridge_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            boot TEXT NOT NULL,
            ref INTEGER,
            op TEXT NOT NULL,
            args TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }

    function schedule(ms = 0) {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, ms);
        if (flushTimer.unref) flushTimer.unref();
    }

    function enqueue(op, args, { ref = null, durable = false, boot = BOOT, durableId = null } = {}) {
        let id = durableId;
        if (durable && !id) {
            try {
                ensureOutbox();
                id = db.getDb().prepare('INSERT INTO chat_bridge_outbox (boot, ref, op, args) VALUES (?, ?, ?, ?)').run(boot, ref, op, JSON.stringify(args)).lastInsertRowid;
            } catch (err) { console.warn('[ChatRemote] outbox write failed:', err.message); }
        }
        if (queue.length >= MAX_QUEUE) {
            // Drop the oldest broadcast, never a write.
            const i = queue.findIndex((q, idx) => idx >= inflight && !q.durableId);
            if (i >= 0) { queue.splice(i, 1); stats.dropped++; }
        }
        queue.push({ seq: ++seq, op, args, ref, durableId: id, boot, at: Date.now() });
        schedule();
    }

    async function post(path, body, retried = false) {
        const res = await fetch(`${CHAT_URL}${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await principal.serviceHeaders(AUDIENCE)) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && !retried) { principal.invalidate(AUDIENCE); return post(path, body, true); }
        if (!res.ok) { const err = new Error(`Chat ${res.status}`); err.status = res.status; throw err; }
        return res.json();
    }

    async function flush() {
        if (busy || !queue.length) return;
        if (Date.now() < backoffUntil) { schedule(backoffUntil - Date.now()); return; }
        busy = true;
        try {
            while (queue.length) {
                // Stale broadcasts are dropped; forwarded writes always go.
                const now = Date.now();
                for (let i = queue.length - 1; i >= 0; i--) {
                    if (!queue[i].durableId && now - queue[i].at > EPHEMERAL_TTL_MS) { queue.splice(i, 1); stats.dropped++; }
                }
                if (!queue.length) break;
                // One boot per request (replayed writes of an earlier boot keep their own id space).
                const boot = queue[0].boot;
                const batch = [];
                for (const q of queue) { if (q.boot !== boot || batch.length >= batchLimit) break; batch.push(q); }
                let out;
                inflight = batch.length;
                try {
                    // A forwarded write carries its outbox id as an idempotency key: Chat applies it once
                    // even when a lost response makes Live send it again.
                    out = await post('/internal/live/calls', { boot, ops: batch.map((q) => ({ seq: q.seq, op: q.op, args: q.args, ref: q.ref, key: q.durableId ? `live:${q.durableId}` : undefined })) });
                } catch (err) {
                    inflight = 0;
                    stats.failed++;
                    if (err.status === 400 || err.status === 413) {
                        // Refused as a request, not per op: retry one by one; a single op still refused
                        // can never be delivered, so it is dropped (logged) instead of blocking the queue.
                        if (batch.length > 1) { batchLimit = 1; continue; }
                        const q = queue.shift();
                        stats.dropped++;
                        console.error(`[ChatRemote] Chat refused ${q.op}${q.op === 'db' ? ` ${q.args[0]}` : ''} (${err.status}); dropped`);
                        if (q.durableId) { try { db.getDb().prepare('DELETE FROM chat_bridge_outbox WHERE id = ?').run(q.durableId); } catch { /* */ } }
                        continue;
                    }
                    if (stats.lastError !== err.message) console.warn(`[ChatRemote] Chat unreachable (${queue.length} queued): ${err.message}`);
                    stats.lastError = err.message;
                    backoffUntil = Date.now() + 2000;
                    schedule(2000);
                    return;
                }
                stats.lastError = null;
                inflight = 0;
                batchLimit = BATCH;
                queue.splice(0, batch.length);
                stats.sent += batch.length;
                const done = batch.filter((q) => q.durableId).map((q) => q.durableId);
                if (done.length) {
                    try { db.getDb().prepare(`DELETE FROM chat_bridge_outbox WHERE id IN (${done.map(() => '?').join(',')})`).run(...done); } catch { /* */ }
                }
                for (const r of (out && out.results) || []) {
                    if (!r.ok) console.warn(`[ChatRemote] Chat refused op #${r.seq}: ${r.error}`);
                }
            }
        } finally { busy = false; }
    }

    async function pollPresence() {
        try {
            const p = await post('/internal/live/presence');
            presence = p;
            slowModeByStream.clear();
            for (const [k, v] of Object.entries(p.slow_mode || {})) slowModeByStream.set(Number(k), Number(v) || 0);
        } catch { /* keep the last snapshot */ }
    }

    // ── Forwarded database writes ───────────────────────────────
    const originals = {};
    function installDbForwarding() {
        for (const [fn, mode] of Object.entries(FORWARDED_DB)) {
            if (typeof db[fn] !== 'function' || originals[fn]) continue;
            originals[fn] = db[fn];
            db[fn] = function forwardedChatWrite(...args) {
                if (mode === 'insert') {
                    const ref = -(REF_BASE + (++refCounter));
                    enqueue('db', [fn, ...args], { ref, durable: true });
                    return { changes: 1, lastInsertRowid: ref };
                }
                let result;
                try { result = originals[fn](...args); } catch (err) { result = undefined; console.warn(`[ChatRemote] mirror ${fn}: ${err.message}`); }
                enqueue('db', [fn, ...args], { durable: true });
                return result;
            };
        }
    }

    function installInvalidations() {
        for (const [fn, target] of Object.entries(OBSERVED_DB)) {
            if (typeof db[fn] !== 'function' || originals[fn]) continue;
            originals[fn] = db[fn];
            db[fn] = function observedLiveWrite(...args) {
                const result = originals[fn](...args);
                try { const [kind, id] = target(args); enqueue('invalidate', [kind, id]); } catch { /* */ }
                return result;
            };
        }
    }

    function replayOutbox() {
        try {
            ensureOutbox();
            const rows = db.getDb().prepare('SELECT id, boot, ref, op, args FROM chat_bridge_outbox ORDER BY id').all();
            for (const r of rows) {
                let args;
                try { args = JSON.parse(r.args); } catch { continue; }
                queue.push({ seq: ++seq, op: r.op, args, ref: r.ref, durableId: r.id, boot: r.boot, at: Date.now() });
            }
            if (rows.length) console.log(`[ChatRemote] replaying ${rows.length} chat write(s) queued before the restart`);
        } catch (err) { console.warn('[ChatRemote] outbox replay:', err.message); }
    }

    // A stream row carries Live's stream keys: Chat only ever needs the owner.
    const slimStream = (s) => (s ? { id: s.id, user_id: s.user_id } : s);
    const send = (op) => (...args) => { enqueue(op, args); };

    // Live code that iterated chatServer.clients and wrote to each socket (a global delete in
    // /api/mod) gets one pseudo-socket whose send() reaches every chat client through Chat.
    const everyone = { readyState: 1, bufferedAmount: 0, send: (raw) => enqueue('broadcastAllRaw', [String(raw)]), close() {} };
    const clients = new Map([[everyone, { pseudo: true }]]);

    const remote = {
        remote: true,
        boot: BOOT,
        stats,
        clients,
        slowModeByStream,

        init() {
            if (started) return null;
            started = true;
            ensureOutbox();
            replayOutbox();
            schedule();
            pollPresence();
            presenceTimer = setInterval(pollPresence, PRESENCE_MS);
            if (presenceTimer.unref) presenceTimer.unref();
            console.log(`[Chat] CHAT_AUTHORITY=chat — chat runs in OpenVibe.Chat (${CHAT_URL}); Live forwards to it`);
            return null;
        },
        handleUpgrade(req, socket) {
            // nginx sends /ws/chat to Chat; a socket that still lands here is told to retry.
            try { socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n'); } catch { /* */ }
            try { socket.destroy(); } catch { /* */ }
            return true;
        },
        close() {
            if (presenceTimer) clearInterval(presenceTimer);
            presenceTimer = null;
            return flush().catch(() => {});
        },
        flush,

        // ── Pushes to browsers (Chat delivers) ──
        broadcastToStream: send('broadcastToStream'),
        broadcastToChannelRoom: send('broadcastToChannelRoom'),
        broadcastGlobal: send('broadcastGlobal'),
        broadcastAll: send('broadcastAll'),
        forwardToGlobal: send('forwardToGlobal'),
        forwardToGlobalByChannel: send('forwardToGlobalByChannel'),
        forwardToStreamerRooms: send('forwardToStreamerRooms'),
        broadcastToOwnerStreams: send('broadcastToOwnerStreams'),
        sendDm: send('sendDm'),
        sendUserUpdate: send('sendUserUpdate'),
        disconnectUser: send('disconnectUser'),
        sendToConn: send('sendToConn'),
        synthesizeAndBroadcastTTS(...args) { enqueue('synthesizeAndBroadcastTTS', args); return Promise.resolve(); },
        triggerChannelSound(ws, client, stream, command, args = [], relay = null) {
            const c = client ? { streamId: client.streamId || null, user: client.user ? { id: client.user.id, username: client.user.username, display_name: client.user.display_name, role: client.user.role, avatar_url: client.user.avatar_url, profile_color: client.user.profile_color } : null, anonId: client.anonId || null, ip: client.ip || null } : {};
            enqueue('triggerChannelSound', [null, c, slimStream(stream), command, args, relay]);
        },
        /** Commits this boot shipped (deploy-notice.js decides which; Chat stores and shows them). */
        deployNotice(commits) { enqueue('deployNotice', [commits], { durable: true }); },
        /** Live changed a user (role push, avatar): Chat drops what it cached about them. */
        userChanged(userId) { if (userId) enqueue('userChanged', [userId]); },

        // ── Synchronous reads (presence snapshot) ──
        getTotalConnections() { return Number(presence.total) || 0; },
        getStreamViewerCount(streamId) { return Number((presence.streams || {})[streamId]) || 0; },
        getConnectedUserIp(userId) {
            const hit = (presence.users || []).find((u) => u.user_id === userId);
            return hit ? hit.ip : null;
        },
        findClientByAnonId(anonId, streamId) {
            // Same match as ChatServer.findClientByAnonId: the socket's stream must equal streamId.
            const hit = (presence.anons || []).find((a) => a.anon_id === anonId && (a.stream_id ?? null) === streamId);
            return hit ? { anonId: hit.anon_id, ip: hit.ip, streamId: hit.stream_id || null, user: null } : null;
        },
        getUserList() { return { logged: [], anonCount: 0 }; },

        // ── Live's own address / anon helpers ──
        normalizeIp: (ip) => local.normalizeIp(ip),
        getClientIp: (req) => local.getClientIp(req),
        getAnonIdForIp: (ip) => local.getAnonIdForIp(ip),
        getAnonIdForConnection(ip, streamId = null) {
            const key = local.normalizeIp(ip);
            const hit = (presence.anons || []).find((a) => a.ip === key && (streamId == null || (a.stream_id || null) === streamId));
            return hit ? hit.anon_id : local.getAnonIdForIp(key);
        },
        /** The anon number for an address (Network's unified resolve, else Live's table) — for Chat. */
        async resolveAnon(ip) {
            const key = local.normalizeIp(ip);
            const num = await local._resolveUnifiedAnonNum(key);
            return { anon_number: num, first_seen: db.getAnonFirstSeen(key) };
        },
    };

    installDbForwarding();
    installInvalidations();
    remote._restoreDb = () => { for (const [fn, orig] of Object.entries(originals)) db[fn] = orig; };
    return remote;
}

/**
 * Rollback: Live runs chat itself again (CHAT_AUTHORITY unset) but chat writes it forwarded were
 * never acknowledged by Chat (Chat down). Apply them to Live's own tables so nothing is lost.
 * A write Chat did apply whose answer was lost is applied twice — rare, and only for that window.
 */
function drainToLocal(log = console) {
    try {
        const d = db.getDb();
        if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_bridge_outbox'").get()) return 0;
        const rows = d.prepare("SELECT id, args FROM chat_bridge_outbox WHERE op = 'db' ORDER BY id").all();
        let applied = 0;
        for (const r of rows) {
            try {
                const [fn, ...args] = JSON.parse(r.args);
                if (FORWARDED_DB[fn] && typeof db[fn] === 'function') { db[fn](...args); applied++; }
            } catch (err) { log.warn(`[ChatRemote] could not apply queued chat write #${r.id}: ${err.message}`); }
        }
        d.prepare('DELETE FROM chat_bridge_outbox').run();
        if (rows.length) log.log(`[ChatRemote] applied ${applied} of ${rows.length} chat write(s) OpenVibe.Chat never acknowledged`);
        return applied;
    } catch (err) { log.warn('[ChatRemote] drain:', err.message); return 0; }
}

module.exports = { create, drainToLocal, FORWARDED_DB, OBSERVED_DB, REF_BASE, AUDIENCE };
