/**
 * OpenVibe.Live — WHIP (WebRTC-HTTP Ingestion Protocol) Handler
 *
 * Implements WHIP endpoint for OBS and other WHIP-compatible encoders.
 * RFC 9725 compliant: POST (offer→answer), PATCH (trickle), DELETE (terminate).
 *
 * Also provides SDP ↔ Mediasoup bridging utilities for SFU viewer consumption
 * so web viewers can watch WHIP streams through the standard broadcast signaling.
 */

const crypto = require('crypto');
const config = require('../config');
const webrtcSFU = require('./webrtc-sfu');
const { verifyToken, resolveNetworkUser } = require('../auth/auth');
const db = require('../db/database');
const recorder = require('./recorder');
const { notifyDiscordGoLive } = require('../integrations/discord-webhook');

let chatRelayService;
try { chatRelayService = require('../integrations/chat-relay-service'); } catch {}

let robotStreamerService;
try { robotStreamerService = require('../integrations/robotstreamer-service'); } catch {}

let sdpTransform;
try {
    sdpTransform = require('sdp-transform');
} catch {
    console.warn('[WHIP] sdp-transform not installed — WHIP endpoint disabled');
}

// Active WHIP ingestion sessions: resourceId → session info
const sessions = new Map();

function generateResourceId() {
    return crypto.randomBytes(16).toString('hex');
}

function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function buildWhipResourceUrl(req, streamId, resourceId) {
    const baseUrl = normalizeOrigin(config.whip?.publicUrl || config.webrtc?.publicUrl || config.baseUrl) || `${req.protocol}://${req.get('host')}`;
    try {
        return new URL(`/whip/${streamId}/${resourceId}`, baseUrl).toString();
    } catch {
        return `/whip/${streamId}/${resourceId}`;
    }
}

function buildWhipResponseHeaders(req, streamId, resourceId) {
    return {
        Location: buildWhipResourceUrl(req, streamId, resourceId),
        'Access-Control-Expose-Headers': 'Location',
    };
}

function sendWhipError(res, status, code, message) {
    res.status(status)
        .set('X-WHIP-ERROR', code)
        .json({ error: message, error_code: code });
}

function logWhipStage(stage, streamId, info = {}) {
    const details = Object.entries(info)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    console.log(`[WHIP] [${stage}] stream=${streamId} ${details}`);
}

function findSessionsByStreamId(streamId) {
    const matches = [];
    for (const [resourceId, session] of sessions.entries()) {
        if (session.streamId === streamId) matches.push({ resourceId, session });
    }
    return matches;
}

const _WHIP_KEEPALIVE_INTERVAL_MS = 30000;

function cleanupExistingSessionsForStream(streamId) {
    for (const { resourceId } of findSessionsByStreamId(streamId)) {
        console.log(`[WHIP] Cleaning existing WHIP session ${resourceId} for stream ${streamId}`);
        cleanupSession(resourceId, { endStreamIfNoActiveSessions: false, reason: 'replace' });
    }
}

function touchWhipHeartbeat(streamId, reason = 'whip_session') {
    if (!streamId) return;
    db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
    console.log(`[WHIP] Refreshed heartbeat for stream ${streamId} via ${reason}`);
}

function hasActiveSessionsForStream(streamId) {
    return findSessionsByStreamId(streamId).some(session => session.iceReady === true);
}

function ensureWhipHeartbeatTimer(session) {
    if (!session || session.heartbeatTimer || !session.iceReady) return;
    session.heartbeatTimer = setInterval(() => {
        if (!sessions.has(session.resourceId) || !session.iceReady) {
            if (session.heartbeatTimer) {
                clearInterval(session.heartbeatTimer);
                session.heartbeatTimer = null;
            }
            return;
        }
        touchWhipHeartbeat(session.streamId, 'whip_keepalive');
    }, _WHIP_KEEPALIVE_INTERVAL_MS);
}

function endActiveWhipStream(streamId, reason = 'whip_cleanup') {
    const stream = db.getStreamById(streamId);
    if (!stream || !stream.is_live) return;

    console.log(`[WHIP] Ending live stream ${streamId} due to WHIP session termination (${reason})`);
    try {
        db.endStream(streamId);
    } catch (err) {
        console.error(`[WHIP] Failed to end stream ${streamId}:`, err.message);
    }

    try { db.computeAndCacheStreamAnalytics(streamId); } catch (err) { /* ignore */ }

    try {
        if (!recorder.isFinalizingStream(streamId)) {
            recorder.finalizeStream(streamId).catch(err => {
                console.warn(`[VOD] Finalization failed for WHIP stream ${streamId}:`, err.message);
            });
        }
    } catch (err) {
        console.warn('[VOD] WHIP end stream finalize helper failed:', err.message);
    }

    try {
        const restreamManager = require('./restream-manager');
        restreamManager.stopAllForStream(streamId);
    } catch (err) { /* ignore */ }

    try { if (robotStreamerService) robotStreamerService.stopForStream(streamId); } catch (err) { /* ignore */ }
    try { if (chatRelayService) chatRelayService.stopForStream(streamId); } catch (err) { /* ignore */ }
    try { require('../integrations/ai-chatbot-service').stopForStream(streamId); } catch (err) { /* ignore */ }
    try { require('./broadcast-server').endStream(streamId); } catch (err) { /* ignore */ }
    try { webrtcSFU.closeRoom(`stream-${streamId}`); } catch (err) { /* ignore */ }
    try { require('./call-server').removeStreamChannel(streamId); } catch (err) { /* ignore */ }
}

