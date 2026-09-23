'use strict';
/**
 * The per-slot ingest switch: managed_streams.ingest_authority = 'live' (default) | 'openre'.
 *
 * 'openre' means OpenRe.Stream ingests this slot's RTMP: Live's RTMP server refuses the slot's
 * key (so a stream can never be ingested twice), the Go Live UI shows OpenRe's ingest URL and
 * rotates OpenRe's key, and the slot's sessions reach `streams` through the mirror (mirror.js).
 * Only RTMP moves (OPENRE_PROTOCOLS); WHIP, browser/WebRTC and JSMPEG stay on Live until
 * OpenRe carries them.
 *
 * Switch off = zero behaviour change: every helper here returns what Live did before unless the
 * slot says 'openre' AND OpenRe is configured (openre-client enabled()).
 */
const crypto = require('crypto');
const db = require('../db/database');
const client = require('./openre-client');

const OPENRE_PROTOCOLS = new Set(['rtmp']);

function authorityOf(slot) {
    if (!slot || slot.ingest_authority !== 'openre') return 'live';
    return client.enabled() ? 'openre' : 'live';
}

function slotById(id) {
    return id ? db.getManagedStreamById(id) : null;
}

/** authorityOf(slotById(id)) === 'openre', without reading the slot when OpenRe is not configured. */
function slotIsOpenre(id) {
    if (!id || !client.enabled()) return false;
    return authorityOf(slotById(id)) === 'openre';
}

/**
 * Live's RTMP publish handler asks this before accepting a key. A slot key is refused when its slot
 * is on OpenRe; a personal key (users.stream_key, no slot) is refused when any of the user's slots is,
 * because Live would attach it to the user's live rows and push the user's destinations twice.
 */
function refusesLiveIngest({ managedStream, user = null, protocol = 'rtmp' }) {
    try {
        if (!OPENRE_PROTOCOLS.has(protocol)) return false;
        if (!managedStream) {
            if (!user || !client.enabled()) return false;
            return Boolean(db.get("SELECT 1 FROM managed_streams WHERE user_id = ? AND ingest_authority = 'openre' LIMIT 1", [user.id]));
        }
        // Unsetting OPENRE_URL is an emergency rollback to Live for every switched slot at once:
        // the slot then behaves as a Live slot again, with the Live key rotated at the switch
        // (only visible to the owner through Regenerate on the Go Live page).
        return authorityOf(managedStream) === 'openre';
    } catch {
        return false;
    }
}

/** A slot as the owner's API returns it. Unchanged (same object) for Live-ingested slots. */
function serializeSlot(slot) {
    if (authorityOf(slot) !== 'openre') return slot;
    return { ...slot, stream_key: null, ingest_authority: 'openre', stream_key_managed_by: 'openre', openre_manage_url: client.manageUrl(slot.openre_stream_id) };
}

/**
 * What the Go Live UI shows for an OpenRe slot: OpenRe's RTMP URL and the hint of its current key
 * (the key itself is only ever shown once, by a rotation).
 */
async function ingestFor(slot, subject) {
    const stream = slot.openre_stream_id ? await client.getStream(slot.openre_stream_id, { subject }) : await client.streamForSlot(slot.id);
    const rtmp = stream && stream.ingest && stream.ingest.rtmp;
    return {
        ingest_authority: 'openre',
        stream_key_managed_by: 'openre',
        openre_stream_id: stream ? stream.id : null,
        rtmp_url: rtmp ? rtmp.url : null,
        stream_key_hint: rtmp && rtmp.key_hint
            ? `Shown once: press Regenerate for a new key (current key ends in …${rtmp.key_hint})`
            : 'Press Regenerate to get your OpenRe stream key',
        openre_manage_url: client.manageUrl(stream ? stream.id : slot.openre_stream_id),
    };
}

/** Regenerate on an OpenRe slot: OpenRe rotates, the new key is returned once. */
async function rotateFor(slot, subject) {
    const streamId = slot.openre_stream_id || (await client.streamForSlot(slot.id) || {}).id;
    if (!streamId) throw new client.OpenReError('this slot has no OpenRe stream yet', 409);
    const r = await client.rotateKey(streamId, { subject });
    return { stream_key: r.key.key, stream_key_managed_by: 'openre', rtmp_url: r.ingest && r.ingest.rtmp ? r.ingest.rtmp.url : null };
}

