const assert = require('assert');
const broadcastServer = require('../server/streaming/broadcast-server');
const config = require('../server/config');

const originalTurn = {
    url: config.turn.url,
    username: config.turn.username,
    credential: config.turn.credential,
};

try {
    config.turn.url = 'http://invalid.example.com:3478';
    config.turn.username = 'user';
    config.turn.credential = 'pass';
    const iceServers = broadcastServer._getIceServers();
    assert.strictEqual(iceServers.length, 2, 'Invalid TURN URL should be skipped and only STUN servers kept');
    assert.ok(iceServers.every(s => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.every((u) => /^stun:/i.test(u));
    }), 'Only STUN URLs should be returned when TURN URL is invalid');

    config.turn.url = 'turn:turn.example.com:3478';
    config.turn.username = 'user';
    config.turn.credential = 'pass';
    const iceServers2 = broadcastServer._getIceServers();
    assert.strictEqual(iceServers2.length, 4, 'Valid TURN URL should produce 2 TURN entries plus 2 STUN entries');
    assert.strictEqual(iceServers2[2].urls, 'turn:turn.example.com:3478');
    assert.strictEqual(iceServers2[2].username, 'user');
    assert.strictEqual(iceServers2[2].credential, 'pass');
    assert.strictEqual(iceServers2[3].urls, 'turn:turn.example.com:3478?transport=tcp');

    const normalized = config._normalizeTurnUrl('turn://turn.example.com:3478');
    assert.strictEqual(normalized, 'turn:turn.example.com:3478');

    const normalizedSecure = config._normalizeTurnUrl('turns://turn.example.com:5349');
    assert.strictEqual(normalizedSecure, 'turns:turn.example.com:5349');

    console.log('✅ ICE server sanitization regression tests passed');
} finally {
    config.turn.url = originalTurn.url;
    config.turn.username = originalTurn.username;
    config.turn.credential = originalTurn.credential;
}