// ── SDP Parsing Utilities ────────────────────────────────────

/**
 * Extract DTLS parameters from a parsed SDP object.
 */
function getDtlsSetupAttribute(sdpObj) {
    if (sdpObj.setup) return String(sdpObj.setup).toLowerCase();

    for (const media of sdpObj.media || []) {
        if (media.setup) return String(media.setup).toLowerCase();
    }

    return null;
}

function selectDtlsFingerprint(fingerprints) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
        throw new Error('No DTLS fingerprints available');
    }

    const normalized = fingerprints.map(fp => ({
        algorithm: String(fp.algorithm || '').toLowerCase(),
        fingerprint: fp,
    }));

    const preferred = ['sha-256', 'sha-1'];
    for (const algorithm of preferred) {
        const match = normalized.find(item => item.algorithm === algorithm);
        if (match) return match.fingerprint;
    }

    return fingerprints[0];
}

function extractDtlsParameters(sdpObj) {
    let fingerprint = sdpObj.fingerprint;
    let setup = getDtlsSetupAttribute(sdpObj);

    for (const media of sdpObj.media || []) {
        if (!fingerprint && media.fingerprint) fingerprint = media.fingerprint;
    }

    if (!fingerprint) throw new Error('No DTLS fingerprint in SDP');

    // In mediasoup, transport.connect() expects the remote endpoint's DTLS role.
    // WHIP clients/encoders are typically DTLS clients, so an offer with
    // setup=actpass or setup=active means the remote side will act as client.
    // If the offer explicitly uses setup=passive, the remote side is the DTLS
    // server and we must connect as the client.
    let role = 'client';
    if (setup === 'passive') {
        role = 'server';
    }

    return {
        role,
        fingerprints: [{
            algorithm: fingerprint.type,
            value: fingerprint.hash,
        }],
    };
}

/**
 * Extract RTP parameters from an SDP media section.
 * Matches codecs against the Mediasoup router's capabilities.
 */
function getH264ProfileIdc(profileLevelId) {
    const profile = String(profileLevelId || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(profile) || profile.length < 2) return null;
    return profile.slice(0, 2);
}

function normalizeH264ProfileLevelId(offeredParams, routerParams) {
    const offProfileIdc = getH264ProfileIdc(offeredParams?.['profile-level-id']);
    const rcProfileIdc = getH264ProfileIdc(routerParams?.['profile-level-id']);
    if (!offProfileIdc || !rcProfileIdc || offProfileIdc !== rcProfileIdc) return false;
    if (routerParams?.['profile-level-id']) {
        offeredParams['profile-level-id'] = routerParams['profile-level-id'];
    }
    return true;
}

function extractRtpParameters(media, routerCapabilities, mediaIndex = 0) {
    if (!media || !media.type) return null;

    const routerCodecs = routerCapabilities.codecs || [];
    const codecs = [];
    const headerExtensions = [];
    const encodings = [];

    // Build rtpmap lookup: payloadType → codec info
    const rtpmaps = {};
    for (const rtp of media.rtp || []) {
        rtpmaps[rtp.payload] = {
            mimeType: `${media.type}/${rtp.codec}`,
            payloadType: rtp.payload,
            clockRate: rtp.rate,
            channels: rtp.encoding || undefined,
            parameters: {},
            rtcpFeedback: [],
        };
    }

    // Parse fmtp parameters
    for (const fmtp of media.fmtp || []) {
        if (rtpmaps[fmtp.payload] && fmtp.config) {
            const params = {};
            for (const part of fmtp.config.split(';')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    const val = trimmed.slice(eqIdx + 1).trim();
                    if (key === 'profile-level-id' || key === 'sprop-parameter-sets' || key === 'level-asymmetry-allowed') {
                        params[key] = val;
                    } else {
                        params[key] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
                    }
                }
            }
            rtpmaps[fmtp.payload].parameters = params;
        }
    }

    // Parse rtcp-fb
    for (const fb of media.rtcpFb || []) {
        if (rtpmaps[fb.payload]) {
            rtpmaps[fb.payload].rtcpFeedback.push({
                type: fb.type,
                parameter: fb.subtype || '',
            });
        }
    }

    // Match offered codecs against router capabilities
    const payloads = (media.payloads || '').toString().split(' ').map(Number).filter(n => !isNaN(n));
    let primaryCodec = null;

    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;

        if (offered.mimeType.toLowerCase().endsWith('/rtx')) continue;

        const match = routerCodecs.find(rc => {
            if (rc.mimeType.toLowerCase() !== offered.mimeType.toLowerCase()) return false;
            if (rc.clockRate !== offered.clockRate) return false;
            if (offered.channels && rc.channels && offered.channels !== rc.channels) return false;
            if (rc.mimeType.toLowerCase() === 'video/h264') {
                const rcProfileIdc = getH264ProfileIdc(rc.parameters?.['profile-level-id']);
                const offProfileIdc = getH264ProfileIdc(offered.parameters?.['profile-level-id']);
                if (rcProfileIdc && offProfileIdc && rcProfileIdc !== offProfileIdc) return false;
                if (rcProfileIdc && offProfileIdc) {
                    normalizeH264ProfileLevelId(offered.parameters, rc.parameters || {});
                }
            }
            return true;
        });

        if (match) {
            primaryCodec = offered;
            codecs.push(offered);
            break;
        }
    }

    if (!primaryCodec) return null;

    // Add RTX codec if present for the primary codec
    for (const pt of payloads) {
        const offered = rtpmaps[pt];
        if (!offered) continue;
        if (offered.mimeType.toLowerCase() === `${media.type}/rtx` && offered.parameters?.apt === primaryCodec.payloadType) {
            codecs.push(offered);
            break;
        }
    }

    // Header extensions: match against router capabilities
    for (const ext of media.ext || []) {
        const routerExt = (routerCapabilities.headerExtensions || []).find(re =>
            re.uri === ext.uri && (re.kind === media.type || !re.kind)
        );
        if (routerExt) {
            headerExtensions.push({
                uri: ext.uri,
                id: ext.value,
                encrypt: false,
                parameters: {},
            });
        }
    }

    function getSsrcEntries() {
        if (Array.isArray(media.ssrcs)) return media.ssrcs.filter(Boolean);
        if (media.ssrc) return [media.ssrc];
        return [];
    }

    function normalizeSsrc(value) {
        if (value === undefined || value === null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : String(value);
    }

    const ssrcCandidates = getSsrcEntries();
    const mainSsrc = ssrcCandidates.find(s => s.attribute === 'cname')?.id || ssrcCandidates[0]?.id;
    let encoding = null;

    if (mainSsrc) {
        encoding = { ssrc: normalizeSsrc(mainSsrc) };
        const fidGroup = (media.ssrcGroups || []).find(g => g.semantics === 'FID' || g.semantics === 'fid');
        if (fidGroup && typeof fidGroup.ssrcs === 'string') {
            const parts = fidGroup.ssrcs.split(' ').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && String(normalizeSsrc(parts[0])) === String(encoding.ssrc)) {
                encoding.rtx = { ssrc: normalizeSsrc(parts[1]) };
            }
        }
    } else if (Array.isArray(media.rids) && media.rids.length > 0) {
        const ridValue = media.rids[0]?.id || media.rids[0];
        if (ridValue) encoding = { rid: String(ridValue) };
    } else if (media.rid) {
        encoding = { rid: String(media.rid) };
    }

    if (!encoding) {
        const error = new Error('No RTP encoding found in SDP media section');
        error.code = 'invalid_rtp_encoding';
        error.mediaType = media.type;
        error.mid = media.mid != null ? String(media.mid) : String(mediaIndex);
        throw error;
    }

    encodings.push(encoding);

    const rtpParameters = { codecs, headerExtensions, encodings };
    rtpParameters.mid = media.mid != null ? String(media.mid) : String(mediaIndex);
    return rtpParameters;
}

