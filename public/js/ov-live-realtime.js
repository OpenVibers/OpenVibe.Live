/**
 * Live's stream lifecycle over OpenVibe.Events realtime (roadmap WS-F task 1): the public
 * live.stream.started / live.stream.ended events on events.openvibe.network/realtime/stream (SSE).
 * The home page's live grid refreshes the moment a stream starts or ends, and polls only as a
 * safety net while this is connected (public/js/app-home.js startHomeRefresh).
 *
 * A native EventSource, the same transport openvibe-sdk/realtime uses in a browser, without the SDK's
 * 128 KB browser bundle on the home page. Resume needs no bookkeeping here: every event, reconnect
 * or gap just refetches the grid.
 *
 *   const off = OVLiveRealtime.on((kind, event) => { … });   // kind: 'open' | 'event' | 'gap' | 'error'
 *   OVLiveRealtime.connected                                  // true while the stream is open
 */
(function () {
    'use strict';
    const URL_ = 'https://events.openvibe.network/realtime/stream?topics=live.stream.started,live.stream.ended';
    const listeners = new Set();
    let es = null;
    let connected = false;

    const emit = (kind, event) => { for (const fn of listeners) { try { fn(kind, event); } catch { /* a listener's problem */ } } };
    function start() {
        if (es || typeof EventSource === 'undefined') return;
        es = new EventSource(URL_);
        es.onopen = () => { connected = true; emit('open'); };
        // EventSource reconnects by itself (with Last-Event-ID); until then the page polls.
        es.onerror = () => { connected = false; emit('error'); };
        es.onmessage = (m) => {
            let d = null;
            try { d = JSON.parse(m.data); } catch { return; }
            if (d && d.event && /^live\.stream\.(started|ended)$/.test(d.event.event_type)) emit('event', d.event);
        };
        es.addEventListener('gap', () => emit('gap'));
    }
    function stop() { if (es) { es.close(); es = null; } connected = false; }

    window.OVLiveRealtime = {
        on(fn) {
            listeners.add(fn);
            start();
            return () => { listeners.delete(fn); if (!listeners.size) stop(); };
        },
        get connected() { return connected; },
    };
})();
