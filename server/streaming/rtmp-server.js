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
            rtmp: {
                port: config.rtmp.port,
                chunk_size: config.rtmp.chunkSize,
                gop_cache: true,
                ping: 30,
                ping_timeout: 60,
            },
            http: {
                port: config.rtmp.port + 8000, // HTTP-FLV port (9935 by default)
                allow_origin: '*',  // Public media — CORS open (CSP restricts which pages can load it)
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
            console.log(`[RTMP] PrePublish: ${streamPath} from session ${id}`);
            // Stream path format: /live/STREAM_KEY
            const parts = streamPath.split('/');
            const streamKey = parts[parts.length - 1];

            if (!streamPath.startsWith('/live/') || !/^[a-zA-Z0-9_-]{8,128}$/.test(streamKey)) {
                console.log(`[RTMP] Rejected malformed publish path: ${streamPath}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const existingActive = this.activeStreams.get(streamKey);
            if (existingActive && existingActive.sessionId !== id) {
                console.log(`[RTMP] Rejected duplicate publisher for stream key ${streamKey}`);
                const session = this.nms.getSession(id);
                if (session) session.reject();
                return;
            }

            const user = db.getUserByStreamKey(streamKey);
            // Also check if key belongs to a managed stream
            const managedStream = !user ? db.getManagedStreamByStreamKey(streamKey) : null;
            const resolvedUser = user || (managedStream ? db.getUserById(managedStream.user_id) : null);
            if (!resolvedUser) {
                console.log(`[RTMP] Rejected: invalid stream key ${streamKey}`);
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

            const heartbeatTimer = setInterval(() => {
                db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);
                console.log(`[RTMP] Heartbeat refreshed for stream ${streamId}`);
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
                console.log(`[RTMP] Stream ended: ${streamKey} (stream ${info.streamId})`);
            } else {
                console.log(`[RTMP] donePublish received for unknown stream key: ${streamKey}`);
            }
        });

        this.nms.on('prePlay', () => {});
        this.nms.on('donePlay', () => {});

        this.nms.run();
        console.log(`[RTMP] Server started on port ${config.rtmp.port}`);
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
