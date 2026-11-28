'use strict';
/**
 * Whether a live stream has sent us anything yet (11-28). A browser stream counts as live from its "Go live" press,
 * before its camera reaches the server, and sometimes it never does: streams 3080, 3096 and 3097 sent no picture and no
 * sound for minutes, yet sat in Live now and on the home (the AI viewers already wait: ai/viewers/engine.js
 * _waitsForMedia). So a browser stream is listed once its room has had a picture or sound, and one that has had media
 * keeps its card through a reconnect (its producers come and go; the card does not flicker).
 *
 * Only while the SFU runs (sfu.ready): in tests and a restore drill nothing is hidden. No listener and no timer: the
 * answer is read when a list is built (drill mode, test/drill-mode.test.js). The set
 * holds only streams that have had media; withMedia() forgets the ones no longer live when it grows.
 */
const seen = new Set();
const PRUNE_AT = 500;

function sfuOf() {
    try { return require('./webrtc-sfu'); } catch { return null; }
}

function hasMedia(stream, sfu = sfuOf()) {
    if (!stream || String(stream.protocol || '') !== 'webrtc') return true;   // RTMP, WHIP, JSMpeg: media is the start
    const id = Number(stream.id);
    if (!Number.isFinite(id)) return true;
    if (seen.has(id)) return true;
    // No SFU running here (tests, a restore drill, a host without mediasoup): never hide a stream.
    if (!sfu || typeof sfu.findProducerByKind !== 'function' || sfu.ready === false) return true;
    const room = `stream-${id}`;
    let has;
    try { has = !!(sfu.findProducerByKind(room, 'video') || sfu.findProducerByKind(room, 'audio')); } catch { has = true; }
    if (has) seen.add(id);
    return has;
}

/** The live streams a viewer should see: every one but a browser stream whose picture or sound has not arrived. */
function withMedia(streams, sfu = sfuOf()) {
    const list = Array.isArray(streams) ? streams : [];
    if (seen.size > PRUNE_AT) {
        const live = new Set(list.map((s) => Number(s && s.id)));
        for (const id of seen) if (!live.has(id)) seen.delete(id);
    }
    return list.filter((s) => hasMedia(s, sfu));
}

module.exports = { hasMedia, withMedia, _seen: seen };
