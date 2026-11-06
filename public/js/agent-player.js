/* Agent stream viewer (Agent Streams S1): the small player the owner's page and the embed share.
 *
 * It speaks the same mediasoup signaling as the site's full player (/js/stream-player.js): connect to /ws/broadcast as
 * a viewer, send `watch`, then Device → recv transport → consume each producer. It is deliberately small — no DVR, no
 * clips, no chat — because an agent stream has none of those in S1, and the embed must stay light enough for a
 * third-party iframe.
 *
 * A private or unlisted agent stream is joined with a view ticket (`?vt=wvt_…`); the socket refuses the join without
 * one, and this player only ever has what the page was allowed to mint.
 */
/* global window, document, WebSocket, MediaStream */
(function () {
    'use strict';
    let clientPromise = null;
    function loadClient() {
        if (!clientPromise) {
            clientPromise = import('https://esm.sh/mediasoup-client@3.18.7');
            clientPromise.catch(() => { clientPromise = null; });
        }
        return clientPromise;
    }

    function create(options) {
        const { streamId, viewTicket = '', video, state: stateEl, curtain: curtainEl, viewers: viewersEl, onViewers } = options;
        const setState = (text) => { if (stateEl) { stateEl.textContent = text; stateEl.hidden = !text; } };
        let ws = null;
        let closed = false;
        let retries = 0;
        let device = null;
        let transport = null;
        let pending = [];
        let waiters = new Map();

        function waitFor(type, timeoutMs = 12000) {
            return new Promise((resolve, reject) => {
                const list = waiters.get(type) || [];
                const timer = setTimeout(() => {
                    waiters.set(type, (waiters.get(type) || []).filter((w) => w.resolve !== resolve));
                    reject(new Error(`${type} timed out`));
                }, timeoutMs);
                list.push({ resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
                waiters.set(type, list);
            });
        }
        function settle(type, msg) {
            const list = waiters.get(type) || [];
            if (!list.length) return false;
            const [first, ...rest] = list;
            waiters.set(type, rest);
            first.resolve(msg);
            return true;
        }

        function send(message) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        }

        async function setup(rtpCapabilities, producers) {
            setState('Starting playback…');
            const mod = await loadClient();
            const Device = mod.Device;
            if (!Device) throw new Error('mediasoup-client unavailable');
            device = new Device();
            await device.load({ routerRtpCapabilities: rtpCapabilities });

            const asked = waitFor('sfu-viewer-transport-created');
            send({ type: 'sfu-viewer-create-transport' });
            const params = await asked;
            const iceServers = Array.isArray(params.iceServers) && params.iceServers.length
                ? params.iceServers
                : [{ urls: 'stun:stun.l.google.com:19302' }];
            transport = device.createRecvTransport({
                id: params.id,
                iceParameters: params.iceParameters,
                iceCandidates: params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers,
            });
            transport.on('connect', ({ dtlsParameters }, callback, errback) => {
                const connected = waitFor('sfu-viewer-transport-connected');
                send({ type: 'sfu-viewer-connect-transport', transportId: transport.id, dtlsParameters });
                connected.then(() => callback()).catch(errback);
            });

            const media = new MediaStream();
            for (const producer of producers) {
                const consumed = waitFor('sfu-viewer-consumed');
                send({ type: 'sfu-viewer-consume', transportId: transport.id, producerId: producer.id, rtpCapabilities: device.rtpCapabilities });
                const info = await consumed;
                const consumer = await transport.consume({
                    id: info.id,
                    producerId: info.producerId,
                    kind: info.kind,
                    rtpParameters: info.rtpParameters,
                });
                media.addTrack(consumer.track);
                if (info.kind === 'video') {
                    consumer.track.addEventListener('unmute', () => { if (video && video.paused) video.play().catch(() => {}); });
                }
            }
            if (video) {
                video.srcObject = media;
                video.autoplay = true;
                video.muted = true;
                video.playsInline = true;
                video.play().then(() => setState('')).catch(() => setState('Tap to play'));
                video.addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); });
            }
        }

        function connect() {
            if (closed) return;
            const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const vt = viewTicket ? `&vt=${encodeURIComponent(viewTicket)}` : '';
            ws = new WebSocket(`${proto}://${window.location.host}/ws/broadcast?streamId=${encodeURIComponent(streamId)}&role=viewer${vt}`);
            ws.addEventListener('open', () => { setState('Connecting…'); send({ type: 'watch' }); });
            ws.addEventListener('message', (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                if (msg.type && settle(msg.type, msg)) return;   // an answer the setup is awaiting
                switch (msg.type) {
                    case 'sfu-viewer-ready':
                        retries = 0;
                        if (msg.producers && msg.producers.length) {
                            setup(msg.rtpCapabilities, msg.producers).catch((err) => {
                                console.warn('[AgentPlayer] setup failed:', err && err.message);
                                setState('Reconnecting…');
                                setTimeout(() => { send({ type: 'watch' }); }, 2500);
                            });
                        } else {
                            setState('Waiting for video…');
                            setTimeout(() => send({ type: 'watch' }), 3000);
                        }
                        break;
                    case 'watch-queued':
                        setState('Waiting for video…');
                        setTimeout(() => send({ type: 'watch' }), 3000);
                        break;
                    case 'sfu-source-unavailable':
                        setState('Waiting for video…');
                        break;
                    case 'curtain':
                        if (curtainEl) curtainEl.hidden = !msg.up;
                        break;
                    case 'viewer-count':
                        if (typeof onViewers === 'function') { try { onViewers(msg.count); } catch { /* the page's own problem */ } }
                        if (viewersEl) {
                            viewersEl.textContent = msg.count === 1 ? '1 watching' : `${msg.count} watching`;
                            viewersEl.hidden = false;
                        }
                        break;
                    case 'stream-ended':
                        setState('Stream ended');
                        if (curtainEl) curtainEl.hidden = true;
                        break;
                    case 'sfu-viewer-error':
                        console.warn('[AgentPlayer]', msg.error);
                        setState('Reconnecting…');
                        break;
                    default:
                        break;
                }
            });
            ws.addEventListener('close', () => {
                if (closed) return;
                if (retries >= 8) { setState('Stream not available'); return; }
                retries++;
                setState('Reconnecting…');
                setTimeout(connect, Math.min(1000 * retries, 8000));
            });
            ws.addEventListener('error', () => { /* close follows */ });
        }

        connect();
        return {
            close() {
                closed = true;
                try { if (ws) ws.close(); } catch { /* */ }
                try { if (transport) transport.close(); } catch { /* */ }
            },
        };
    }

    window.AgentPlayer = { create };
})();