// ── SDP Answer/Offer Building ────────────────────────────────

/**
 * Build an SDP answer for a WHIP ingestion (server recvonly).
 */
function buildSdpAnswer(transport, offerSdp, producersByKind) {
    const { iceParameters, iceCandidates, dtlsParameters } = transport;
    const fingerprint = selectDtlsFingerprint(dtlsParameters.fingerprints);
    const setup = getDtlsSetupAttribute(offerSdp) === 'passive' ? 'active' : 'passive';
    const mids = [];

    const serverAddress = iceCandidates?.[0]?.ip || config.mediasoup.announcedIp || '127.0.0.1';
    const sdpObj = {
        version: 0,
        origin: { username: '-', sessionId: String(Date.now()), sessionVersion: 2, netType: 'IN', ipVer: 4, address: serverAddress },
        name: 'OpenVibe.Live',
        timing: { start: 0, stop: 0 },
        icelite: 'ice-lite',
        groups: [],
        msidSemantic: { semantic: 'WMS', token: '*' },
        media: [],
    };

    for (const offerMedia of offerSdp.media || []) {
        const mid = offerMedia.mid != null ? String(offerMedia.mid) : String(mids.length);
        mids.push(mid);

        const producer = producersByKind[offerMedia.type];
        if (!producer) {
            sdpObj.media.push({
                type: offerMedia.type,
                port: 0,
                protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
                payloads: '0',
                mid,
                direction: 'inactive',
            });
            continue;
        }

        const answerMedia = {
            type: offerMedia.type,
            port: 9,
            protocol: offerMedia.protocol || 'UDP/TLS/RTP/SAVPF',
            payloads: '',
            connection: { ip: '0.0.0.0', version: 4 },
            mid,
            iceUfrag: iceParameters.usernameFragment,
            icePwd: iceParameters.password,
            fingerprint: { type: fingerprint.algorithm, hash: fingerprint.value },
            setup,
            direction: 'recvonly',
            rtcpMux: 'rtcp-mux',
            rtp: [],
            fmtp: [],
            rtcpFb: [],
            ext: [],
            candidates: iceCandidates.map(c => {
                const cand = {
                    foundation: c.foundation,
                    component: 1,
                    transport: c.protocol.toUpperCase(),
                    priority: c.priority,
                    ip: c.ip,
                    port: c.port,
                    type: c.type,
                };
                if (c.tcpType) cand.tcptype = c.tcpType;
                return cand;
            }),
        };

        const pts = [];
        for (const codec of producer.rtpParameters.codecs) {
            pts.push(codec.payloadType);
            answerMedia.rtp.push({
                payload: codec.payloadType,
                codec: codec.mimeType.split('/')[1],
                rate: codec.clockRate,
                encoding: codec.channels,
            });
            if (codec.parameters && Object.keys(codec.parameters).length > 0) {
                answerMedia.fmtp.push({
                    payload: codec.payloadType,
                    config: Object.entries(codec.parameters).map(([k, v]) => `${k}=${v}`).join(';'),
                });
            }
            for (const fb of codec.rtcpFeedback || []) {
                answerMedia.rtcpFb.push({
                    payload: codec.payloadType,
                    type: fb.type,
                    subtype: fb.parameter || undefined,
                });
            }
        }
        answerMedia.payloads = pts.join(' ');

        for (const ext of producer.rtpParameters.headerExtensions || []) {
            answerMedia.ext.push({ value: ext.id, uri: ext.uri });
        }

        sdpObj.media.push(answerMedia);
    }

    if (mids.length > 0) {
        sdpObj.groups.push({ type: 'BUNDLE', mids: mids.join(' ') });
    }

    return sdpTransform.write(sdpObj);
}

