/**
 * Tranche 2 contract: mic/desktop audio must reach every downstream consumer, and keep
 * reaching them when the streamer changes something mid-broadcast.
 *
 * Every consumer of the broadcast audio binds to a track ONCE and keeps its own
 * reference — MediaRecorder snapshots its tracks at construction, mediasoup Producers
 * wrap a specific track, viewer RTCPeerConnection senders hold theirs. So the old
 * removeTrack/addTrack dance on ss.localStream changed nothing for anyone: toggling the
 * mic mid-stream left viewers hearing the previous track and the VOD recording it,
 * silently, for the rest of the session.
 *
 * Server side, the same shape of bug existed across process boundaries: ffmpeg's
 * argument list and the RS relay's werift peer are both built once from whichever
 * producers existed at that instant, so a broadcaster who went live video-only and then
 * switched the mic on kept pushing silent video to Twitch/Kick/RobotStreamer.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bc = read('public/js/broadcast.js');
const restream = read('server/streaming/restream-manager.js');
const relay = read('server/integrations/rs-passthrough-relay.js');

// ── A: one mixer, one stable output track ────────────────────────────────────────────
assert.ok(/function _ensureAudioMixer\(ss\)/.test(bc), 'a shared audio mixer must exist');
assert.ok(/createMediaStreamDestination\(\)/.test(bc), 'the mixer must publish a MediaStreamDestination track');
assert.ok(/createConstantSource\(\)/.test(bc),
    'the mixer needs a silent keep-alive source, or its output track ends when the last input is removed');
assert.ok(/function _mixOutputTrack\(ss\)/.test(bc), 'consumers need one accessor for the published track');
console.log('OK A: mixer exists and its output track is kept alive independently of its inputs');

// ── B: capture publishes the mixer output, not a raw device track ────────────────────
const captureIdx = bc.indexOf('const finalAudioTrack = _mixOutputTrack(ss);');
assert.ok(captureIdx > 0, 'screen-share capture must publish the mixer output');
console.log('OK B: screen-share capture publishes the mixer output');

// ── C: toggling the mic only touches the mixer ───────────────────────────────────────
const toggle = bc.slice(bc.indexOf('async function toggleScreenShareMic()'),
                        bc.indexOf('function _republishAudioTrack('));
assert.ok(toggle.includes("_mixSetSource(ss, 'mic', null)"), 'muting must disconnect the mic from the mix');
assert.ok(toggle.includes("_mixSetSource(ss, 'mic', micStream)"), 'unmuting must connect the mic to the mix');
assert.ok(!/localStream\.removeTrack\([\s\S]{0,40}\)\s*;\s*[\s\S]{0,80}addTrack\(desktopAudioTracks/.test(toggle),
    'the old remove/add track dance must be gone — it never reached any consumer');
console.log('OK C: mic toggle is a mixer operation, invisible to downstream consumers');

// ── D: when the track identity DOES change, every holder is told ─────────────────────
const republish = bc.slice(bc.indexOf('function _republishAudioTrack('));
for (const [what, re] of [
    ['the local SFU producer', /audioProducer\?\.replaceTrack\(\{ track \}\)/],
    ['the RobotStreamer producer', /robotStreamer\?\.audioProducer\?\.replaceTrack/],
    ['viewer peer connections', /getSenders\?\.\(\)[\s\S]{0,120}replaceTrack\(track\)/],
    ['the VOD recorder', /uploadVodRecording\(streamId, \{ finalizeStream: false \}\)[\s\S]{0,120}startVodRecording\(streamId\)/],
]) {
    assert.ok(re.test(republish), `_republishAudioTrack must update ${what}`);
}
console.log('OK D: SFU, RobotStreamer, viewer PCs and the VOD segment are all updated on a real track change');

// ── E: the mixer is torn down with the capture ───────────────────────────────────────
assert.ok(/_teardownAudioMixer\(ss\)/.test(bc), 'the mixer must be closed when capture stops');
assert.strictEqual((bc.match(/_mixAudioContext/g) || []).length, 0,
    'the old per-toggle AudioContext must be fully retired — two mixers would double the audio');
console.log('OK E: mixer torn down on stop, legacy per-toggle context fully removed');

// ── F: RTMP restreams rebuild when audio shows up late ───────────────────────────────
assert.ok(/webrtcSFU\.on\('producer-added'/.test(restream),
    'the restream manager must watch for producers being ADDED, not only removed');
assert.ok(/_handleAudioProducerAdded\(roomId\)/.test(restream), 'audio arriving late needs a handler');
const handler = restream.slice(restream.indexOf('_handleAudioProducerAdded(roomId) {'));
assert.ok(/webrtcState\?\.hasAudio\) continue/.test(handler),
    'sessions that already carry audio must be left alone — restarting them drops frames for nothing');
assert.ok(/hasAudio: !!audioConsumer/.test(restream),
    'the session must record whether its ffmpeg was built with an audio mapping');
console.log('OK F: Twitch/Kick restreams restart to pick up a microphone enabled after going live');

// ── G: the RobotStreamer relay does the same ─────────────────────────────────────────
assert.ok(/waitForProducer\(session\.roomId, 'audio', \d+\)/.test(relay),
    'the relay should give a slightly-late mic a grace period before declaring the stream video-only');
assert.ok(/producer-added/.test(relay) && /audio producer appeared after start/.test(relay),
    'the relay must restart when audio appears after a video-only start');
assert.ok(/session\._audioWatch/.test(relay), 'the watcher must be tracked so teardown can remove it');
console.log('OK G: RobotStreamer relay waits for a late mic, then rebuilds if one appears');

console.log('✅ broadcast audio harmony test passed');
