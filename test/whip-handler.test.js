const assert = require('assert');
const { _extractRtpParameters, _extractDtlsParameters, _buildSdpAnswer } = require('../server/streaming/whip-handler');
const config = require('../server/config');

const routerCaps = {
    codecs: config.mediasoup.mediaCodecs,
    headerExtensions: [],
};

const audioMedia = {
    type: 'audio',
    payloads: '111 0',
    rtp: [
        { payload: 111, codec: 'opus', rate: 48000, encoding: 2 },
        { payload: 0, codec: 'PCMU', rate: 8000 },
    ],
    fmtp: [
        { payload: 111, config: 'minptime=10;useinbandfec=1' },
    ],
    rtcpFb: [
        { payload: 111, type: 'transport-cc' },
    ],
    ext: [
        { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', value: 1 },
    ],
    ssrcs: [
        { id: '12345678', attribute: 'cname', value: 'test-opus' },
        { id: '12345678', attribute: 'msid', value: 'audio-stream audio-track' },
    ],
    mid: '0',
};

const rtpParameters = _extractRtpParameters(audioMedia, routerCaps, 0);
assert.ok(rtpParameters, 'Expected RTP parameters to be extracted');
assert.strictEqual(rtpParameters.mid, '0');
assert.ok(Array.isArray(rtpParameters.encodings), 'Encodings must be an array');
assert.strictEqual(rtpParameters.encodings.length, 1);
assert.strictEqual(rtpParameters.encodings[0].ssrc, 12345678);
assert.strictEqual(rtpParameters.codecs[0].mimeType, 'audio/opus');
assert.notDeepStrictEqual(rtpParameters.encodings[0], {}, 'Encoding object must not be empty');

console.log('✅ WHIP handler RTP encoding regression test passed');

const { buildWhipResponseHeaders, handleWhipOptions, whipCors, WHIP_CORS_HEADERS } = require('../server/streaming/whip-handler');

const req = {
    protocol: 'https',
    get: () => 'whip.example.com',
};

const headers = buildWhipResponseHeaders(req, '123', 'resource-abc');
assert.strictEqual(headers.Location, 'http://localhost:3000/whip/123/resource-abc');
// A browser can only read the resource URL (and our error code) if both are exposed.
assert.strictEqual(headers['Access-Control-Expose-Headers'], 'Location, X-WHIP-ERROR');
assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'Link'));

function makeRes() {
    return {
        statusCode: null,
        headers: {},
        ended: false,
        status(code) { this.statusCode = code; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        end() { this.ended = true; },
    };
}

const res = makeRes();
handleWhipOptions({}, res);
assert.strictEqual(res.statusCode, 204);
assert.strictEqual(res.headers['Access-Control-Expose-Headers'], 'Location, X-WHIP-ERROR');
assert.ok(!('Link' in res.headers));
assert.strictEqual(res.ended, true);

console.log('✅ WHIP handler response header regression test passed');

// ── Browser (cross-origin) publishing: /whip must be open to every origin ──
// A static site with no backend can only publish if the preflight and the POST both
// come back with Access-Control-Allow-Origin: * — the stream key is the credential.
assert.strictEqual(WHIP_CORS_HEADERS['Access-Control-Allow-Origin'], '*');
for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.ok(WHIP_CORS_HEADERS['Access-Control-Allow-Methods'].includes(method), `CORS must allow ${method}`);
}
assert.ok(/Authorization/.test(WHIP_CORS_HEADERS['Access-Control-Allow-Headers']), 'Bearer auth needs Authorization allowed');
assert.ok(/Content-Type/.test(WHIP_CORS_HEADERS['Access-Control-Allow-Headers']), 'application/sdp needs Content-Type allowed');

