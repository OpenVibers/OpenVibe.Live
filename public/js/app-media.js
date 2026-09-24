/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — VOD and clip lists and players: pagination and filters, VOD player, clip creator, clip player, chat replay, comments, watch progress.

   Split out of app.js, which every page used to download and parse. This file loads with its
   route (public/features.json); it runs after app.js and relies on app.js globals.
   ═══════════════════════════════════════════════════════════════ */
// Render an AI overview block just above a VOD/clip description element.
function _renderMediaAiOverview(descElId, overview) {
    const desc = document.getElementById(descElId);
    if (!desc || !desc.parentNode) return;
    let box = desc.parentNode.querySelector('.media-ai-overview');
    const txt = (overview || '').trim();
    if (!txt) { if (box) box.remove(); return; }
    if (!box) {
        box = document.createElement('div');
        box.className = 'media-ai-overview';
        desc.parentNode.insertBefore(box, desc);
    }
    box.innerHTML = `<span class="media-ai-label"><i class="fa-solid fa-wand-magic-sparkles"></i> AI overview</span> <span class="media-ai-text">${esc(txt)}</span>`;
}

// Render a collapsible, downloadable transcript block after a VOD/clip description.
// `item` carries {id, title, ai_transcript}. The ' ' sentinel = "no speech" → hidden.
function _fmtTs(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}
// Seek a VOD/clip <video> to a transcript timestamp.
function seekMediaTo(videoId, sec) {
    const v = document.getElementById(videoId);
    if (!v) return;
    try { v.currentTime = Math.max(0, Number(sec) || 0); v.play().catch(() => {}); } catch { /* */ }
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _renderMediaTranscript(descElId, kind, item) {
    const desc = document.getElementById(descElId);
    if (!desc || !desc.parentNode) return;
    const prev = desc.parentNode.querySelector('.media-transcript');
    if (prev) prev.remove();
    const t = ((item && item.ai_transcript) || '').trim();
    let segments = null;
    try { segments = (item && item.ai_transcript_json) ? JSON.parse(item.ai_transcript_json) : null; } catch { segments = null; }
    const hasSegs = Array.isArray(segments) && segments.length > 0;
    if (!t && !hasSegs) {
        // No transcript (yet): say why, instead of silently showing nothing. 'empty' and
        // unknown states stay quiet — there is nothing useful to tell the viewer.
        const st = item && item.transcript_status;
        const msg = (st === 'pending' || st === 'retry' || st === 'processing' || st === null || st === undefined) && item && item.id
            ? (st === 'processing' ? 'Transcript in progress…' : (st ? 'Transcript queued — check back soon' : null))
            : (st === 'failed' ? 'Transcript unavailable for this recording' : null);
        if (!msg) return;
        const note = document.createElement('div');
        note.className = 'media-transcript media-transcript-pending';
        note.innerHTML = `<div class="media-transcript-head"><span class="media-transcript-toggle" style="cursor:default;opacity:.7"><i class="fa-solid ${st === 'failed' ? 'fa-file-circle-xmark' : 'fa-file-lines'}"></i> <span>${esc(msg)}</span></span></div>`;
        desc.parentNode.insertBefore(note, desc.nextSibling);
        return;
    }
    const videoId = kind === 'vod' ? 'vp-video' : 'clp-video';
    const words = (t || segments.map(s => s.text).join(' ')).split(/\s+/).filter(Boolean).length;

    const bodyHtml = hasSegs
        ? `<div class="media-transcript-segs">${segments.map(s =>
            `<button type="button" class="ts-seg" onclick="seekMediaTo('${videoId}', ${Number(s.start) || 0})"><span class="ts-time">${_fmtTs(s.start)}</span><span class="ts-text">${esc(s.text)}</span></button>`
          ).join('')}</div>`
        : `<p class="media-transcript-text">${esc(t)}</p>`;

    const box = document.createElement('div');
    box.className = 'media-transcript';
    box.dataset.filename = `${kind}-${item.id}-transcript`;
    box.dataset.plain = hasSegs ? segments.map(s => `[${_fmtTs(s.start)}] ${s.text}`).join('\n') : t;
    box.innerHTML = `
        <div class="media-transcript-head">
            <button type="button" class="media-transcript-toggle" onclick="toggleMediaTranscript(this)">
                <i class="fa-solid fa-file-lines"></i> <span>Transcript</span>
                <span class="media-transcript-meta">${words} words · ${hasSegs ? 'timestamped · ' : ''}local AI</span>
                <i class="fa-solid fa-chevron-down media-transcript-caret"></i>
            </button>
            <button type="button" class="btn btn-small btn-outline media-transcript-dl" onclick="downloadMediaTranscript(this)" title="Download as .txt">
                <i class="fa-solid fa-download"></i> .txt
            </button>
        </div>
        <div class="media-transcript-body">${bodyHtml}</div>`;
    desc.parentNode.insertBefore(box, desc.nextSibling);
}

function toggleMediaTranscript(btn) {
    const box = btn.closest('.media-transcript');
    if (box) box.classList.toggle('open');
}

function downloadMediaTranscript(btn) {
    const box = btn.closest('.media-transcript');
    if (!box) return;
    const text = box.dataset.plain || box.querySelector('.media-transcript-text')?.textContent || '';
    const name = (box.dataset.filename || 'transcript') + '.txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}       // streamer's user id — the stable chat room key
// The site-wide VOD and clip lists are the Content feed now (public/js/content-feed.js).
// AI "memory" timeline on the VOD player — clickable timestamps that seek the video.
async function loadVodAiTimeline(vodId) {
    const el = document.getElementById('vp-ai-timeline');
    if (!el) return;
    el.style.display = 'none'; el.innerHTML = '';
    try {
        const data = await api(`/vods/${vodId}/memories`);
        const mems = data.memories || [];
        if (!mems.length) return;
        el.innerHTML = `<div class="vod-ai-timeline-title"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Timeline <span class="vod-ai-timeline-hint"><i class="fa-solid fa-hand-pointer"></i> click a moment to jump the video</span></div>` +
            mems.map(m => {
                const t = formatDuration(m.offset_seconds || 0);
                return `<button class="vod-ai-memory" title="Jump to ${t}" onclick="seekVodTo(${Number(m.offset_seconds) || 0})">
                    <span class="vod-ai-memory-t"><i class="fa-solid fa-play vod-ai-memory-play"></i> ${t}</span>
                    <span class="vod-ai-memory-d">${esc(m.description || '')}</span></button>`;
            }).join('');
        el.style.display = '';
    } catch { /* silent */ }
}
function seekVodTo(seconds) {
    const v = document.getElementById('vp-video');
    if (v && Number.isFinite(seconds)) {
        v.currentTime = Math.max(0, seconds);
        if (v.play) v.play().catch(() => {});
        // Bring the viewer back up to the player so the jump is visible.
        try { v.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* */ }
        // Briefly flash the player to signal the jump landed.
        const container = document.getElementById('vp-container') || v.closest('.video-container');
        if (container) { container.classList.remove('vp-seek-flash'); void container.offsetWidth; container.classList.add('vp-seek-flash'); setTimeout(() => container.classList.remove('vp-seek-flash'), 700); }
    }
}

/* ── VOD watch progress (localStorage, per-vod) ───────────────── */
const VOD_PROGRESS_KEY = 'vodProgress';
const VOD_PROGRESS_MAX = 200;        // cap stored entries (LRU-ish by write time)

function _readVodProgressMap() {
    try { return JSON.parse(localStorage.getItem(VOD_PROGRESS_KEY)) || {}; } catch { return {}; }
}
function _getVodProgress(vodId) {
    const m = _readVodProgressMap();
    const e = m[String(vodId)];
    return e && Number.isFinite(e.t) ? e.t : null;
}
function _saveVodProgress(vodId, seconds) {
    const m = _readVodProgressMap();
    m[String(vodId)] = { t: Math.max(0, Math.floor(seconds)), at: Date.now() };
    // Trim oldest if we exceed the cap.
    const keys = Object.keys(m);
    if (keys.length > VOD_PROGRESS_MAX) {
        keys.sort((a, b) => (m[a].at || 0) - (m[b].at || 0));
        for (const k of keys.slice(0, keys.length - VOD_PROGRESS_MAX)) delete m[k];
    }
    try { localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify(m)); } catch { /* quota */ }
}
function _clearVodProgress(vodId) {
    const m = _readVodProgressMap();
    if (m[String(vodId)]) { delete m[String(vodId)]; try { localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify(m)); } catch { /* */ } }
}
// Save currentTime periodically while watching; clear it once effectively finished.
function _attachVodProgressTracking(video, vodId) {
    if (!video || video._progressTracked === vodId) return;
    video._progressTracked = vodId;
    let last = 0;
    video.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - last < 4000) return;      // throttle writes to ~every 4s
        last = now;
        const dur = isFinite(video.duration) ? video.duration : 0;
        const t = video.currentTime || 0;
        if (dur > 0 && t > dur - 10) _clearVodProgress(vodId);  // near the end → don't resume next time
        else if (t > 3) _saveVodProgress(vodId, t);
    });
    video.addEventListener('ended', () => _clearVodProgress(vodId));
    // Best-effort flush on navigate away / tab close.
    window.addEventListener('pagehide', () => {
        const dur = isFinite(video.duration) ? video.duration : 0;
        const t = video.currentTime || 0;
        if (t > 3 && !(dur > 0 && t > dur - 10)) _saveVodProgress(vodId, t);
    }, { once: true });
}
/* ── VOD Player ───────────────────────────────────────────────── */
async function loadVodPlayer(vodId, seekTo) {
    try {
        // Clean up any previous live VOD poll
        if (window._liveVodPollTimer) {
            clearInterval(window._liveVodPollTimer);
            window._liveVodPollTimer = null;
        }
        // Reset live-DVR globals so a previously-viewed live stream's inflated
        // duration can't leak into a completed VOD's timeline (which would let the
        // scrubber seek past the real footage → permanent black screen).
        window._liveVodIsLive = false;
        window._liveVodDuration = 0;
        window._liveVodFilename = null;
        // Clean up chat replay
        if (window._chatReplayTimer) {
            cancelAnimationFrame(window._chatReplayTimer);
            window._chatReplayTimer = null;
        }
        window._vpChatReplay = null;
        const vpMsgs = document.getElementById('vp-chat-replay-messages');
        if (vpMsgs) vpMsgs.innerHTML = '<div class="chat-replay-empty" id="vp-chat-replay-empty"><i class="fa-solid fa-comments" style="font-size:1.5rem"></i><p>Chat messages will appear here as the video plays</p></div>';
        const vpSidebar = document.getElementById('vp-chat-replay');
        if (vpSidebar) vpSidebar.classList.remove('no-data');

        const data = await api(`/vods/${vodId}`);
        const v = data.vod;
        const clips = data.clips || [];

        // Store for comments
        window._vpVodId = v.id;

        document.getElementById('vp-title').textContent = v.title || 'Video';
        setPageTitle(v.title || 'Video');
        loadVodAiTimeline(v.id);
        document.getElementById('vp-streamer').textContent = v.display_name || v.username || 'Unknown';
        { const _a = document.getElementById('vp-avatar'); if (_a) _a.innerHTML = _avatarInner(v.avatar_url, v.username); }
        document.getElementById('vp-date').textContent = formatDateTime(v.created_at);
        document.getElementById('vp-duration').textContent = formatDuration(v.duration_seconds || v.duration);
        document.getElementById('vp-views').textContent = `${v.view_count || 0} views${v.unique_views != null ? ` · ${v.unique_views} unique` : ''}`;
        document.getElementById('vp-description').textContent = v.description || '';
        _renderMediaAiOverview('vp-description', v.ai_overview);
        _renderMediaTranscript('vp-description', 'vod', v);
        // Show this streamer's OpenCoins in the navbar while viewing their VOD.
        if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(v.user_id);

        // Protocol badge
        const vpProto = document.getElementById('vp-protocol');
        if (vpProto) vpProto.innerHTML = v.stream_protocol ? protocolBadge(v.stream_protocol) : '';

        // Enhanced details
        const extraDetails = document.getElementById('vp-extra-details');
        if (extraDetails) {
            let chips = '';
            if (v.stream_category) chips += `<span class="detail-chip"><i class="fa-solid fa-tag"></i> ${esc(_capTag(v.stream_category))}</span>`;
            if (v.stream_peak_viewers) chips += `<span class="detail-chip"><i class="fa-solid fa-users"></i> Peak: ${v.stream_peak_viewers}</span>`;
            if (v.stream_started_at) {
                const streamDate = new Date(v.stream_started_at + 'Z');
                chips += `<span class="detail-chip"><i class="fa-solid fa-calendar"></i> ${streamDate.toLocaleDateString()}</span>`;
            }
            if (chips) { extraDetails.innerHTML = chips; extraDetails.style.display = ''; }
            else extraDetails.style.display = 'none';
        }

        // Handle private VODs
        const video = document.getElementById('vp-video');
        const container = document.getElementById('vp-container');
        const privateNotice = document.getElementById('vp-private-notice');
        const liveIndicator = document.getElementById('vp-live-indicator');
        const jumpLiveBtn = document.getElementById('vp-jump-live');

        if (v.is_private) {
            // Private VOD — show notice instead of video
            video.style.display = 'none';
            if (privateNotice) privateNotice.style.display = '';
            container.querySelector('.video-overlay').style.display = 'none';
        } else if (v.file_path) {
            if (privateNotice) privateNotice.style.display = 'none';
            container.querySelector('.video-overlay').style.display = '';

            // Stream source info
            const vpStream = document.getElementById('vp-stream-source');
            if (vpStream) {
                if (v.is_recording) {
                    vpStream.innerHTML = `<span style="color:#e53e3e;animation:pulse 2s infinite"><i class="fa-solid fa-circle"></i> Recording in progress</span> — VOD is being recorded live`;
                    vpStream.style.display = '';
                } else if (v.stream_title) {
                    vpStream.innerHTML = `<i class="fa-solid fa-tower-broadcast"></i> From stream: <strong>${esc(v.stream_title)}</strong>`;
                    vpStream.style.display = '';
                } else {
                    vpStream.style.display = 'none';
                }
                // Activity strip: chat lines, chatters, viewers, mic moments, follows, report.
                if (typeof renderVodContextStrip === 'function') renderVodContextStrip(v.id);
            }

            const filename = v.file_path.split('/').pop();
            // Record the server-probed duration (ffprobe truth). The player clamps
            // to this when the browser mis-reports the WebM container duration.
            const serverDur = Number(v.duration_seconds || v.duration || 0);
            video.dataset.serverDuration = (serverDur > 0 && !v.is_recording) ? String(serverDur) : '';
            video.src = `/api/vods/file/${filename}?t=${Date.now()}`;
            video.style.display = 'block';

            if (v.is_recording) {
                // Live VOD mode
                container.classList.add('vp-live-mode');
                if (liveIndicator) liveIndicator.style.display = '';

                window._liveVodDuration = v.duration_seconds || 0;
                window._liveVodId = v.id;
                window._liveVodFilename = filename;
                window._liveVodIsLive = true;

                if (jumpLiveBtn) {
                    jumpLiveBtn.onclick = () => {
                        video.src = `/api/vods/file/${filename}?t=${Date.now()}`;
                        video.addEventListener('loadedmetadata', function _jumpOnce() {
                            video.removeEventListener('loadedmetadata', _jumpOnce);
                            const dur = isFinite(video.duration) ? video.duration : window._liveVodDuration;
                            if (dur > 2) video.currentTime = dur - 1;
                            video.play().catch(() => {});
                        });
                    };
                }

                window._liveVodSeekableLoaded = false;
                window._liveVodLastSeekableRefresh = 0;

                window._liveVodPollTimer = setInterval(async () => {
                    try {
                        const info = await api(`/vods/${v.id}/live-info`);
                        if (!info.isRecording) {
                            clearInterval(window._liveVodPollTimer);
                            window._liveVodPollTimer = null;
                            window._liveVodIsLive = false;
                            container.classList.remove('vp-live-mode');
                            if (liveIndicator) liveIndicator.style.display = 'none';
                            loadVodPlayer(v.id);
                            return;
                        }
                        window._liveVodDuration = info.duration || 0;

                        if (info.seekable) {
                            const now = Date.now();
                            const shouldRefresh = !window._liveVodSeekableLoaded ||
                                (now - window._liveVodLastSeekableRefresh > 60000);

                            if (shouldRefresh) {
                                window._liveVodSeekableLoaded = true;
                                window._liveVodLastSeekableRefresh = now;
                                const currentTime = video.currentTime;
                                const wasPaused = video.paused;
                                video.src = `/api/vods/file/${filename}?t=${now}`;
                                video.addEventListener('loadedmetadata', function _restore() {
                                    video.removeEventListener('loadedmetadata', _restore);
                                    const dur = isFinite(video.duration) ? video.duration : window._liveVodDuration;
                                    video.currentTime = Math.min(currentTime, dur);
                                    if (!wasPaused) video.play().catch(() => {});
                                });
                            }
                        }

                        document.getElementById('vp-duration').textContent = formatDuration(info.duration);
                    } catch (e) { /* silent */ }
                }, 15000);
            } else {
                // Normal completed VOD
                container.classList.remove('vp-live-mode');
                if (liveIndicator) liveIndicator.style.display = 'none';
                window._liveVodIsLive = false;
            }

            setupCustomVideoControls('vp');

            // Resume position: an explicit deep-link timestamp (?t=) wins; otherwise
            // restore the viewer's last saved watch position for THIS vod. This also
            // fixes VODs that would otherwise load parked at the very end (a WebM whose
            // container reports the full duration as the initial currentTime).
            if (!v.is_recording) {
                const saved = _getVodProgress(v.id);
                const _dur0 = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : (serverDur || 0));
                let target = null;
                if (seekTo && seekTo > 0) {
                    target = seekTo;                 // deep link (from a clip / timeline share)
                } else if (saved && saved > 3) {
                    target = saved;                  // resume where they left off
                } else {
                    target = 0;                      // start from the beginning
                }
                const _applyStart = function () {
                    video.removeEventListener('loadedmetadata', _applyStart);
                    const dur = _dur0();
                    // Never resume within the last ~10s (counts as "finished" → restart).
                    let t = target;
                    if (dur > 0 && t > dur - 10) t = (seekTo && seekTo > 0) ? Math.max(0, dur - 0.5) : 0;
                    try { video.currentTime = Math.max(0, t); } catch { /* */ }
                    if (seekTo && seekTo > 0) video.play().catch(() => {});
                };
                if (video.readyState >= 1) _applyStart();
                else video.addEventListener('loadedmetadata', _applyStart);

                // Persist progress as they watch (throttled) and clear it when finished.
                _attachVodProgressTracking(video, v.id);
            }

            // Load chat replay data for this VOD
            if (v.stream_id && v.stream_started_at) {
                loadChatReplayData('vp', v.stream_id, v.stream_started_at, v.stream_ended_at);
            }
        }

        // Navigate to streamer on click
        const streamerLink = document.getElementById('vp-streamer-link');
        if (streamerLink && v.username) {
            const targetUrl = channelPath(v.username);
            streamerLink.href = targetUrl;
            streamerLink.onclick = (event) => handleLinkClick(event, targetUrl);
        }

        // Owner/admin controls: change visibility (public/unlisted/private) + delete.
        const vpActions = document.getElementById('vp-actions');
        if (vpActions && currentUser) {
            let canManage = (v.user_id === currentUser.id) || currentUser.capabilities?.moderate_global;
            if (canManage && !v.is_recording) {
                const vis = v.visibility || (v.is_public ? 'public' : 'private');
                vpActions.style.display = '';
                vpActions.innerHTML = `
                    <div class="vp-visibility-control" title="Who can see this video">
                        <i class="fa-solid ${vis === 'public' ? 'fa-globe' : vis === 'unlisted' ? 'fa-link' : 'fa-lock'} vp-visibility-icon" id="vp-visibility-icon"></i>
                        <select id="vp-visibility-select" class="form-input form-input-sm" onchange="setVodVisibilityFromPlayer(${v.id}, this.value)">
                            <option value="public"${vis === 'public' ? ' selected' : ''}>Public</option>
                            <option value="unlisted"${vis === 'unlisted' ? ' selected' : ''}>Unlisted</option>
                            <option value="private"${vis === 'private' ? ' selected' : ''}>Private</option>
                        </select>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteVodFromPlayer(${v.id})"><i class="fa-solid fa-trash"></i> Delete</button>`;
            } else if (canManage) {
                // Still recording — only allow delete once finished; show nothing intrusive.
                vpActions.style.display = '';
                vpActions.innerHTML = `<button class="btn btn-danger btn-small" onclick="deleteVodFromPlayer(${v.id})"><i class="fa-solid fa-trash"></i> Delete</button>`;
            } else {
                vpActions.style.display = 'none';
            }
        }

        // Clips for this VOD
        const clipsGrid = document.getElementById('vp-clips-grid');
        if (clips.length) {
            clipsGrid.innerHTML = clips.map(cl => `
                <a class="stream-card" href="/clip/${cl.id}" onclick="return handleLinkClick(event, '/clip/${cl.id}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
                        <span class="stream-card-viewers">${formatDuration(cl.duration_seconds)}</span>
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    </div>
                </a>
            `).join('');
        } else {
            clipsGrid.innerHTML = '<p class="muted">No clips from this stream</p>';
        }

        // Load comments
        loadComments('vod', v.id, 'vp');
    } catch (e) {
        console.error('Failed to load VOD player', e);
        toast('Failed to load video: ' + (e.message || 'not found'), 'error');
        navigate('/vods');
    }
}

