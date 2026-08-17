/**
 * OpenVibe.Live Media Player — Custom controls, server-side streaming, position save/restore.
 *
 * Key features:
 *   - Uses server-extracted direct stream URLs (yt-dlp) — no embed restrictions
 *   - Custom play/pause, seek bar, volume, fullscreen controls
 *   - Saves playback position every 5 seconds for resume on reload/restart
 *   - Auto-reports failures → server auto-refunds coins
 *   - WebSocket + polling for real-time queue updates
 */

// ── State ───────────────────────────────────────────────────
let mpState = null;
let mpChannel = null;
let mpOwner = false;
let mpLiveStream = null;
let mpPollTimer = null;
let mpSocket = null;
let mpSuppressAutoStart = false;

// Current playback
let mpMedia = null;           // <video> or <audio> element
let mpCurrentRequestId = null;
let mpPositionSaveTimer = null;
let mpRetryCount = 0;
let mpHls = null;
const MP_MAX_RETRIES = 2;
const MP_POSITION_SAVE_INTERVAL = 5000;
const mpExternalScriptPromises = new Map();

// ── Helpers ─────────────────────────────────────────────────
function mpUsername() {
    return window.location.pathname.split('/').filter(Boolean)[1] || '';
}

function mpToken() {
    return localStorage.getItem('token') || '';
}

