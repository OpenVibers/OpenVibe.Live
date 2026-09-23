'use strict';
/**
 * TURN credentials for ICE server lists (voice channels, SFU viewers and broadcasters).
 *
 * With TURN_AUTH_SECRET set — coturn running `use-auth-secret` with the same `static-auth-secret` —
 * every list carries a credential that expires (TURN REST API: username `<expiry>:<tag>`, credential
 * HMAC-SHA1 of the username, base64). Without it the static TURN_USERNAME/TURN_CREDENTIAL pair is
 * used, and nothing is emitted for a turn: URL that has no credentials at all (the browser refuses
 * such an entry outright).
 */
const crypto = require('crypto');
const config = require('../config');

const TTL_SECONDS = 3600;

function turnCredentials(tag = 'anon') {
    // A restore-drill instance (LIVE_DRILL) hands out no credential for production's TURN server.
    if (require('../drill').enabled) return null;
    const secret = String(process.env.TURN_AUTH_SECRET || '').trim();
    if (secret) {
        const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${String(tag).replace(/[^A-Za-z0-9_-]/g, '')}`;
        const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
        return { username, credential, ephemeral: true };
    }
    const { username, credential } = config.turn || {};
    if (username && credential) return { username, credential, ephemeral: false };
    return null;
}

/** [{ urls, username, credential }] for a TURN URL (udp + tcp), or [] when it cannot be authenticated. */
function turnEntries(url, tag) {
    if (!url) return [];
    const creds = turnCredentials(tag);
    if (!creds) return [];
    const tcp = url.includes('?') ? `${url}&transport=tcp` : `${url}?transport=tcp`;
    return [{ urls: url, username: creds.username, credential: creds.credential }, { urls: tcp, username: creds.username, credential: creds.credential }];
}

module.exports = { turnCredentials, turnEntries, TTL_SECONDS };
