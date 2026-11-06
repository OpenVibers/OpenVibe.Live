'use strict';

/**
 * Live's client for OpenVibe.Vision's unsafe-image review (VIS-6).
 *
 * Live classifies its own AI text locally (server/ai/explicit.js): nudity is fine, sex acts are not, and a
 * child with nudity or a sex act is the hard line. When that hard line fires, Live asks Vision to make the
 * operator's report record, so one queue (openvibe.vision/review) holds every category-3 object across the
 * network. The report is internal; nothing is sent to an external authority by this call.
 *
 * Env: VISION_URL (or OV_VISION_URL), OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID/SECRET. With no URL or no
 * secret the client is off and the clip is still made private; only the operator record is missing, and the
 * warning says so. A restore drill (LIVE_DRILL) never calls out.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

let tokens = null;
let tokensAt = '';

function configNow() {
    const base = String(process.env.VISION_URL || process.env.OV_VISION_URL || '').replace(/\/+$/, '');
    const secret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    return { base, secret, network: String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '') };
}

function serviceTokens({ base, secret, network }) {
    const at = `${network}|${secret}`;
    if (tokens && tokensAt === at) return tokens;
    tokens = createServiceTokenClient({
        tokenUrl: `${network}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'live',
        clientSecret: secret,
        audience: 'openvibe.vision',
        scope: 'vision.image.review',
    });
    tokensAt = at;
    return tokens;
}

function enabled() {
    if (require('../drill').enabled) return false;
    const c = configNow();
    return Boolean(c.base && c.secret);
}

/** Report a category-3 text review to Vision. → the stored review/report, or null when the client is off. */
async function reportMinorSexual({ clip, text, ownerSubject = null, fetchImpl = globalThis.fetch } = {}) {
    if (!enabled()) return null;
    const c = configNow();
    const id = clip && clip.id != null ? String(clip.id) : null;
    if (!id) return null;
    const res = await fetchImpl(`${c.base}/api/v1/review`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await serviceTokens(c).authHeaders()) },
        body: JSON.stringify({
            text: String(text || '').slice(0, 4000),
            object_type: 'live.clip',
            object_id: id,
            owner_subject: ownerSubject || null,
            preview_url: clip && clip.thumbnail_url ? String(clip.thumbnail_url).slice(0, 2000) : null,
            note: 'Live auto-clip guard: sexual content involving a minor',
        }),
        signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.review) throw new Error(`Vision review ${res.status}: ${(body && (body.detail || body.code)) || 'failed'}`);
    return body;
}

function _reset() { tokens = null; tokensAt = ''; }

module.exports = { enabled, reportMinorSexual, _reset };
