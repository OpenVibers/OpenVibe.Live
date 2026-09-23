const { maskKey, redactUrl } = require('../utils/redact');
/**
 * OpenVibe.Live — RTMP Ingest Server
 * 
 * Accepts RTMP streams from OBS/FFmpeg and converts to HLS or relays.
 * Uses node-media-server for RTMP handling.
 */
const EventEmitter = require('events');
const config = require('../config');
const db = require('../db/database');
const recorder = require('./recorder');
const { notifyDiscordGoLive } = require('../integrations/discord-webhook');

const RTMP_HEARTBEAT_INTERVAL_MS = 30000; // Refresh live stream timestamp while RTMP session is active

let NodeMediaServer;
try {
    NodeMediaServer = require('node-media-server');
} catch {
    console.warn('[RTMP] node-media-server not installed — RTMP streaming disabled');
    console.warn('[RTMP] Install with: npm install node-media-server');
}

class RTMPServer extends EventEmitter {
    constructor() {
        super();
        this.nms = null;
        this.activeStreams = new Map(); // streamKey → { streamId, userId }
    }

    start() {
        if (!NodeMediaServer) {
            console.warn('[RTMP] node-media-server not available, RTMP disabled');
            return;
        }

        const nmsConfig = {
            // ERROR only: the library's info lines print streamPath, i.e. /live/<stream key>, into the
            // journal on every connect/publish/play. Our own [RTMP] lines are redacted.
            logType: 1,
            rtmp: {
                port: config.rtmp.port,
                chunk_size: config.rtmp.chunkSize,
                gop_cache: true,
                ping: 30,
                ping_timeout: 60,
            },
            http: {
                port: config.rtmp.port + 8000, // HTTP-FLV port (9935 by default)
                // Nothing in a browser talks to this port. The web player pulls FLV from
                // /api/streams/:id/flv on the main app, which proxies from 127.0.0.1 here after
                // checking the stream is live and resolving the key; the restreamer's ffmpeg also
                // reads from 127.0.0.1. Neither sends an Origin header or looks at CORS, so a
                // wildcard bought nothing and meant any page anywhere could read this directly if
                // the port were ever reachable.
                //
                // node-media-server 2.7.4 calls httpServer.listen(port) with no host, so this
                // cannot be bound to loopback from config — the port is on every interface by
                // design of the library. It is not reachable from outside today (the provider
                // edge drops it), but that is somebody else's firewall, not ours, so the origin
                // is narrowed here as the part we control.
                allow_origin: config.baseUrl || 'http://127.0.0.1',
                mediaroot: './data/media',
            },
            // NOTE: NMS trans server crashes on v2.7.4 with 'version is not defined'
            // in node_trans_server.js. HTTP-FLV playback works without HLS transcoding.
            // Revisit when NMS releases a fix or after upgrading to a newer version.
            // trans: {
            //     ffmpeg: '/usr/bin/ffmpeg',
            //     tasks: [
            //         {
            //             app: 'live',
            //             hls: true,
            //             hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
            //             hlsKeep: false,
            //             dash: false,
            //         },
            //     ],
            // },
        };

        this.nms = new NodeMediaServer(nmsConfig);

        // ── Auth: Validate stream key on publish ─────────────
        this.nms.on('prePublish', (id, streamPath, args) => {
            console.log(`[RTMP] PrePublish: ${redactUrl(streamPath)} from session ${id}`);
            // Stream path format: /live/STREAM_KEY
            const parts = streamPath.split('/');
            const streamKey = parts[parts.length - 1];

            if (!streamPath.startsWith('/live/') || !/^[a-zA-Z0-9_-]{8,128}$/.test(streamKey)) {
                console.log(`[RTMP] Rejected malformed publish path: ${redactUrl(streamPath)}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const existingActive = this.activeStreams.get(streamKey);
            if (existingActive && existingActive.sessionId !== id) {
                console.log(`[RTMP] Rejected duplicate publisher for stream key ${maskKey(streamKey)}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const user = db.getUserByStreamKey(streamKey);
            // Also check if key belongs to a managed stream
            const managedStream = !user ? db.getManagedStreamByStreamKey(streamKey) : null;
            const resolvedUser = user || (managedStream ? db.getUserById(managedStream.user_id) : null);
            if (!resolvedUser) {
                console.log(`[RTMP] Rejected: invalid stream key ${maskKey(streamKey)}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            if (resolvedUser.is_banned) {
                console.log(`[RTMP] Rejected: banned user ${resolvedUser.username}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            // OpenRe.Stream ingests this slot (managed_streams.ingest_authority = 'openre'): refuse
            // here so one stream can never be ingested twice. Slots on 'live' (the default) are
            // untouched. See server/openre/authority.js.
            if (require('../openre/authority').refusesLiveIngest({ managedStream, user: managedStream ? null : resolvedUser, protocol: 'rtmp' })) {
                console.log(`[RTMP] Rejected: ${managedStream ? `slot ${managedStream.id}` : `personal key of ${resolvedUser.username}`} is ingested by OpenRe`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            // Create or update stream record
            // Look for an existing RTMP stream (created via Go Live page) that's waiting for the RTMP client
            const existingStreams = db.getLiveStreamsByUserId(resolvedUser.id);
            const rtmpStream = existingStreams.find(s => s.protocol === 'rtmp');
            let streamId;
            if (rtmpStream) {
                streamId = rtmpStream.id;
                db.run('UPDATE streams SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [streamId]);
            } else {
                // No pre-created RTMP stream — auto-create one (direct OBS connect without Go Live page)
                db.ensureChannel(resolvedUser.id);
                const result = db.createStream({
                    user_id: resolvedUser.id,
                    managed_stream_id: managedStream ? managedStream.id : null,
                    title: `${resolvedUser.display_name}'s Stream`,
                    protocol: 'rtmp',
                });
                streamId = result.lastInsertRowid;
            }

            // Apply the per-slot control config, mirroring WHIP: the slot's own
            // control_config_id wins, falling back to the channel default. This
            // fixes viewers seeing the wrong (channel-default) controls when a
            // streamer set different controls per stream slot.
            try {
                const streamRow = db.getStreamById(streamId);
                const slot = managedStream
                    || (streamRow && streamRow.managed_stream_id ? db.getManagedStreamById(streamRow.managed_stream_id) : null);
                const channel = db.getChannelByUserId(resolvedUser.id);
                const configId = (slot && slot.control_config_id) || (channel && channel.active_control_config_id);
                if (configId) {
                    const applied = db.applyConfigToStream(configId, streamId);
                    console.log(`[RTMP] Applied control config ${configId} to stream ${streamId} (${applied} buttons)${slot && slot.control_config_id ? ' [per-slot]' : ' [channel default]'}`);
                }
            } catch (cfgErr) {
                console.warn('[RTMP] Failed to apply control config:', cfgErr.message);
            }

            // Dedup: end any other stale live session on this slot (keep this one).
            try {
                const streamRow2 = db.getStreamById(streamId);
                const slotId2 = (managedStream && managedStream.id) || (streamRow2 && streamRow2.managed_stream_id) || null;
                if (slotId2) {
                    const ended = db.endOtherLiveStreamsForSlot(slotId2, streamId);
                    if (ended.length) {
                        console.log(`[RTMP] Ended ${ended.length} stale duplicate session(s) on slot ${slotId2}: ${ended.join(',')}`);
                        for (const sid of ended) { try { require('./broadcast-server').endStream(sid); } catch { /* */ } }
                    }
                }
            } catch { /* non-critical */ }

            // Ensure heartbeat is always set (for stale-stream cleanup)
            db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);

            // A throw inside a timer is an uncaught exception, and the process exits on those — one
            // "database is locked" here would drop every live stream, not just this one.
            const heartbeatTimer = setInterval(() => {
                try {
                    db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
                } catch (e) { console.warn(`[RTMP] heartbeat for stream ${streamId} failed: ${e.message}`); }
            }, RTMP_HEARTBEAT_INTERVAL_MS);

            this.activeStreams.set(streamKey, {
                streamId,
                userId: resolvedUser.id,
                sessionId: id,
                connectedAt: new Date().toISOString(),
                heartbeatTimer,
            });
            console.log(`[RTMP] Stream started: ${resolvedUser.username} (stream ${streamId})`);

            // Emit event for restream auto-start
            this.emit('publish', { streamId, userId: resolvedUser.id, streamKey });

            // Discord webhook notification (fire-and-forget)
            const stream = db.getStreamById ? db.getStreamById(streamId) : { id: streamId, title: `${resolvedUser.display_name}'s Stream` };
            // Unified go-live event (inbox + push + email to followers, Discord via network;
            // falls back to the webhook). Deduped per slot/hour inside.
            try { require('./golive-notify').notifyFollowersGoLive(resolvedUser, stream || { id: streamId }); }
            catch (e) { console.warn('[RTMP] go-live notify failed:', e.message); notifyDiscordGoLive(resolvedUser, stream || { id: streamId }); }
            try { require('./live-events').announceGoLive(stream || { id: streamId }, resolvedUser); } catch { /* */ }

            // Start server-side VOD recording via FFmpeg
            // Small delay to let NMS fully register the RTMP stream before FFmpeg pulls it
            setTimeout(() => {
                const mode = db.resolveStreamRecordingMode(db.getStreamById(streamId));
                if (mode !== 'none') {
                    recorder.startRecording(streamId, 'rtmp', { streamKey }, { mode });
                }
            }, 2000);
        });

        this.nms.on('donePublish', (id, streamPath, args) => {
            const parts = streamPath.split('/');
            const streamKey = parts[parts.length - 1];
            const info = this.activeStreams.get(streamKey);

            if (info) {
                // Stop VOD recording first (SIGINT → FFmpeg writes trailer → finalize)
                recorder.stopRecording(info.streamId);

                // Emit event for restream cleanup
                this.emit('unpublish', { streamId: info.streamId, userId: info.userId, streamKey });

                if (info.heartbeatTimer) {
                    clearInterval(info.heartbeatTimer);
                    info.heartbeatTimer = null;
                }

                db.endStream(info.streamId);
                try { db.computeAndCacheStreamAnalytics(info.streamId); } catch {}
                this.activeStreams.delete(streamKey);
                console.log(`[RTMP] Stream ended: ${maskKey(streamKey)} (stream ${info.streamId})`);
            } else {
                console.log(`[RTMP] donePublish received for unknown stream key: ${maskKey(streamKey)}`);
            }
        });

        this.nms.on('prePlay', () => {});
        this.nms.on('donePlay', () => {});

        // Bind the HTTP-FLV server to loopback. node-media-server 2.7.4 calls httpServer.listen(port)
        // with no host, so it listened on every interface — but every consumer of it (the FLV
        // proxy route, the restreamer, AI audio/vision, live thumbnails, the RobotStreamer
        // publisher) connects to 127.0.0.1, and browsers only ever reach it through the proxy.
        // The library starts that server synchronously inside run(), so the host is supplied for
        // exactly that one listen() call and the original is put back straight after. RTMP ingest
        // (a net.Server on config.rtmp.port) is not an http.Server and is untouched: streamers
        // still push from anywhere.
        const http = require('http');
        const flvPort = config.rtmp.port + 8000;
        const hadOwnListen = Object.prototype.hasOwnProperty.call(http.Server.prototype, 'listen');
        const origListen = http.Server.prototype.listen;
        http.Server.prototype.listen = function (...args) {
            if (args[0] === flvPort && (args.length === 1 || typeof args[1] === 'function')) {
                args.splice(1, 0, '127.0.0.1');
            }
            return origListen.apply(this, args);
        };
        try {
            this.nms.run();
        } finally {
            if (hadOwnListen) http.Server.prototype.listen = origListen;
            else delete http.Server.prototype.listen;
        }
        console.log(`[RTMP] Server started on port ${config.rtmp.port} (HTTP-FLV on 127.0.0.1:${flvPort})`);
    }

    getActiveStreams() {
        return Array.from(this.activeStreams.entries()).map(([key, info]) => ({
            streamKey: key,
            ...info,
            heartbeatActive: !!info.heartbeatTimer,
        }));
    }

    /**
     * Check if an RTMP feed is actively being received for a given stream key.
     * @param {string} streamKey
     * @returns {boolean}
     */
    isReceiving(streamKey) {
        return this.activeStreams.has(streamKey);
    }

    /**
     * Get status info for an active RTMP stream.
     * @param {string} streamKey
     * @returns {{ receiving: boolean, connected_at?: string }}
     */
    getStatus(streamKey) {
        const info = this.activeStreams.get(streamKey);
        if (!info) return { receiving: false };
        return {
            receiving: true,
            streamId: info.streamId,
            connected_at: info.connectedAt,
            heartbeatActive: !!info.heartbeatTimer,
        };
    }

    stop() {
        // Stop all active recordings before shutting down RTMP server
        recorder.stopAll();
        if (this.nms) {
            this.nms.stop();
        }
    }
}

module.exports = new RTMPServer();
