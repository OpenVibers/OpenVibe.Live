'use strict';
/**
 * Network's internal JSON client, with Live's service token for each call (server/net/network-principal.js).
 *
 * The sharing system (openvibe-sdk/share) needs Network twice: to turn a name into a person and to resolve people for
 * display. One client for both, so a test that answers Network's lookups locally (agent streams, the Rundown) changes
 * one place.
 */
let override = null;

/** Tests and a restore drill: answer Network's calls locally. */
function _setNetwork(client) { override = client || null; }

/** The client: one call, one service token, a timeout, and the status on the error. */
function client() {
    if (override) return override;
    const principal = require('./network-principal');
    const base = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    return {
        async json({ path, method = 'GET', query, json }) {
            const headers = await principal.headersFor(path);
            const q = query ? `?${new URLSearchParams(query)}` : '';
            const res = await fetch(`${base}${path}${q}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...headers },
                ...(json === undefined ? {} : { body: JSON.stringify(json) }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) {
                const err = new Error(`Network ${path} answered ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        },
    };
}

module.exports = { client, _setNetwork };