async function mpApi(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const token = mpToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function mpLoadExternalScriptOnce(src) {
    if (!src) return Promise.reject(new Error('Missing script URL'));
    if (mpExternalScriptPromises.has(src)) return mpExternalScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
        const key = encodeURIComponent(src);
        const existing = document.querySelector(`script[data-external-src="${key}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') return resolve();
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.externalSrc = key;
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });

    mpExternalScriptPromises.set(src, promise);
    return promise;
}

function mpIsHlsUrl(url) {
    const value = String(url || '');
    return /\.m3u8(?:$|[?#])/i.test(value) || /\/api\/manifest\/(?:hls|dash)_playlist\//i.test(value);
}

async function mpAttachSource(media, url) {
    if (!mpIsHlsUrl(url)) {
        media.src = url;
        return;
    }

    if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = url;
        return;
    }

    await mpLoadExternalScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@latest');
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
        throw new Error('HLS playback is not supported in this browser');
    }

    if (mpHls) {
        try { mpHls.destroy(); } catch {}
        mpHls = null;
    }

    mpHls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
    });
    mpHls.loadSource(url);
    mpHls.attachMedia(media);
    mpHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
            try { mpHls.destroy(); } catch {}
            mpHls = null;
            media.dispatchEvent(new Event('error'));
        }
    });
}

// ── Init ────────────────────────────────────────────────────
async function loadMediaPage() {
    const username = mpUsername();
    if (!username) return;

    // Wire static buttons
    document.getElementById('mp-copy-link').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
        } catch {}
    });
    document.getElementById('mp-start-next').addEventListener('click', () => ownerAction('/api/media/start', 'POST'));
    document.getElementById('mp-mark-played').addEventListener('click', () => ownerAction('/api/media/advance', 'POST', { status: 'played' }));
    document.getElementById('mp-skip-current').addEventListener('click', () => ownerAction('/api/media/advance', 'POST', { status: 'skipped' }));
    document.getElementById('mp-settings-form').addEventListener('submit', saveSettings);
    document.getElementById('mp-retry-btn').addEventListener('click', retryPlayback);

    // Custom control wiring
    wireControls();

    await refreshState();
    startPolling();
}

// ── Data fetch ──────────────────────────────────────────────
async function refreshState() {
    const username = mpUsername();
    const data = await mpApi(`/api/media/channel/${encodeURIComponent(username)}`);
    mpChannel = data.channel;
    mpState = data.state;
    mpOwner = !!data.is_owner;
    mpLiveStream = data.live_stream;

    renderPage();
    connectSocket();
    maybeAutoStart();
}

// ── Render ──────────────────────────────────────────────────
function renderPage() {
    document.getElementById('mp-title').textContent = `${mpChannel.display_name} — Media Queue`;
    document.getElementById('mp-subtitle').textContent = mpOwner
        ? 'Manage requests, playback, and your queue from this page.'
        : `Request media in chat with !sr, !yt, !youtube, !req, or !request while watching ${mpChannel.display_name}.`;
    document.getElementById('mp-channel-link').href = (typeof channelPath === 'function')
        ? channelPath(mpChannel.username)
        : `/@${encodeURIComponent(mpChannel.username || '')}`;
    document.getElementById('mp-owner-controls').hidden = !mpOwner;
    document.getElementById('mp-settings-card').hidden = !mpOwner;

    const np = mpState.now_playing;
    document.getElementById('mp-now-meta').textContent = np
        ? `Requested by ${np.username}`
        : 'Nothing is playing right now.';

    renderNowPlaying();
    renderQueue();
    renderHistory();
    renderSettings();
    document.title = `${mpChannel.display_name} media queue`;
}

function renderNowPlaying() {
    const current = mpState.now_playing;
    const empty = document.getElementById('mp-player-empty');
    const host = document.getElementById('mp-player-host');
    const card = document.getElementById('mp-now-card');
    const controls = document.getElementById('mp-controls');

    if (!current) {
        empty.hidden = false;
        host.hidden = true;
        card.hidden = true;
        controls.hidden = true;
        destroyPlayer();
        return;
    }

    empty.hidden = true;
    host.hidden = false;
    card.hidden = false;

    // Build info card
    const durText = current.duration_seconds ? formatDuration(current.duration_seconds) : '';
    card.innerHTML = `
        <div class="mp-now-title">${esc(current.title)}</div>
        <div class="mp-now-meta-row">
            <span><i class="fa-solid fa-user"></i> ${esc(current.username)}</span>
            <span><i class="fa-solid fa-circle-play"></i> ${esc(current.provider)}</span>
            <span><i class="fa-solid fa-coins"></i> ${current.cost} coins</span>
            ${durText ? `<span class="mp-duration"><i class="fa-solid fa-clock"></i> ${durText}</span>` : ''}
            ${current.download_status && current.download_status !== 'ready' ? `<span class="mp-item-status mp-status-${esc(current.download_status)}">${esc(current.download_status)}</span>` : ''}
        </div>
    `;

    // Only re-create player if it's a different request
    if (mpCurrentRequestId !== current.id) {
        mpRetryCount = 0;
        loadPlayer(current);
    }
}

// ── Player lifecycle ────────────────────────────────────────
async function loadPlayer(request) {
    destroyPlayer();
    mpCurrentRequestId = request.id;

    const host = document.getElementById('mp-player-host');
    const controls = document.getElementById('mp-controls');
    const loading = document.getElementById('mp-loading-overlay');
    const error = document.getElementById('mp-error-overlay');

    loading.hidden = false;
    error.hidden = true;
    document.getElementById('mp-loading-text').textContent = 'Loading media…';

    // Try to get a stream URL from the server
    let streamUrl = request.stream_url;
    let lastError = '';
    if (!streamUrl || request.download_status !== 'ready') {
        document.getElementById('mp-loading-text').textContent = 'Preparing server-side media…';
        try {
            const data = await mpApi(`/api/media/queue/${request.id}/stream-url`);
            streamUrl = data.stream_url;
            lastError = data.last_error || '';
            // If still extracting, poll until ready
            if (data.download_status !== 'ready' && data.download_status !== 'failed') {
                streamUrl = await pollStreamUrl(request.id);
            }
        } catch (err) {
            streamUrl = null;
            lastError = err?.message || '';
        }
    }

    const playUrl = streamUrl;

    if (!playUrl) {
        const msg = lastError || 'Server could not prepare a playable media file for this request.';
        showError(msg);
        if (mpOwner) reportFailure(request.id, msg);
        return;
    }

    // Create native <video> or <audio> element
    const isAudio = request.provider === 'audio';
    const media = document.createElement(isAudio ? 'audio' : 'video');
    media.src = playUrl;
    media.autoplay = true;
    media.playsInline = true;
    media.preload = 'auto';
    if (!isAudio) media.style.cssText = 'width:100%;height:100%;display:block;background:#000;';
    else media.style.cssText = 'width:100%;min-height:84px;display:block;background:#111;';

    // Resume from saved position
    const resumePos = request.playback_position || 0;
    if (resumePos > 1) {
        media.currentTime = resumePos;
    }

    // Events
    media.addEventListener('loadedmetadata', () => {
        loading.hidden = true;
        controls.hidden = false;
        updateTimeDisplay();
    });

    media.addEventListener('canplay', () => {
        loading.hidden = true;
    });

    media.addEventListener('waiting', () => {
        document.getElementById('mp-loading-text').textContent = 'Buffering…';
        loading.hidden = false;
    });

    media.addEventListener('playing', () => {
        loading.hidden = true;
    });

    media.addEventListener('timeupdate', () => {
        if (!mpMedia) return;
        updateSeekBar();
        updateTimeDisplay();
    });

    media.addEventListener('progress', () => {
        updateBufferedBar();
    });

    media.addEventListener('ended', () => {
        if (mpOwner) {
            ownerAction('/api/media/advance', 'POST', { status: 'played' }, true);
        }
    });

    media.addEventListener('error', () => {
        const err = media.error;
        const msg = err ? `Media error: code ${err.code}` : 'Media failed to load';
        console.warn('[MediaPlayer]', msg, playUrl);

        if (mpRetryCount < MP_MAX_RETRIES) {
            mpRetryCount++;
            document.getElementById('mp-loading-text').textContent = `Retrying (${mpRetryCount}/${MP_MAX_RETRIES})…`;
            loading.hidden = false;
            setTimeout(() => {
                if (mpCurrentRequestId === request.id) {
                    loadPlayer(request);
                }
            }, 2000);
        } else {
            showError(msg);
            if (mpOwner) reportFailure(request.id, msg);
        }
    });

    // Clear old content and insert
    const existingMedia = host.querySelector('video, audio');
    if (existingMedia) existingMedia.remove();
    host.appendChild(media);
    mpMedia = media;

    try {
        await mpAttachSource(media, playUrl);
    } catch (attachErr) {
        const msg = attachErr?.message || 'Media failed to load';
        showError(msg);
        if (mpOwner) reportFailure(request.id, msg);
        return;
    }

    // Start position save timer
    startPositionSave(request.id);
}

function destroyPlayer() {
    stopPositionSave();
    if (mpHls) {
        try { mpHls.destroy(); } catch {}
        mpHls = null;
    }
    const host = document.getElementById('mp-player-host');
    if (host) {
        const el = host.querySelector('video, audio');
        if (el) {
            try { el.pause(); } catch {}
            el.remove();
        }
    }
    mpMedia = null;
    mpCurrentRequestId = null;

    // Reset controls UI
    const controls = document.getElementById('mp-controls');
    if (controls) controls.hidden = true;
    const loading = document.getElementById('mp-loading-overlay');
    if (loading) loading.hidden = true;
    const error = document.getElementById('mp-error-overlay');
    if (error) error.hidden = true;
}

// ── Stream URL polling ──────────────────────────────────────
async function pollStreamUrl(requestId, maxWait = 25000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 1500));
        try {
            const data = await mpApi(`/api/media/queue/${requestId}/stream-url`);
            if (data.download_status === 'ready' && data.stream_url) return data.stream_url;
            if (data.download_status === 'failed') return null;
            document.getElementById('mp-loading-text').textContent = `Preparing media (${data.download_status || 'working'})…`;
        } catch {
            return null;
        }
    }
    return null;
}

// ── Error / retry ───────────────────────────────────────────
function showError(msg) {
    document.getElementById('mp-loading-overlay').hidden = true;
    document.getElementById('mp-error-overlay').hidden = false;
    document.getElementById('mp-error-text').textContent = msg || 'Playback failed';
    document.getElementById('mp-controls').hidden = true;
}

function retryPlayback() {
    const current = mpState?.now_playing;
    if (!current) return;
    mpRetryCount = 0;
    loadPlayer(current);
}

async function reportFailure(requestId, errorMsg) {
    try {
        await mpApi(`/api/media/queue/${requestId}/fail`, {
            method: 'POST',
            body: JSON.stringify({ error: errorMsg }),
        });
    } catch {}
}

// ── Playback position save/restore ──────────────────────────
function startPositionSave(requestId) {
    stopPositionSave();
    mpPositionSaveTimer = setInterval(() => {
        if (!mpMedia || !requestId) return;
        const pos = mpMedia.currentTime;
        if (Number.isFinite(pos) && pos > 0) {
            fetch(`/api/media/queue/${requestId}/position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position: pos }),
            }).catch(() => {});
        }
    }, MP_POSITION_SAVE_INTERVAL);
}

