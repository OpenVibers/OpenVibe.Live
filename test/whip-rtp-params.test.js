const assert = require('assert');
const sdpTransform = require('sdp-transform');
const whipHandler = require('../server/streaming/whip-handler');

const sdp = `v=0\r\n` +
`m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` +
`a=mid:audio\r\n` +
`a=sendrecv\r\n` +
`a=rtpmap:111 opus/48000/2\r\n` +
`a=ssrc:123456 cname:some\r\n` +
`a=ssrc:123456 msid:stream track\r\n` +
`a=rid:1 send\r\n`;

const parsed = sdpTransform.parse(sdp);
const media = parsed.media[0];
const rtpParameters = whipHandler._extractRtpParameters(media, {
    codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
    headerExtensions: [],
});

assert.strictEqual(rtpParameters.mid, 'audio');
assert.strictEqual(rtpParameters.codecs[0].mimeType, 'audio/opus');
assert.strictEqual(rtpParameters.encodings[0].ssrc, 123456);
assert.strictEqual(rtpParameters.encodings[0].rid, undefined);

console.log('✅ WHIP RTP parameter parser regression test passed');