// ── WHIP HTTP Handlers ───────────────────────────────────────

/**
 * Auto-create a live stream session for WHIP, mirroring RTMP prePublish behavior.
 * Returns the newly created stream record, or null on failure.
 */
function autoCreateWhipSession(managedStream, user) {
    try {
        db.ensureChannel(user.id);
        const result = db.createStream({
            user_id: user.id,
            managed_stream_id: managedStream.id,
            title: managedStream.title || `${user.display_name || user.username}'s Stream`,
            description: managedStream.description || '',
            category: managedStream.category || 'irl',
            protocol: 'webrtc',
            is_nsfw: managedStream.is_nsfw || 0,
        });
        const streamId = result.lastInsertRowid;
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
        db.run(`INSERT INTO cameras (stream_id, camera_index, label, protocol) VALUES (?, 0, 'Main', 'webrtc')`, [streamId]);

        // Apply control config
        const channel = db.getChannelByUserId(user.id);
        const configId = managedStream.control_config_id || (channel && channel.active_control_config_id);
        if (configId) {
            try { db.applyConfigToStream(configId, streamId); } catch {}
        }

        const stream = db.getStreamById(streamId);
        console.log(`[WHIP] Auto-created live session ${streamId} for WHIP slot ${managedStream.id} (user: ${user.username})`);

        // Fire-and-forget side effects
        notifyDiscordGoLive(user, stream || { id: streamId });
        try { require('./live-events').announceGoLive(stream || { id: streamId }, user); } catch { /* */ }
        if (chatRelayService) {
            chatRelayService.startForStream(stream).catch(() => {});
        }
        try { require('../integrations/ai-chatbot-service').startForStream(stream); } catch { /* non-critical */ }
        setTimeout(() => {
            const mode = db.resolveStreamRecordingMode(stream || db.getStreamById(streamId));
            if (mode !== 'none') {
                recorder.startRecording(streamId, 'webrtc', {}, { mode });
            }
        }, 2000);

        return stream;
    } catch (err) {
        console.error('[WHIP] Failed to auto-create session:', err.message);
        return null;
    }
}

/**
 * POST /whip/:streamId — WHIP offer → answer
 *
 * Supports two auth models:
 *   1. Stream-key auth (OBS / external WHIP encoders):
 *      - Path param is the managed stream's stream_key (hex string)
 *      - Bearer token (optional, OBS sends it) must match the same key
 *      - Server looks up managed_stream → finds live session
 *   2. JWT Bearer auth (legacy / internal):
 *      - Path param is the numeric stream session ID
 *      - Bearer token is a valid JWT
 */