function stopPositionSave() {
    if (mpPositionSaveTimer) {
        clearInterval(mpPositionSaveTimer);
        mpPositionSaveTimer = null;
    }
}

// ── Custom controls ─────────────────────────────────────────
function wireControls() {
    const playBtn = document.getElementById('mp-ctrl-play');
    const muteBtn = document.getElementById('mp-ctrl-mute');
    const volSlider = document.getElementById('mp-vol-slider');
    const seekInput = document.getElementById('mp-seek-input');
    const fsBtn = document.getElementById('mp-ctrl-fullscreen');

    // Play/Pause
    playBtn.addEventListener('click', () => {
        if (!mpMedia) return;
        if (mpMedia.paused) {
            mpMedia.play().catch(() => {});
        } else {
            mpMedia.pause();
        }
    });

    // Mute
    muteBtn.addEventListener('click', () => {
        if (!mpMedia) return;
        mpMedia.muted = !mpMedia.muted;
        updateVolumeIcon();
    });

    // Volume
    volSlider.addEventListener('input', () => {
        if (!mpMedia) return;
        mpMedia.volume = Number(volSlider.value) / 100;
        mpMedia.muted = false;
        updateVolumeIcon();
    });

    // Seek
    let seeking = false;
    seekInput.addEventListener('mousedown', () => { seeking = true; });
    seekInput.addEventListener('touchstart', () => { seeking = true; }, { passive: true });
    seekInput.addEventListener('input', () => {
        if (!mpMedia || !Number.isFinite(mpMedia.duration)) return;
        const pct = Number(seekInput.value) / 1000;
        const seekTime = pct * mpMedia.duration;
        // Update visual immediately
        document.getElementById('mp-seek-progress').style.width = `${pct * 100}%`;
        document.getElementById('mp-time-current').textContent = formatTime(seekTime);
    });
    seekInput.addEventListener('change', () => {
        seeking = false;
        if (!mpMedia || !Number.isFinite(mpMedia.duration)) return;
        mpMedia.currentTime = (Number(seekInput.value) / 1000) * mpMedia.duration;
    });
    seekInput.addEventListener('mouseup', () => { seeking = false; });
    seekInput.addEventListener('touchend', () => { seeking = false; });

    // Fullscreen
    fsBtn.addEventListener('click', () => {
        const wrap = document.getElementById('mp-player-wrap');
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            wrap.requestFullscreen().catch(() => {});
        }
    });

    document.addEventListener('fullscreenchange', () => {
        const icon = fsBtn.querySelector('i');
        if (document.fullscreenElement) {
            icon.className = 'fa-solid fa-compress';
        } else {
            icon.className = 'fa-solid fa-expand';
        }
    });

    // Play/pause icon tracking
    document.addEventListener('play', () => updatePlayIcon(), true);
    document.addEventListener('pause', () => updatePlayIcon(), true);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (!mpMedia) return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                if (mpMedia.paused) mpMedia.play().catch(() => {});
                else mpMedia.pause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                mpMedia.currentTime = Math.max(0, mpMedia.currentTime - 5);
                break;
            case 'ArrowRight':
                e.preventDefault();
                mpMedia.currentTime = Math.min(mpMedia.duration || 0, mpMedia.currentTime + 5);
                break;
            case 'j':
                mpMedia.currentTime = Math.max(0, mpMedia.currentTime - 10);
                break;
            case 'l':
                mpMedia.currentTime = Math.min(mpMedia.duration || 0, mpMedia.currentTime + 10);
                break;
            case 'ArrowUp':
                e.preventDefault();
                mpMedia.volume = Math.min(1, mpMedia.volume + 0.05);
                volSlider.value = Math.round(mpMedia.volume * 100);
                updateVolumeIcon();
                break;
            case 'ArrowDown':
                e.preventDefault();
                mpMedia.volume = Math.max(0, mpMedia.volume - 0.05);
                volSlider.value = Math.round(mpMedia.volume * 100);
                updateVolumeIcon();
                break;
            case 'm':
                mpMedia.muted = !mpMedia.muted;
                updateVolumeIcon();
                break;
            case 'f':
                document.getElementById('mp-ctrl-fullscreen').click();
                break;
        }
    });
}

