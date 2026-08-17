const assert = require('assert');

function loadConfig() {
    delete require.cache[require.resolve('../server/config')];
    return require('../server/config');
}

process.env.BASE_URL = 'https://example.com';
process.env.WEBRTC_PUBLIC_URL = '';
process.env.WHIP_PUBLIC_URL = 'https://whip.example.com';
process.env.WHIP_PUBLIC_URL_ENABLED = 'false';
process.env.MEDIASOUP_ANNOUNCED_IP = '';
delete process.env.TURN_URL;
delete process.env.TURN_USERNAME;
delete process.env.TURN_CREDENTIAL;

let config = loadConfig();
assert.strictEqual(config.baseUrl, 'https://example.com');
assert.strictEqual(config.webrtc.publicUrl, 'https://example.com');
assert.strictEqual(config.whip.publicUrl, 'https://whip.example.com');
assert.strictEqual(config.whip.enabled, false);
assert.strictEqual(config.mediasoup.announcedIp, 'example.com');
assert.strictEqual(config.turn.url, 'turn:turn.openvibe.live'); // default TURN host for openvibe.live

console.log('✅ WHIP config defaults regression test passed');

delete process.env.WHIP_PUBLIC_URL_ENABLED;
config = loadConfig();
assert.strictEqual(config.whip.publicUrl, 'https://whip.example.com');
assert.strictEqual(config.whip.enabled, true);
console.log('✅ WHIP public URL defaults to enabled when configured without an explicit enabled flag');

process.env.TURN_URL = 'turn:turn.example.com:3478';
process.env.TURN_USERNAME = 'testuser';
process.env.TURN_CREDENTIAL = 'testpass';
config = loadConfig();
assert.strictEqual(config.turn.url, 'turn:turn.example.com:3478');
assert.strictEqual(config.turn.username, 'testuser');
assert.strictEqual(config.turn.credential, 'testpass');

console.log('✅ Valid TURN URL normalization passed');

process.env.TURN_URL = 'invalid-turn-url';
delete process.env.TURN_USERNAME;
delete process.env.TURN_CREDENTIAL;
config = loadConfig();
assert.strictEqual(config.turn.url, ''); // explicit invalid URL disables TURN (no fallback)

console.log('✅ Invalid TURN URL is ignored and no ICE metadata will be emitted');