// Preflight from a foreign origin is answered directly with the open headers.
const preflightRes = makeRes();
let preflightNext = false;
whipCors({ method: 'OPTIONS', headers: { origin: 'https://static.example' } }, preflightRes, () => { preflightNext = true; });
assert.strictEqual(preflightRes.statusCode, 204);
assert.strictEqual(preflightRes.ended, true);
assert.strictEqual(preflightNext, false, 'preflight must not fall through to the route handlers');
assert.strictEqual(preflightRes.headers['Access-Control-Allow-Origin'], '*');
assert.strictEqual(preflightRes.headers['Access-Control-Allow-Methods'], WHIP_CORS_HEADERS['Access-Control-Allow-Methods']);
assert.strictEqual(preflightRes.headers['Access-Control-Allow-Headers'], WHIP_CORS_HEADERS['Access-Control-Allow-Headers']);

// The actual POST/PATCH/DELETE gets the headers stamped up-front and continues, so even
// an error response from the handler (401 invalid key, 406 no codecs…) is readable
// cross-origin instead of surfacing as an opaque "TypeError: Failed to fetch".
for (const method of ['POST', 'PATCH', 'DELETE']) {
    const r = makeRes();
    let nextCalled = false;
    whipCors({ method, headers: { origin: 'https://static.example' } }, r, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, `${method} must reach the handler`);
    assert.strictEqual(r.ended, false);
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(r.headers['Access-Control-Expose-Headers'], 'Location, X-WHIP-ERROR');
}

console.log('✅ WHIP cross-origin (browser publisher) CORS regression test passed');

