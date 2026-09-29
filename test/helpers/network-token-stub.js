'use strict';
/**
 * For tests with a stub OpenVibe.Network: answer POST /oauth/token the way Network does for Live's client-credentials
 * request, and tell whether a call carried Live's service token (and never X-Internal-Key, retired in plan T2).
 *
 *   if (req.url === '/oauth/token') return tokenReply(res);
 *   assert.ok(sentToken(req));
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let issued = 0;

const CAPS = ['identity.subject.resolve', 'network.notifications.push', 'network.coins.credit', 'network.registry.read'];
/** Network's /oauth/token answer body for Live (a real RS256 service token). */
function tokenBody(cap = CAPS) {
    const now = Math.floor(Date.now() / 1000);
    issued += 1;
    const access_token = serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: ['openvibe.network'], cap, iat: now, exp: now + 300, jti: `tok_stub_${String(issued).padStart(6, '0')}` }, keys.privateKey);
    return { access_token, token_type: 'Bearer', expires_in: 300 };
}
function tokenReply(res, cap = CAPS) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(tokenBody(cap)));
}

const sentToken = (req) => /^Bearer \S+/.test(String(req.headers.authorization || '')) && !req.headers['x-internal-key'];

module.exports = { tokenReply, tokenBody, sentToken, keys, issued: () => issued };
