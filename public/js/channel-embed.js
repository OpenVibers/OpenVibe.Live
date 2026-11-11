'use strict';
(() => {
    const user = decodeURIComponent(location.pathname.split('/').pop()).replace(/^@/, '');
    const video = document.getElementById('video-element');
    const safeOrigins = new Set(window.__OV_EMBED_ORIGINS || []);
    const allowedOrigin = (origin) => safeOrigins.has(origin) || /^https:\/\/(?:[a-z0-9-]+\.)+openvibe\.website$/.test(origin);
    let state = { live: false, muted: true, playing: false, title: '', username: user, viewers: 0 };
    let currentStreamId = null;
    let requestedSound = false;
    let pausedByParent = false;
    const approved18 = new Set();
    const send = () => { if (parent !== window) parent.postMessage({ type: 'ov-embed', event: 'state', ...state }, '*'); };
    const paint = () => { document.getElementById('live').hidden = !state.live; send(); };
    const setMuted = (muted) => {
        const wanted = !!muted;
        requestedSound = !wanted;
        if (state.muted !== wanted) document.getElementById('btn-volume')?.click();
        window.OVChannelEmbedForceMuted = wanted;
        video.muted = wanted;
        if (!wanted && (video.srcObject || video.currentSrc)) video.play().catch(() => {
            // A newly loaded cross-site document may need another tap for sound.
            requestedSound = false;
            window.OVChannelEmbedForceMuted = true;
            video.muted = true;
            state.muted = true;
            send();
            video.play().catch(() => {});
        });
        state.muted = wanted;
        send();
    };
    const setPlaying = (playing) => {
        const wanted = !!playing;
        pausedByParent = !wanted;
        if (state.playing !== wanted) document.getElementById('btn-play-pause')?.click();
        state.playing = wanted;
        send();
    };
    addEventListener('message', (event) => {
        if (!allowedOrigin(event.origin) || event.source !== parent || event.data?.type !== 'ov-embed') return;
        if (event.data.cmd === 'mute') setMuted(true);
        if (event.data.cmd === 'unmute') setMuted(false);
        if (event.data.cmd === 'play') setPlaying(true);
        if (event.data.cmd === 'pause') setPlaying(false);
    });
    video.addEventListener('volumechange', () => { state.muted = video.muted; send(); });
    video.addEventListener('playing', () => { state.playing = true; send(); });
    video.addEventListener('pause', () => { state.playing = false; send(); });
    video.addEventListener('canplay', () => {
        const streamId = currentStreamId;
        setTimeout(() => {
            if (streamId === null || currentStreamId !== streamId || pausedByParent || !video.paused || video.muted || video.readyState < 2) return;
            // An unmuted handoff may be blocked by autoplay. Keep the picture moving until the next tap for sound.
            requestedSound = false;
            window.OVChannelEmbedForceMuted = true;
            video.muted = true;
            state.muted = true;
            send();
            video.play().catch(() => {});
        }, 1500);
    });
    document.getElementById('video-container').addEventListener('click', (event) => {
        if (state.live && !event.target.closest('#gate')) setMuted(!state.muted);
    });
    const start = (stream) => {
        currentStreamId = stream.id;
        state.muted = !requestedSound;
        state.playing = true;
        window.OVChannelEmbedForceMuted = !requestedSound;
        video.muted = !requestedSound;
        document.getElementById('offline').style.display = 'none';
        initPlayer(stream);
    };
    const load = async () => {
        try {
            const r = await fetch(`/api/streams/channel/${encodeURIComponent(user)}?pollOnly=1`);
            if (!r.ok) throw new Error('offline');
            const data = await r.json();
            const stream = (data.liveStreams || data.streams || []).find((s) => s.is_live) || data.liveStream;
            const channel = data.channel || data;
            state.username = channel.username || user; state.title = stream?.title || ''; state.viewers = Number(stream?.viewer_count || 0); state.live = !!stream;
            if (!stream) {
                if (currentStreamId !== null) { destroyPlayer(); currentStreamId = null; state.playing = false; }
                document.getElementById('gate').style.display = 'none';
                const box = document.getElementById('offline');
                box.style.display = 'block'; box.innerHTML = `<img alt="" src="${String(channel.avatar_url || '').replace(/["<>]/g,'')}"><strong>${String(channel.display_name || user).replace(/[<>]/g,'')} is offline</strong>`;
            } else if ((stream.is_nsfw || data.channel?.force_nsfw || data.channel?.is_nsfw) && !approved18.has(String(stream.id))) {
                document.getElementById('gate').style.display = 'grid';
                if (currentStreamId !== null) { destroyPlayer(); currentStreamId = null; state.playing = false; }
                document.getElementById('continue').onclick = () => { approved18.add(String(stream.id)); document.getElementById('gate').style.display = 'none'; start(stream); };
            } else {
                document.getElementById('gate').style.display = 'none';
                if (String(currentStreamId) !== String(stream.id)) start(stream);
            }
            paint();
        } catch {
            if (currentStreamId !== null) { destroyPlayer(); currentStreamId = null; state.playing = false; }
            document.getElementById('offline').textContent = `${user} is offline`; document.getElementById('offline').style.display = 'block'; state.live = false; paint();
        }
    };
    paint(); load(); setInterval(load, 15000);
})();