const actpassDtls = _extractDtlsParameters({
    version: 0,
    origin: { username: '-', sessionId: '1', sessionVersion: 1, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
    name: 'test',
    timing: { start: 0, stop: 0 },
    media: [
        {
            type: 'audio',
            protocol: 'UDP/TLS/RTP/SAVPF',
            payloads: '111',
            connection: { ip: '127.0.0.1', version: 4 },
            mid: '0',
            setup: 'actpass',
            fingerprint: { type: 'sha-256', hash: 'AA:BB:CC:DD' },
        },
    ],
});
assert.strictEqual(actpassDtls.role, 'client');
assert.strictEqual(actpassDtls.fingerprints[0].algorithm, 'sha-256');
assert.strictEqual(actpassDtls.fingerprints[0].value, 'AA:BB:CC:DD');

const passiveDtls = _extractDtlsParameters({
    version: 0,
    origin: { username: '-', sessionId: '1', sessionVersion: 1, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
    name: 'test',
    timing: { start: 0, stop: 0 },
    media: [
        {
            type: 'audio',
            protocol: 'UDP/TLS/RTP/SAVPF',
            payloads: '111',
            connection: { ip: '127.0.0.1', version: 4 },
            mid: '0',
            setup: 'passive',
            fingerprint: { type: 'sha-1', hash: '11:22:33:44' },
        },
    ],
});
assert.strictEqual(passiveDtls.role, 'server');
assert.strictEqual(passiveDtls.fingerprints[0].algorithm, 'sha-1');
assert.strictEqual(passiveDtls.fingerprints[0].value, '11:22:33:44');

const answerSdp = _buildSdpAnswer(
    {
        iceParameters: { usernameFragment: 'ufrag', password: 'pwd' },
        iceCandidates: [
            { foundation: '1', protocol: 'udp', priority: 2130706432, ip: '1.2.3.4', port: 1234, type: 'host' },
        ],
        dtlsParameters: {
            fingerprints: [
                { algorithm: 'sha-1', value: '11:22:33:44' },
                { algorithm: 'sha-256', value: 'AA:BB:CC:DD' },
            ],
        },
    },
    {
        version: 0,
        origin: { username: '-', sessionId: '1', sessionVersion: 1, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
        name: 'test',
        timing: { start: 0, stop: 0 },
        setup: 'actpass',
        media: [
            {
                type: 'audio',
                protocol: 'UDP/TLS/RTP/SAVPF',
                payloads: '111',
                mid: '0',
                setup: 'actpass',
                connection: { ip: '127.0.0.1', version: 4 },
                rtp: [{ payload: 111, codec: 'opus', rate: 48000, encoding: 2 }],
                fmtp: [{ payload: 111, config: 'minptime=10' }],
                rtcpFb: [],
                ext: [],
                ssrcs: [{ id: '1234', attribute: 'cname' }],
            },
        ],
    },
    {
        audio: {
            rtpParameters: {
                codecs: [{ payloadType: 111, mimeType: 'audio/opus', clockRate: 48000 }],
                headerExtensions: [],
                encodings: [{ ssrc: 1234 }],
            },
        },
    }
);
assert.ok(answerSdp.includes('a=setup:passive'));
assert.ok(answerSdp.includes('sha-256'));
assert.ok(answerSdp.includes('AA:BB:CC:DD'));

console.log('✅ WHIP handler DTLS role and fingerprint regression test passed');

// ── Browser publishers: rejected m-sections must stay out of the BUNDLE group ──
// A browser offer can carry an m-section we cannot accept (a data channel, or a codec
// the router lacks). RFC 8843 §7.3.3 says a rejected section must not be listed in
// BUNDLE and Chrome/Firefox refuse the whole answer if it is; OBS never checked.
const mixedAnswer = _buildSdpAnswer(
    {
        iceParameters: { usernameFragment: 'ufrag', password: 'pwd' },
        iceCandidates: [
            { foundation: '1', protocol: 'udp', priority: 2130706432, ip: '1.2.3.4', port: 1234, type: 'host' },
        ],
        dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC:DD' }] },
    },
    {
        version: 0,
        origin: { username: '-', sessionId: '1', sessionVersion: 1, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
        name: 'test',
        timing: { start: 0, stop: 0 },
        media: [
            {
                type: 'audio', protocol: 'UDP/TLS/RTP/SAVPF', payloads: '111', mid: '0', setup: 'actpass',
                connection: { ip: '127.0.0.1', version: 4 },
                rtp: [{ payload: 111, codec: 'opus', rate: 48000, encoding: 2 }], fmtp: [], rtcpFb: [], ext: [],
                ssrcs: [{ id: '1234', attribute: 'cname' }],
            },
            {
                type: 'video', protocol: 'UDP/TLS/RTP/SAVPF', payloads: '96 97', mid: '1', setup: 'actpass',
                connection: { ip: '127.0.0.1', version: 4 },
                rtp: [{ payload: 96, codec: 'VP8', rate: 90000 }, { payload: 97, codec: 'rtx', rate: 90000 }], fmtp: [], rtcpFb: [], ext: [],
                ssrcs: [{ id: '5678', attribute: 'cname' }],
            },
            {
                type: 'application', protocol: 'UDP/DTLS/SCTP', payloads: 'webrtc-datachannel', mid: '2', setup: 'actpass',
                connection: { ip: '127.0.0.1', version: 4 },
            },
        ],
    },
    {
        audio: { rtpParameters: { codecs: [{ payloadType: 111, mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [], encodings: [{ ssrc: 1234 }] } },
        video: { rtpParameters: { codecs: [{ payloadType: 96, mimeType: 'video/VP8', clockRate: 90000 }], headerExtensions: [], encodings: [{ ssrc: 5678 }] } },
    }
);
assert.ok(mixedAnswer.includes('a=group:BUNDLE 0 1\r\n'), `BUNDLE must list only accepted mids, got: ${mixedAnswer.match(/a=group:[^\r\n]*/)?.[0]}`);
assert.ok(mixedAnswer.includes('m=application 0 UDP/DTLS/SCTP webrtc-datachannel'), 'rejected section keeps its offered format list');
assert.ok(mixedAnswer.includes('a=mid:2'), 'rejected section keeps its mid so the m-line count still matches the offer');
assert.strictEqual((mixedAnswer.match(/^m=/gm) || []).length, 3, 'answer must have one m-line per offered m-line');

console.log('✅ WHIP answer BUNDLE group excludes rejected m-sections (browser publisher) test passed');
