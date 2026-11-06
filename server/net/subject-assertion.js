'use strict';

/**
 * The person's own subject assertion for Live's money calls (ADR-003, the 2026-11-06 amendment; plan H1).
 *
 * Live names the person it acts for — the person who signed in — and Billing believes it. On a money
 * route that is only Live's word: a compromised Live could tip in anyone's name or read anyone's
 * receipts. A subject assertion is the person's own answer to the same question: Network signs their
 * access token into a 60-second proof (ES256) that names them, and Billing checks that proof instead
 * of Live's word.
 *
 * Live holds the person's Network access token on the request (the session cookie `ov_token`, or the
 * Authorization header), so it can ask Network to sign it. Without that token there is nothing to
 * sign and no assertion is minted: the call then travels the old way, which Billing's
 * BILLING_REQUIRE_SUBJECT_ASSERTION flag decides on.
 *
 * The assertion is minted per call and never cached: Billing refuses a replayed one (the jti is
 * remembered), so two money calls must not share it.
 */
const { createSubjectAssertionMinter } = require('openvibe-sdk/assertions');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The person's own Network access token on this request, or null (no session, or a Live API token). */
function personToken(headers) {
    const h = headers || {};
    const auth = String(h.authorization || '');
    if (/^Bearer\s+/i.test(auth)) {
        const token = auth.slice(7).trim();
        // A Live API token (hbt_…) is not a Network session; Network would refuse it anyway.
        if (token && !/^hbt_/.test(token)) return token;
    }
    // The session cookie (the person's Network token, JS-readable for the navbar).
    for (const part of String(h.cookie || '').split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() !== 'ov_token') continue;
        const value = decodeURIComponent(part.slice(idx + 1).trim());
        if (value) return value;
    }
    return null;
}

const minter = createSubjectAssertionMinter({
    internalUrl: NETWORK_INTERNAL_URL,
    oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
});

/**
 * The assertion for the person this request acts for, or null when it cannot be had (no session,
 * no grant, Network down). It never throws: a money call must not fail because a proof is missing.
 */
async function assertionFor(headers, subject) {
    if (!subject || !SUBJECT_RE.test(String(subject))) return null;
    const userToken = personToken(headers);
    if (!userToken) return null;
    return await minter.mint({ userToken, subject, audience: 'openvibe.billing' });
}

module.exports = { personToken, assertionFor, SUBJECT_RE };