/* ── VOD Clip Creator ─────────────────────────────────────────── */
let _vpClipStart = 0;
let _vpClipEnd = 0;
let _clipDragging = null;      // 'start' | 'end' | null
let _clipPreviewRAF = null;
let _clipVideoDuration = 0;
const CLIP_MAX_DURATION = 60;

function openClipCreator() {
    if (!currentUser) { toast('Login required to create clips', 'info'); return; }
    const modal = document.getElementById('vp-clip-modal');
    const video = document.getElementById('vp-video');
    if (!modal || !video) return;

    _clipVideoDuration = video.duration || 0;
    if (!_clipVideoDuration || !isFinite(_clipVideoDuration)) {
        toast('Video not loaded yet', 'error');
        return;
    }

    // Pause the main video
    video.pause();

    // Initialize clip range: center on current position, 30s default
    const cur = video.currentTime;
    const halfDur = 15;
    _vpClipStart = Math.max(0, cur - halfDur);
    _vpClipEnd = Math.min(_clipVideoDuration, _vpClipStart + 30);
    if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;

    // Setup preview video
    const preview = document.getElementById('clip-preview-video');
    if (preview) {
        const filename = video.src.split('/').pop().split('?')[0];
        preview.src = `/api/vods/file/${filename}`;
        preview.currentTime = _vpClipStart;
        preview.muted = true;
    }

    // Build timeline ticks
    _buildClipTimelineTicks();

    modal.style.display = '';
    document.body.style.overflow = 'hidden';

    _updateClipCreatorUI();
    _setupClipDragHandlers();
    document.addEventListener('keydown', _clipModalKeyHandler);
}