function updatePlayIcon() {
    const icon = document.getElementById('mp-ctrl-play')?.querySelector('i');
    if (!icon) return;
    icon.className = mpMedia && !mpMedia.paused ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}

function updateVolumeIcon() {
    const icon = document.getElementById('mp-ctrl-mute')?.querySelector('i');
    if (!icon || !mpMedia) return;
    if (mpMedia.muted || mpMedia.volume === 0) {
        icon.className = 'fa-solid fa-volume-xmark';
    } else if (mpMedia.volume < 0.5) {
        icon.className = 'fa-solid fa-volume-low';
    } else {
        icon.className = 'fa-solid fa-volume-high';
    }
}

function updateSeekBar() {
    if (!mpMedia || !Number.isFinite(mpMedia.duration) || mpMedia.duration <= 0) return;
    const pct = (mpMedia.currentTime / mpMedia.duration) * 100;
    document.getElementById('mp-seek-progress').style.width = `${pct}%`;

    const seekInput = document.getElementById('mp-seek-input');
    // Don't update while user is dragging
    if (!document.activeElement || document.activeElement !== seekInput) {
        seekInput.value = Math.round((mpMedia.currentTime / mpMedia.duration) * 1000);
    }
}

function updateBufferedBar() {
    if (!mpMedia || !Number.isFinite(mpMedia.duration) || mpMedia.duration <= 0) return;
    const buf = mpMedia.buffered;
    if (buf.length > 0) {
        const end = buf.end(buf.length - 1);
        const pct = (end / mpMedia.duration) * 100;
        document.getElementById('mp-seek-buffered').style.width = `${pct}%`;
    }
}

