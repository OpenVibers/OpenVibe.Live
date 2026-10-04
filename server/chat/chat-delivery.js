'use strict';
/**
 * The one seam Live's chat producers call (T3 J2, first half).
 *
 * LIVE_CHAT_INGRESS=1 (with CHAT_AUTHORITY=chat): OpenVibe.Chat's typed ingress (chat-client.js) — Chat persists,
 * broadcasts, mirrors, speaks and moderates in one call per operation, and nothing goes through the bridge.
 * Otherwise (the default): the existing path — require('./chat-server'), which is the chat-remote.js bridge under
 * CHAT_AUTHORITY=chat and Live's own ChatServer without it.
 *
 * With the flag on, a Chat 4xx/5xx is logged and counted by chat-client.js and never thrown into the caller; the
 * operation is not handed to the bridge (it would deliver twice once Chat owns delivery). Every function here
 * returns a promise in ingress mode and the legacy call's own value otherwise.
 *
 *   ingress()                      which path is active
 *   message(body)                  ingress only: a chat line (Chat's /messages body) → Promise<real id | null>
 *   event(target, frame, opts)     a transient frame; target { kind: stream|channel|global|all|user, id, stream }
 *   moderate(action, fields)       ingress only: Chat's /moderation actions → Promise<Chat's answer | null>
 *   logModeration(entry)           a moderation-log row (db.logModerationAction shape)
 *   disconnect({ userId, ip, streamId })
 *   invalidate(hint, legacy)       a cache hint ({ user, user_data, approvals, bans, channel })
 *   mirror(fn, ...args)            ingress only: keep Live's own copy of a bridge 'local' write (pending IP rows,
 *                                  hidden relay users, first chats, TTS overrides) that Live still reads
 *   after(value, fn)               fn(value) now for a plain value, after it resolves for a promise
 */
const chatAuthority = require('./chat-authority');
const client = require('./chat-client');

function ingress() { return process.env.LIVE_CHAT_INGRESS === '1' && chatAuthority.isRemote(); }
// Lazy: chat-server pulls in most of Live, and several producers are required by it.
function chatServer() { return require('./chat-server'); }

function defined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
    return out;
}

// Chat's ingress takes these as positive integers; route params and bodies hand Live strings.
const INT_FIELDS = ['id', 'user_id', 'stream_id', 'channel_id', 'channel_user_id', 'reply_to_id', 'reviewed_by', 'actor_user_id', 'target_user_id', 'created_by', 'set_by'];
function ints(o) {
    for (const k of INT_FIELDS) if (typeof o[k] === 'string' && /^\d+$/.test(o[k])) o[k] = Number(o[k]);
    return o;
}

function message(body) {
    const b = ints(defined(body));
    if (b.key) b.key = client.key('messages', b.key);
    if (b.is_global != null) b.is_global = !!b.is_global;
    if (b.frame) b.frame = defined(b.frame);
    if (b.tts) b.tts = defined(b.tts);
    return client.message(b).then((r) => (r && r.id != null ? Number(r.id) : null));
}

function event(target, frame, { key } = {}) {
    if (ingress()) {
        const t = { kind: target.kind };
        if (target.id != null) t.id = Number(target.id);
        return client.event({ key: key ? client.key('events', key) : undefined, target: t, frame: defined(frame) });
    }
    const cs = chatServer();
    if (target.kind === 'stream') return cs.broadcastToStream(target.id, frame);
    if (target.kind === 'channel') return cs.broadcastToChannelRoom(target.id, target.stream || null, frame);
    if (target.kind === 'global') return cs.broadcastGlobal(frame);
    if (target.kind === 'all') return cs.broadcastAll(frame);
    if (target.kind === 'user') return cs.sendDm(target.id, frame);
    throw new Error(`unknown chat target ${target.kind}`);
}

function moderate(action, fields, { key } = {}) {
    return client.moderation(ints({ ...defined(fields), action, key: key ? client.key('moderation', key) : undefined }));
}

const LOG_FIELDS = ['scope_type', 'scope_id', 'actor_user_id', 'target_user_id', 'action_type', 'details'];
function logModeration(entry) {
    if (!ingress()) return require('../db/database').logModerationAction(entry);
    const fields = {};
    for (const k of LOG_FIELDS) if (entry[k] != null) fields[k] = entry[k];
    if (typeof fields.scope_id === 'string' && fields.scope_type !== 'room' && /^\d+$/.test(fields.scope_id)) fields.scope_id = Number(fields.scope_id);
    return moderate('log', fields);
}

function disconnect({ userId, ip, streamId } = {}) {
    if (!ingress()) return chatServer().disconnectUser(defined({ userId, ip, streamId }));
    return moderate('disconnect', { user_id: userId || undefined, ip: ip || undefined, stream_id: streamId || undefined });
}

/** legacy: what to run without the flag (cache hints had no single legacy call). */
function invalidate(hint, legacy) {
    if (ingress()) return client.invalidate(defined(hint));
    return legacy ? legacy() : undefined;
}

function mirror(fn, ...args) {
    try { return require('./chat-remote').localWrite(fn, ...args); } catch (err) { console.warn(`[ChatIngress] local ${fn}: ${err.message}`); return undefined; }
}

function after(value, fn) {
    return value && typeof value.then === 'function' ? value.then(fn) : fn(value);
}

module.exports = { ingress, message, event, moderate, logModeration, disconnect, invalidate, mirror, after, client };