async function handleWhipPost(req, res) {
    if (!sdpTransform) {
        return sendWhipError(res, 503, 'whip_unavailable', 'WHIP not available (sdp-transform not installed)');
    }

    try {
        const pathParam = req.params.streamId;
        const authHeader = req.headers.authorization;
        const bearerToken = (authHeader && authHeader.startsWith('Bearer '))
            ? authHeader.slice(7).trim()
            : null;

        let stream = null;
        let userId = null;

        // ── Auth strategy 1: stream-key-based (hex key in path) ──
        // OBS WHIP sends stream key both in the URL path and as Bearer token.
        // A hex string ≥16 chars that isn't purely numeric → treat as stream key.
        const isStreamKey = /^[0-9a-f]{16,}$/i.test(pathParam) && !/^\d+$/.test(pathParam);

        // ── Auth strategy 2: slot numeric ID + key auth ──
        // Path: /whip/:slotId with Bearer token = stream key or ?key= query param.
        const isSlotId = /^\d+$/.test(pathParam);
        const keyParam = req.query?.key || null;

        if (isStreamKey) {
            const managedStream = db.getManagedStreamByStreamKey(pathParam);
            if (!managedStream) {
                logWhipStage('auth_key_fail', pathParam, { reason: 'stream_key_not_found' });
                return sendWhipError(res, 401, 'invalid_stream_key', 'Stream key not recognized');
            }

            // If Bearer token was sent (OBS does this), verify it matches the key
            if (bearerToken && bearerToken !== pathParam) {
                logWhipStage('auth_key_fail', pathParam, { reason: 'bearer_mismatch' });
                return sendWhipError(res, 401, 'bearer_mismatch', 'Bearer token does not match stream key');
            }

            userId = managedStream.user_id;
            logWhipStage('auth_key', pathParam, { user_id: userId, managed_stream_id: managedStream.id });

            // Find a live session on this managed stream
            const liveSessions = db.getLiveStreamsByUserId(managedStream.user_id) || [];
            stream = liveSessions.find(s => s.managed_stream_id === managedStream.id);

            if (!stream) {
                // Auto-create session (like RTMP prePublish)
                const user = db.getUserById(managedStream.user_id);
                if (!user) {
                    return sendWhipError(res, 401, 'user_not_found', 'Stream owner not found');
                }
                if (user.is_banned) {
                    return sendWhipError(res, 403, 'user_banned', 'Account is banned');
                }
                logWhipStage('auto_create', pathParam, { managed_stream_id: managedStream.id });
                stream = autoCreateWhipSession(managedStream, user);
                if (!stream) {
                    return sendWhipError(res, 500, 'session_create_failed', 'Failed to auto-create stream session');
                }
            }
            // Dedup: end any other stale live session on this slot (keep this one) so
            // "going live twice" doesn't leave a broken duplicate tab.
            try {
                const ended = db.endOtherLiveStreamsForSlot(managedStream.id, stream.id);
                if (ended.length) {
                    console.log(`[WHIP] Ended ${ended.length} stale duplicate session(s) on slot ${managedStream.id}: ${ended.join(',')}`);
                    for (const sid of ended) { try { require('./broadcast-server').endStream(sid); } catch { /* */ } }
                }
            } catch { /* non-critical */ }
            if (stream.protocol !== 'webrtc') {
                logWhipStage('auth_key_fail', pathParam, { reason: 'wrong_protocol', protocol: stream.protocol });
                return sendWhipError(res, 409, 'wrong_protocol',
                    `Stream protocol is ${stream.protocol}, not webrtc — change the streaming method to Browser/WHIP in the stream manager`);
            }
        }
        // ── Auth strategy 2: slot numeric ID + key (Bearer or ?key= query) ──
        else if (isSlotId && (bearerToken || keyParam)) {
            const slotId = parseInt(pathParam, 10);
            const streamKey = keyParam || bearerToken;

            // First try: slot ID + key
            const managedStream = db.getManagedStreamById(slotId);
            if (!managedStream) {
                logWhipStage('auth_slot_fail', pathParam, { reason: 'slot_not_found' });
                return sendWhipError(res, 404, 'slot_not_found', 'Stream slot not found');
            }

            // Verify key matches slot's stream key
            if (managedStream.stream_key !== streamKey) {
                // If the Bearer is a JWT, fall through to JWT auth below
                const decoded = verifyToken(bearerToken);
                if (decoded) {
                    const user = resolveNetworkUser(decoded);
                    if (user) {
                        userId = user.id;
                        // Find live session for this slot owned by this user
                        const liveSessions = db.getLiveStreamsByUserId(user.id) || [];
                        stream = liveSessions.find(s => s.managed_stream_id === slotId);
                        if (!stream) {
                            // Auto-create session
                            logWhipStage('auto_create_jwt', pathParam, { slot_id: slotId });
                            stream = autoCreateWhipSession(managedStream, user);
                            if (!stream) return sendWhipError(res, 500, 'session_create_failed', 'Failed to auto-create stream session');
                        }
                        if (stream.protocol !== 'webrtc') return sendWhipError(res, 409, 'wrong_protocol', `Stream protocol is ${stream.protocol}, not webrtc`);
                        logWhipStage('auth_slot_jwt', pathParam, { user_id: userId, slot_id: slotId });
                    } else {
                        return sendWhipError(res, 401, 'invalid_key', 'Stream key or token does not match');
                    }
                } else {
                    logWhipStage('auth_slot_fail', pathParam, { reason: 'key_mismatch' });
                    return sendWhipError(res, 401, 'invalid_key', 'Stream key does not match this slot');
                }
            }

            if (!stream) {
                userId = managedStream.user_id;
                logWhipStage('auth_slot_key', pathParam, { user_id: userId, slot_id: slotId });

                const liveSessions = db.getLiveStreamsByUserId(managedStream.user_id) || [];
                stream = liveSessions.find(s => s.managed_stream_id === slotId);

                if (!stream) {
                    // Auto-create session
                    const user = db.getUserById(managedStream.user_id);
                    if (!user) return sendWhipError(res, 401, 'user_not_found', 'Stream owner not found');
                    if (user.is_banned) return sendWhipError(res, 403, 'user_banned', 'Account is banned');
                    logWhipStage('auto_create', pathParam, { slot_id: slotId });
                    stream = autoCreateWhipSession(managedStream, user);
                    if (!stream) return sendWhipError(res, 500, 'session_create_failed', 'Failed to auto-create stream session');
                }
                if (stream.protocol !== 'webrtc') {
                    return sendWhipError(res, 409, 'wrong_protocol',
                        `Stream protocol is ${stream.protocol}, not webrtc`);
                }
            }
        }
        // ── Auth strategy 3: JWT Bearer (legacy numeric stream ID) ──
        else {
            if (!bearerToken) {
                logWhipStage('auth_fail', pathParam, { reason: 'no_bearer_token' });
                return res.status(401)
                    .set('WWW-Authenticate', 'Bearer')
                    .set('X-WHIP-ERROR', 'authentication_required')
                    .json({ error: 'Bearer token required', error_code: 'authentication_required' });
            }

            const decoded = verifyToken(bearerToken);
            if (!decoded) {
                logWhipStage('auth_fail', pathParam, { reason: 'invalid_jwt' });
                return sendWhipError(res, 401, 'invalid_token', 'Invalid or expired token');
            }
            const user = resolveNetworkUser(decoded);
            if (!user) {
                logWhipStage('auth_fail', pathParam, { reason: 'user_not_found' });
                return sendWhipError(res, 401, 'user_not_found', 'User not found');
            }
            userId = user.id;

            const streamId = parseInt(pathParam, 10);
            if (!streamId || isNaN(streamId)) {
                logWhipStage('auth_fail', pathParam, { reason: 'invalid_stream_id' });
                return sendWhipError(res, 400, 'invalid_stream_id', 'Invalid stream ID');
            }
            stream = db.getStreamById(streamId);
            if (!stream) return sendWhipError(res, 404, 'stream_not_found', 'Stream not found');
            if (stream.user_id !== user.id && user.role !== 'admin') {
                return sendWhipError(res, 403, 'not_your_stream', 'Not your stream');
            }
            if (!stream.is_live) return sendWhipError(res, 409, 'stream_not_live', 'Stream is not live — go live first');
            if (stream.protocol !== 'webrtc') return sendWhipError(res, 409, 'wrong_protocol', 'Stream protocol must be webrtc for WHIP');
            logWhipStage('auth_jwt', pathParam, { user_id: userId });
        }

        const streamId = stream.id;
        if (!webrtcSFU.ready) return sendWhipError(res, 503, 'sfu_unavailable', 'WebRTC SFU unavailable');
        logWhipStage('stream_validation', streamId, { protocol: stream.protocol, live: stream.is_live });

        cleanupExistingSessionsForStream(streamId);

        // Parse SDP offer
        const offerSdpStr = req.body;
        if (!offerSdpStr || typeof offerSdpStr !== 'string') {
            return sendWhipError(res, 400, 'missing_sdp', 'Missing SDP offer in request body');
        }

        let offerSdp;
        try {
            offerSdp = sdpTransform.parse(offerSdpStr);
        } catch (err) {
            console.warn('[WHIP] Invalid SDP offer:', err.message);
            return sendWhipError(res, 400, 'invalid_sdp', 'Invalid SDP offer');
        }

        const offerCandidateSummary = (offerSdp.media || []).map(media => {
            const count = Array.isArray(media.candidates) ? media.candidates.length : 0;
            return `${media.type || 'unknown'}=${count}`;
        }).join(', ');
        console.log(`[WHIP] offer candidate counts for stream ${streamId}: ${offerCandidateSummary}`);

        const roomId = `stream-${streamId}`;
        const room = await webrtcSFU.getOrCreateRoom(roomId);
        logWhipStage('room_creation', streamId, { roomId });

        const resourceId = generateResourceId();
        const peerId = `whip-${resourceId}`;

        const session = {
            streamId,
            roomId,
            peerId,
            transportId: null,
            producerIds: [],
            userId,
            createdAt: Date.now(),
            resourceId,
            iceReady: false,
            heartbeatTimer: null,
        };
        sessions.set(resourceId, session);
        touchWhipHeartbeat(streamId, 'whip_post');

        let transportInfo;
        try {
            // Disable ICE consent timeout for WHIP ingest — OBS/libdatachannel
            // WHIP clients do not respond to RFC 7675 consent freshness checks,
            // causing mediasoup to mark ICE as disconnected after 30 s (the default).
            transportInfo = await webrtcSFU.createTransport(roomId, peerId, { iceConsentTimeout: 0 });
        } catch (err) {
            console.warn('[WHIP] Transport creation failed for stream', streamId, err.message);
            cleanupSession(resourceId);
            logWhipStage('transport_creation', streamId, { success: false, error: err.message });
            return sendWhipError(res, 502, 'transport_creation_failed', 'WHIP transport creation failed');
        }

        session.transportId = transportInfo.id;
        const transport = room.transports.get(`${peerId}-${transportInfo.id}`);
        if (!transport) {
            console.error(`[WHIP] Transport missing after createTransport for stream ${streamId}, transport ${transportInfo.id}`);
            cleanupSession(resourceId);
            return sendWhipError(res, 502, 'transport_creation_failed', 'WHIP transport creation failed');
        }
        logWhipStage('transport_creation', streamId, { transportId: transportInfo.id });

        try {
            const dtlsParams = extractDtlsParameters(offerSdp);
            await webrtcSFU.connectTransport(roomId, peerId, transportInfo.id, dtlsParams);
            console.log(`[WHIP] DTLS parameters accepted for stream ${streamId}, transport ${transportInfo.id}, remote_role=${dtlsParams.role}`);
        } catch (err) {
            console.warn('[WHIP] DTLS negotiation failed for stream', streamId, err.message);
            cleanupSession(resourceId);
            logWhipStage('dtls_connect', streamId, { success: false, error: err.message });
            return sendWhipError(res, 502, 'dtls_negotiation_failed', 'DTLS negotiation failed');
        }
        logWhipStage('dtls_connect', streamId, { transportId: transportInfo.id });

        const routerCaps = room.router.rtpCapabilities;
        const producersByKind = {};

        for (const [mediaIndex, media] of (offerSdp.media || []).entries()) {
            if (media.port === 0) continue;

            let rtpParams;
            try {
                rtpParams = extractRtpParameters(media, routerCaps, mediaIndex);
            } catch (err) {
                if (err.code === 'invalid_rtp_encoding') {
                    console.warn('[WHIP] Invalid RTP encoding in SDP:', err.message);
                    logWhipStage('rtp_parse', streamId, { kind: media.type, mid: err.mid, error: err.message });
                    cleanupSession(resourceId);
                    return sendWhipError(res, 400, 'invalid_rtp_encoding', `Invalid RTP encoding for ${media.type}`);
                }
                throw err;
            }

            if (!rtpParams || rtpParams.codecs.length === 0) {
                console.warn(`[WHIP] No compatible codec for ${media.type} in stream ${streamId}`);
                logWhipStage('rtp_parse', streamId, { kind: media.type, success: false });
                continue;
            }
            logWhipStage('rtp_parse', streamId, { kind: media.type, mid: rtpParams.mid, encodings: JSON.stringify(rtpParams.encodings) });

            let producer;
            try {
                producer = await transport.produce({ kind: media.type, rtpParameters: rtpParams });
            } catch (err) {
                console.warn(`[WHIP] Producer creation failed for ${media.type} in stream ${streamId}:`, err.message);
                logWhipStage('producer_creation', streamId, { kind: media.type, success: false, error: err.message });
                cleanupSession(resourceId);
                return sendWhipError(res, 502, 'producer_creation_failed', 'Failed to create media producer');
            }
            logWhipStage('producer_creation', streamId, { kind: media.type, success: true, producerId: producer.id });

            room.producers.set(producer.id, { producer, peerId, transportId: transportInfo.id });
            producersByKind[media.type] = producer;
            session.producerIds.push(producer.id);

            producer.on('transportclose', () => {
                room.producers.delete(producer.id);
                webrtcSFU.emit('producer-removed', { roomId, producerId: producer.id, kind: media.type });
            });

            webrtcSFU.emit('producer-added', { roomId, producerId: producer.id, kind: media.type, peerId });
            console.log(`[WHIP] Producer created: ${producer.id} (${media.type}) for stream ${streamId}`);
        }

        if (session.producerIds.length === 0) {
            cleanupSession(resourceId);
            return sendWhipError(
                res,
                406,
                'no_compatible_codecs',
                'No compatible codecs — router supports VP8, H264, Opus. H265/HEVC is not supported for browser playback on this platform.'
            );
        }

        // Promote user to streamer role on first real feed ingest
        if (userId) {
            db.ensureStreamerRoleOnFeed(userId);
        }

        let answerSdp;
        try {
            answerSdp = buildSdpAnswer(transport, offerSdp, producersByKind);
        } catch (err) {
            console.error('[WHIP] SDP answer generation failed:', err.message);
            cleanupSession(resourceId);
            logWhipStage('answer_generation', streamId, { success: false, error: err.message });
            return sendWhipError(res, 500, 'answer_generation_failed', 'Failed to generate SDP answer');
        }
        logWhipStage('answer_generation', streamId, { producers: session.producerIds.length });

        transport.on('dtlsstatechange', (state) => {
            console.log(`[WHIP] stream=${streamId} session=${resourceId} transport=${transportInfo.id} DTLS: ${state}`);
            if (state === 'closed' || state === 'failed') {
                if (_iceGraceTimer) { clearTimeout(_iceGraceTimer); _iceGraceTimer = null; }
                cleanupSession(resourceId);
            }
        });

        // ICE state monitoring — clean up stale WHIP sessions when ingest connectivity is lost.
        // ICE 'disconnected' is transient (network blip); 'failed' is permanent.
        // Grace timeout gives ICE restart 15 s to recover before tearing down producers.
        let _iceGraceTimer = null;
        transport.on('icestatechange', (state) => {
            console.log(`[WHIP] stream=${streamId} session=${resourceId} transport=${transportInfo.id} ICE: ${state}`);
            if (state === 'failed') {
                if (_iceGraceTimer) { clearTimeout(_iceGraceTimer); _iceGraceTimer = null; }
                console.warn(`[WHIP] ICE failed for stream ${streamId} (session ${resourceId}) — cleaning up`);
                cleanupSession(resourceId);
            } else if (state === 'disconnected') {
                if (!_iceGraceTimer) {
                    console.warn(`[WHIP] ICE disconnected for stream ${streamId} (session ${resourceId}) — starting 15 s grace timer`);
                    _iceGraceTimer = setTimeout(() => {
                        _iceGraceTimer = null;
                        if (!sessions.has(resourceId)) return; // already cleaned up by DTLS or DELETE
                        console.warn(`[WHIP] ICE grace expired for stream ${streamId} (session ${resourceId}) — removing stale session`);
                        cleanupSession(resourceId);
                    }, 15000);
                }
            } else if (state === 'connected' || state === 'completed') {
                if (_iceGraceTimer) {
                    clearTimeout(_iceGraceTimer);
                    _iceGraceTimer = null;
                    console.log(`[WHIP] ICE recovered to '${state}' for stream ${streamId} (session ${resourceId}) — grace timer canceled`);
                }
                if (!session.iceReady) {
                    session.iceReady = true;
                    touchWhipHeartbeat(streamId, 'whip_ice_connected');
                    ensureWhipHeartbeatTimer(session);
                    webrtcSFU.emit('whip-ice-connected', { streamId, roomId, resourceId });
                    console.log(`[WHIP] ICE connected for stream ${streamId} — notifying broadcast server`);

                    // Media is flowing — start the RS integration (chat mirror +
                    // native video publish) and ALL enabled restream destinations.
                    // WHIP broadcasters have no browser session to start these
                    // manually, so an enabled destination means "run it when live".
                    const liveStream = db.getStreamById(streamId);
                    if (liveStream?.is_live) {
                        if (robotStreamerService) {
                            // We're in the WHIP ICE-connected handler → this is a browserless
                            // WHIP ingest. Tell RS to publish natively regardless of the
                            // stored streaming_method (which can be stale/misconfigured).
                            robotStreamerService.startForStream(liveStream, { ingest: 'whip' }).catch((err) => {
                                console.warn(`[WHIP] RS start failed for stream ${streamId}:`, err.message);
                            });
                        }
                        try {
                            const restreamManager = require('./restream-manager');
                            restreamManager.resumeForStream(streamId, liveStream.user_id, {
                                protocol: 'webrtc',
                                streamKey: liveStream.managed_stream_key,
                            }).catch((err) => {
                                console.warn(`[WHIP] Restream resume failed for stream ${streamId}:`, err.message);
                            });
                        } catch (err) {
                            console.warn(`[WHIP] Restream resume error for stream ${streamId}:`, err.message);
                        }
                    }
                }
            }
        });

        console.log(`[WHIP] Session ${resourceId} created for stream ${streamId} (${session.producerIds.length} producer(s))`);
        logWhipStage('response_send', streamId, { resourceId, status: 201 });

        res.status(201)
            .set('Content-Type', 'application/sdp')
            .set(buildWhipResponseHeaders(req, streamId, resourceId))
            .send(answerSdp);

    } catch (err) {
        console.error('[WHIP] POST error:', err.message || err);
        sendWhipError(res, 500, 'internal_server_error', 'WHIP negotiation failed');
    }
}