function updateTimeDisplay() {
    if (!mpMedia) return;
    document.getElementById('mp-time-current').textContent = formatTime(mpMedia.currentTime);
    document.getElementById('mp-time-total').textContent = formatTime(mpMedia.duration);
}

// ── Queue & History rendering ───────────────────────────────
function renderQueue() {
    const list = document.getElementById('mp-queue-list');
    const queue = mpState.queue || [];
    document.getElementById('mp-queue-count').textContent = `${queue.length} queued`;
    if (!queue.length) {
        list.innerHTML = '<div class="mp-empty">Queue is empty.</div>';
        return;
    }

    list.innerHTML = queue.map((item, index) => {
        const dur = item.duration_seconds ? formatDuration(item.duration_seconds) : '';
        const statusBadge = item.download_status && item.download_status !== 'none'
            ? `<span class="mp-item-status mp-status-${esc(item.download_status)}">${esc(item.download_status)}</span>`
            : '';
        return `
        <article class="mp-item">
            <div class="mp-item-top">
                <div class="mp-item-main">
                    ${item.thumbnail_url ? `<img class="mp-item-thumb" src="${esc(item.thumbnail_url)}" alt="" loading="lazy">` : ''}
                    <div class="mp-item-body">
                        <div class="mp-item-title">#${index + 1} ${esc(item.title)}</div>
                        <div class="mp-item-meta">
                            ${esc(item.username)} · ${esc(item.provider)} · ${item.cost} coins
                            ${dur ? ` · ${dur}` : ''}
                            ${statusBadge}
                        </div>
                    </div>
                </div>
            </div>
            ${mpOwner ? `<div class="mp-item-actions">
                <button class="mp-icon-btn" onclick="playRequest(${item.id})" title="Play now"><i class="fa-solid fa-play"></i></button>
                <button class="mp-icon-btn" onclick="moveRequest(${item.id}, 'up')" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                <button class="mp-icon-btn" onclick="moveRequest(${item.id}, 'down')" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                <button class="mp-icon-btn" onclick="refundRequest(${item.id})" title="Refund & remove"><i class="fa-solid fa-rotate-left"></i></button>
                <button class="mp-icon-btn mp-icon-danger" onclick="removeRequest(${item.id})" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            </div>` : ''}
        </article>`;
    }).join('');
}