function recordingModeFor(slot) {
    try {
        return db.resolveStreamRecordingMode({ user_id: slot.user_id, managed_stream_id: slot.id });
    } catch { return 'vod'; }
}

/**
 * The admin switch (PUT /api/admin/openre/managed/:id/ingest-authority).
 *   'openre': needs OpenRe configured, the slot offline on Live, the owner's canonical subject;
 *             finds or creates the OpenRe definition, then (one transaction) flips the slot and
 *             rotates Live's own key for it, so no key that existed before works anywhere.
 *   'live':   flips back (rollback). Live's key was rotated at the switch: the broadcaster
 *             regenerates it on the Go Live page.
 */
async function setAuthority(slotId, authority, { force = false } = {}) {
    const slot = slotById(slotId);
    if (!slot) return { status: 404, error: 'Managed stream not found' };
    if (!['live', 'openre'].includes(authority)) return { status: 400, error: "authority must be 'live' or 'openre'" };
    if (authority === 'live') {
        db.run("UPDATE managed_streams SET ingest_authority = 'live', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [slot.id]);
        return { status: 200, body: { managed_stream_id: slot.id, ingest_authority: 'live', next: 'The broadcaster regenerates the stream key on the Go Live page (the Live key was rotated when the slot moved to OpenRe).' } };
    }
    if (!client.enabled()) return { status: 409, error: 'OpenRe is not configured on this Live (OPENRE_URL, OV_OAUTH_CLIENT_SECRET)' };
    if (slot.ingest_authority === 'openre') return { status: 200, body: { managed_stream_id: slot.id, ingest_authority: 'openre', openre_stream_id: slot.openre_stream_id, unchanged: true } };
    const live = db.get('SELECT id FROM streams WHERE managed_stream_id = ? AND is_live = 1 LIMIT 1', [slot.id]);
    if (live) return { status: 409, error: `Slot ${slot.id} is live on Live (stream ${live.id}); switch it in a maintenance window, while it is offline` };
    const method = String(slot.streaming_method || '').toLowerCase();
    if (!force && slot.protocol !== 'rtmp' && !['rtmp', 'obs'].includes(method)) {
        return { status: 409, error: `Slot ${slot.id} is a ${slot.protocol}${method ? `/${method}` : ''} slot; OpenRe only ingests RTMP today (pass force to switch anyway)` };
    }
    const subject = require('../auth/identity-sync').subjectOf(slot.user_id);
    if (!subject) return { status: 409, error: 'The owner has no canonical subject yet (they need to sign in to Live once)' };
    let stream = await client.streamForSlot(slot.id);
    if (!stream) {
        let visibility = 'public';
        try { visibility = db.resolveStreamVodVisibility({ user_id: slot.user_id, managed_stream_id: slot.id }); } catch { /* public */ }
        stream = await client.createStreamForSlot(slot, { subject, recordingMode: recordingModeFor(slot), recordingVisibility: visibility });
    }
    const newLiveKey = crypto.randomBytes(20).toString('hex');
    const flipped = db.getDb().transaction(() => {
        // Checked again here: a Live publish may have started while OpenRe was being asked.
        if (db.get('SELECT id FROM streams WHERE managed_stream_id = ? AND is_live = 1 LIMIT 1', [slot.id])) return false;
        db.run("UPDATE managed_streams SET ingest_authority = 'openre', openre_stream_id = ?, stream_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [stream.id, newLiveKey, slot.id]);
        return true;
    })();
    if (!flipped) return { status: 409, error: `Slot ${slot.id} went live on Live meanwhile; switch it while it is offline` };
    return {
        status: 200,
        body: {
            managed_stream_id: slot.id,
            ingest_authority: 'openre',
            openre_stream_id: stream.id,
            rtmp_url: stream.ingest && stream.ingest.rtmp ? stream.ingest.rtmp.url : null,
            live_key_rotated: true,
            next: 'The broadcaster presses Regenerate on the Go Live page (OpenRe issues the key) and pastes the new server and key into OBS.',
        },
    };
}

module.exports = { OPENRE_PROTOCOLS, authorityOf, slotById, slotIsOpenre, refusesLiveIngest, serializeSlot, ingestFor, rotateFor, setAuthority };