/**
 * PATCH /whip/:streamId/:resourceId — ICE trickle
 */
function handleWhipPatch(req, res) {
    const { resourceId } = req.params;
    const session = sessions.get(resourceId);
    if (!session) return sendWhipError(res, 404, 'session_not_found', 'Session not found');

    const payload = req.body;
    let patchCandidates = 0;
    if (typeof payload === 'string' && payload.trim().length > 0) {
        try {
            const parsed = sdpTransform.parse(payload);
            patchCandidates = Array.isArray(parsed.media)
                ? parsed.media.reduce((sum, media) => sum + (Array.isArray(media.candidates) ? media.candidates.length : 0), 0)
                : 0;
        } catch (err) {
            console.warn(`[WHIP] Invalid trickle ICE patch for session ${resourceId}:`, err.message);
        }
    }

    if (patchCandidates > 0) {
        touchWhipHeartbeat(session.streamId, 'whip_patch');
    }
    logWhipStage('patch', session.streamId, { resourceId, candidates: patchCandidates });
    // Mediasoup handles ICE internally — acknowledge
    res.status(204).end();
}

/**
 * DELETE /whip/:streamId/:resourceId — End WHIP session
 */
function handleWhipDelete(req, res) {
    const { resourceId } = req.params;
    cleanupSession(resourceId, { endStreamIfNoActiveSessions: true, reason: 'delete' });
    res.status(200).end();
}

