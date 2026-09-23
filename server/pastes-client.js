'use strict';
/**
 * Where Live's pastes live (roadmap Wave 5).
 *
 * PASTES_AUTHORITY=community: OpenVibe.Community owns pastes. Live calls its /api/pastes with a
 * service token (community.paste.create/write/moderate) and names the person it acts for in
 * X-OV-Subject (their canonical usr_ id). AI-made pastes are sent as X-OV-Origin: ai and are never
 * filed under a person (roadmap 33); the stream they came from rides along as X-OV-Source-Ref.
 * Anything else (default): the old path through OpenVibe.Media's app API (media-client).
 *
 * Same function shapes as media-client's paste helpers, so call sites only swap the require.
 */
const media = require('./media-client');
const principal = require('./net/network-principal');

const COMMUNITY_URL = (process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
const AUDIENCE = 'openvibe.community';
const onCommunity = () => process.env.PASTES_AUTHORITY === 'community';

class CommunityApiError extends Error {
    constructor(status, body) {
        super((body && (body.error || body.detail)) || `Community API ${status}`);
        this.name = 'MediaApiError';     // call sites already branch on this name for status passthrough
        this.status = status;
        this.body = body;
    }
}

const _subjects = new Map();   // live user id -> usr_ id (or null), for this process
/** Canonical subject for a Live user: from the link table (tokens fill it), else Network's identity map. */
async function subjectForLiveUser(liveUserId) {
    if (liveUserId == null) return null;
    const id = Number(liveUserId);
    if (_subjects.has(id)) return _subjects.get(id);
    let sid = null;
    try { sid = require('./auth/identity-sync').subjectOf(id); } catch { /* */ }
    if (!sid) {
        try {
            const res = await fetch(`${process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'}/internal/identity/resolve-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(await principal.serviceHeaders('openvibe.network')) },
                body: JSON.stringify({ system: 'live', type: 'user', ids: [String(id)] }),
                signal: AbortSignal.timeout(5000),
            });
            const out = res.ok ? await res.json() : null;
            const hit = out && out.results && out.results[String(id)];
            sid = hit && hit.subject ? hit.subject.id : null;
        } catch (err) { console.warn(`[Pastes] subject lookup for live user ${id} failed: ${err.message}`); }
    }
    if (sid) _subjects.set(id, sid);
    return sid;
}

/**
 * One call to Community's paste API. body: plain object (JSON) or FormData. act: { liveUserId } to act
 * as a person, { origin: 'ai', sourceRef } for derived pastes, { staff: true } when Live has already
 * decided the caller is staff (X-OV-Staff; needs community.paste.moderate), {} for Live itself.
 */
async function request(method, path, { query, body, act = {}, ip, timeoutMs = 20000, retried = false } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
    const headers = { Accept: 'application/json', ...(await principal.serviceHeaders(AUDIENCE)) };
    if (act.liveUserId != null) {
        const sid = await subjectForLiveUser(act.liveUserId);
        if (!sid) throw new CommunityApiError(409, { error: 'This account is not linked to an OpenVibe account yet — sign in again and retry.' });
        headers['X-OV-Subject'] = sid;
    }
    if (act.origin === 'ai') {
        headers['X-OV-Origin'] = 'ai';
        if (act.sourceRef) headers['X-OV-Source-Ref'] = JSON.stringify(act.sourceRef);
    }
    if (act.staff) headers['X-OV-Staff'] = '1';
    if (ip) headers['X-Forwarded-For'] = ip;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${COMMUNITY_URL}/api/pastes${path}${qs}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const out = await res.json().catch(() => null);
    if (res.status === 401 && !retried) {             // token rotated/expired under us: fetch a fresh one once
        principal.invalidate(AUDIENCE);
        return request(method, path, { query, body, act, ip, timeoutMs, retried: true });
    }
    if (!res.ok) throw new CommunityApiError(res.status, out);
    return out;
}

/** media-client-compatible createPaste: user_id -> acting person; opts.origin 'ai' -> ownerless. */
async function createPaste({ screenshot, user_id, ...fields } = {}, opts = {}) {
    if (!onCommunity()) return media.createPaste({ screenshot, user_id, ...fields }, opts);
    const act = opts.origin === 'ai'
        ? { origin: 'ai', sourceRef: fields.stream_id ? { service: 'live', type: 'stream', id: String(fields.stream_id) } : undefined }
        : { liveUserId: user_id };
    if (typeof fields.metadata === 'object' && fields.metadata) fields.metadata = JSON.stringify(fields.metadata);
    if (screenshot) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, String(v));
        fd.append('screenshot', new Blob([screenshot.buffer], { type: screenshot.contentType || 'image/png' }), screenshot.filename || 'screenshot.png');
        return request('POST', '', { body: fd, act, timeoutMs: 60000 });
    }
    return request('POST', '', { body: fields, act });
}

async function getPaste(slug) {
    if (!onCommunity()) return media.getPaste(slug);
    const out = await request('GET', `/${encodeURIComponent(slug)}`, { query: { no_view: 1 } });
    return (out && out.paste) || out;
}

function listPastes(query = {}) {
    if (!onCommunity()) return media.listPastes(query);
    return request('GET', '', { query });
}

function listPastesNeedingAi(limit = 5) {
    if (!onCommunity()) return media.listPastesNeedingAi(limit);
    return request('GET', '', { query: { needs_ai: 1, limit } });
}

function setPasteAi(slug, { ai_summary, ai_tags } = {}) {
    if (!onCommunity()) return media.setPasteAi(slug, { ai_summary, ai_tags });
    return request('POST', `/${encodeURIComponent(slug)}/ai`, { body: { ai_summary, ai_tags } });
}

module.exports = { onCommunity, request, createPaste, getPaste, listPastes, listPastesNeedingAi, setPasteAi, subjectForLiveUser, COMMUNITY_URL, CommunityApiError };