/**
 * Legacy alias — the HTML button still calls toggleVodClipPanel()
 */
function toggleVodClipPanel() {
    const modal = document.getElementById('vp-clip-modal');
    if (modal && modal.style.display !== 'none') {
        closeClipCreator();
    } else {
        openClipCreator();
    }
}

function closeClipCreator() {
    const modal = document.getElementById('vp-clip-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';

    // Stop preview playback
    const preview = document.getElementById('clip-preview-video');
    if (preview) { preview.pause(); preview.removeAttribute('src'); preview.load(); }
    if (_clipPreviewRAF) { cancelAnimationFrame(_clipPreviewRAF); _clipPreviewRAF = null; }

    _teardownClipDragHandlers();
    document.removeEventListener('keydown', _clipModalKeyHandler);
}

function _clipModalKeyHandler(e) {
    if (e.key === 'Escape') { closeClipCreator(); e.stopPropagation(); }
}

function _buildClipTimelineTicks() {
    const ticksEl = document.getElementById('clip-timeline-ticks');
    if (!ticksEl || !_clipVideoDuration) return;
    ticksEl.innerHTML = '';

    // Determine tick interval based on duration
    let interval;
    if (_clipVideoDuration <= 60) interval = 10;
    else if (_clipVideoDuration <= 300) interval = 30;
    else if (_clipVideoDuration <= 1800) interval = 120;
    else if (_clipVideoDuration <= 7200) interval = 300;
    else interval = 600;

    for (let t = 0; t <= _clipVideoDuration; t += interval) {
        const pct = (t / _clipVideoDuration) * 100;
        const tick = document.createElement('span');
        tick.className = 'clip-tick';
        tick.style.left = pct + '%';
        tick.textContent = formatDuration(t);
        ticksEl.appendChild(tick);
    }
}

function _updateClipCreatorUI() {
    if (!_clipVideoDuration) return;
    const startPct = (_vpClipStart / _clipVideoDuration) * 100;
    const endPct = (_vpClipEnd / _clipVideoDuration) * 100;
    const duration = Math.max(0, _vpClipEnd - _vpClipStart);

    // Timeline handles & fill
    const handleStart = document.getElementById('clip-handle-start');
    const handleEnd = document.getElementById('clip-handle-end');
    const fill = document.getElementById('clip-timeline-fill');
    if (handleStart) handleStart.style.left = startPct + '%';
    if (handleEnd) handleEnd.style.left = endPct + '%';
    if (fill) { fill.style.left = startPct + '%'; fill.style.width = (endPct - startPct) + '%'; }

    // Time displays
    const startDisp = document.getElementById('clip-start-display');
    const endDisp = document.getElementById('clip-end-display');
    if (startDisp) startDisp.textContent = formatDuration(Math.floor(_vpClipStart));
    if (endDisp) endDisp.textContent = formatDuration(Math.floor(_vpClipEnd));

    // Duration display
    const durNum = document.getElementById('clip-duration-number');
    const durBar = document.getElementById('clip-duration-bar');
    const durSec = Math.floor(duration);
    if (durNum) {
        durNum.textContent = durSec;
        durNum.classList.toggle('clip-duration-over', durSec > CLIP_MAX_DURATION);
        durNum.classList.toggle('clip-duration-zero', durSec <= 0);
    }
    if (durBar) durBar.style.width = Math.min(100, (durSec / CLIP_MAX_DURATION) * 100) + '%';

    // Create button state
    const btn = document.getElementById('clip-create-btn');
    if (btn) btn.disabled = durSec <= 0 || durSec > CLIP_MAX_DURATION;
}

function setClipMarkToCurrent(which) {
    const video = document.getElementById('vp-video');
    if (!video) return;
    const cur = video.currentTime;
    if (which === 'start') {
        _vpClipStart = Math.max(0, cur);
        if (_vpClipEnd <= _vpClipStart) _vpClipEnd = Math.min(_vpClipStart + 30, _clipVideoDuration);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
    } else {
        _vpClipEnd = Math.min(cur, _clipVideoDuration);
        if (_vpClipStart >= _vpClipEnd) _vpClipStart = Math.max(0, _vpClipEnd - 30);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
    }
    _updateClipCreatorUI();
    _seekClipPreview(_vpClipStart);
}

function nudgeClipMark(which, delta) {
    if (which === 'start') {
        _vpClipStart = Math.max(0, Math.min(_vpClipStart + delta, _clipVideoDuration));
        if (_vpClipStart >= _vpClipEnd) _vpClipEnd = Math.min(_vpClipStart + 1, _clipVideoDuration);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
    } else {
        _vpClipEnd = Math.max(0, Math.min(_vpClipEnd + delta, _clipVideoDuration));
        if (_vpClipEnd <= _vpClipStart) _vpClipStart = Math.max(0, _vpClipEnd - 1);
        if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
    }
    _updateClipCreatorUI();
    _seekClipPreview(which === 'start' ? _vpClipStart : _vpClipEnd - 1);
}

function _seekClipPreview(time) {
    const preview = document.getElementById('clip-preview-video');
    if (preview && preview.readyState >= 1) {
        preview.currentTime = Math.max(0, time);
    }
}

function toggleClipPreview() {
    const preview = document.getElementById('clip-preview-video');
    const btn = document.getElementById('clip-preview-play-btn');
    if (!preview) return;

    if (preview.paused) {
        preview.currentTime = _vpClipStart;
        preview.play().catch(() => {});
        if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        _clipPreviewLoop();
    } else {
        preview.pause();
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (_clipPreviewRAF) { cancelAnimationFrame(_clipPreviewRAF); _clipPreviewRAF = null; }
    }
}

function _clipPreviewLoop() {
    const preview = document.getElementById('clip-preview-video');
    if (!preview || preview.paused) return;

    // Update playhead position
    const playhead = document.getElementById('clip-playhead');
    if (playhead && _clipVideoDuration) {
        const pct = (preview.currentTime / _clipVideoDuration) * 100;
        playhead.style.left = pct + '%';
        playhead.style.display = '';
    }

    // Stop at clip end
    if (preview.currentTime >= _vpClipEnd) {
        preview.pause();
        preview.currentTime = _vpClipStart;
        const btn = document.getElementById('clip-preview-play-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (playhead) playhead.style.display = 'none';
        _clipPreviewRAF = null;
        return;
    }

    _clipPreviewRAF = requestAnimationFrame(_clipPreviewLoop);
}

/* -- Clip timeline drag handlers -- */
let _clipDragBound = {};

function _setupClipDragHandlers() {
    const wrap = document.getElementById('clip-timeline-wrap');
    if (!wrap) return;

    const onMouseDown = (e) => {
        const handle = e.target.closest('.clip-handle-start, .clip-handle-end');
        if (!handle) {
            // Click on timeline bar itself → move nearest handle
            const rect = wrap.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const time = pct * _clipVideoDuration;
            // Move whichever handle is closer
            const distStart = Math.abs(time - _vpClipStart);
            const distEnd = Math.abs(time - _vpClipEnd);
            if (distStart <= distEnd) {
                _vpClipStart = Math.max(0, time);
                if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = _vpClipStart + CLIP_MAX_DURATION;
            } else {
                _vpClipEnd = Math.min(_clipVideoDuration, time);
                if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = _vpClipEnd - CLIP_MAX_DURATION;
            }
            _updateClipCreatorUI();
            _seekClipPreview(_vpClipStart);
            return;
        }
        _clipDragging = handle.classList.contains('clip-handle-start') ? 'start' : 'end';
        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!_clipDragging) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = pct * _clipVideoDuration;

        if (_clipDragging === 'start') {
            _vpClipStart = Math.max(0, Math.min(time, _vpClipEnd - 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = Math.min(_vpClipStart + CLIP_MAX_DURATION, _clipVideoDuration);
        } else {
            _vpClipEnd = Math.min(_clipVideoDuration, Math.max(time, _vpClipStart + 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = Math.max(0, _vpClipEnd - CLIP_MAX_DURATION);
        }
        _updateClipCreatorUI();
        // Live-scrub: show the frame of whichever handle you're dragging (esp. the end).
        _seekClipPreview(_clipDragging === 'end' ? _vpClipEnd : _vpClipStart);
    };

    const onMouseUp = () => {
        if (_clipDragging) {
            _seekClipPreview(_clipDragging === 'end' ? _vpClipEnd : _vpClipStart);
            _clipDragging = null;
        }
    };

    // Touch support
    const onTouchStart = (e) => {
        const handle = e.target.closest('.clip-handle-start, .clip-handle-end');
        if (!handle) return;
        _clipDragging = handle.classList.contains('clip-handle-start') ? 'start' : 'end';
        e.preventDefault();
    };

    const onTouchMove = (e) => {
        if (!_clipDragging) return;
        const touch = e.touches[0];
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
        const time = pct * _clipVideoDuration;

        if (_clipDragging === 'start') {
            _vpClipStart = Math.max(0, Math.min(time, _vpClipEnd - 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipEnd = Math.min(_vpClipStart + CLIP_MAX_DURATION, _clipVideoDuration);
        } else {
            _vpClipEnd = Math.min(_clipVideoDuration, Math.max(time, _vpClipStart + 1));
            if (_vpClipEnd - _vpClipStart > CLIP_MAX_DURATION) _vpClipStart = Math.max(0, _vpClipEnd - CLIP_MAX_DURATION);
        }
        _updateClipCreatorUI();
        _seekClipPreview(_clipDragging === 'end' ? _vpClipEnd : _vpClipStart);
        e.preventDefault();
    };

    const onTouchEnd = () => {
        if (_clipDragging) {
            _seekClipPreview(_clipDragging === 'end' ? _vpClipEnd : _vpClipStart);
            _clipDragging = null;
        }
    };

    wrap.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);

    _clipDragBound = { wrap, onMouseDown, onMouseMove, onMouseUp, onTouchStart, onTouchMove, onTouchEnd };
}

function _teardownClipDragHandlers() {
    const b = _clipDragBound;
    if (b.wrap) {
        b.wrap.removeEventListener('mousedown', b.onMouseDown);
        b.wrap.removeEventListener('touchstart', b.onTouchStart);
    }
    document.removeEventListener('mousemove', b.onMouseMove);
    document.removeEventListener('mouseup', b.onMouseUp);
    document.removeEventListener('touchmove', b.onTouchMove);
    document.removeEventListener('touchend', b.onTouchEnd);
    _clipDragBound = {};
    _clipDragging = null;
}

let _clipCreating = false;
let _clipCooldownUntil = 0;
let _clipCooldownTimer = null;
const CLIP_CLIENT_COOLDOWN_MS = 10000;

async function createVodClip() {
    if (!currentUser) { toast('Login required to create clips', 'info'); return; }

    // Debounce: prevent double-clicks while request is in-flight
    if (_clipCreating) return;

    // Cooldown: enforce client-side wait between clips
    const now = Date.now();
    if (now < _clipCooldownUntil) {
        const secs = Math.ceil((_clipCooldownUntil - now) / 1000);
        toast(`Please wait ${secs}s before creating another clip`, 'info');
        return;
    }

    const vodId = window._vpVodId;
    if (!vodId) { toast('No VOD loaded', 'error'); return; }

    const duration = _vpClipEnd - _vpClipStart;
    if (duration <= 0) { toast('End time must be after start time', 'error'); return; }
    if (duration > CLIP_MAX_DURATION) { toast('Clips are limited to 60 seconds', 'error'); return; }

    const title = document.getElementById('clip-title-input')?.value?.trim() || 'Untitled Clip';
    const btn = document.getElementById('clip-create-btn');

    _clipCreating = true;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }

    try {
        const result = await api('/vods/clips', {
            method: 'POST',
            body: {
                vod_id: vodId,
                start_time: _vpClipStart,
                end_time: _vpClipEnd,
                title,
            }
        });
        toast(result.deduplicated ? 'Clip already exists — opening it' : 'Clip created!', 'success');

        // Start client-side cooldown
        _clipCooldownUntil = Date.now() + CLIP_CLIENT_COOLDOWN_MS;
        _startClipCooldownUI(btn);

        closeClipCreator();
        if (result.clip?.id) {
            navigate(`/clip/${result.clip.id}`);
        } else {
            loadVodPlayer(vodId);
        }
    } catch (err) {
        toast(err.message || 'Failed to create clip', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip'; }
    } finally {
        _clipCreating = false;
    }
}

function _startClipCooldownUI(btn) {
    if (!btn) return;
    if (_clipCooldownTimer) clearInterval(_clipCooldownTimer);
    const update = () => {
        const left = Math.ceil((_clipCooldownUntil - Date.now()) / 1000);
        if (left <= 0) {
            clearInterval(_clipCooldownTimer);
            _clipCooldownTimer = null;
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip';
        } else {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-clock"></i> Wait ${left}s`;
        }
    };
    update();
    _clipCooldownTimer = setInterval(update, 1000);
}

/* ── Clip Player ──────────────────────────────────────────────── */
/** Ask the server to re-render a clip whose cut failed, then resume polling. */
async function recutClip(clipId) {
    const note = document.getElementById('clp-processing-note');
    if (note) note.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:2rem;color:var(--accent)"></i><p class="muted">Re-cutting…</p>';
    try {
        await api(`/clips/${clipId}/recut`, { method: 'POST' });
        toast('Re-cutting the clip — this page will update when it is ready', 'info');
        setTimeout(() => { if (window._clpClipId === clipId) loadClipPlayer(clipId); }, 3000);
    } catch (e) {
        toast(e.message, 'error');
        if (window._clpClipId === clipId) loadClipPlayer(clipId);
    }
}

/**
 * The clip page's attribution line, from the clip's own origin (Media's auto_generated):
 *   a person's clip  → "Clipped by <clipper>"
 *   an auto-clip     → "AI clip · from <streamer>'s stream" and what made it; never "Clipped by"
 *                      the streamer the job filed it under.
 */
function _renderClipAttribution(el, cl) {
    el.textContent = '';
    el.classList.toggle('clp-ai-attribution', !!cl.auto_generated);
    const icon = (cls) => { const i = document.createElement('i'); i.className = cls; i.setAttribute('aria-hidden', 'true'); return i; };
    if (!cl.auto_generated) {
        const who = document.createElement('strong');
        who.textContent = cl.display_name || cl.username || 'Unknown';
        el.append(icon('fa-solid fa-scissors'), ' Clipped by ', who);
        return;
    }
    const streamerName = cl.source_streamer_display_name || cl.streamer_display_name || cl.source_streamer_username || cl.streamer_username || cl.display_name || cl.username;
    const streamerUser = cl.source_streamer_username || cl.streamer_username || cl.username;
    const badge = document.createElement('span');
    badge.className = 'ai-badge';
    badge.textContent = 'AI clip';
    el.append(icon('fa-solid fa-wand-magic-sparkles'), ' ', badge, ' · from ');
    if (streamerName && streamerUser) {
        const a = document.createElement('a');
        const href = channelPath(streamerUser);
        a.href = href;
        a.textContent = streamerName;
        a.addEventListener('click', (event) => handleLinkClick(event, href));
        el.append(a, "'s stream");
    } else {
        el.append('a live stream');
    }
    const how = document.createElement('div');
    how.className = 'muted clp-ai-how';
    how.textContent = 'Cut automatically by OpenVibe\'s auto-clip workflow when chat reacted. No one clipped it.';
    el.append(how);
}

async function loadClipPlayer(clipId) {
    try {
        // Clean up chat replay
        if (window._chatReplayTimer) {
            cancelAnimationFrame(window._chatReplayTimer);
            window._chatReplayTimer = null;
        }
        window._clpChatReplay = null;
        const clpMsgs = document.getElementById('clp-chat-replay-messages');
        if (clpMsgs) clpMsgs.innerHTML = '<div class="chat-replay-empty" id="clp-chat-replay-empty"><i class="fa-solid fa-comments" style="font-size:1.5rem"></i><p>Chat messages will appear here as the clip plays</p></div>';
        const clpSidebar = document.getElementById('clp-chat-replay');
        if (clpSidebar) clpSidebar.classList.remove('no-data');

        const data = await api(`/clips/${clipId}`);
        const cl = data.clip;

        // Store for comments
        window._clpClipId = cl.id;

        document.getElementById('clp-title').textContent = cl.title || 'Clip';
        setPageTitle(cl.title || 'Clip');
        // Reset unlisted badge
        const unlistedBadge = document.getElementById('clp-unlisted-badge');
        if (unlistedBadge) unlistedBadge.style.display = 'none';
        document.getElementById('clp-streamer').textContent = cl.display_name || cl.username || 'Unknown';
        { const _a = document.getElementById('clp-avatar'); if (_a) _a.innerHTML = _avatarInner(cl.avatar_url, cl.username); }
        document.getElementById('clp-date').textContent = formatDateTime(cl.created_at);
        document.getElementById('clp-duration').textContent = formatDuration(cl.duration_seconds);
        document.getElementById('clp-description').textContent = cl.description || '';
        _renderMediaAiOverview('clp-description', cl.ai_overview);
        _renderMediaTranscript('clp-description', 'clip', cl);
        // Show this streamer's OpenCoins in the navbar while viewing their clip.
        if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(cl.user_id);

        // View count
        const clpViews = document.getElementById('clp-views');
        if (clpViews) clpViews.textContent = `${cl.view_count || 0} views${cl.unique_views != null ? ` · ${cl.unique_views} unique` : ''}`;

        // Protocol badge
        const clpProto = document.getElementById('clp-protocol');
        if (clpProto) clpProto.innerHTML = cl.stream_protocol ? protocolBadge(cl.stream_protocol) : '';

        // Enhanced details
        const extraDetails = document.getElementById('clp-extra-details');
        if (extraDetails) {
            let chips = '';
            if (cl.stream_category) chips += `<span class="detail-chip"><i class="fa-solid fa-tag"></i> ${esc(_capTag(cl.stream_category))}</span>`;
            if (cl.stream_peak_viewers) chips += `<span class="detail-chip"><i class="fa-solid fa-users"></i> Peak: ${cl.stream_peak_viewers}</span>`;
            if (cl.stream_started_at) {
                const streamDate = new Date(cl.stream_started_at + 'Z');
                chips += `<span class="detail-chip"><i class="fa-solid fa-calendar"></i> ${streamDate.toLocaleDateString()}</span>`;
            }
            if (chips) { extraDetails.innerHTML = chips; extraDetails.style.display = ''; }
            else extraDetails.style.display = 'none';
        }

        // Stream source + timestamp info
        const clpSource = document.getElementById('clp-stream-source');
        if (clpSource) {
            let sourceHtml = '';
            // Deep-link into the source VOD at the exact moment this clip starts,
            // but only when that VOD is still up and public/unlisted.
            const seekT = Math.max(0, Math.floor(cl.start_time || 0));
            const vodJumpUrl = (cl.vod_id && cl.vod_available) ? `/vod/${cl.vod_id}?t=${seekT}` : null;
            if (cl.stream_title) {
                const titleText = esc(cl.stream_title);
                if (vodJumpUrl) {
                    sourceHtml += `<i class="fa-solid fa-tower-broadcast"></i> From stream: <a href="${vodJumpUrl}" onclick="return handleLinkClick(event, '${vodJumpUrl}')" style="color:var(--accent);text-decoration:none;font-weight:600">${titleText}</a>`;
                } else {
                    sourceHtml += `<i class="fa-solid fa-tower-broadcast"></i> From stream: <strong>${titleText}</strong>`;
                }
                if (cl.start_time > 0) {
                    sourceHtml += ` at <strong>${formatDuration(cl.start_time)}</strong>`;
                }
            } else if (cl.start_time > 0) {
                sourceHtml += `<i class="fa-solid fa-clock"></i> Clipped at <strong>${formatDuration(cl.start_time)}</strong> into the stream`;
            }
            if (vodJumpUrl) {
                sourceHtml += ` <a href="${vodJumpUrl}" onclick="return handleLinkClick(event, '${vodJumpUrl}')" class="clip-vod-jump" title="Watch this moment in the full VOD" style="display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:3px 10px;border-radius:999px;background:var(--accent);color:#fff;font-size:0.8rem;font-weight:600;text-decoration:none"><i class="fa-solid fa-forward"></i> Watch in full VOD</a>`;
            }
            if (sourceHtml) {
                clpSource.innerHTML = sourceHtml;
                clpSource.style.display = '';
            } else {
                clpSource.style.display = 'none';
            }
            // Upgrade the plain line into the rich "from this stream" card when the VOD context loads.
            if (cl.vod_id && typeof renderClipSourceCard === 'function') renderClipSourceCard(cl);
        }

        const video = document.getElementById('clp-video');
        clearTimeout(window._clpProcessingPoll);
        { const _n = document.getElementById('clp-processing-note'); if (_n) _n.remove(); }
        if (!cl.file_path && (cl.status || 'processing') !== 'ready') {
            // A clip with no file is either still being cut or the cut FAILED. These used
            // to render identically — a failed clip showed "the server is cutting your
            // clip" and polled forever, which is why hours-old broken clips still claimed
            // to be in progress. Tell the truth, and offer a retry.
            const failed = String(cl.status || '') === 'failed';
            video.style.display = 'none';
            const container = document.getElementById('clp-container');
            if (container) {
                const note = document.createElement('div');
                note.id = 'clp-processing-note';
                note.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;gap:12px;color:var(--text-muted,#999)';
                note.innerHTML = failed ? `
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:2.5rem;color:var(--danger,#e74c3c)"></i>
                    <p style="font-size:1.05rem;font-weight:600">${cl.will_retry ? 'This clip is being re-cut' : 'This clip failed to render'}</p>
                    ${cl.will_retry ? `<p class="muted" style="font-size:0.82rem;margin:-4px 0 8px"><i class="fa-solid fa-rotate fa-spin"></i> The server retries automatically${cl.cut_next_at ? ' · next try ' + esc(timeAgo(cl.cut_next_at)) : ''}${cl.cut_attempts ? ' · attempt ' + cl.cut_attempts : ''}</p>` : ''}
                    ${cl.cut_error ? `<p class="muted" style="font-size:0.74rem;max-width:520px;margin:0 auto 8px;opacity:0.75">${esc(String(cl.cut_error).split(' | ')[0].slice(0, 160))}</p>` : ''}
                    <p class="muted" style="font-size:0.85rem">The server couldn't cut it from the recording.</p>
                    <button class="btn btn-sm btn-outline" onclick="recutClip(${cl.id})"><i class="fa-solid fa-rotate-right"></i> Try again</button>` : `
                    <i class="fa-solid fa-scissors fa-bounce" style="font-size:2.5rem;color:var(--accent)"></i>
                    <p style="font-size:1.05rem;font-weight:600">Clip is processing…</p>
                    <p class="muted" style="font-size:0.85rem">The server is cutting your clip — this page will update automatically.</p>`;
                container.appendChild(note);
            }
            // Only poll while it is genuinely in progress; polling a failed clip forever
            // was pure noise.
            if (!failed) {
                window._clpProcessingPoll = setTimeout(() => {
                    if (window._clpClipId === cl.id) loadClipPlayer(cl.id);
                }, 3000);
            }
        }
        if (cl.file_path) {
            const filename = cl.file_path.split('/').pop();
            // Handle video load errors (corrupt files, codec issues)
            video.onerror = () => {
                const container = document.getElementById('clp-container');
                if (container) {
                    container.innerHTML = `
                        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:var(--text-muted,#999)">
                            <i class="fa-solid fa-triangle-exclamation" style="font-size:3rem;margin-bottom:12px;color:#ef4444"></i>
                            <p style="font-size:1.1rem">This clip could not be played</p>
                            <p class="muted" style="font-size:0.85rem">The recording may be corrupt or in an unsupported format</p>
                        </div>`;
                }
            };
            video.src = `/api/vods/file/${filename}`;
            video.style.display = 'block';
            setupCustomVideoControls('clp');

            // Load chat replay data for this clip
            if (cl.stream_id && cl.stream_started_at) {
                loadChatReplayData('clp', cl.stream_id, cl.stream_started_at, cl.stream_ended_at, cl.start_time, cl.end_time);
            }
        }

        const streamerLink = document.getElementById('clp-streamer-link');
        if (streamerLink && cl.username) {
            const targetUrl = channelPath(cl.username);
            streamerLink.href = targetUrl;
            streamerLink.onclick = (event) => handleLinkClick(event, targetUrl);
        }

        // Who made it. An auto-clip was cut by OpenVibe's AI when chat reacted, not by the
        // streamer it is filed under (roadmap 33.4): "AI clip · from <streamer>'s stream".
        const clippedByEl = document.getElementById('clp-clipped-by');
        if (clippedByEl) _renderClipAttribution(clippedByEl, cl);

        // Show delete button per the server-authoritative can_delete flag (streamer /
        // channel mod / staff, or the creator only if the channel opted in).
        const clpActions = document.getElementById('clp-actions');
        if (clpActions && currentUser) {
            let canDelete = !!cl.can_delete;
            let isStreamOwner = false;
            // Check if current user owns the stream this clip is from (gates publish toggle)
            if (cl.stream_id) {
                try {
                    const sData = await api(`/streams/${cl.stream_id}`);
                    if (sData.stream && sData.stream.user_id === currentUser.id) {
                        isStreamOwner = true;
                    }
                } catch {}
            }

            let actionsHtml = '';
            // Edit title — clip creator or admin
            if (cl.user_id === currentUser.id || currentUser.capabilities?.moderate_global) {
                actionsHtml += `<button class="btn btn-small" onclick="editClipTitle(${cl.id})"><i class="fa-solid fa-pen"></i> Edit Title</button> `;
            }
            // Publish/unpublish toggle — only for stream owner or admin
            if (isStreamOwner || currentUser.capabilities?.moderate_global) {
                if (cl.is_public) {
                    actionsHtml += `<button class="btn btn-small" onclick="toggleClipVisibility(${cl.id}, false)"><i class="fa-solid fa-eye-slash"></i> Make Unlisted</button>`;
                } else {
                    actionsHtml += `<button class="btn btn-primary btn-small" onclick="toggleClipVisibility(${cl.id}, true)"><i class="fa-solid fa-eye"></i> Make Public</button>`;
                }
            }
            // Unlisted badge for non-public clips
            if (!cl.is_public) {
                const badge = document.getElementById('clp-unlisted-badge');
                if (badge) badge.style.display = '';
            }
            if (canDelete) {
                actionsHtml += ` <button class="btn btn-danger btn-small" onclick="deleteClipFromPlayer(${cl.id})"><i class="fa-solid fa-trash"></i> Delete Clip</button>`;
            }
            if (actionsHtml) {
                clpActions.style.display = '';
                clpActions.innerHTML = actionsHtml;
            }
        }

        // Load comments
        loadComments('clip', cl.id, 'clp');
    } catch (e) {
        toast('Clip not found', 'error');
        navigate('/clips');
    }
}

/* ═══════════════════════════════════════════════════════════════
   Chat Replay System
   Syncs stored chat messages with VOD/clip video playback
   Sidebar always visible — shows empty state or synced messages
   ═══════════════════════════════════════════════════════════════ */

/**
 * Load chat messages for replay and set up sync with video.
 * @param {string} prefix - 'vp' or 'clp'
 * @param {number} streamId - stream the messages belong to
 * @param {string} streamStartedAt - ISO timestamp of stream start
 * @param {string} streamEndedAt - ISO timestamp of stream end (optional)
 * @param {number} clipStartOffset - for clips, seconds into the stream the clip starts
 * @param {number} clipEndOffset - for clips, seconds into the stream the clip ends
 */
async function loadChatReplayData(prefix, streamId, streamStartedAt, streamEndedAt, clipStartOffset, clipEndOffset) {
    const sidebar = document.getElementById(`${prefix}-chat-replay`);
    const emptyEl = document.getElementById(`${prefix}-chat-replay-empty`);
    const container = document.getElementById(`${prefix}-chat-replay-messages`);

    try {
        // For clips, narrow the fetch window to just the clip's time range (+ small buffer)
        const params = new URLSearchParams();
        const streamStartMs = new Date(streamStartedAt + (streamStartedAt.endsWith('Z') ? '' : 'Z')).getTime();
        if (clipStartOffset && streamStartMs) {
            // Fetch from 5s before clip start to clip end
            const clipFromMs = streamStartMs + Math.max(0, (clipStartOffset - 5)) * 1000;
            const clipToMs = streamStartMs + (clipEndOffset || clipStartOffset + 300) * 1000;
            // Format as 'YYYY-MM-DD HH:MM:SS' to match SQLite CURRENT_TIMESTAMP format
            const toSqlite = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
            params.set('from', toSqlite(clipFromMs));
            params.set('to', toSqlite(clipToMs));
        } else {
            if (streamStartedAt) params.set('from', streamStartedAt);
            if (streamEndedAt) params.set('to', streamEndedAt);
        }

        const data = await api(`/chat/${streamId}/replay?${params.toString()}`);
        const messages = data.messages || [];

        if (!messages.length) {
            // No chat data — show empty state with "no data" indicator
            if (sidebar) sidebar.classList.add('no-data');
            if (emptyEl) emptyEl.innerHTML = '<i class="fa-solid fa-comment-slash" style="font-size:1.5rem"></i><p>No chat messages were recorded for this stream</p>';
            return;
        }

        // Has data — clear empty state, prep for sync
        if (sidebar) sidebar.classList.remove('no-data');
        if (emptyEl) emptyEl.remove();

        // Store replay data on window for sync
        const streamStart = new Date(streamStartedAt + (streamStartedAt.endsWith('Z') ? '' : 'Z')).getTime();
        window[`_${prefix}ChatReplay`] = {
            messages,
            streamStart,
            clipStartOffset: clipStartOffset || 0,
            lastIndex: 0,
        };

        // Start sync loop
        startChatReplaySync(prefix);
    } catch (e) {
        console.warn('Failed to load chat replay:', e.message);
        if (sidebar) sidebar.classList.add('no-data');
        if (emptyEl) emptyEl.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="font-size:1.5rem"></i><p>Failed to load chat replay</p>';
    }
}

function startChatReplaySync(prefix) {
    const video = document.getElementById(`${prefix}-video`);
    const container = document.getElementById(`${prefix}-chat-replay-messages`);
    if (!video || !container) return;

    function syncFrame() {
        const replay = window[`_${prefix}ChatReplay`];
        if (!replay) return;

        const currentTime = video.currentTime; // seconds into the video
        // For clips, add the clip's start offset to get stream-relative time
        const streamRelativeSeconds = currentTime + replay.clipStartOffset;
        const currentMs = replay.streamStart + (streamRelativeSeconds * 1000);

        // Find messages up to current time
        let newMessages = false;
        while (replay.lastIndex < replay.messages.length) {
            const msg = replay.messages[replay.lastIndex];
            const msgTime = new Date(msg.timestamp + (msg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();

            if (msgTime <= currentMs) {
                appendChatReplayMessage(container, msg, streamRelativeSeconds, replay.streamStart, replay.clipStartOffset);
                replay.lastIndex++;
                newMessages = true;
            } else {
                break;
            }
        }

        // If user seeked backward, reset and re-render up to current time
        if (replay.lastIndex > 0) {
            const lastMsg = replay.messages[replay.lastIndex - 1];
            const lastMsgTime = new Date(lastMsg.timestamp + (lastMsg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
            if (currentMs < lastMsgTime - 2000) {
                replay.lastIndex = 0;
                container.innerHTML = '';
            }
        }

        if (newMessages) {
            container.scrollTop = container.scrollHeight;
        }

        window._chatReplayTimer = requestAnimationFrame(syncFrame);
    }

    // Clear previous
    if (window._chatReplayTimer) cancelAnimationFrame(window._chatReplayTimer);
    window._chatReplayTimer = requestAnimationFrame(syncFrame);
}

function appendChatReplayMessage(container, msg, streamSeconds, streamStart, clipStartOffset) {
    const div = document.createElement('div');
    div.className = 'chat-replay-msg';

    // Calculate relative time — clip-relative if viewing a clip, stream-relative otherwise
    const msgTime = new Date(msg.timestamp + (msg.timestamp.endsWith('Z') ? '' : 'Z')).getTime();
    const streamRelSecs = (msgTime - streamStart) / 1000;
    const relSecs = Math.max(0, Math.floor(clipStartOffset ? streamRelSecs - clipStartOffset : streamRelSecs));
    const timeStr = formatDuration(relSecs);

    const color = msg.profile_color || '#8b5cf6';
    const name = msg.display_name || msg.username || msg.anon_id || 'Anonymous';

    div.innerHTML = `<span class="cr-time">${timeStr}</span><span class="cr-user" style="color:${esc(color)}">${esc(name)}</span><span class="cr-text">${esc(msg.message)}</span>`;
    container.appendChild(div);

    // Keep max 300 messages in DOM for performance
    while (container.children.length > 300) {
        container.removeChild(container.firstChild);
    }
}

/* ═══════════════════════════════════════════════════════════════
   Comments System (YouTube-style)
   ═══════════════════════════════════════════════════════════════ */

async function loadComments(contentType, contentId, prefix) {
    const countEl = document.getElementById(`${prefix}-comment-count`);
    const listEl = document.getElementById(`${prefix}-comments-list`);
    const formEl = document.getElementById(`${prefix}-comment-form`);
    if (!listEl) return;

    // Show comment form if logged in
    if (formEl) formEl.style.display = currentUser ? '' : 'none';
    // The same thread on OpenVibe.Community (comments are Community threads; the link is offered for items anyone may see).
    let elsewhere = document.getElementById(`${prefix}-comments-elsewhere`);
    if (!elsewhere) {
        elsewhere = document.createElement('p');
        elsewhere.id = `${prefix}-comments-elsewhere`;
        elsewhere.className = 'comments-elsewhere';
        listEl.after(elsewhere);
    }
    elsewhere.replaceChildren();

    try {
        const data = await api(`/comments/${contentType}/${contentId}`);
        const comments = data.comments || [];
        const total = data.total || 0;

        if (countEl) countEl.textContent = total > 0 ? `(${total})` : '';
        if (data.thread && data.thread.url) {
            const a = document.createElement('a');
            a.href = data.thread.url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'View this thread on OpenVibe.Community';
            elsewhere.append(a);
        }

        if (!comments.length) {
            listEl.innerHTML = '<div class="comments-empty"><i class="fa-solid fa-comment-dots" style="font-size:1.5rem;margin-bottom:8px"></i><p>No comments yet. Be the first!</p></div>';
            return;
        }

        listEl.innerHTML = comments.map(c => renderComment(c, contentType, contentId)).join('');
    } catch (e) {
        if (countEl) countEl.textContent = '';
        // Never an empty list that looks real: say what happened.
        if (formEl && e && e.status === 503) formEl.style.display = 'none';
        listEl.innerHTML = e && e.status === 503
            ? '<div class="comments-empty comments-unavailable"><i class="fa-solid fa-plug-circle-exclamation" style="font-size:1.5rem;margin-bottom:8px"></i><p>Comments are unavailable right now. Try again in a moment.</p></div>'
            : `<p class="muted">${esc((e && e.message) || 'Failed to load comments')}</p>`;
    }
}

function renderComment(c, contentType, contentId) {
    if (c.deleted) {
        const replies = c.replies && c.replies.length ? `<div class="comment-replies">${c.replies.map(r => renderComment(r, contentType, contentId)).join('')}</div>` : '';
        return `
        <div class="comment-item comment-deleted" id="comment-${c.id}">
            <div class="comment-avatar" style="background:var(--bg-tertiary, #444)">?</div>
            <div class="comment-body">
                <div class="comment-text muted">This comment was deleted.</div>
                ${replies}
            </div>
        </div>`;
    }
    const name = c.display_name || c.username || 'Unknown';
    const initial = (c.username || name || '?')[0].toUpperCase();
    const color = c.profile_color || '#8b5cf6';
    const canEdit = c.can_edit ?? (currentUser && c.user_id === currentUser.id);
    const canDelete = c.can_delete ?? (canEdit || (currentUser && currentUser.capabilities?.moderate_global));
    const edited = !!c.edited_at || (c.updated_at && c.updated_at !== c.created_at);

    let actionsHtml = '';
    if (currentUser) {
        actionsHtml += `<button onclick="showReplyForm(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-reply"></i> Reply</button>`;
    }
    if (canEdit) {
        actionsHtml += `<button onclick="editComment(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-pen"></i> Edit</button>`;
    }
    if (canDelete) {
        actionsHtml += `<button onclick="deleteCommentAction(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-trash"></i> Delete</button>`;
    }

    let repliesHtml = '';
    if (c.replies && c.replies.length) {
        repliesHtml = `<div class="comment-replies">${c.replies.map(r => renderComment(r, contentType, contentId)).join('')}</div>`;
    }

    return `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-avatar" style="background:${esc(color)}">${esc(initial)}</div>
            <div class="comment-body">
                <div class="comment-meta">
                    <span class="comment-author" style="color:${esc(color)}">${esc(name)}</span>
                    <span class="comment-date">${timeAgo(c.created_at)}${edited ? ' (edited)' : ''}</span>
                    ${c.role === 'admin' ? '<span class="badge" style="font-size:0.7rem;padding:1px 5px">ADMIN</span>' : ''}
                </div>
                <div class="comment-text">${esc(c.message)}</div>
                <div class="comment-actions">${actionsHtml}</div>
                <div id="reply-form-${c.id}"></div>
                ${repliesHtml}
            </div>
        </div>`;
}

async function postComment(contentType, contentId) {
    const prefix = contentType === 'vod' ? 'vp' : 'clp';
    const input = document.getElementById(`${prefix}-comment-input`);
    if (!input) return;

    const message = input.value.trim();
    if (!message) return toast('Write a comment first', 'error');

    try {
        await api(`/comments/${contentType}/${contentId}`, {
            method: 'POST',
            body: { message },
        });
        input.value = '';
        toast('Comment posted', 'success');
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to post comment', 'error');
    }
}

function showReplyForm(parentId, contentType, contentId) {
    const existing = document.getElementById(`reply-form-${parentId}`);
    if (!existing) return;

    // Toggle off if already visible
    if (existing.innerHTML) {
        existing.innerHTML = '';
        return;
    }

    existing.innerHTML = `
        <div class="reply-form">
            <input type="text" id="reply-input-${parentId}" placeholder="Write a reply..." maxlength="2000"
                   onkeydown="if(event.key==='Enter')postReply(${parentId}, '${contentType}', ${contentId})">
            <button class="btn btn-small btn-primary" onclick="postReply(${parentId}, '${contentType}', ${contentId})">Reply</button>
        </div>`;
    document.getElementById(`reply-input-${parentId}`)?.focus();
}

async function postReply(parentId, contentType, contentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    try {
        await api(`/comments/${contentType}/${contentId}`, {
            method: 'POST',
            body: { message, parent_id: parentId },
        });
        toast('Reply posted', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to post reply', 'error');
    }
}

async function editComment(commentId, contentType, contentId) {
    const commentEl = document.getElementById(`comment-${commentId}`);
    if (!commentEl) return;
    const textEl = commentEl.querySelector('.comment-text');
    if (!textEl) return;

    const currentText = textEl.textContent;
    const newText = prompt('Edit comment:', currentText);
    if (newText === null || newText.trim() === currentText) return;

    try {
        await api(`/comments/${commentId}`, {
            method: 'PUT',
            body: { message: newText.trim() },
        });
        toast('Comment updated', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to update comment', 'error');
    }
}

async function deleteCommentAction(commentId, contentType, contentId) {
    if (!confirm('Delete this comment?')) return;

    try {
        await api(`/comments/${commentId}`, { method: 'DELETE' });
        toast('Comment deleted', 'success');
        const prefix = contentType === 'vod' ? 'vp' : 'clp';
        loadComments(contentType, contentId, prefix);
    } catch (e) {
        toast(e.message || 'Failed to delete comment', 'error');
    }
}

/* ── Delete VOD / Clip from player pages ──────────────────────── */
async function deleteVodFromPlayer(vodId) {
    if (!confirm('Delete this video permanently?')) return;
    try {
        await api(`/vods/${vodId}`, { method: 'DELETE' });
        toast('Video deleted', 'success');
        navigate('/vods');
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

// Change a VOD's visibility (public/unlisted/private) from its player page.
async function setVodVisibilityFromPlayer(vodId, visibility) {
    const sel = document.getElementById('vp-visibility-select');
    const icon = document.getElementById('vp-visibility-icon');
    if (sel) sel.disabled = true;
    try {
        await api(`/vods/${vodId}`, { method: 'PUT', body: { visibility } });
        if (icon) icon.className = `fa-solid ${visibility === 'public' ? 'fa-globe' : visibility === 'unlisted' ? 'fa-link' : 'fa-lock'} vp-visibility-icon`;
        const label = visibility === 'public' ? 'Public — anyone can find it'
            : visibility === 'unlisted' ? 'Unlisted — only people with the link'
            : 'Private — only you can see it';
        toast(`Video is now ${label}`, 'success');
    } catch (e) {
        toast(e.message || 'Failed to update visibility', 'error');
    } finally {
        if (sel) sel.disabled = false;
    }
}

async function editClipTitle(clipId) {
    const newTitle = prompt('Enter new clip title:');
    if (newTitle === null) return; // cancelled
    if (!newTitle.trim()) { toast('Title cannot be empty', 'error'); return; }
    try {
        await api(`/clips/${clipId}/title`, {
            method: 'PUT',
            body: { title: newTitle.trim() }
        });
        toast('Title updated', 'success');
        loadClipPlayer(clipId); // refresh the page
    } catch (e) { toast(e.message || 'Failed to update title', 'error'); }
}

async function deleteClipFromPlayer(clipId) {
    if (!confirm('Delete this clip permanently?')) return;
    try {
        await api(`/clips/${clipId}`, { method: 'DELETE' });
        toast('Clip deleted', 'success');
        navigate('/clips');
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

async function toggleClipVisibility(clipId, makePublic) {
    try {
        const data = await api(`/clips/${clipId}/visibility`, {
            method: 'PUT',
            body: { is_public: makePublic }
        });
        toast(data.message || (makePublic ? 'Clip is now public' : 'Clip is now unlisted'), 'success');
        loadClipPlayer(clipId); // refresh the page
    } catch (e) { toast(e.message || 'Failed to update visibility', 'error'); }
}

/* ── Init ─────────────────────────────────────────────────────── */
/* ── Custom VOD / Clip Player Controls ────────────────────────── */
/**
 * Set up themed custom controls for a <video> element.
 * @param {string} prefix - Element ID prefix ('vp' for VOD, 'clp' for clip)
 */
function setupCustomVideoControls(prefix) {
    const video = document.getElementById(`${prefix}-video`);
    const container = document.getElementById(`${prefix}-container`);
    const btnPlay = document.getElementById(`${prefix}-btn-play`);
    const btnVol = document.getElementById(`${prefix}-btn-vol`);
    const volSlider = document.getElementById(`${prefix}-vol-slider`);
    const timeDisplay = document.getElementById(`${prefix}-time`);
    const btnSpeed = document.getElementById(`${prefix}-btn-speed`);
    const btnFullscreen = document.getElementById(`${prefix}-btn-fullscreen`);
    const progressWrap = document.getElementById(`${prefix}-progress-wrap`);
    const progressFill = document.getElementById(`${prefix}-progress-fill`);
    const progressBuffer = document.getElementById(`${prefix}-progress-buffer`);

    if (!video || !container) return;

    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    let speedIdx = 3; // 1x
    let _rafId = null;

    function fmtTime(s) {
        if (!s || isNaN(s) || !isFinite(s)) return '0:00';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
            : `${m}:${String(sec).padStart(2, '0')}`;
    }

    /**
     * Get effective duration.
     * - Live VODs: use the largest known duration (video vs. server live-info).
     * - Completed VODs: trust the browser's container duration UNLESS it is missing
     *   or absurdly larger than the server's ffprobe'd duration. Some WHIP recordings
     *   carry a bogus inflated container duration; trusting it lets the scrubber seek
     *   into a region that has no frames, leaving a permanent black screen. In that
     *   case we clamp to the ffprobe'd truth so the timeline matches the real footage.
     */
    function getEffectiveDuration() {
        const vd = (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : 0;
        if (window._liveVodIsLive && window._liveVodDuration > 0) return Math.max(vd, window._liveVodDuration);
        const sd = parseFloat(video.dataset.serverDuration || '') || 0;
        if (vd > 0 && sd > 0) return (vd > sd * 1.5) ? sd : vd;
        return vd || sd || 0;
    }

    function updateProgress() {
        const dur = getEffectiveDuration();
        if (dur > 0) {
            const pct = (video.currentTime / dur) * 100;
            progressFill.style.width = Math.min(pct, 100) + '%';
            if (window._liveVodIsLive) {
                timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)} [LIVE]`;
            } else {
                timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
            }
        }
        // Update buffer bar
        if (video.buffered.length > 0) {
            const dur2 = getEffectiveDuration();
            if (dur2 > 0) {
                const buffEnd = video.buffered.end(video.buffered.length - 1);
                progressBuffer.style.width = (buffEnd / dur2) * 100 + '%';
            }
        }
        if (!video.paused) _rafId = requestAnimationFrame(updateProgress);
    }

    // Play / Pause
    btnPlay.onclick = () => {
        if (video.paused) { video.play().catch(() => {}); } else { video.pause(); }
    };
    video.addEventListener('play', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';
        container.classList.remove('paused');
        _rafId = requestAnimationFrame(updateProgress);
    });
    video.addEventListener('pause', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
        container.classList.add('paused');
        if (_rafId) cancelAnimationFrame(_rafId);
    });
    video.addEventListener('ended', () => {
        btnPlay.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
        container.classList.add('paused');
    });
    // When the container over-reports its duration, the browser never fires 'ended'
    // at the real end — it keeps "playing" black past the last frame. Detect the
    // clamped case and stop at the true end so the VOD doesn't appear frozen/black.
    video.addEventListener('timeupdate', () => {
        if (window._liveVodIsLive) return;
        const eff = getEffectiveDuration();
        if (eff > 0 && isFinite(video.duration) && video.duration > eff * 1.5 && video.currentTime >= eff - 0.25) {
            video.pause();
            btnPlay.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
            container.classList.add('paused');
        }
    });

    // Click on video to toggle play
    video.addEventListener('click', () => {
        if (video.paused) { video.play().catch(() => {}); } else { video.pause(); }
    });

    // Double-click for fullscreen
    video.addEventListener('dblclick', () => {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else { container.requestFullscreen().catch(() => {}); }
    });

    // Volume
    btnVol.onclick = () => {
        video.muted = !video.muted;
        btnVol.innerHTML = video.muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        volSlider.value = video.muted ? 0 : video.volume * 100;
    };
    volSlider.oninput = () => {
        const v = volSlider.value / 100;
        video.volume = v;
        video.muted = v === 0;
        btnVol.innerHTML = v === 0
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : v < 0.5 ? '<i class="fa-solid fa-volume-low"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
    };

    // Progress seek
    progressWrap.onclick = (e) => {
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) video.currentTime = pct * dur;
    };
    // Drag seek
    let _seeking = false;
    progressWrap.addEventListener('mousedown', (e) => {
        _seeking = true;
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) video.currentTime = pct * dur;
    });
    document.addEventListener('mousemove', (e) => {
        if (!_seeking) return;
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) {
            video.currentTime = pct * dur;
            progressFill.style.width = pct * 100 + '%';
        }
    });
    document.addEventListener('mouseup', () => { _seeking = false; });
    // Touch seek — scoped to the bar (touch events keep firing on the origin element).
    const _touchSeek = (clientX) => {
        const rect = progressWrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const dur = getEffectiveDuration();
        if (dur > 0) { video.currentTime = pct * dur; if (progressFill) progressFill.style.width = pct * 100 + '%'; }
    };
    progressWrap.addEventListener('touchstart', (e) => { _seeking = true; if (e.touches[0]) _touchSeek(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
    progressWrap.addEventListener('touchmove', (e) => { if (_seeking && e.touches[0]) { _touchSeek(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
    progressWrap.addEventListener('touchend', () => { _seeking = false; });

    // Speed
    btnSpeed.onclick = () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        video.playbackRate = speeds[speedIdx];
        btnSpeed.textContent = speeds[speedIdx] + 'x';
    };

    // Fullscreen
    btnFullscreen.onclick = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen().catch(() => {});
        }
    };
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === container) {
            btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i>';
        } else {
            btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i>';
        }
    });

    // Keyboard shortcuts when container/video focused
    container.tabIndex = 0;
    container.addEventListener('keydown', (e) => {
        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                if (video.paused) video.play().catch(() => {}); else video.pause();
                break;
            case 'ArrowLeft':
                e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
            case 'ArrowRight':
                e.preventDefault(); video.currentTime = Math.min(getEffectiveDuration() || 0, video.currentTime + 5); break;
            case 'ArrowUp':
                e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1);
                volSlider.value = video.volume * 100; break;
            case 'ArrowDown':
                e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1);
                volSlider.value = video.volume * 100; break;
            case 'f':
                e.preventDefault();
                if (document.fullscreenElement) document.exitFullscreen();
                else container.requestFullscreen().catch(() => {});
                break;
            case 'm':
                e.preventDefault();
                video.muted = !video.muted;
                btnVol.innerHTML = video.muted
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
                volSlider.value = video.muted ? 0 : video.volume * 100;
                break;
        }
    });

    // Metadata loaded — update time
    video.addEventListener('loadedmetadata', () => {
        const dur = getEffectiveDuration();
        timeDisplay.textContent = `0:00 / ${fmtTime(dur)}`;
    });
    video.addEventListener('timeupdate', updateProgress);
}