/**
 * OPTIONS /whip/* — CORS/discovery
 */
function handleWhipOptions(req, res) {
    res.status(204)
        .set('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS')
        .set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        .set('Access-Control-Expose-Headers', 'Location')
        .end();
}

/**
 * Clean up a WHIP ingestion session.
 */
function cleanupSession(resourceId, { endStreamIfNoActiveSessions = true, reason = null } = {}) {
    const session = sessions.get(resourceId);
    if (!session) return;

    sessions.delete(resourceId);
    if (session.heartbeatTimer) {
        clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = null;
    }

    try {
        const room = webrtcSFU.rooms?.get(session.roomId);
        if (room) {
            for (const pid of session.producerIds) {
                const entry = room.producers.get(pid);
                if (entry) {
                    const kind = entry.producer.kind;
                    try { entry.producer.close(); } catch {}
                    room.producers.delete(pid);
                    // Explicitly notify broadcast-server so SFU viewers learn the source is gone.
                    // (The 'transportclose' event on the producer would fire only if the transport
                    //  is closed *after* the producer — explicit emit is the reliable path.)
                    webrtcSFU.emit('producer-removed', { roomId: session.roomId, producerId: pid, kind });
                }
            }
            const transportKey = `${session.peerId}-${session.transportId}`;
            const transport = room.transports.get(transportKey);
            if (transport) {
                try { transport.close(); } catch {}
                room.transports.delete(transportKey);
            }
        }
        console.log(`[WHIP] Session ${resourceId} cleaned up (stream ${session.streamId})${reason ? ` reason=${reason}` : ''}`);
    } catch (err) {
        console.error(`[WHIP] Cleanup error for ${resourceId}:`, err.message);
    }

    if (endStreamIfNoActiveSessions && !hasActiveSessionsForStream(session.streamId)) {
        endActiveWhipStream(session.streamId, reason || 'session_cleanup');
    }
}

// ── SFU Viewer Support ───────────────────────────────────────
// Viewer consumption is now handled via mediasoup-client signaling in
// broadcast-server.js. The hand-built SDP approach (buildViewerSdpOffer,
// createSfuViewerOffer, handleSfuViewerAnswer, cleanupSfuViewer) has been
// removed in favor of proper Device/RecvTransport on the viewer client.

/**
 * Check if SFU has producers for a given stream.
 */
function hasSfuProducers(streamId) {
    const roomId = `stream-${streamId}`;
    return webrtcSFU.hasProducers(roomId);
}

module.exports = {
    handleWhipPost,
    handleWhipPatch,
    handleWhipDelete,
    handleWhipOptions,
    buildWhipResourceUrl,
    buildWhipResponseHeaders,
    hasSfuProducers,
    hasActiveSessionsForStream,
    sessions,
    cleanupSession,
    available: !!sdpTransform,
    _extractRtpParameters: extractRtpParameters,
    _extractDtlsParameters: extractDtlsParameters,
    _buildSdpAnswer: buildSdpAnswer,
    _selectDtlsFingerprint: selectDtlsFingerprint,
};
