'use strict';
/**
 * What the lineage resolver reads from OpenVibe.Media: VODs and clips (API v1, the ids Live uses)
 * and canonical objects (API v2, `GET /api/v2/<app>/objects/<med_… | legacy:…>`), all as this app
 * with no acting user. Every read answers { value } | { not_found } | { unavailable }, so the
 * resolver can tell "Media says no such record" from "Media could not be asked".
 */
const media = require('../media-client');

const MEDIA_API_KEY = process.env.MEDIA_API_KEY || '';

function classify(err) {
    const status = err && err.name === 'MediaApiError' ? err.status : 0;
    return [400, 404, 410, 422].includes(status) ? { not_found: true } : { unavailable: true, detail: (err && err.message) || 'Media unavailable' };
}

async function read(fn) {
    try {
        const value = await fn();
        return value ? { value } : { not_found: true };
    } catch (err) {
        return classify(err);
    }
}

/** GET /api/v2/<app>/objects/<id>: the canonical object (legacy_ref, kind, owner { subject, user_id }). */
async function fetchObject(id, { timeoutMs = 10000 } = {}) {
    const url = `${media.MEDIA_URL}/api/v2/${encodeURIComponent(media.MEDIA_APP_ID)}/objects/${encodeURIComponent(id)}`;
    const headers = { Accept: 'application/json' };
    if (MEDIA_API_KEY) headers.Authorization = `Bearer ${MEDIA_API_KEY}`;
    let res;
    let body = null;
    try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        body = await res.json().catch(() => null);
    } catch (err) {
        throw new media.MediaApiError(`Media unreachable (GET objects/${id}): ${err.message}`, 0, null);
    }
    if (!res.ok) throw new media.MediaApiError((body && (body.detail || body.error)) || `Media API ${res.status} on GET objects/${id}`, res.status, body);
    return body;
}

module.exports = {
    appId: media.MEDIA_APP_ID,
    getVod: (id) => read(() => media.getVod(id)),
    getClip: (id) => read(() => media.getClip(id)),
    getObject: (id) => read(() => fetchObject(id)),
    _classify: classify,
};
