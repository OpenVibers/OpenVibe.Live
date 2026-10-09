'use strict';
/**
 * OpenVibe Live on by default for OpenRestream (contracts 0.126.0, capability live.openre.slot.bind).
 *
 * A stream someone makes on openre.stream gets its own slot on their Live channel: a managed_streams row ingested by
 * OpenRestream from the start (ingest_authority 'openre', openre_stream_id = the stream). Its sessions then reach
 * `streams` through the mirror (mirror.js) like any switched slot, so the person is live on openvibe.live/@username
 * with chat, clips and VODs. Nothing about an existing slot changes: this only ever creates a new one, or returns the
 * one already bound to that stream.
 *
 * The slot's own Live key is random and never shown: Live refuses it while the slot is on OpenRestream
 * (authority.refusesLiveIngest), and the broadcaster's key is OpenRestream's.
 */
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const STREAM_RE = /^std_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROTOCOLS = { rtmp: { protocol: 'rtmp', method: 'obs' }, webrtc: { protocol: 'webrtc', method: 'whip' }, jsmpeg: { protocol: 'jsmpeg', method: null } };

class BindError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function channelUrl(username) {
    return `${String(config.baseUrl || 'https://openvibe.live').replace(/\/+$/, '')}/@${encodeURIComponent(username)}`;
}

/** The Live user a Network subject signed in as (linked_accounts, written at sign-in), or null. */
async function userForSubject(subject) {
    const row = await db.get("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY user_id LIMIT 1", [subject]);
    return row ? await db.getUserById(row.user_id) : null;
}

/**
 * Find or create the slot bound to one OpenRestream stream. { managed_stream_id, channel_url, created }, or throws
 * BindError (400 bad input, 409 live.no_account / live.slot_taken / live.slot_limit, 403 live.account_banned).
 */
async function bindSlot({ subject, openre_stream_id: streamId, title, protocol } = {}) {
    if (!SUBJECT_RE.test(String(subject || ''))) throw new BindError(400, 'request.invalid', 'subject must be a usr_ subject id');
    if (!STREAM_RE.test(String(streamId || ''))) throw new BindError(400, 'request.invalid', 'openre_stream_id must be an OpenRestream std_ id');
    const kind = PROTOCOLS[protocol || 'rtmp'];
    if (!kind) throw new BindError(400, 'request.invalid', 'protocol must be rtmp, webrtc or jsmpeg');
    const user = await userForSubject(subject);
    if (!user) throw new BindError(409, 'live.no_account', 'this person has no OpenVibe Live account yet: they sign in to openvibe.live once');
    if (user.is_banned) throw new BindError(403, 'live.account_banned', 'this Live account is banned');
    const name = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'OpenRestream';

    return await db.getDb().tx(async () => {
        // One bind per stream at a time: two calls for the same stream wait here, and the second finds the first's slot.
        await db.get('SELECT pg_advisory_xact_lock(hashtext(?))', [`live.openre.slot:${streamId}`]);
        const bound = await db.get('SELECT id, user_id FROM managed_streams WHERE openre_stream_id = ? LIMIT 1', [streamId]);
        if (bound) {
            if (bound.user_id !== user.id) throw new BindError(409, 'live.slot_taken', 'that OpenRestream stream is bound to another person\'s slot');
            return { managed_stream_id: bound.id, channel_url: channelUrl(user.username), created: false };
        }
        const limit = await db.getManagedStreamLimit(user);
        if (await db.countManagedStreamsByUser(user.id) >= limit) {
            throw new BindError(409, 'live.slot_limit', `this Live account already has its ${limit} stream slots`);
        }
        const channel = await db.ensureChannel(user.id);
        const created = await db.createManagedStream({
            user_id: user.id,
            channel_id: channel && channel.id,
            title: name,
            protocol: kind.protocol,
            streaming_method: kind.method,
            stream_key: crypto.randomBytes(20).toString('hex'),
        });
        const id = Number(created.lastInsertRowid);
        await db.run("UPDATE managed_streams SET ingest_authority = 'openre', openre_stream_id = ?, updated_at = ov_now() WHERE id = ?", [streamId, id]);
        console.log(`[OpenRestream] stream ${streamId} bound to new slot ${id} (${user.username})`);
        return { managed_stream_id: id, channel_url: channelUrl(user.username), created: true };
    });
}

module.exports = { bindSlot, BindError, userForSubject };
