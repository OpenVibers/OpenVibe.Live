const assert = require('assert');
const { URL_DEFINITIONS, normalizeValue, resolveRegistryValues } = require('../url-resolver');

const env = {
    OV_LIVE_URL: 'https://env.example.com',
    WEBRTC_PUBLIC_URL: 'https://webrtc.env.example.com',
    OV_NETWORK_URL: 'https://network.env.example.com',
};

const bootstrap = {
    OV_LIVE_URL: 'https://bootstrap.example.com',
    WHIP_PUBLIC_URL: 'https://bootstrap.whip.example.com',
};

const overrides = {
    OV_LIVE_URL: 'https://admin.example.com',
};

const resolved = resolveRegistryValues(env, overrides, bootstrap, URL_DEFINITIONS);
assert.strictEqual(resolved.OV_LIVE_URL.value, 'https://admin.example.com');
assert.strictEqual(resolved.OV_LIVE_URL.source, 'admin');
assert.strictEqual(resolved.WHIP_PUBLIC_URL.value, 'https://bootstrap.whip.example.com');
assert.strictEqual(resolved.WHIP_PUBLIC_URL.source, 'bootstrap');
assert.strictEqual(resolved.WEBRTC_PUBLIC_URL.value, 'https://webrtc.env.example.com');
assert.strictEqual(resolved.WEBRTC_PUBLIC_URL.source, 'env');
assert.strictEqual(resolved.OV_NETWORK_URL.value, 'https://network.env.example.com');
assert.strictEqual(resolved.OV_NETWORK_URL.source, 'env');
assert.strictEqual(resolved.OV_GAMES_URL.value, 'https://openvibe.games');
assert.strictEqual(resolved.OV_MEDIA_URL.value, 'https://openvibe.media');
assert.strictEqual(resolved.JSMPEG_PUBLIC_URL.source, 'default');

assert.strictEqual(normalizeValue('turn:turn.example.com:3478', 'turn_url'), 'turn:turn.example.com:3478');
assert.strictEqual(normalizeValue('turn://turn.example.com:3478', 'turn_url'), 'turn:turn.example.com:3478');
assert.strictEqual(normalizeValue('turns://turn.example.com:5349', 'turn_url'), 'turns:turn.example.com:5349');
assert.strictEqual(normalizeValue('turn://user:pass@turn.example.com:3478', 'turn_url'), null);
assert.strictEqual(normalizeValue('turn://invalid host', 'turn_url'), null);

console.log('✅ openvibe-shared url-resolver precedence test passed');
