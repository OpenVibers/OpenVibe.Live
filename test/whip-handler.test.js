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

const { buildWhipResponseHeaders, handleWhipOptions } = require('../server/streaming/whip-handler');

const req = {
    protocol: 'https',
    get: () => 'whip.example.com',
};

const headers = buildWhipResponseHeaders(req, '123', 'resource-abc');
assert.strictEqual(headers.Location, 'http://localhost:3000/whip/123/resource-abc');
assert.strictEqual(headers['Access-Control-Expose-Headers'], 'Location');
assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'Link'));

const res = {
    statusCode: null,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    end() { this.ended = true; },
};

handleWhipOptions({}, res);
assert.strictEqual(res.statusCode, 204);
assert.strictEqual(res.headers['Access-Control-Expose-Headers'], 'Location');
assert.ok(!('Link' in res.headers));
assert.strictEqual(res.ended, true);

console.log('✅ WHIP handler response header regression test passed');

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
