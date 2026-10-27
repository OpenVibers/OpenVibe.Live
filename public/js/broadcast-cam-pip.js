/* ───────────────────────────────────────────────────────────────
   broadcast-cam-pip.js — a screen share's camera as a stream of its own (owner, 2026-10-26: "when a browser streamer
   uses the PIP feature for their camera, the PIP camera should actually be using it's own independent stream … own
   vods").

   Instead of painting the camera into the screen share (_startPipComposite), the page publishes it to one of the
   streamer's slots, which is the screen share slot's picture-in-picture (stream_pips). So the camera:
   - is a live stream of its own: viewers move, resize, mute or hide it over the screen share (stream-pip.js);
   - is recorded to its own VOD by the server, like any WebRTC stream (recorder.reconcileLiveRecordings);
   - plays over the screen share's VOD again, where it was (streaming/pip-history.js, openvibe.video).
   Its slot: the first of the streamer's own slots the screen share slot already lists as a PIP and that is not live,
   else a new "<title> camera" slot, added as a PIP where the screen share settings put the camera. Restreams (Twitch,
   YouTube …) get the screen share only; "Drawn into the screen" keeps the old composite for them.

     OVCamPip.wanted(ss)          → whether this stream's camera goes out on its own (the setting, a slot, the module)
     OVCamPip.start(ss, camStream) → go live with it (or swap its track when already live); resolves true when live
     OVCamPip.stop(mainStreamId)   → end the camera stream and stop its tracks
   It talks to /ws/broadcast as a broadcaster, like broadcast.js's _handleSfuProduceRequest, with that file's helpers.
   ─────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    const SIZES = { small: 0.18, medium: 0.25, large: 0.35 };
    const MARGIN = 0.02;
    const sessions = new Map();   // main stream id → { camStreamId, camMsid, ws, transport, producer, stream, closing, retries }

    /** The screen share settings' corner and size as the PIP's place (fractions of the player, the overlay 16:9). */
    function placeOf(pos, size) {
        const w = SIZES[size] || SIZES.small;
        const h = w * 9 / 16;
        const right = 1 - w - MARGIN, bottom = 1 - h - MARGIN;
        const p = String(pos || 'bottom-right');
        return { w, x: p.endsWith('left') ? MARGIN : right, y: p.startsWith('top') ? MARGIN : bottom };
    }

    function wanted(ss) {
        const mode = (typeof broadcastState !== 'undefined' && broadcastState.settings && broadcastState.settings.screenCamMode) || 'stream';
        return mode !== 'overlay' && !!(ss && ss.streamData && ss.streamData.managed_stream_id);
    }

    /** The camera's slot: an idle one of the streamer's own already listed as a PIP here, else a new one, added as a PIP. */
    async function cameraSlot(mainMsid, title) {
        const me = (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || '';
        const listed = await api(`/streams/managed/${mainMsid}/pips`);
        const pips = (listed && listed.pips) || [];
        const own = pips.find((p) => p.username && p.username.toLowerCase() === me.toLowerCase() && !p.live);
        if (own) return own.source_msid;
        const created = await api('/streams/managed', {
            method: 'POST',
            body: { title: `${String(title || 'Stream').slice(0, 80)} camera`, protocol: 'webrtc', streaming_method: 'browser' },
        });
        const msid = created && created.managed_stream && created.managed_stream.id;
        if (!msid) throw new Error('could not make a camera slot');
        const s = (typeof broadcastState !== 'undefined' && broadcastState.settings) || {};
        const rows = pips.map((p) => ({ source_msid: p.source_msid, x: p.defaults.x, y: p.defaults.y, w: p.defaults.w, muted: p.muted }));
        if (rows.length >= ((listed && listed.max) || 3)) rows.pop();   // the newest camera takes the last place
        rows.push({ source_msid: msid, ...placeOf(s.screenPipPos, s.screenPipSize), muted: true });
        await api(`/streams/managed/${mainMsid}/pips`, { method: 'PUT', body: { pips: rows } });
        return msid;
    }

    function waitFor(ws, type, ms = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(`camera: no ${type}`)); }, ms);
            function on(ev) {
                let m; try { m = JSON.parse(ev.data); } catch { return; }
                if (m.type === type) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(m); }
                else if (m.type === 'sfu-error') { clearTimeout(timer); ws.removeEventListener('message', on); reject(new Error(m.error || 'camera: SFU error')); }
            }
            ws.addEventListener('message', on);
        });
    }

    /** Broadcaster socket for the camera stream, and its video producer in the SFU. */
    async function publish(sess) {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const token = localStorage.getItem('token') || '';
        const ws = new WebSocket(`${proto}://${window.location.host}/ws/broadcast?token=${encodeURIComponent(token)}&streamId=${sess.camStreamId}&role=broadcaster`);
        sess.ws = ws;
        await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('camera: socket failed')), { once: true }); });
        ws.addEventListener('close', () => { if (!sess.closing) retry(sess); });
        const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
        const mod = await loadRobotStreamerMediasoup();
        const Device = mod.Device || mod.default?.Device;
        const device = new Device();
        send({ type: 'sfu-get-capabilities' });
        const caps = await waitFor(ws, 'sfu-capabilities');
        await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
        send({ type: 'sfu-create-transport' });
        const tp = await waitFor(ws, 'sfu-transport-created');
        const transport = device.createSendTransport({ id: tp.id, iceParameters: tp.iceParameters, iceCandidates: tp.iceCandidates,
            dtlsParameters: tp.dtlsParameters, iceServers: tp.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
        sess.transport = transport;
        transport.on('connect', ({ dtlsParameters }, cb, errb) => { send({ type: 'sfu-connect-transport', transportId: transport.id, dtlsParameters }); waitFor(ws, 'sfu-transport-connected').then(() => cb()).catch(errb); });
        transport.on('produce', ({ kind, rtpParameters }, cb, errb) => { send({ type: 'sfu-produce', transportId: transport.id, kind, rtpParameters }); waitFor(ws, 'sfu-produced').then((m) => cb({ id: m.id })).catch(errb); });
        const track = sess.stream.getVideoTracks()[0];
        if (!track) throw new Error('camera: no video track');
        const opts = typeof sfuVideoProduceOptions === 'function' ? sfuVideoProduceOptions(device, track) : { track, stopTracks: false };
        try { sess.producer = await transport.produce(opts); } catch (err) {
            if (!opts.codec) throw err;
            delete opts.codec;
            sess.producer = await transport.produce(opts);
        }
        if (typeof applyVideoSenderPrefs === 'function') await applyVideoSenderPrefs(sess.producer).catch(() => {});
    }

    /** A dropped camera socket comes back (three tries, a few seconds apart); the screen share is never touched. */
    function retry(sess) {
        if (sess.closing || sess.retries >= 3) return;
        sess.retries += 1;
        try { sess.transport && sess.transport.close(); } catch { /* */ }
        setTimeout(() => { if (!sess.closing) publish(sess).catch((e) => console.warn('[Camera PiP] reconnect failed:', e.message)); }, 2000 * sess.retries);
    }

    async function start(ss, camStream) {
        const mainId = ss && ss.streamData && ss.streamData.id;
        if (!mainId || !camStream) return false;
        const cur = sessions.get(mainId);
        if (cur && !cur.closing) {
            // Already live (a camera switch, the overlay toggled back on): the same stream, the new track.
            const track = camStream.getVideoTracks()[0];
            const old = cur.stream;
            cur.stream = camStream;
            try { if (cur.producer && track) await cur.producer.replaceTrack({ track }); } catch (e) { console.warn('[Camera PiP] track swap failed:', e.message); }
            if (old && old !== camStream) old.getTracks().forEach((t) => t.stop());
            return true;
        }
        const sess = { camStreamId: null, camMsid: null, ws: null, transport: null, producer: null, stream: camStream, closing: false, retries: 0 };
        sessions.set(mainId, sess);
        try {
            const title = ss.streamData.title || 'Stream';
            sess.camMsid = await cameraSlot(ss.streamData.managed_stream_id, title);
            if (sess.closing) return false;
            const made = await api('/streams', { method: 'POST', body: { title: `${title} · camera`, protocol: 'webrtc', managed_stream_id: sess.camMsid } });
            const live = made && (made.stream || made);
            sess.camStreamId = live && live.id;
            if (!sess.camStreamId) throw new Error('the camera stream did not start');
            // Stopped while it was starting: stop() could not end a stream it did not know yet.
            if (sess.closing) { api(`/streams/${sess.camStreamId}`, { method: 'DELETE' }).catch(() => {}); return false; }
            await publish(sess);
            console.log(`[Camera PiP] camera live as stream ${sess.camStreamId} on slot ${sess.camMsid}`);
            return true;
        } catch (err) {
            console.warn('[Camera PiP] the camera could not go out on its own:', err.message);
            if (typeof toast === 'function') toast(`Your camera could not go live as its own stream (${err.message}). The screen share carries on.`, 'error');
            stop(mainId);
            return false;
        }
    }

    function stop(mainId) {
        const sess = sessions.get(mainId);
        if (!sess) return;
        sess.closing = true;
        sessions.delete(mainId);
        try { sess.producer && sess.producer.close(); } catch { /* */ }
        try { sess.transport && sess.transport.close(); } catch { /* */ }
        try { sess.ws && sess.ws.close(); } catch { /* */ }
        try { sess.stream && sess.stream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
        if (sess.camStreamId) api(`/streams/${sess.camStreamId}`, { method: 'DELETE' }).catch(() => {});
    }

    window.OVCamPip = { wanted, start, stop, placeOf, _sessions: sessions };
})();