function renderHistory() {
    const list = document.getElementById('mp-history-list');
    const history = mpState.history || [];
    if (!history.length) {
        list.innerHTML = '<div class="mp-empty">Nothing has finished yet.</div>';
        return;
    }
    list.innerHTML = history.map((item) => {
        const statusIcon = item.status === 'played' ? 'fa-circle-check' : item.status === 'failed' ? 'fa-circle-xmark' : 'fa-forward';
        const statusColor = item.status === 'played' ? 'var(--mp-success)' : item.status === 'failed' ? 'var(--mp-danger)' : 'var(--mp-muted)';
        return `
        <article class="mp-item">
            <div class="mp-item-title">${esc(item.title)}</div>
            <div class="mp-item-meta">
                <i class="fa-solid ${statusIcon}" style="color:${statusColor}"></i>
                ${esc(item.username)} · ${esc(item.status)} · ${esc(item.provider)}
                ${item.refunded ? ' · <span style="color:var(--mp-accent)">refunded</span>' : ''}
            </div>
        </article>`;
    }).join('');
}

// ── Settings ────────────────────────────────────────────────
function renderSettings() {
    if (!mpOwner) return;
    const form = document.getElementById('mp-settings-form');
    const s = mpState.settings || {};
    form.enabled.checked = !!s.enabled;
    form.request_cost.value = s.request_cost ?? 25;
    form.cost_per_minute.value = s.cost_per_minute ?? 5;
    form.cost_mode.value = s.cost_mode || 'flat';
    form.max_per_user.value = s.max_per_user ?? 3;
    form.max_duration_seconds.value = s.max_duration_seconds ?? 600;
    form.allow_youtube.checked = !!s.allow_youtube;
    form.allow_vimeo.checked = !!s.allow_vimeo;
    form.allow_direct_media.checked = !!s.allow_direct_media;
    form.allow_live.checked = !!s.allow_live;
    form.auto_advance.checked = !!s.auto_advance;
}

async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await ownerAction('/api/media/settings', 'PUT', {
        enabled: form.enabled.checked,
        request_cost: Number(form.request_cost.value || 25),
        cost_per_minute: Number(form.cost_per_minute.value || 5),
        cost_mode: form.cost_mode.value,
        max_per_user: Number(form.max_per_user.value || 3),
        max_duration_seconds: Number(form.max_duration_seconds.value || 600),
        allow_youtube: form.allow_youtube.checked,
        allow_vimeo: form.allow_vimeo.checked,
        allow_direct_media: form.allow_direct_media.checked,
        allow_live: form.allow_live.checked,
        auto_advance: form.auto_advance.checked,
    });
}

