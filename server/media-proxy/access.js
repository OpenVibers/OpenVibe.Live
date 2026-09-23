/**
 * OpenVibe.Live — who may see a VOD or clip (Media rows and the frozen legacy rows alike).
 *
 * A private item is invisible to everyone but its owners and staff, and "invisible" means the
 * caller gets exactly what a missing id gets: the same 404 and body, never a stub with the
 * title and username, never a 403 that confirms the id is real.
 *
 *   private   visibility 'private', or no visibility and a falsy is_public (legacy rows)
 *   owners    the uploader/clipper (user_id), the clipped channel (channel_user_id) and the
 *             streamer whose stream it came from (stream_id → streams.user_id)
 *   staff     admin or global_mod (permissions.isStaff)
 *
 * Unlisted items stay reachable by direct link — that is what unlisted means.
 */
'use strict';
const db = require('../db/database');
const permissions = require('../auth/permissions');

function isPrivate(row) {
    if (!row) return false;
    if (row.visibility) return row.visibility === 'private';
    return !row.is_public || row.is_public === '0';
}

function ownerIds(row) {
    const ids = [row.user_id, row.channel_user_id];
    if (row.stream_id) {
        try { const s = db.getStreamById(row.stream_id); if (s) ids.push(s.user_id); } catch { /* no stream */ }
    }
    return ids.filter((x) => x != null).map(Number);
}

/** Owner or staff — may see the item whatever its visibility. */
function canSeePrivate(user, row) {
    if (!user || !row) return false;
    if (permissions.isStaff(user)) return true;
    return ownerIds(row).includes(Number(user.id));
}

/** May this caller (req.user, or null) see this row at all? */
function canView(user, row) {
    return !!row && (!isPrivate(row) || canSeePrivate(user, row));
}

module.exports = { isPrivate, canSeePrivate, canView, ownerIds };
