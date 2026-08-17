const assert = require('assert');
const config = require('../server/config');

const originalFetch = global.fetch;
global.fetch = async () => ({
    ok: true,
    json: async () => ({
        registry: {
            BASE_URL: { value: 'https://openvibe.live', source: 'bootstrap' },
            WEBRTC_PUBLIC_URL: { value: 'https://webrtc.openvibe.live', source: 'bootstrap' },
            WHIP_PUBLIC_URL: { value: 'https://whip.openvibe.live', source: 'admin' },
            JSMPEG_PUBLIC_URL: { value: 'https://jsmpeg.openvibe.live', source: 'bootstrap' },
            OV_NETWORK_URL: { value: 'https://openvibe.network', source: 'bootstrap' },
        }
    })
});

(async () => {
    config.internalApiKey = 'test-key';
    config.openvibeToolsInternalUrl = 'http://127.0.0.1:3100';
    await config.refreshRegistry();
    assert.strictEqual(config.baseUrl, 'https://openvibe.live');
    assert.strictEqual(config.webrtc.publicUrl, 'https://webrtc.openvibe.live');
    assert.strictEqual(config.whip.publicUrl, 'https://whip.openvibe.live');
    assert.strictEqual(config.jsmpeg.publicUrl, 'https://jsmpeg.openvibe.live');
    assert.strictEqual(config.openvibeToolsUrl, 'https://openvibe.network');
    console.log('✅ openvibelive config refresh test passed');
    global.fetch = originalFetch;
})();
