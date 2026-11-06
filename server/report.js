'use strict';

/**
 * The session report of an agent stream (Agent Streams S3).
 *
 * When an agent stream ends, Live tells OpenVibe.Report about it. The report the tool wrote for the same task gets
 * the stream added to it (the stream part); when no tool finished the session - the stream was the session - a
 * stream-only report is written instead.
 *
 * The token is Live's own, for the audience openvibe.report, with the capability report.session.write (Network's
 * principals seed).
 */
const TOKEN_TTL_MS = 10 * 60_000;

function createReportClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
    const base = String(config.reportInternalUrl || process.env.OV_REPORT_INTERNAL_URL || 'http://127.0.0.1:5080').replace(/\/+$/, '');
    const networkUrl = String(config.networkInternalUrl || process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    let cached = null;

    async function token() {
        if (cached && cached.until > now()) return cached.token;
        const clientId = (config.oauth && config.oauth.clientId) || process.env.OV_OAUTH_CLIENT_ID || 'live';
        const clientSecret = (config.oauth && config.oauth.clientSecret) || process.env.OV_OAUTH_CLIENT_SECRET || '';
        if (!clientId || !clientSecret) throw new Error('Live has no Network client secret, so it cannot write a session report');
        const body = new URLSearchParams({
            grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
            audience: 'openvibe.report', scope: 'report.session.write',
        });
        const res = await fetchImpl(`${networkUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString(),
            signal: AbortSignal.timeout(15_000),
        });
        const doc = await res.json().catch(() => null);
        if (!res.ok || !doc || !doc.access_token) throw new Error(`OpenVibe.Network answered ${res.status}`);
        cached = { token: String(doc.access_token), until: now() + TOKEN_TTL_MS };
        return cached.token;
    }

    /** Tell Report that a stream ended. */
    async function sendStream(payload) {
        const t = await token();
        const res = await fetchImpl(`${base}/internal/session-reports/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        });
        const doc = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error((doc && (doc.detail || doc.error)) || `OpenVibe.Report answered ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return doc;
    }

    return { sendStream, token, baseUrl: base };
}

module.exports = { createReportClient };
