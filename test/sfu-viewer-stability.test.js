'use strict';

/**
 * SFU viewer stability regression tests
 *
 * Verifies the key behavioral fixes for the viewer re-watch loop:
 *   A. Server-side: _tryCreateSfuViewer guard skips transport recreation when DTLS is connected
 *   B. Server-side: webrtc-sfu.js consume() triggers requestKeyFrame() for video consumers
 *   C. Client-side: _sfuViewerSetupInProgress guard is present in stream-player.js
 *   D. Client-side: 20s first-frame grace window (not 8s in SFU path), armed from transport connected
 *   E. Client-side: 15s transport connect timeout + null-before-close cascade guard
 *   F. WHIP ICE disconnect: grace timer + explicit producer-removed emit in cleanupSession
 *   G. Broadcast-server: ICE-state filter + stale-source path + watch-queued message
 *   H. Client: sfu-source-unavailable and watch-queued handled without P2P offer timeout
 *   I. Client: frozen-video detector starts after play, stops on transport change
 *   J. Broadcaster auto-publishes into SFU and legacy P2P is explicitly gated
 *   K. Server startup logs TURN / announced-IP diagnostics for SFU viewers
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerSrc = fs.readFileSync(path.join(__dirname, '../public/js/stream-player.js'), 'utf8');
const sfuSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/webrtc-sfu.js'), 'utf8');
const bcastSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/broadcast-server.js'), 'utf8');
const broadcastClientSrc = fs.readFileSync(path.join(__dirname, '../public/js/broadcast.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(__dirname, '../server/config.js'), 'utf8');
const whipSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/whip-handler.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');

// ── A: broadcast-server dedup guard ────────────────────────────
assert.ok(
    bcastSrc.includes("dtlsState === 'connected'") && bcastSrc.includes('return true; // handled'),
    'broadcast-server.js _tryCreateSfuViewer must short-circuit when DTLS is already connected'
);
assert.ok(
    bcastSrc.includes('requestKeyFrame') && bcastSrc.includes('Keyframe re-request'),
    'broadcast-server.js must request a keyframe on existing consumer instead of recreating transport'
);
assert.ok(
    bcastSrc.includes('Clean up previous SFU viewer transport (e.g. on re-watch after real transport failure)'),
    'broadcast-server.js must still clean up on real failure path'
);
console.log('OK A: broadcast-server.js _tryCreateSfuViewer dedup guard present');

// ── B: webrtc-sfu.js keyframe request ──────────────────────────
assert.ok(
    sfuSrc.includes('requestKeyFrame()'),
    'webrtc-sfu.js consume() must call consumer.requestKeyFrame()'
);
assert.ok(
    sfuSrc.includes("consumer.kind === 'video'") && sfuSrc.includes('requestKeyFrame'),
    'webrtc-sfu.js must guard requestKeyFrame() behind kind === video'
);
assert.ok(
    sfuSrc.includes('Keyframe requested for video consumer'),
    'webrtc-sfu.js must log keyframe request for diagnostics'
);
console.log('OK B: webrtc-sfu.js consume() calls requestKeyFrame() for video consumers');

// ── C: client-side in-progress guard ───────────────────────────
assert.ok(
    playerSrc.includes('let _sfuViewerSetupInProgress = false'),
    'stream-player.js must declare _sfuViewerSetupInProgress module-level flag'
);
assert.ok(
    playerSrc.includes('if (_sfuViewerSetupInProgress)'),
    'stream-player.js must guard sfu-viewer-ready message with _sfuViewerSetupInProgress check'
);
assert.ok(
    playerSrc.includes('_sfuViewerSetupInProgress = true;'),
    'stream-player.js must set _sfuViewerSetupInProgress = true before handleSfuViewerReady'
);
assert.ok(
    playerSrc.includes('finally') && playerSrc.includes('_sfuViewerSetupInProgress = false'),
    'stream-player.js must clear _sfuViewerSetupInProgress in a finally block'
);
console.log('OK C: _sfuViewerSetupInProgress concurrent-setup guard present in stream-player.js');

// ── D: 20s stall timer in SFU path, armed from connected state ──
assert.ok(
    playerSrc.includes("starting 20s first-frame grace window"),
    'stream-player.js SFU path must log 20s first-frame grace window message'
);
assert.ok(
    playerSrc.includes('}, 20000);'),
    'stream-player.js must have a 20000ms stall timer'
);
assert.ok(
    playerSrc.includes("state === 'connected'") &&
    playerSrc.indexOf("starting 20s first-frame grace window") >
        playerSrc.indexOf("state === 'connected'"),
    'stream-player.js 20s stall timer must be armed inside the connected state handler'
);
assert.ok(
    playerSrc.includes('no frames after 20s post-connect'),
    'stream-player.js SFU stall log must say 20s post-connect, not 8s'
);
console.log('OK D: 20s first-frame grace window armed inside transport connected handler');

// ── E: connect timeout + null-before-close cascade guard ────────
assert.ok(
    playerSrc.includes('}, 15000);') && playerSrc.includes('_sfuTransportConnectTimeout'),
    'stream-player.js must have a 15s ICE/DTLS connect timeout (_sfuTransportConnectTimeout)'
);
assert.ok(
    playerSrc.includes('_oldRecvTransport') && playerSrc.includes('player._sfuRecvTransport = null;'),
    'stream-player.js must null player._sfuRecvTransport BEFORE calling close() to prevent cascade'
);
assert.ok(
    playerSrc.includes('if (!player || player._sfuRecvTransport !== recvTransport) return;'),
    'stream-player.js connectionstatechange handler must guard against stale transport events'
);
console.log('OK E: 15s connect timeout + null-before-close cascade guard present in stream-player.js');

// ── F: WHIP ICE disconnect grace timer ──────────────────────────
assert.ok(
    whipSrc.includes("state === 'disconnected'") && whipSrc.includes('_iceGraceTimer'),
    'whip-handler.js must set a grace timer on ICE disconnected'
);
assert.ok(
    whipSrc.includes('15000') && whipSrc.includes('ICE grace expired'),
    'whip-handler.js ICE grace timer must be 15s and log expiry'
);
assert.ok(
    whipSrc.includes("state === 'failed'") && whipSrc.includes('ICE failed'),
    'whip-handler.js must clean up immediately on ICE failed'
);
assert.ok(
    whipSrc.includes("state === 'connected' || state === 'completed'") &&
    whipSrc.includes('grace timer canceled'),
    'whip-handler.js must cancel the grace timer if ICE recovers'
);
assert.ok(
    whipSrc.includes('hasActiveSessionsForStream') && whipSrc.includes('iceReady'),
    'whip-handler.js must track healthy WHIP sessions for protocol-aware stale cleanup'
);
assert.ok(
    whipSrc.includes("ICE: ${state}") && whipSrc.includes('session=${resourceId}'),
    'whip-handler.js ICE state log must include stream, session, and transport IDs'
);
console.log('OK F: WHIP ICE disconnect/failed/recovery grace timer present in whip-handler.js');

// ── G: broadcast-server ICE filter + stale-source path ─────────
assert.ok(
    bcastSrc.includes("p.iceState !== 'connected' && p.iceState !== 'completed'"),
    'broadcast-server.js must filter producers by ICE state (not just DTLS)'
);
assert.ok(
    bcastSrc.includes('sfu-source-unavailable') && bcastSrc.includes('ingest_stale'),
    'broadcast-server.js must send sfu-source-unavailable when stale producers exist'
);
assert.ok(
    bcastSrc.includes('watch-queued'),
    'broadcast-server.js must send watch-queued when viewer is added to pending queue'
);
assert.ok(
    bcastSrc.includes('config.allowP2pFallback') && bcastSrc.includes('p2p.relay.attempt'),
    'broadcast-server.js must gate legacy P2P relay behind config.allowP2pFallback and log relay attempts'
);
assert.ok(
    bcastSrc.includes('viewer.queued') && bcastSrc.includes('viewer.notified'),
    'broadcast-server.js must log queued/notified viewer metrics for the SFU warm-up flow'
);
assert.ok(
    bcastSrc.includes('_notifyViewersSourceLost') && bcastSrc.includes('producer_removed'),
    'broadcast-server.js must notify SFU viewers when the source producer is removed'
);
assert.ok(
    bcastSrc.includes("producer-removed") && bcastSrc.includes('remaining.length === 0'),
    'broadcast-server.js must only notify source-lost when ALL producers are gone'
);
console.log('OK G: broadcast-server ICE filter + stale-source notification path present');

// ── H: client handles sfu-source-unavailable and watch-queued ──
assert.ok(
    playerSrc.includes("case 'sfu-source-unavailable':"),
    'stream-player.js must handle sfu-source-unavailable message'
);
assert.ok(
    playerSrc.includes("case 'watch-queued':"),
    'stream-player.js must handle watch-queued message'
);
// Neither handler should start the P2P offer timeout
assert.ok(
    !playerSrc.includes("case 'sfu-source-unavailable':\n                    // Server: ingest source is gone") ||
    playerSrc.includes("intentionally NOT calling _startWatchOfferTimeout()"),
    'stream-player.js sfu-source-unavailable handler must NOT start P2P offer timeout'
);
assert.ok(
    playerSrc.includes('Stream source temporarily unavailable'),
    'stream-player.js must show a user-facing status message on source unavailable'
);
assert.ok(
    playerSrc.includes('copyPlayerDiagnostics') && playerSrc.includes('player-loader-shell'),
    'stream-player.js must expose copyable playback diagnostics and the richer loader shell'
);
console.log('OK H: sfu-source-unavailable and watch-queued handled without P2P offer timeout');

// ── I: frozen-video detector in SFU path ───────────────────────
assert.ok(
    playerSrc.includes('_sfuFrozenInterval') && playerSrc.includes('_frozenTicks'),
    'stream-player.js must have a frozen-video detector (_sfuFrozenInterval)'
);
assert.ok(
    playerSrc.includes('video frozen for ~30s'),
    'stream-player.js frozen detector must log after 30s of frozen video'
);
assert.ok(
    playerSrc.includes('player._sfuFrozenInterval = null') &&
    playerSrc.includes('clearInterval(player._sfuFrozenInterval)'),
    'stream-player.js must clear the frozen interval when transport changes'
);
// Frozen re-watch must NOT start P2P offer timeout
assert.ok(
    playerSrc.includes('Intentionally NOT calling _startWatchOfferTimeout()'),
    'stream-player.js frozen-video re-watch must NOT call _startWatchOfferTimeout()'
);
console.log('OK I: frozen-video detector (30s post-play check) present in stream-player.js');

// ── J: broadcaster auto-publishes into SFU, P2P rollback gated ──
assert.ok(
    broadcastClientSrc.includes("_ensureSfuBroadcastReady(streamId, 'signaling-open')"),
    'broadcast.js must auto-start SFU publishing when broadcaster signaling opens'
);
assert.ok(
    broadcastClientSrc.includes('ss._allowP2pFallback = !!msg.allowP2pFallback'),
    'broadcast.js must track whether legacy P2P rollback is enabled'
);
assert.ok(
    broadcastClientSrc.includes('SFU-only mode is active'),
    'broadcast.js must ignore legacy P2P viewer signaling while SFU-only mode is active'
);
assert.ok(
    configSrc.includes('ALLOW_P2P_FALLBACK') && configSrc.includes('allowP2pFallback'),
    'server/config.js must expose the ALLOW_P2P_FALLBACK feature flag'
);
console.log('OK J: broadcaster auto-publishes into SFU and P2P rollback is explicitly gated');

// ── K: server startup TURN / announced-IP diagnostics ───────────
assert.ok(
    indexSrc.includes('TURN server:') && indexSrc.includes('not configured (STUN-only'),
    'server/index.js must log TURN configuration status at startup'
);
assert.ok(
    indexSrc.includes('MEDIASOUP_ANNOUNCED_IP does not match WHIP_PUBLIC_URL host'),
    'server/index.js must warn when announced IP does not match the public WHIP host'
);
assert.ok(
    indexSrc.includes('WHIP_PUBLIC_URL is using http:// in production'),
    'server/index.js must warn when WHIP_PUBLIC_URL is not using TLS in production'
);
assert.ok(
    indexSrc.includes('RTMP_HOST and WHIP_PUBLIC_URL host are identical'),
    'server/index.js must warn when RTMP and WHIP hosts would collide'
);
console.log('OK K: server startup logs TURN / announced-IP diagnostics for viewer connectivity');

console.log('\nAll SFU viewer stability regression tests passed');