// ── Owner actions ───────────────────────────────────────────
async function ownerAction(path, method, body, silent = false) {
    if (!mpOwner) return;
    try {
        const data = await mpApi(path, { method, body: body ? JSON.stringify(body) : undefined });
        if (data.settings) mpState.settings = data.settings;
        await refreshState();
    } catch (err) {
        if (!silent) alert(err.message || 'Action failed');
    }
}

async function playRequest(id) {
    await ownerAction(`/api/media/queue/${id}/play`, 'POST');
}
window.playRequest = playRequest;

async function moveRequest(id, direction) {
    await ownerAction(`/api/media/queue/${id}/move`, 'POST', { direction });
}
window.moveRequest = moveRequest;

async function removeRequest(id) {
    await ownerAction(`/api/media/queue/${id}`, 'DELETE');
}
window.removeRequest = removeRequest;

async function refundRequest(id) {
    if (!confirm('Refund coins and remove this request?')) return;
    try {
        await mpApi(`/api/media/queue/${id}/refund`, { method: 'POST' });
        await mpApi(`/api/media/queue/${id}`, { method: 'DELETE' });
        await refreshState();
    } catch (err) {
        alert(err.message || 'Refund failed');
    }
}
window.refundRequest = refundRequest;

// ── Auto-start ──────────────────────────────────────────────
function maybeAutoStart() {
    if (!mpOwner || mpSuppressAutoStart) return;
    const settings = mpState?.settings || {};
    if (settings.auto_advance && !mpState.now_playing && mpState.queue?.length) {
        mpSuppressAutoStart = true;
        ownerAction('/api/media/start', 'POST', undefined, true).finally(() => {
            setTimeout(() => { mpSuppressAutoStart = false; }, 1500);
        });
    }
}

// ── Polling ─────────────────────────────────────────────────
function startPolling() {
    stopPolling();
    mpPollTimer = setInterval(() => {
        refreshState().catch(() => {});
    }, 8000);
}

function stopPolling() {
    if (mpPollTimer) clearInterval(mpPollTimer);
    mpPollTimer = null;
}

// ── WebSocket ───────────────────────────────────────────────
function connectSocket() {
    if (!mpLiveStream?.id) return;
    if (mpSocket && mpSocket._streamId === mpLiveStream.id && mpSocket.readyState <= 1) return;
    try { mpSocket?.close(); } catch {}

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws/chat`);
    if (mpToken()) url.searchParams.set('token', mpToken());
    url.searchParams.set('stream', mpLiveStream.id);

    const socket = new WebSocket(url.toString());
    socket._streamId = mpLiveStream.id;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join_stream', streamId: mpLiveStream.id, token: mpToken() || undefined }));
    });
    socket.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'media_queue_update' && msg.state) {
                mpState = msg.state;
                renderPage();
                maybeAutoStart();
            } else if (msg.type === 'media_now_playing' && msg.request) {
                mpState.now_playing = msg.request;
                renderNowPlaying();
            }
        } catch {}
    });
    socket.addEventListener('close', () => {
        if (mpSocket === socket) mpSocket = null;
    });
    mpSocket = socket;
}

// ── Cleanup ─────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    // Save final position before leaving
    if (mpMedia && mpCurrentRequestId && Number.isFinite(mpMedia.currentTime) && mpMedia.currentTime > 0) {
        navigator.sendBeacon(`/api/media/queue/${mpCurrentRequestId}/position`,
            new Blob([JSON.stringify({ position: mpMedia.currentTime })], { type: 'application/json' }));
    }
    stopPolling();
    stopPositionSave();
    try { mpSocket?.close(); } catch {}
    destroyPlayer();
});

document.addEventListener('DOMContentLoaded', loadMediaPage);
