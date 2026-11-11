'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/js/stream-player.js'), 'utf8');
const start = source.indexOf('function createRecvTransportWithIceFallback(');
const end = source.indexOf('\nfunction isMediaRecorderSupported(', start);
assert.ok(start >= 0 && end > start);
const create = new Function(`${source.slice(start, end)}; return createRecvTransportWithIceFallback;`)();
const iceServers = [
    { urls: 'stun:stun.example.org:3478' },
    { urls: 'turn:turn.example.org:3478', username: 'test', credential: 'test' },
    { urls: 'turn:turn.example.org:3478?transport=tcp', username: 'test', credential: 'test' },
];

const calls = [];
const device = { createRecvTransport(params) {
    calls.push(params);
    if (params.iceServers.some((s) => String(s.urls).includes('?transport='))) {
        throw new SyntaxError('Invalid TURN URL query string');
    }
    return params;
} };
const result = create(device, { id: 'recv' }, iceServers);
assert.equal(calls.length, 2);
assert.deepEqual(result.iceServers, iceServers.slice(0, 2));
assert.equal(result.iceServers[1].credential, 'test');
assert.throws(() => create({ createRecvTransport() { throw new Error('connection failed'); } }, {}, iceServers), /connection failed/);

// The engine check proves the exact constructor difference behind this regression.
let playwright;
try { playwright = require(process.env.OV_PLAYWRIGHT || 'playwright'); } catch { /* optional locally */ }
(async () => {
    if (playwright) {
        for (const name of ['chromium', 'webkit']) {
            const browser = await playwright[name].launch({ headless: true });
            try {
                const page = await browser.newPage();
                const value = await page.evaluate((fn) => {
                    const helper = new Function(`${fn}; return createRecvTransportWithIceFallback;`)();
                    const servers = [
                        { urls: 'turn:turn.example.org:3478', username: 'test', credential: 'test' },
                        { urls: 'turn:turn.example.org:3478?transport=tcp', username: 'test', credential: 'test' },
                    ];
                    const device = { createRecvTransport(params) {
                        const pc = new RTCPeerConnection({ iceServers: params.iceServers });
                        pc.close();
                        return params;
                    } };
                    return helper(device, { id: 'recv' }, servers).iceServers.map((s) => s.urls);
                }, source.slice(start, end));
                assert.equal(value.length, name === 'webkit' ? 1 : 2, `${name} ICE compatibility`);
            } finally { await browser.close(); }
        }
    }
    console.log(`turn-browser-compat: fallback keeps TURN credentials${playwright ? '; Chromium and WebKit verified' : ''}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
