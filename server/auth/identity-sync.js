'use strict';
/**
 * Canonical subjects on the Live side (roadmap Wave 1, ADR-001).
 *
 * - noteSubject(): Network tokens carry `subject_id` (usr_<ULID>) next to the integer `sub`. The
 *   verified claim is remembered on linked_accounts(service='network').subject_id, so Live can hand
 *   out and accept canonical ids without asking Network per request.
 * - syncLegacyMap(): pushes every Live-user <-> Network-account link to Network's
 *   identity_legacy_map (POST /internal/identity/legacy-map), so any service can resolve
 *   "live user N" without calling Live. Network never repoints an existing mapping; conflicts are
 *   logged here for a human to look at.
 */
const db = require('../db/database');
const { OV_NETWORK_INTERNAL_URL, INTERNAL_API_KEY } = require('../utils/notify');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const BATCH = 500;
const _known = new Map();   // live user id -> subject id already stored

/** Store the token's subject id for this Live user (only writes when it changes). */
function noteSubject(liveUserId, networkUserId, subjectId) {
    if (!liveUserId || !SUBJECT_RE.test(String(subjectId || ''))) return;
    if (_known.get(liveUserId) === subjectId) return;
    try {
        db.getDb().prepare("UPDATE linked_accounts SET subject_id = ? WHERE service = 'network' AND user_id = ? AND service_user_id = ? AND (subject_id IS NULL OR subject_id != ?)")
            .run(subjectId, liveUserId, String(networkUserId), subjectId);
        _known.set(liveUserId, subjectId);
    } catch (err) { console.warn('[Identity] subject note failed:', err.message); }
}

/** Subject id for a Live user id, if Network has told us (via a token) yet. */
function subjectOf(liveUserId) {
    const row = db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(liveUserId);
    return row ? row.subject_id || null : null;
}

async function syncLegacyMap() {
    if (!INTERNAL_API_KEY) return { skipped: 'no INTERNAL_API_KEY' };
    const rows = db.getDb().prepare("SELECT user_id, service_user_id FROM linked_accounts WHERE service = 'network' AND service_user_id GLOB '[0-9]*' ORDER BY user_id").all();
    const total = { sent: rows.length, inserted: 0, unchanged: 0, conflicts: 0, rejected: 0 };
    for (let i = 0; i < rows.length; i += BATCH) {
        const entries = rows.slice(i, i + BATCH).map(r => ({
            network_user_id: Number(r.service_user_id), source_system: 'live', source_type: 'user', source_id: String(r.user_id), verified: true,
        }));
        const res = await fetch(`${OV_NETWORK_INTERNAL_URL}/internal/identity/legacy-map`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_API_KEY },
            body: JSON.stringify({ entries }),
            signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404) return { skipped: 'network has no /internal/identity yet' };
        if (!res.ok) throw new Error(`legacy-map ${res.status}`);
        const out = await res.json();
        total.inserted += out.inserted; total.unchanged += out.unchanged;
        total.conflicts += out.conflicts.length; total.rejected += out.rejected.length;
        for (const c of out.conflicts) console.warn(`[Identity] live user ${c.source.split(':').pop()} is mapped to ${c.mapped_to} on Network, not ${c.requested}; left as is`);
    }
    if (total.inserted || total.conflicts || total.rejected) console.log(`[Identity] legacy map sync: ${JSON.stringify(total)}`);
    return total;
}

module.exports = { noteSubject, subjectOf, syncLegacyMap };
