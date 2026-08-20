'use strict';
/* ═══════════════════════════════════════════════════════════════
   broadcast-workspace.js — Managed-stream workspace UI.

   State model (3 explicit classes):

   A. Persistent stream profile (server-backed, per managed stream):
      Structured columns: title, description, category, is_nsfw,
        protocol, control_config_id, slug
        Saved via: PUT /streams/managed/:id  (manual Save button)
      Broadcast settings blob: bitrate, fps, resolution, browserMode,
        micOnlyImage, screenShareOpts
        Saved via: PUT /streams/broadcast-settings  (manual Save button)

   B. Device-local preferences (this browser only):
      camera deviceId, mic deviceId, screen audio prefs
        Stored in: localStorage
        Labeled clearly in UI: "This Device Only"

   C. Live-session transient state (in-memory only):
      broadcastState.streams Map — active stream state,
        tracks, connections, timers, live session id
   ═══════════════════════════════════════════════════════════════ */

/* ── Workspace state ─────────────────────────────────────────── */

let _wsState = {
    managedStreams: [],
    selectedId: null,       // currently selected managed stream ID
    selectedMs: null,       // Class A structured fields (from managed_streams table)
    streamKey: null,        // per-managed-stream key (shown in endpoint tools)
    profile: {},            // Class A blob: { bitrate, fps, resolution, browserMode, ... }
    dirty: false,           // any unsaved change (stream fields or profile blob)
    saving: false,
    history: [],
    activeTab: 'profile',   // current workspace tab
    _liveStatsTimer: null,  // interval for updating live stats
};

const WS_VIBE_DEFAULTS = {
    enabled: 0,
    widget_title: 'Vibe Coding',
    viewer_depth: 'standard',
    show_prompts: 1,
    show_responses: 1,
    show_thinking: 0,
    show_tool_calls: 1,
    show_tool_arguments: 0,
    show_file_events: 1,
    show_file_snippets: 0,
    redact_file_paths: 1,
    paused: 0,
    delay_ms: 0,
    max_events: 18,
    max_prompt_chars: 220,
    max_response_chars: 360,
    max_thinking_chars: 140,
    max_tool_chars: 140,
    max_snippet_chars: 140,
};

function _wsNormalizeVibeSettings(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const boolField = (key, fallback) => {
        if (source[key] === undefined || source[key] === null) return fallback;
        return source[key] ? 1 : 0;
    };
    const intField = (key, fallback, min, max) => {
        const value = parseInt(source[key], 10);
        if (!Number.isFinite(value)) return fallback;
        return Math.min(max, Math.max(min, value));
    };
    const depth = ['headline', 'standard', 'deep'].includes(source.viewer_depth) ? source.viewer_depth : WS_VIBE_DEFAULTS.viewer_depth;
    return {
        enabled: boolField('enabled', WS_VIBE_DEFAULTS.enabled),
        widget_title: String(source.widget_title || WS_VIBE_DEFAULTS.widget_title).trim() || WS_VIBE_DEFAULTS.widget_title,
        viewer_depth: depth,
        show_prompts: boolField('show_prompts', WS_VIBE_DEFAULTS.show_prompts),
        show_responses: boolField('show_responses', WS_VIBE_DEFAULTS.show_responses),
        show_thinking: boolField('show_thinking', WS_VIBE_DEFAULTS.show_thinking),
        show_tool_calls: boolField('show_tool_calls', WS_VIBE_DEFAULTS.show_tool_calls),
        show_tool_arguments: boolField('show_tool_arguments', WS_VIBE_DEFAULTS.show_tool_arguments),
        show_file_events: boolField('show_file_events', WS_VIBE_DEFAULTS.show_file_events),
        show_file_snippets: boolField('show_file_snippets', WS_VIBE_DEFAULTS.show_file_snippets),
        redact_file_paths: (source.redact_file_paths === 0 || source.redact_file_paths === false) ? 0 : 1,
        paused: boolField('paused', WS_VIBE_DEFAULTS.paused),
        delay_ms: intField('delay_ms', WS_VIBE_DEFAULTS.delay_ms, 0, 120000),
        max_events: intField('max_events', WS_VIBE_DEFAULTS.max_events, 1, 100),
        max_prompt_chars: intField('max_prompt_chars', WS_VIBE_DEFAULTS.max_prompt_chars, 60, 1200),
        max_response_chars: intField('max_response_chars', WS_VIBE_DEFAULTS.max_response_chars, 80, 2400),
        max_thinking_chars: intField('max_thinking_chars', WS_VIBE_DEFAULTS.max_thinking_chars, 40, 1200),
        max_tool_chars: intField('max_tool_chars', WS_VIBE_DEFAULTS.max_tool_chars, 40, 1200),
        max_snippet_chars: intField('max_snippet_chars', WS_VIBE_DEFAULTS.max_snippet_chars, 40, 1200),
    };
}

function _wsReadStoredVibeSettings(profile) {
    if (!profile || typeof profile !== 'object') return null;
    return profile.vibeCoding || profile.vibe_coding || null;
}

function _wsGetVibeSettings() {
    _wsState.profile = _wsState.profile || {};
    _wsState.profile.vibeCoding = _wsNormalizeVibeSettings(_wsReadStoredVibeSettings(_wsState.profile));
    return _wsState.profile.vibeCoding;
}

function _wsCollectVibeSettingsFromDom() {
    return _wsNormalizeVibeSettings({
        enabled: document.getElementById('bc-ws-vibe-enabled')?.checked ? 1 : 0,
        widget_title: document.getElementById('bc-ws-vibe-title')?.value.trim() || WS_VIBE_DEFAULTS.widget_title,
        viewer_depth: document.getElementById('bc-ws-vibe-depth')?.value || WS_VIBE_DEFAULTS.viewer_depth,
        show_prompts: document.getElementById('bc-ws-vibe-prompts')?.checked ? 1 : 0,
        show_responses: document.getElementById('bc-ws-vibe-responses')?.checked ? 1 : 0,
        show_thinking: document.getElementById('bc-ws-vibe-thinking')?.checked ? 1 : 0,
        show_tool_calls: document.getElementById('bc-ws-vibe-tools')?.checked ? 1 : 0,
        show_tool_arguments: document.getElementById('bc-ws-vibe-tool-args')?.checked ? 1 : 0,
        show_file_events: document.getElementById('bc-ws-vibe-files')?.checked ? 1 : 0,
        show_file_snippets: document.getElementById('bc-ws-vibe-snippets')?.checked ? 1 : 0,
        redact_file_paths: document.getElementById('bc-ws-vibe-redact-paths')?.checked ? 1 : 0,
        paused: document.getElementById('bc-ws-vibe-paused')?.checked ? 1 : 0,
        delay_ms: document.getElementById('bc-ws-vibe-delay')?.value || WS_VIBE_DEFAULTS.delay_ms,
        max_events: document.getElementById('bc-ws-vibe-max-events')?.value || WS_VIBE_DEFAULTS.max_events,
        max_prompt_chars: document.getElementById('bc-ws-vibe-max-prompt')?.value || WS_VIBE_DEFAULTS.max_prompt_chars,
        max_response_chars: document.getElementById('bc-ws-vibe-max-response')?.value || WS_VIBE_DEFAULTS.max_response_chars,
        max_thinking_chars: document.getElementById('bc-ws-vibe-max-thinking')?.value || WS_VIBE_DEFAULTS.max_thinking_chars,
        max_tool_chars: document.getElementById('bc-ws-vibe-max-tool')?.value || WS_VIBE_DEFAULTS.max_tool_chars,
        max_snippet_chars: document.getElementById('bc-ws-vibe-max-snippet')?.value || WS_VIBE_DEFAULTS.max_snippet_chars,
    });
}

/* ── Init ────────────────────────────────────────────────────── */

async function initBroadcastWorkspace() {
    await _wsLoadManagedStreams();
    _wsRenderSidebar();
    if (_wsState.managedStreams.length > 0) {
        // Reopen the slot this device last had open, if it still exists.
        let openId = _wsState.managedStreams[0].id;
        try {
            const lastId = parseInt(localStorage.getItem('openvibe-ws-last-slot'), 10);
            if (lastId && _wsState.managedStreams.some(ms => ms.id === lastId)) openId = lastId;
        } catch { /* */ }
        await _wsSelectStream(openId);
    } else {
        _wsShowEmpty();
    }
}

async function _wsLoadManagedStreams() {
    try {
        const data = await api('/streams/managed');
        _wsState.managedStreams = data.managed_streams || [];
    } catch {
        _wsState.managedStreams = [];
    }
}

/* ── Sidebar ─────────────────────────────────────────────────── */

function _wsRenderSidebar() {
    const list = document.getElementById('bc-ws-list');
    if (!list) return;

    if (_wsState.managedStreams.length === 0) {
        list.innerHTML = '<p class="bc-ws-empty-hint muted">No stream slots yet.<br>Click <strong>+</strong> to create your first one.</p>';
        return;
    }

    list.innerHTML = _wsState.managedStreams.map(ms => {
        const isSelected = ms.id === _wsState.selectedId;
        const isLive = _wsIsManagedStreamLive(ms.id);
        const proto = _wsMethodLabel(ms.streaming_method || ms.protocol);
        return `
            <div class="bc-ws-item${isSelected ? ' selected' : ''}" onclick="wsSelectStream(${ms.id})">
                <div class="bc-ws-item-status${isLive ? ' live' : ''}"></div>
                <div class="bc-ws-item-body">
                    <div class="bc-ws-item-name">${esc(ms.title || 'Untitled')}</div>
                    <div class="bc-ws-item-meta">
                        <span class="bc-ws-item-proto">${esc(proto)}</span>
                        ${ms.slug ? `<span class="bc-ws-item-slug">/${esc(ms.slug)}</span>` : `<span class="bc-ws-item-slug">#${ms.id}</span>`}
                        ${isLive ? '<span class="bc-ws-live-dot"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
                    </div>
                </div>
                <button class="bc-ws-item-del" onclick="event.stopPropagation();_wsConfirmDelete(${ms.id})" title="Delete slot">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
    }).join('');
}

/** Human-readable method label for sidebar/panel */
function _wsMethodLabel(method) {
    if (method === 'browser') return 'Browser';
    if (method === 'whip') return 'WHIP';
    if (method === 'rtmp') return 'RTMP';
    if (method === 'cli') return 'CLI / FFmpeg';
    // Legacy protocol fallback
    if (method === 'webrtc') return 'Browser';
    if (method === 'jsmpeg') return 'CLI / FFmpeg';
    return (method || 'browser').toUpperCase();
}

function _wsIsManagedStreamLive(managedStreamId) {
    if (!broadcastState?.streams) return false;
    for (const [, ss] of broadcastState.streams) {
        if (ss.streamData?.managed_stream_id === managedStreamId) return true;
    }
    return false;
}

/* ── Stream selection ────────────────────────────────────────── */

// Public – called from sidebar onclick
async function wsSelectStream(managedStreamId) {
    if (_wsState.selectedId === managedStreamId) return;
    if (_wsState.dirty) {
        const action = await _wsConfirmUnsaved('You have unsaved changes. What would you like to do?');
        if (action === 'save') await _wsSaveAll();
        if (action === 'cancel') return;
        // 'discard' falls through
    }
    await _wsSelectStream(managedStreamId);
}

async function _wsSelectStream(managedStreamId) {
    _wsState.selectedId = managedStreamId;
    _wsState.selectedMs = _wsState.managedStreams.find(ms => ms.id === managedStreamId) || null;
    _wsState.dirty = false;
    // Remember the last-opened slot for this device so it reopens next visit.
    try { localStorage.setItem('openvibe-ws-last-slot', String(managedStreamId)); } catch { /* */ }
    _wsRenderSidebar();

    const panel = document.getElementById('bc-ws-panel');
    const empty = document.getElementById('bc-ws-empty');
    if (empty) empty.style.display = 'none';
    if (panel) {
        panel.style.display = '';
        panel.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading stream profile\u2026</div>';
    }

    await _wsLoadProfile(managedStreamId);
    _wsRenderPanel();
    _wsLoadHistory(managedStreamId);
}

async function _wsLoadProfile(managedStreamId) {
    try {
        const data = await api(`/streams/managed/${managedStreamId}/profile`);
        if (data.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...data.managed_stream };
        }
        _wsState.streamKey = data.stream_key || null;
        _wsState.profile = data.broadcast_settings || {};
        _wsState.profile.vibeCoding = _wsNormalizeVibeSettings(_wsReadStoredVibeSettings(_wsState.profile));
        _wsState.whipUrlBase = data.whip_url_base || null;
        _wsState.whipUrlSource = data.whip_url_source || null;
        _wsState.whipUrlWarning = data.whip_url_warning || null;
        _wsState.rtmpUrl = data.rtmp_url || null;
    } catch {
        _wsState.profile = {};
        _wsState.streamKey = _wsState.selectedMs?.stream_key || null;
        _wsState.rtmpUrl = null;
    }
    _wsState.dirty = false;
}

/* ── Panel rendering ─────────────────────────────────────────── */

function _wsShowEmpty() {
    const empty = document.getElementById('bc-ws-empty');
    const panel = document.getElementById('bc-ws-panel');
    if (empty) empty.style.display = '';
    if (panel) panel.style.display = 'none';
}

function _wsRenderPanel() {
    const empty = document.getElementById('bc-ws-empty');
    const panel = document.getElementById('bc-ws-panel');
    if (!panel) return;

    const ms = _wsState.selectedMs;
    if (!ms) { _wsShowEmpty(); return; }

    if (empty) empty.style.display = 'none';
    panel.style.display = '';

    const p = _wsState.profile;
    const vibe = _wsGetVibeSettings();
    const isLive = _wsIsManagedStreamLive(ms.id);
    const method = ms.streaming_method || 'browser';
    const streamKey = _wsState.streamKey || '';
    const vibePublisherUrl = _wsGetVibePublisherUrl();
    const vibeFeedUrl = _wsGetVibeFeedUrl(ms);
    const vibeSlotRef = ms.slug || ms.id;

    // Class C: find active session
    let liveSessionId = null;
    let liveSessionData = null;
    if (broadcastState?.streams) {
        for (const [sid, ss] of broadcastState.streams) {
            if (ss.streamData?.managed_stream_id === ms.id) {
                liveSessionId = sid;
                liveSessionData = ss;
                break;
            }
        }
    }

    // Determine browser submode from managed stream or profile
    const browserMode = ms.browser_mode || p.browserMode || 'camera';

    panel.innerHTML = `
        <!-- ── Panel header ── -->
        <div class="bc-ws-panel-hd">
            <div class="bc-ws-panel-title">
                <h2>${esc(ms.title || 'Untitled Stream')}</h2>
                <span class="bc-ws-slug muted">
                    ${currentUser?.username
                        ? `<a href="${channelPath(currentUser.username, ms.slug || ms.id)}" target="_blank" style="color:var(--text-muted);text-decoration:none"><i class="fa-solid fa-link" style="font-size:0.7rem"></i> openvibe.live${channelPath(currentUser.username, ms.slug || ms.id)}</a>`
                        : ms.slug
                            ? `<i class="fa-solid fa-link" style="font-size:0.7rem"></i> openvibe.live/${esc(ms.slug)}`
                            : `<i class="fa-solid fa-hashtag" style="font-size:0.7rem"></i> Stream #${ms.id}`}
                </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                ${isLive ? '<span class="bc-live-badge bc-ws-live-badge-hd"><i class="fa-solid fa-circle"></i> LIVE</span>' : ''}
                <button class="btn btn-small btn-ghost bc-ws-popout-chat-btn" onclick="_wsOpenPopoutChat()" title="Popout Chat">
                    <i class="fa-solid fa-comment-dots"></i> Chat
                </button>
            </div>
        </div>

        <!-- ── Live session banner (expanded with stats) ── -->
        <div id="bc-ws-live-banner" style="${liveSessionId ? '' : 'display:none'}">
            <div class="bc-ws-live-banner">
                <div class="bc-ws-live-banner-left">
                    <span class="bc-live-badge"><i class="fa-solid fa-circle"></i> LIVE</span>
                    <div class="bc-ws-uptime-wrap">
                        <i class="fa-solid fa-clock"></i>
                        <span id="bc-ws-uptime">${liveSessionId ? _wsFormatUptime(liveSessionData?.startedAt) : ''}</span>
                    </div>
                    ${liveSessionData?.streamData
                        ? `<span class="bc-ws-live-proto-badge">${esc(_wsMethodLabel(liveSessionData.streamData.protocol))}</span>`
                        : ''}
                </div>
                <div class="bc-ws-live-banner-right">
                    <button class="btn btn-small" onclick="_wsOpenPopoutChat()" title="Popout Chat">
                        <i class="fa-solid fa-comment-dots"></i>
                    </button>
                    <button class="btn btn-small" onclick="openViewerPreview()" title="Open viewer page">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="btn btn-small btn-danger" onclick="_wsEndStream()" title="End this stream">
                        <i class="fa-solid fa-stop"></i> End Stream
                    </button>
                </div>
            </div>
            <div class="bc-ws-live-stats" id="bc-ws-live-stats">
                <div class="bc-ws-stat">
                    <span class="bc-ws-stat-val" id="bc-ws-stat-viewers">0</span>
                    <span class="bc-ws-stat-label">Viewers</span>
                </div>
                <div class="bc-ws-stat">
                    <span class="bc-ws-stat-val" id="bc-ws-stat-uptime">0:00</span>
                    <span class="bc-ws-stat-label">Uptime</span>
                </div>
                <div class="bc-ws-stat">
                    <span class="bc-ws-stat-val" id="bc-ws-stat-bitrate">--</span>
                    <span class="bc-ws-stat-label">Bitrate</span>
                </div>
            </div>
        </div>

        <!-- ── Tabs ── -->
        <div class="bc-ws-tabs" id="bc-ws-tabs">
            <button class="bc-ws-tab active" data-wstab="profile" onclick="_wsTabSwitch('profile')">
                <i class="fa-solid fa-sliders"></i> Stream
            </button>
            <button class="bc-ws-tab" data-wstab="settings" onclick="_wsTabSwitch('settings')">
                <i class="fa-solid fa-gear"></i> Settings
            </button>
            <button class="bc-ws-tab" data-wstab="endpoint" onclick="_wsTabSwitch('endpoint')">
                <i class="fa-solid fa-plug"></i> Endpoint
            </button>
            <button class="bc-ws-tab" data-wstab="history" onclick="_wsTabSwitch('history')">
                <i class="fa-solid fa-clock-rotate-left"></i> History
            </button>
        </div>

        <!-- ═══ TAB: Stream Profile ═══ -->
        <div class="bc-ws-tab-panel active" data-wstabpanel="profile">
            <div class="bc-ws-profile-section">

                <div class="form-group">
                    <label>Title</label>
                    <input type="text" id="bc-title" class="form-input"
                        value="${esc(ms.title || '')}"
                        placeholder="What are you streaming?" maxlength="200"
                        oninput="_wsMarkDirty()">
                </div>

                <div class="form-group">
                    <label>Description</label>
                    <textarea id="bc-description" class="form-input" rows="2"
                        placeholder="Optional description\u2026" maxlength="500"
                        oninput="_wsMarkDirty()">${esc(ms.description || '')}</textarea>
                </div>

                <div class="bc-ws-row">
                    <div class="form-group" style="flex:2">
                        <label>Category</label>
                        <select id="bc-category" class="form-input" onchange="_wsMarkDirty()">
                            ${_wsRenderCategoryOptions(ms.category || 'irl')}
                        </select>
                    </div>
                    <div class="form-group" style="flex:1">
                        <label>&nbsp;</label>
                        <label class="bc-toggle-label">
                            <input type="checkbox" id="bc-nsfw" ${ms.is_nsfw ? 'checked' : ''}
                                onchange="_wsMarkDirty()">
                            <i class="fa-solid fa-triangle-exclamation" style="color:var(--danger)"></i> NSFW
                        </label>
                    </div>
                </div>

                <!-- URL Slug -->
                <div class="form-group">
                    <label>URL Slug <span class="muted">(optional)</span></label>
                    <div style="display:flex;align-items:center;gap:6px">
                        <span class="muted" style="font-size:0.82rem;white-space:nowrap">openvibe.live/@${esc(currentUser?.username || '')}/</span>
                        <input type="text" id="bc-slug" class="form-input form-input-sm"
                            value="${esc(ms.slug || '')}" placeholder="my-stream" maxlength="32"
                            oninput="_wsMarkDirty()">
                    </div>
                </div>

                <!-- ═══ Streaming Method ═══ -->
                <div class="form-group">
                    <label>Streaming Method</label>
                    <div class="bc-method-picker bc-method-picker-sm" id="bc-ws-method-picker">
                        ${_wsRenderMethodCards(method)}
                    </div>
                </div>

                <!-- ═══ Browser Sub-mode (only when method is browser) ═══ -->
                <div id="bc-ws-browser-submodes" style="${method === 'browser' ? '' : 'display:none'}">
                    <div class="form-group">
                        <label>Browser Capture Mode</label>
                        <div class="bc-method-picker bc-method-picker-sm" id="bc-ws-browser-mode-picker">
                            ${_wsRenderBrowserModeCards(browserMode)}
                        </div>
                    </div>

                    <!-- Microphone Only: image upload -->
                    <div id="bc-ws-mic-only-opts" style="${browserMode === 'mic_only' ? '' : 'display:none'}">
                        <div class="form-group">
                            <label><i class="fa-solid fa-image"></i> Placeholder Image</label>
                            <p class="muted" style="font-size:0.82rem;margin-bottom:6px">
                                Displayed to viewers instead of video. Recommended: square, 400\u00d7400+.
                            </p>
                            <input type="file" id="bc-ws-mic-image" accept="image/*" class="form-input form-input-sm"
                                onchange="_wsMicImageChanged(this)">
                            <div id="bc-ws-mic-image-preview" class="bc-ws-mic-image-preview">
                                ${p.micOnlyImage ? `<img src="${esc(p.micOnlyImage)}" alt="Mic-only placeholder">` : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Screen Share options -->
                    <div id="bc-ws-screen-opts" style="${browserMode === 'screen' ? '' : 'display:none'}">
                        <div class="bc-ws-screen-info">
                            <i class="fa-solid fa-circle-info"></i>
                            <span>Screen capture is requested when you click Go Live. Toggle the options below to add microphone or camera to your screen share.</span>
                        </div>

                        <div class="bc-ws-screen-section">
                            <label class="bc-ws-screen-section-label">Audio Sources</label>
                            <div class="bc-ws-screen-perm-item">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-screen-mic" ${(p.screenMic !== false) ? 'checked' : ''} onchange="_wsScreenMicToggle(this.checked)">
                                    <i class="fa-solid fa-microphone"></i> Microphone
                                </label>
                                <div id="bc-ws-screen-mic-device" class="bc-ws-screen-device-inline" style="display:none">
                                    <div style="display:flex;gap:4px;align-items:center">
                                        <select id="bc-ws-screen-mic-select" class="form-input form-input-sm" style="max-width:240px;flex:1" onchange="_wsOnMicDeviceChange()">
                                            <option value="default">Default Microphone</option>
                                        </select>
                                        <button type="button" class="btn btn-small btn-ghost" title="Refresh device list" onclick="refreshDeviceLists()" style="flex-shrink:0;padding:4px 7px"><i class="fa-solid fa-rotate"></i></button>
                                    </div>
                                    <div id="bc-ws-mic-meter-wrap" class="bc-mic-meter-wrap" style="display:none">
                                        <canvas id="bc-ws-mic-meter" class="bc-mic-meter" width="360" height="22"></canvas>
                                        <span id="bc-ws-mic-meter-status" class="bc-mic-meter-status">Listening…</span>
                                    </div>
                                </div>
                                <div id="bc-ws-screen-mic-perm" class="bc-ws-screen-perm-inline" style="display:none">
                                    <button class="btn btn-small btn-outline" onclick="_wsRequestMicPermission()">
                                        <i class="fa-solid fa-shield-halved"></i> Allow Microphone Access
                                    </button>
                                </div>
                            </div>
                            <div class="bc-ws-screen-perm-item" style="margin-top:6px">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-screen-sysaudio" ${(p.screenSysAudio !== false) ? 'checked' : ''} onchange="_wsMarkDirty();_wsUpdateCaptureSummary()">
                                    <i class="fa-solid fa-volume-high"></i> System / Tab Audio
                                </label>
                                <p class="muted" style="font-size:0.75rem;margin:2px 0 0 26px">Included in screen capture prompt. Chrome/Edge only.</p>
                            </div>
                        </div>

                        <div class="bc-ws-screen-section">
                            <label class="bc-ws-screen-section-label">Camera Overlay (PiP)</label>
                            <div class="bc-ws-screen-perm-item">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-screen-cam" ${p.screenCam ? 'checked' : ''} onchange="_wsScreenCamToggle(this.checked)">
                                    <i class="fa-solid fa-video"></i> Show camera as picture-in-picture
                                </label>
                                <div id="bc-ws-screen-cam-perm" class="bc-ws-screen-perm-inline" style="display:none">
                                    <button class="btn btn-small btn-outline" onclick="_wsRequestCamPermission()">
                                        <i class="fa-solid fa-shield-halved"></i> Allow Camera Access
                                    </button>
                                </div>
                                <div id="bc-ws-screen-cam-device" class="bc-ws-screen-device-inline" style="display:none">
                                    <div class="form-group" style="margin:0">
                                        <label style="font-size:0.78rem">Camera</label>
                                        <div style="display:flex;gap:4px;align-items:center">
                                            <select id="bc-ws-screen-cam-select" class="form-input form-input-sm" style="max-width:240px;flex:1" onchange="_wsOnCamDeviceChange()">
                                                <option value="default">Default Camera</option>
                                            </select>
                                            <button type="button" class="btn btn-small btn-ghost" title="Refresh device list" onclick="refreshDeviceLists()" style="flex-shrink:0;padding:4px 7px"><i class="fa-solid fa-rotate"></i></button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div id="bc-ws-screen-pip-opts" style="${p.screenCam ? '' : 'display:none'}">
                                <div class="bc-ws-row" style="margin-top:6px">
                                    <div class="form-group" style="margin:0;flex:1">
                                        <label style="font-size:0.78rem">Position</label>
                                        <select id="bc-ws-screen-pip-pos" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                            <option value="bottom-right"${(p.screenPipPos || 'bottom-right') === 'bottom-right' ? ' selected' : ''}>Bottom Right</option>
                                            <option value="bottom-left"${p.screenPipPos === 'bottom-left' ? ' selected' : ''}>Bottom Left</option>
                                            <option value="top-right"${p.screenPipPos === 'top-right' ? ' selected' : ''}>Top Right</option>
                                            <option value="top-left"${p.screenPipPos === 'top-left' ? ' selected' : ''}>Top Left</option>
                                        </select>
                                    </div>
                                    <div class="form-group" style="margin:0;flex:1">
                                        <label style="font-size:0.78rem">Size</label>
                                        <select id="bc-ws-screen-pip-size" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                            <option value="small"${(p.screenPipSize || 'small') === 'small' ? ' selected' : ''}>Small</option>
                                            <option value="medium"${p.screenPipSize === 'medium' ? ' selected' : ''}>Medium</option>
                                            <option value="large"${p.screenPipSize === 'large' ? ' selected' : ''}>Large</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="bc-ws-screen-section">
                            <label class="bc-ws-screen-section-label">What gets captured</label>
                            <div id="bc-ws-capture-summary"></div>
                        </div>

                        <details class="bc-ws-quality bc-ws-screen-quality">
                            <summary><i class="fa-solid fa-film"></i> Screen Share Quality</summary>
                            <div class="bc-ws-quality-inner bc-ws-row">
                                <div class="form-group" style="margin:0;flex:1">
                                    <label style="font-size:0.82rem">Resolution</label>
                                    <select id="bc-ws-screen-resolution" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                        ${['720', '1080', '1440', '2160'].map(r =>
                                            `<option value="${r}"${(p.screenResolution || '1080') === r ? ' selected' : ''}>${r}p</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group" style="margin:0;flex:1">
                                    <label style="font-size:0.82rem">FPS</label>
                                    <select id="bc-ws-screen-fps" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                        ${['15', '24', '30', '60'].map(f =>
                                            `<option value="${f}"${(p.screenFps || '30') === f ? ' selected' : ''}>${f}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group" style="margin:0;flex:2">
                                    <label style="font-size:0.82rem">Bitrate (kbps)</label>
                                    <input type="number" id="bc-ws-screen-bitrate" class="form-input form-input-sm"
                                        value="${p.screenBitrate || 3000}" min="500" max="12000" step="100"
                                        oninput="_wsMarkDirty()">
                                </div>
                            </div>
                        </details>
                    </div>
                </div>

                <!-- Video quality defaults (Class A blob, browser method only) -->
                <div id="bc-ws-quality-wrap" style="${method === 'browser' ? '' : 'display:none'}">
                <details class="bc-ws-quality">
                    <summary><i class="fa-solid fa-film"></i> Video Quality Defaults</summary>
                    <div class="bc-ws-quality-inner bc-ws-row">
                        <div class="form-group" style="margin:0;flex:1">
                            <label style="font-size:0.82rem">Resolution</label>
                            <select id="bc-ws-resolution" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                ${['360', '480', '720', '1080', '1440'].map(r =>
                                    `<option value="${r}"${(p.resolution || '720') === r ? ' selected' : ''}>${r}p</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group" style="margin:0;flex:1">
                            <label style="font-size:0.82rem">FPS</label>
                            <select id="bc-ws-fps" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                ${['24', '30', '60'].map(f =>
                                    `<option value="${f}"${(p.fps || '30') === f ? ' selected' : ''}>${f}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group" style="margin:0;flex:2">
                            <label style="font-size:0.82rem">Bitrate (kbps)</label>
                            <input type="number" id="bc-ws-bitrate" class="form-input form-input-sm"
                                value="${p.bitrate || 2500}" min="500" max="10000" step="100"
                                oninput="_wsMarkDirty()">
                        </div>
                    </div>
                </details>
                </div>

                <!-- Control profile lives under Settings; createNewStream() and the save
                     payload both read #bc-control-config, which is rendered there. -->

                <!-- Hidden element required by createNewStream() -->
                <select id="bc-managed-stream" style="display:none">
                    <option value="${ms.id}" selected>${esc(ms.title || '')}</option>
                </select>
            </div>

            <!-- ── Go Live / Auto-detect section ── -->
            <div class="bc-ws-golive-section" id="bc-ws-golive-section"${liveSessionId ? ' style="display:none"' : ''}>

                ${method === 'browser' ? `
                <!-- Class B: Device-local preferences (browser only) -->
                <div id="bc-ws-device-wrap">
                    <div class="bc-ws-device-local-label">
                        <i class="fa-solid fa-laptop"></i>
                        <strong>This Device Only</strong>
                        <span class="muted">&mdash; camera &amp; mic selection is saved after going live</span>
                    </div>
                    <div id="bc-perm-request" class="bc-perm-request">
                        <p class="bc-perm-hint"><i class="fa-solid fa-shield-halved"></i>
                            <span id="bc-perm-hint-text">${browserMode === 'mic_only' ? 'Browser needs microphone access to stream.'
                                : browserMode === 'camera_only' ? 'Browser needs camera access to stream.'
                                : browserMode === 'screen' ? 'Browser needs screen capture access to stream.'
                                : 'Browser needs camera &amp; mic access to stream.'}</span></p>
                        <button id="bc-perm-btn" class="btn btn-outline" type="button"
                            onclick="requestMediaPermissions()">
                            <i class="fa-solid ${browserMode === 'mic_only' ? 'fa-microphone'
                                : browserMode === 'screen' ? 'fa-display'
                                : 'fa-video'}"></i>
                            <span id="bc-perm-btn-text">${browserMode === 'mic_only' ? 'Allow Microphone'
                                : browserMode === 'camera_only' ? 'Allow Camera'
                                : browserMode === 'screen' ? 'Allow Screen Share'
                                : 'Allow Camera &amp; Mic'}</span>
                        </button>
                        <p id="bc-perm-debug" style="display:none;font-size:0.75rem;color:var(--text-secondary);margin-top:6px"></p>
                    </div>
                    <div id="bc-device-selects" style="display:none">
                        <div class="bc-ws-device-row">
                            <div class="form-group" style="margin:0;flex:1" id="bc-ws-camera-group">
                                <label style="font-size:0.82rem"><i class="fa-solid fa-camera"></i> Camera</label>
                                <div style="display:flex;gap:4px;align-items:center">
                                    <select id="bc-create-camera" class="form-input form-input-sm" style="flex:1">
                                        <option value="default">Default</option>
                                    </select>
                                    <button type="button" class="btn btn-small btn-ghost" title="Refresh device list" onclick="refreshDeviceLists()" style="flex-shrink:0;padding:4px 7px"><i class="fa-solid fa-rotate"></i></button>
                                </div>
                            </div>
                            <div class="form-group" style="margin:0;flex:1" id="bc-ws-audio-group">
                                <label style="font-size:0.82rem"><i class="fa-solid fa-microphone"></i> Microphone</label>
                                <select id="bc-create-audio" class="form-input form-input-sm">
                                    <option value="default">Default</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Screen-share hidden defaults -->
                <input type="checkbox" id="bc-screen-mic-enabled" checked style="display:none">
                <input type="checkbox" id="bc-screen-cam-enabled" style="display:none">
                <input type="checkbox" id="bc-screenPreferCurrentTab-create" style="display:none">
                <select id="bc-screenSystemAudio-create" style="display:none"><option value="include" selected>Include</option><option value="auto">Auto</option><option value="exclude">Exclude</option></select>
                <select id="bc-screenSelfBrowser-create" style="display:none"><option value="exclude" selected>Exclude</option><option value="include">Include</option></select>
                <select id="bc-screenSurfaceSwitching-create" style="display:none"><option value="include" selected>Allow</option><option value="exclude">Disallow</option></select>
                <select id="bc-screen-audio" style="display:none"><option value="default">Default</option></select>
                <select id="bc-screen-camera" style="display:none"><option value="default">Default</option></select>

                <button class="btn btn-primary btn-lg bc-ws-golive-btn"
                    onclick="goLiveFromWorkspace()" id="bc-ws-golive-btn">
                    <i class="fa-solid fa-tower-broadcast"></i> Go Live
                </button>
                <p class="bc-create-reassurance" style="margin-top:6px;font-size:0.82rem">
                    <i class="fa-solid fa-circle-info"></i>
                    Live at <strong>openvibe.live${channelPath(currentUser?.username || 'your-channel', ms.slug || ms.id)}</strong>
                </p>
                ` : `
                <!-- Auto-detect notice for non-browser methods -->
                <div class="bc-ws-autodetect">
                    <div class="bc-ws-autodetect-pulse"></div>
                    <div>
                        <strong>Auto-detect enabled</strong><br>
                        Your stream will go live automatically when ${method === 'rtmp' ? 'your streaming software connects via RTMP'
                            : method === 'whip' ? 'your encoder connects via WHIP'
                            : 'FFmpeg or your streaming tool sends data to the endpoint'}.
                        Configure your software using the <strong>Endpoint</strong> tab, then just start streaming.
                    </div>
                </div>
                <button class="btn btn-small btn-outline" onclick="_wsTabSwitch('endpoint')" style="width:100%">
                    <i class="fa-solid fa-plug"></i> View Endpoint &amp; Setup Instructions
                </button>
                `}
            </div>
        </div>

        <!-- ═══ TAB: Settings ═══ -->
        <div class="bc-ws-tab-panel" data-wstabpanel="settings">
            <div class="bc-ws-profile-section">

                <!-- Control Profile -->
                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-gamepad"></i> Control Profile</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <p class="muted" style="font-size:0.82rem;margin-bottom:10px">
                            Lets viewers send commands to hardware attached to this slot. Leave as None
                            for an ordinary stream.
                        </p>
                        <div class="form-group">
                            <select id="bc-control-config" class="form-input form-input-sm" onchange="_wsMarkDirty()">
                                <option value="">None (no controls)</option>
                            </select>
                        </div>
                    </div>
                </details>

                <!-- Picture-in-picture camera -->
                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-video"></i> Picture-in-picture Camera</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <p class="muted" style="font-size:0.82rem;margin-bottom:10px">
                            Overlay another of your slots on top of this stream. The camera stays a stream
                            in its own right — its own VOD, clips and restreams — so it can be your webcam,
                            a second angle, or a co-host's slot. Viewers can move, resize, mute or hide it
                            themselves; the values below are only where it starts.
                        </p>
                        <div class="form-group">
                            <label>Camera slot</label>
                            <select id="bc-ws-pip-source" class="form-input" onchange="_wsSlotSettingChanged();_wsPipDefaultsToggle()">
                                <option value="">None</option>
                                ${(_wsState.managedStreams || []).filter(o => o.id !== ms.id).map(o =>
                                    `<option value="${o.id}"${String(ms.pip_source_msid || '') === String(o.id) ? ' selected' : ''}>${esc(o.title || ('Slot ' + o.id))}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div id="bc-ws-pip-defaults" style="display:${ms.pip_source_msid ? '' : 'none'}">
                            <div class="bc-ws-row">
                                <div class="form-group" style="flex:1">
                                    <label>Starting corner</label>
                                    <select id="bc-ws-pip-corner" class="form-input form-input-sm" onchange="_wsSlotSettingChanged()">
                                        <option value="br">Bottom Right</option>
                                        <option value="bl">Bottom Left</option>
                                        <option value="tr">Top Right</option>
                                        <option value="tl">Top Left</option>
                                    </select>
                                </div>
                                <div class="form-group" style="flex:1">
                                    <label>Starting size</label>
                                    <select id="bc-ws-pip-size" class="form-input form-input-sm" onchange="_wsSlotSettingChanged()">
                                        <option value="0.18">Small</option>
                                        <option value="0.25">Medium</option>
                                        <option value="0.35">Large</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </details>

                <!-- Restream Destinations -->
                <details class="bc-ws-slot-settings" open>
                    <summary><i class="fa-solid fa-tower-broadcast"></i> Restream Destinations</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <p class="muted" style="font-size:0.82rem;margin-bottom:10px">
                            Stream this slot to external platforms (Twitch, YouTube, Kick, etc.). Each slot can have its own destinations.
                        </p>
                        <div id="bc-ws-restream-list" class="bc-ws-restream-list">
                            <div class="bc-ws-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>
                        </div>
                        <button class="btn btn-small btn-outline" style="margin-top:8px" onclick="_wsAddRestreamDest()">
                            <i class="fa-solid fa-plus"></i> Add Destination
                        </button>
                    </div>
                </details>

                <!-- Chat Overlay -->
                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-closed-captioning"></i> Chat Overlay</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <p class="muted" style="font-size:0.82rem;margin-bottom:8px">
                            Add this URL as a Browser Source in OBS to display chat on stream.
                            This overlay shows chat for this stream slot only, including relayed restream chats.
                        </p>
                        <div class="form-group">
                            <label>Slot Chat Overlay URL</label>
                            <div style="display:flex;gap:6px;align-items:center">
                                <input type="text" class="form-input form-input-sm" readonly
                                    id="bc-ws-overlay-url"
                                    value="${esc(window.location.origin)}/overlay/chat/${esc(currentUser?.username || '')}/${ms.slug || ms.id}">
                                <button class="btn btn-small" onclick="_wsCopyOverlayUrl()" title="Copy URL">
                                    <i class="fa-solid fa-copy"></i>
                                </button>
                                <button class="btn btn-small" onclick="_wsPreviewOverlay()" title="Preview">
                                    <i class="fa-solid fa-external-link"></i>
                                </button>
                            </div>
                        </div>
                        <details style="margin-top:6px">
                            <summary style="font-size:0.82rem;color:var(--text-secondary);cursor:pointer"><i class="fa-solid fa-sliders"></i> Customize</summary>
                            <p class="muted" style="font-size:0.78rem;margin-top:6px">
                                Add query params: <code>?fade=30</code> (seconds, 0 = never), <code>&amp;max=40</code> (max messages),
                                <code>&amp;fontsize=32</code> (px), <code>&amp;bg=1</code> (dark background), <code>&amp;shadow=0</code> (turn off text outline).
                            </p>
                        </details>
                    </div>
                </details>

                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-code"></i> Vibe Coding Feed</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <p class="muted" style="font-size:0.82rem;margin-bottom:10px">
                            Show a live coding activity widget above this slot's chat room. Any compatible publisher can send a sanitized coding feed into this slot, and viewers only see the fields enabled here.
                        </p>
                        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)">
                            <div style="font-weight:600;margin-bottom:8px"><i class="fa-solid fa-plug-circle-bolt"></i> VS Code Quick Setup</div>
                            <ol style="margin:0 0 10px 18px;font-size:0.82rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:6px">
                                <li>Create an API token on the Dashboard using the <strong>GitHub Copilot Companion</strong> preset. That preset includes the <code>vibe_coding_publish</code> scope.</li>
                                <li>In VS Code, run <strong>OpenVibe.Live Copilot Companion: Open Settings</strong>.</li>
                                <li>Paste the publisher URL below into <code>copilotChatWebSocket.url</code>.</li>
                                <li>Paste this slot ID into <code>copilotChatWebSocket.managedStreamId</code> and optionally the slot slug into <code>copilotChatWebSocket.slotSlug</code>.</li>
                                <li>Paste the API token into <code>copilotChatWebSocket.apiToken</code>, then run <strong>Connect</strong>.</li>
                            </ol>
                            <div style="display:flex;flex-wrap:wrap;gap:8px">
                                <button class="btn btn-small btn-outline" onclick="_wsCopyVibeSettingsTemplate()"><i class="fa-solid fa-copy"></i> Copy Settings Template</button>
                                <button class="btn btn-small btn-outline" onclick="navigate('/dashboard')"><i class="fa-solid fa-key"></i> Open Dashboard Tokens</button>
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:2">
                                <label>Publisher WebSocket URL</label>
                                <div style="display:flex;gap:6px;align-items:center">
                                    <input type="text" id="bc-ws-vibe-publisher-url" class="form-input form-input-sm" readonly value="${esc(vibePublisherUrl)}">
                                    <button class="btn btn-small" onclick="_wsCopyVibePublisherUrl()" title="Copy URL"><i class="fa-solid fa-copy"></i></button>
                                </div>
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Managed Stream ID</label>
                                <div style="display:flex;gap:6px;align-items:center">
                                    <input type="text" id="bc-ws-vibe-managed-stream-id" class="form-input form-input-sm" readonly value="${ms.id}">
                                    <button class="btn btn-small" onclick="_wsCopyVibeManagedStreamId()" title="Copy ID"><i class="fa-solid fa-copy"></i></button>
                                </div>
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label>Slot Slug</label>
                                <div style="display:flex;gap:6px;align-items:center">
                                    <input type="text" id="bc-ws-vibe-slot-slug" class="form-input form-input-sm" readonly value="${esc(ms.slug || '')}" placeholder="Optional">
                                    <button class="btn btn-small" onclick="_wsCopyVibeSlotSlug()" title="Copy slug"><i class="fa-solid fa-copy"></i></button>
                                </div>
                            </div>
                            <div class="form-group" style="flex:2">
                                <label>Public Feed Endpoint</label>
                                <div style="display:flex;gap:6px;align-items:center">
                                    <input type="text" id="bc-ws-vibe-feed-url" class="form-input form-input-sm" readonly value="${esc(vibeFeedUrl)}">
                                    <button class="btn btn-small" onclick="_wsCopyVibeFeedUrl()" title="Copy feed URL"><i class="fa-solid fa-copy"></i></button>
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="bc-toggle-label">
                                <input type="checkbox" id="bc-ws-vibe-enabled" ${vibe.enabled ? 'checked' : ''} onchange="_wsSlotSettingChanged()">
                                Enable vibe-coding widget for this slot
                            </label>
                        </div>
                        <div class="form-group">
                            <label class="bc-toggle-label">
                                <input type="checkbox" id="bc-ws-vibe-paused" ${vibe.paused ? 'checked' : ''} onchange="_wsSlotSettingChanged()">
                                Pause viewer updates without disconnecting the publisher
                            </label>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:2">
                                <label>Widget Title</label>
                                <input type="text" id="bc-ws-vibe-title" class="form-input form-input-sm"
                                    value="${esc(vibe.widget_title || 'Vibe Coding')}" maxlength="80"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Viewer Depth</label>
                                <select id="bc-ws-vibe-depth" class="form-input" onchange="_wsSlotSettingChanged()">
                                    <option value="headline" ${vibe.viewer_depth === 'headline' ? 'selected' : ''}>Headline</option>
                                    <option value="standard" ${vibe.viewer_depth === 'standard' ? 'selected' : ''}>Standard</option>
                                    <option value="deep" ${vibe.viewer_depth === 'deep' ? 'selected' : ''}>Deep</option>
                                </select>
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label>Delay (ms)</label>
                                <input type="number" id="bc-ws-vibe-delay" class="form-input form-input-sm"
                                    value="${vibe.delay_ms || 0}" min="0" max="120000"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Max Events</label>
                                <input type="number" id="bc-ws-vibe-max-events" class="form-input form-input-sm"
                                    value="${vibe.max_events || 18}" min="1" max="100"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                        </div>
                        <div class="bc-ws-row" style="flex-wrap:wrap">
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-prompts" ${vibe.show_prompts ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Prompts</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-responses" ${vibe.show_responses ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Responses</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-thinking" ${vibe.show_thinking ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Thinking summaries</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-tools" ${vibe.show_tool_calls ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Tool calls</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-tool-args" ${vibe.show_tool_arguments ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Tool argument previews</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-files" ${vibe.show_file_events ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> File events</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-snippets" ${vibe.show_file_snippets ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> File snippets</label>
                            <label class="bc-toggle-label" style="min-width:220px"><input type="checkbox" id="bc-ws-vibe-redact-paths" ${vibe.redact_file_paths ? 'checked' : ''} onchange="_wsSlotSettingChanged()"> Redact file paths</label>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label>Prompt Chars</label>
                                <input type="number" id="bc-ws-vibe-max-prompt" class="form-input form-input-sm"
                                    value="${vibe.max_prompt_chars || 220}" min="60" max="1200"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Response Chars</label>
                                <input type="number" id="bc-ws-vibe-max-response" class="form-input form-input-sm"
                                    value="${vibe.max_response_chars || 360}" min="80" max="2400"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Thinking Chars</label>
                                <input type="number" id="bc-ws-vibe-max-thinking" class="form-input form-input-sm"
                                    value="${vibe.max_thinking_chars || 140}" min="40" max="1200"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label>Tool Chars</label>
                                <input type="number" id="bc-ws-vibe-max-tool" class="form-input form-input-sm"
                                    value="${vibe.max_tool_chars || 140}" min="40" max="1200"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Snippet Chars</label>
                                <input type="number" id="bc-ws-vibe-max-snippet" class="form-input form-input-sm"
                                    value="${vibe.max_snippet_chars || 140}" min="40" max="1200"
                                    oninput="_wsSlotSettingChanged()">
                            </div>
                        </div>
                        <p class="muted" style="font-size:0.78rem;margin:8px 0 0">
                            This slot listens on <code>${esc(vibeSlotRef)}</code>. The same publish/feed endpoints also work for other coding publishers, not just the Copilot reference extension.
                        </p>
                    </div>
                </details>

                <!-- VOD / Clips Settings -->
                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-film"></i> VOD &amp; Clips Settings</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-vod-recording" ${ms.slot_vod_recording_enabled !== 0 ? 'checked' : ''}
                                        onchange="_wsSlotSettingChanged()">
                                    Record VODs
                                </label>
                            </div>
                            <div class="form-group" style="flex:1">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-clip-recording" ${ms.slot_clip_recording_enabled !== 0 ? 'checked' : ''}
                                        onchange="_wsSlotSettingChanged()">
                                    Allow Clips
                                </label>
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label class="bc-toggle-label">
                                    <input type="checkbox" id="bc-ws-clip-notify" ${ms.slot_clip_notify_enabled !== 0 ? 'checked' : ''}
                                        onchange="_wsSlotSettingChanged()">
                                    Announce new clips in chat
                                </label>
                            </div>
                        </div>
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:1">
                                <label>Default VOD Visibility</label>
                                <select id="bc-ws-vod-visibility" class="form-input" onchange="_wsSlotSettingChanged()">
                                    <option value="public" ${(ms.default_vod_visibility || 'public') === 'public' ? 'selected' : ''}>Public</option>
                                    <option value="unlisted" ${ms.default_vod_visibility === 'unlisted' ? 'selected' : ''}>Unlisted (link only)</option>
                                    <option value="private" ${ms.default_vod_visibility === 'private' ? 'selected' : ''}>Private</option>
                                </select>
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Default Clip Visibility</label>
                                <select id="bc-ws-clip-visibility" class="form-input" onchange="_wsSlotSettingChanged()">
                                    <option value="public" ${(ms.default_clip_visibility || 'public') === 'public' ? 'selected' : ''}>Public</option>
                                    <option value="unlisted" ${ms.default_clip_visibility === 'unlisted' ? 'selected' : ''}>Unlisted (link only)</option>
                                    <option value="private" ${ms.default_clip_visibility === 'private' ? 'selected' : ''}>Private</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </details>

                <!-- Weather Widget Settings -->
                <details class="bc-ws-slot-settings">
                    <summary><i class="fa-solid fa-cloud-sun"></i> Weather Widget Settings</summary>
                    <div class="bc-ws-slot-settings-inner">
                        <div class="bc-ws-row">
                            <div class="form-group" style="flex:2">
                                <label>Zip/Location</label>
                                <input type="text" id="bc-ws-weather-zip" class="form-input form-input-sm"
                                    value="${esc(ms.weather_zip || '')}" placeholder="e.g. 90210"
                                    maxlength="20" oninput="_wsSlotSettingChanged()">
                            </div>
                            <div class="form-group" style="flex:1">
                                <label>Detail Level</label>
                                <select id="bc-ws-weather-detail" class="form-input" onchange="_wsSlotSettingChanged()">
                                    <option value="basic" ${(ms.weather_detail || 'basic') === 'basic' ? 'selected' : ''}>Current Only</option>
                                    <option value="hourly" ${ms.weather_detail === 'hourly' ? 'selected' : ''}>+ 8-Hour Forecast</option>
                                    <option value="detailed" ${ms.weather_detail === 'detailed' ? 'selected' : ''}>+ 24-Hour &amp; 7-Day</option>
                                    <option value="off" ${ms.weather_detail === 'off' ? 'selected' : ''}>Off</option>
                                </select>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="bc-toggle-label">
                                <input type="checkbox" id="bc-ws-weather-location" ${ms.weather_show_location ? 'checked' : ''}
                                    onchange="_wsSlotSettingChanged()">
                                <i class="fa-solid fa-map-marker-alt"></i> Show Location on Stream
                            </label>
                        </div>
                    </div>
                </details>

            </div>
        </div>

        <!-- ═══ TAB: Endpoint & Key ═══ -->
        <div class="bc-ws-tab-panel" data-wstabpanel="endpoint">
            <div class="bc-ws-endpoint-section">
                <div class="bc-ws-endpoint-hd">
                    <h3><i class="fa-solid fa-plug"></i> Stream Endpoint &amp; Key</h3>
                </div>
                <p class="bc-ws-endpoint-note">
                    This key belongs to <strong>${esc(ms.title || 'this stream slot')}</strong>.
                    Each slot has its own stable key. Regenerating invalidates the current key immediately.
                </p>
                <div class="bc-ws-key-row">
                    <div class="bc-ws-key-display">
                        <input type="password" id="bc-ws-stream-key" class="form-input form-input-sm bc-ws-key-input"
                            value="${esc(streamKey)}" readonly autocomplete="off" spellcheck="false"
                            aria-label="Stream key">
                        <button class="btn btn-small btn-ghost bc-ws-key-toggle"
                            onclick="_wsToggleKeyVisibility()" title="Show / hide key">
                            <i class="fa-solid fa-eye" id="bc-ws-key-eye"></i>
                        </button>
                        <button class="btn btn-small btn-ghost"
                            onclick="_wsCopyStreamKey()" title="Copy stream key">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                    <button class="btn btn-small btn-outline bc-ws-regen-btn"
                        onclick="_wsRegenerateKey(${ms.id})">
                        <i class="fa-solid fa-arrows-rotate"></i> Regen Key
                    </button>
                </div>
                <div id="bc-ws-method-endpoint">${_wsRenderMethodEndpoint(method, streamKey, ms.id)}</div>
            </div>
        </div>

        <!-- ═══ TAB: History ═══ -->
        <div class="bc-ws-tab-panel" data-wstabpanel="history">
            <div class="bc-ws-profile-section">
                <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Sessions</h3>
                <div id="bc-ws-history-list" class="bc-ws-history-list">
                    <p class="muted" style="padding:12px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading\u2026</p>
                </div>
            </div>
        </div>
    `;

    // Restore active tab
    _wsTabSwitch(_wsState.activeTab || 'profile');

    // Async post-render: populate control configs and check device permissions
    _wsPopulateControlConfigs(ms.control_config_id);
    // Corner/size selects are derived from the stored {x,y,w} fractions.
    _wsPipDefaultsRestore(ms);
    if (method === 'browser') {
        _wsInitDevicePicker(method, browserMode);
        _wsSyncScreenShareHiddenDefaults(browserMode);
    }

    // Start live stats timer if live
    _wsStartLiveStatsTimer(liveSessionId, liveSessionData);

    // Ensure floating save bar exists in document body
    _wsEnsureSaveBar();

    // Load restream destinations for this slot
    _wsLoadRestreamDests(ms.id);
}

/* ── Tab switching ───────────────────────────────────────────── */

function _wsTabSwitch(tabId) {
    _wsState.activeTab = tabId;
    document.querySelectorAll('.bc-ws-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.wstab === tabId)
    );
    document.querySelectorAll('.bc-ws-tab-panel').forEach(p =>
        p.classList.toggle('active', p.dataset.wstabpanel === tabId)
    );
    // Load history lazily when switching to history tab
    if (tabId === 'history' && _wsState.selectedId) {
        _wsLoadHistory(_wsState.selectedId);
    }
}

/* ── Floating save bar (Discord-style) ───────────────────────── */

function _wsEnsureSaveBar() {
    if (document.getElementById('bc-ws-save-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'bc-ws-save-bar hidden';
    bar.id = 'bc-ws-save-bar';
    bar.style.display = 'none';
    bar.innerHTML = `
        <span id="bc-ws-save-status" class="bc-ws-save-status bc-ws-dirty">Unsaved changes</span>
        <button class="btn btn-small bc-ws-discard-btn" onclick="_wsDiscardChanges()">
            Discard
        </button>
        <button class="btn btn-primary btn-small bc-ws-save-btn" id="bc-ws-save-btn"
            onclick="_wsSaveAll()">
            <i class="fa-solid fa-floppy-disk"></i> Save Changes
        </button>
    `;
    document.body.appendChild(bar);
}

function _wsDiscardChanges() {
    _wsState.dirty = false;
    _wsUpdateSaveButton();
    // Re-render panel to restore original values
    if (_wsState.selectedId) _wsSelectStream(_wsState.selectedId);
}

/* ── Custom confirm modal (replaces browser confirm()) ───────── */

function _wsConfirmUnsaved(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'bc-ws-confirm-overlay';
        overlay.innerHTML = `
            <div class="bc-ws-confirm-dialog">
                <h3><i class="fa-solid fa-triangle-exclamation" style="color:var(--warning)"></i> Unsaved Changes</h3>
                <p>${esc(message || 'You have unsaved changes.')}</p>
                <div class="bc-ws-confirm-actions">
                    <button class="btn btn-small" id="bc-ws-confirm-cancel">Cancel</button>
                    <button class="btn btn-small btn-outline" id="bc-ws-confirm-discard">Discard</button>
                    <button class="btn btn-small btn-primary" id="bc-ws-confirm-save">
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cleanup = (result) => {
            overlay.remove();
            resolve(result);
        };
        overlay.querySelector('#bc-ws-confirm-cancel').onclick = () => cleanup('cancel');
        overlay.querySelector('#bc-ws-confirm-discard').onclick = () => cleanup('discard');
        overlay.querySelector('#bc-ws-confirm-save').onclick = () => cleanup('save');
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup('cancel'); });
    });
}

/** General-purpose confirm dialog (OK/Cancel) — for destructive actions like regenerate key, delete */
function _wsConfirmAction(message, { title = 'Are you sure?', okLabel = 'Confirm', okClass = 'btn-danger' } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'bc-ws-confirm-overlay';
        overlay.innerHTML = `
            <div class="bc-ws-confirm-dialog">
                <h3><i class="fa-solid fa-triangle-exclamation" style="color:var(--warning)"></i> ${esc(title)}</h3>
                <p>${esc(message)}</p>
                <div class="bc-ws-confirm-actions">
                    <button class="btn btn-small" id="bc-ws-confirm-cancel">Cancel</button>
                    <button class="btn btn-small ${okClass}" id="bc-ws-confirm-ok">${esc(okLabel)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cleanup = (result) => {
            overlay.remove();
            resolve(result);
        };
        overlay.querySelector('#bc-ws-confirm-cancel').onclick = () => cleanup(false);
        overlay.querySelector('#bc-ws-confirm-ok').onclick = () => cleanup(true);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    });
}

/* ── Live stats timer ────────────────────────────────────────── */

function _wsStartLiveStatsTimer(liveSessionId, liveSessionData) {
    if (_wsState._liveStatsTimer) clearInterval(_wsState._liveStatsTimer);
    if (!liveSessionId) return;

    const update = () => {
        const uptimeEl = document.getElementById('bc-ws-uptime');
        const statUptimeEl = document.getElementById('bc-ws-stat-uptime');
        const statViewersEl = document.getElementById('bc-ws-stat-viewers');
        const statBitrateEl = document.getElementById('bc-ws-stat-bitrate');

        if (uptimeEl && liveSessionData?.startedAt) {
            uptimeEl.textContent = _wsFormatUptime(liveSessionData.startedAt);
        }
        if (statUptimeEl && liveSessionData?.startedAt) {
            statUptimeEl.textContent = _wsFormatUptime(liveSessionData.startedAt);
        }
        if (statViewersEl && liveSessionData?.streamData) {
            const viewers = liveSessionData.streamData.viewer_count || 0;
            statViewersEl.textContent = String(viewers);
        }
        if (statBitrateEl) {
            // Try to read bitrate from broadcastState stats
            const stats = broadcastState?.stats;
            if (stats?.bitrate) {
                statBitrateEl.textContent = Math.round(stats.bitrate / 1000) + ' kbps';
            }
        }
    };

    update();
    _wsState._liveStatsTimer = setInterval(update, 1000);
}

/* ── End stream (remote kill) ────────────────────────────────── */

async function _wsEndStream() {
    const confirmed = await _wsConfirmUnsaved('End this live stream? Viewers will be disconnected.');
    if (confirmed === 'cancel') return;
    if (confirmed === 'save') await _wsSaveAll();

    // Find the active session for this managed stream
    const liveSessionId = _wsGetLiveSessionId(_wsState.selectedId);
    if (!liveSessionId) {
        toast('No active stream found', 'error');
        return;
    }

    try {
        await api(`/streams/${liveSessionId}/end`, { method: 'POST' });
        if (typeof stopBroadcast === 'function') stopBroadcast();
        toast('Stream ended', 'success');
        updateWorkspaceLiveStatus();
    } catch (err) {
        toast(err?.message || 'Failed to end stream', 'error');
    }
}

/* ── Popout chat ─────────────────────────────────────────────── */

function _wsOpenPopoutChat() {
    const ms = _wsState.selectedMs;
    if (!ms) return;

    // Use the managed stream's live session ID if live, otherwise open global chat for the channel
    const liveSessionId = _wsGetLiveSessionId(ms.id);
    if (liveSessionId && typeof popoutChat === 'function') {
        popoutChat('stream', liveSessionId);
    } else {
        // Even when not live, open a popout chat scoped to the channel
        if (typeof popoutChat === 'function') {
            popoutChat('global');
        } else {
            const params = new URLSearchParams({ popout: '1', mode: 'global' });
            window.open(`/popout-chat.html?${params.toString()}`, `openvibe-chat-global`,
                'width=400,height=600,menubar=no,toolbar=no,resizable=yes');
        }
    }
}

/* ── Method cards ────────────────────────────────────────────── */

function _wsRenderMethodCards(selected) {
    const methods = [
        { id: 'browser', icon: 'globe', label: 'Browser', hint: 'Camera, mic, or screen from your browser' },
        { id: 'whip', icon: 'satellite-dish', label: 'WHIP', hint: 'OBS WHIP encoder / external WebRTC' },
        { id: 'rtmp', icon: 'server', label: 'RTMP', hint: 'OBS / Streamlabs / IRL Pro' },
        { id: 'cli', icon: 'terminal', label: 'CLI / FFmpeg', hint: 'FFmpeg, Pi, RTSP cameras' },
    ];
    return methods.map(m => `
        <div class="bc-method-card-sm${selected === m.id ? ' selected' : ''}"
            data-wsmethod="${m.id}" onclick="_wsSelectMethod('${m.id}')">
            <i class="fa-solid fa-${m.icon}"></i>
            <strong>${m.label}</strong>
            <span class="bc-card-sm-hint">${m.hint}</span>
        </div>`).join('');
}

function _wsRenderBrowserModeCards(selected) {
    const modes = [
        { id: 'camera', icon: 'video', label: 'Camera & Mic', hint: 'Webcam + microphone' },
        { id: 'camera_only', icon: 'camera', label: 'Camera Only', hint: 'Video only, no audio' },
        { id: 'mic_only', icon: 'microphone', label: 'Mic Only', hint: 'Audio-only with image' },
        { id: 'screen', icon: 'display', label: 'Screen Share', hint: 'Tab, window, or display' },
    ];
    return modes.map(m => `
        <div class="bc-method-card-sm${selected === m.id ? ' selected' : ''}"
            data-wsbrowsermode="${m.id}" onclick="_wsSelectBrowserMode('${m.id}')">
            <i class="fa-solid fa-${m.icon}"></i>
            <strong>${m.label}</strong>
            <span class="bc-card-sm-hint">${m.hint}</span>
        </div>`).join('');
}

/* ── Category options ────────────────────────────────────────── */

function _wsRenderCategoryOptions(selected) {
    const cats = [
        ['outdoors', 'Outdoors'], ['travel', 'Travel'], ['building', 'Building/Craft'],
        ['music', 'Music'], ['gaming', 'Gaming'], ['robot', 'Robot'],
        ['desktop', 'Desktop'], ['irl', 'IRL'], ['other', 'Other'],
    ];
    return cats.map(([v, l]) =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`
    ).join('');
}

/* ── Method-specific endpoint info ───────────────────────────── */

function _wsRenderMethodEndpoint(method, streamKey, managedStreamId) {
    if (!streamKey) return '';
    const rtmpServer = _wsState.rtmpUrl || 'rtmp://openvibe.live/live';

    if (method === 'rtmp') {
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">RTMP Server</span>
                <div class="bc-ws-method-info-val">
                    <code>${esc(rtmpServer)}</code>
                    <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(rtmpServer)}')" title="Copy">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Stream Key</span>
                <span class="bc-ws-method-info-note">Use the key shown above</span>
            </div>
            <p class="bc-ws-method-info-hint">
                <strong>OBS:</strong> Settings &rarr; Stream &rarr; Service: Custom &rarr; paste server &amp; key above.<br>
                <strong>Streamlabs / IRL Pro:</strong> Use Custom RTMP with the same server &amp; key.
            </p>
        </div>`;
    }

    if (method === 'browser') {
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Browser Streaming</span>
                <span class="bc-ws-method-info-note">Use the Go Live button on the Stream tab &mdash; no extra config needed.</span>
            </div>
            <p class="bc-ws-method-info-hint">
                Your browser will capture camera, microphone, and/or screen depending on your selected capture mode.
                Make sure to allow permissions when prompted.
            </p>
        </div>`;
    }

    if (method === 'whip') {
        const whipBaseUrl = (_wsState.whipUrlBase || window.location.origin).replace(/\/$/, '');
        const whipUrl = `${whipBaseUrl}/whip/${managedStreamId || streamKey}`;
        return `
        <div class="bc-ws-method-info">
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">WHIP URL</span>
                <div class="bc-ws-method-info-val">
                    <code style="word-break:break-all">${esc(whipUrl)}</code>
                    <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(whipUrl)}')" title="Copy WHIP URL">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            <div class="bc-ws-method-info-row">
                <span class="bc-ws-method-info-label">Bearer Token</span>
                <span class="bc-ws-method-info-note">Use the stream key shown above as the Bearer Token in OBS.</span>
            </div>
            <p class="bc-ws-method-info-hint">
                <strong>OBS WHIP setup:</strong> Settings &rarr; Stream &rarr; Service: WHIP &rarr; paste URL above.
                Set Bearer Token to your stream key. Your stream will auto-start when OBS begins transmitting.
            </p>
        </div>`;
    }

    if (method === 'cli') {
        const whipBaseUrl = (_wsState.whipUrlBase || window.location.origin).replace(/\/$/, '');
        const whipUrl = `${whipBaseUrl}/whip/${managedStreamId || streamKey}`;
        return `
        <div class="bc-ws-method-info">
            <h4 style="margin:8px 0 4px"><i class="fa-solid fa-terminal"></i> CLI / FFmpeg Streaming</h4>
            <p class="bc-ws-method-info-hint" style="margin-bottom:8px">
                Stream from the command line using <strong>FFmpeg</strong>, <strong>GStreamer</strong>, or any tool that outputs to RTMP, WebRTC (WHIP), or JSMPEG.
                Pick the protocol that fits your use case below.
            </p>

            <div class="bc-ws-cli-tabs" id="bc-ws-cli-tabs">
                <button type="button" class="bc-ws-cli-tab active" onclick="_wsCliTab('jsmpeg')"><i class="fa-solid fa-bolt"></i> JSMPEG</button>
                <button type="button" class="bc-ws-cli-tab" onclick="_wsCliTab('rtmp')"><i class="fa-solid fa-server"></i> RTMP</button>
                <button type="button" class="bc-ws-cli-tab" onclick="_wsCliTab('whip')"><i class="fa-solid fa-satellite-dish"></i> WebRTC (WHIP)</button>
            </div>

            <!-- ═══ JSMPEG Tab ═══ -->
            <div class="bc-ws-cli-panel active" data-clipanel="jsmpeg">
                <p class="bc-ws-cli-desc"><strong>Lowest latency</strong> &mdash; uses MPEG-TS over HTTP. Best for robots, Raspberry Pi, or any scenario where sub-second latency matters. Limited to MPEG1 video codec.</p>
                <p class="muted" style="font-size:0.82rem"><i class="fa-solid fa-circle-info"></i> Port will be assigned once the stream session starts.</p>

                <h5><i class="fa-solid fa-video"></i> Camera + Audio</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f v4l2 -framerate 24 -i /dev/video0 \\
  -f alsa -i default \\
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k \\
  -codec:a mp2 -b:a 96k -ar 44100 \\
  http://openvibe.live:PORT/${esc(streamKey)}/640/480/</pre>

                <h5><i class="fa-solid fa-display"></i> Screen Capture (Linux X11)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f x11grab -s 1280x720 -r 24 -i :0.0 \\
  -f pulse -i default \\
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 400k \\
  -codec:a mp2 -b:a 96k -ar 44100 \\
  http://openvibe.live:PORT/${esc(streamKey)}/640/480/</pre>

                <h5><i class="fa-solid fa-film"></i> MP4 / File Loop</h5>
                <pre class="bc-ws-cli-code">ffmpeg -re -stream_loop -1 -i video.mp4 \\
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 400k \\
  -codec:a mp2 -b:a 96k -ar 44100 \\
  http://openvibe.live:PORT/${esc(streamKey)}/640/480/</pre>

                <h5><i class="fa-solid fa-microchip"></i> Raspberry Pi Camera</h5>
                <pre class="bc-ws-cli-code"># Pi Camera v2 / libcamera &rarr; JSMPEG
rpicam-vid -t 0 --width 640 --height 480 --framerate 24 \\
  --codec yuv420 -o - | \\
  ffmpeg -f rawvideo -pix_fmt yuv420p -s 640x480 -r 24 -i - \\
  -f mpegts -codec:v mpeg1video -b:v 350k \\
  http://openvibe.live:PORT/${esc(streamKey)}/640/480/</pre>

                <h5><i class="fa-solid fa-camera-cctv"></i> RTSP / IP Camera</h5>
                <pre class="bc-ws-cli-code">ffmpeg -rtsp_transport tcp -i rtsp://user:pass@192.168.1.100:554/stream \\
  -f mpegts -codec:v mpeg1video -s 640x480 -b:v 400k \\
  -codec:a mp2 -b:a 96k -ar 44100 \\
  http://openvibe.live:PORT/${esc(streamKey)}/640/480/</pre>

                <details class="bc-ws-cli-note">
                    <summary>About JSMPEG</summary>
                    <p>JSMPEG uses MPEG1 video decoded in JavaScript — no native video element needed.
                    Quality is lower than H.264 but latency can be under 200ms.
                    Ideal for IoT, robots, and embedded hardware. Audio uses MP2 codec at 44100 Hz sample rate.</p>
                </details>
            </div>

            <!-- ═══ RTMP Tab ═══ -->
            <div class="bc-ws-cli-panel" data-clipanel="rtmp">
                <p class="bc-ws-cli-desc"><strong>Best compatibility</strong> &mdash; RTMP works with nearly all streaming tools (OBS, Streamlabs, FFmpeg, GStreamer). Supports H.264 video + AAC audio at high quality. Slightly higher latency than JSMPEG or WHIP.</p>

                <div class="bc-ws-method-info-row" style="margin-bottom:8px">
                    <span class="bc-ws-method-info-label">RTMP Server</span>
                    <div class="bc-ws-method-info-val">
                        <code>rtmp://openvibe.live/live</code>
                        <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('rtmp://openvibe.live/live')" title="Copy"><i class="fa-solid fa-copy"></i></button>
                    </div>
                </div>

                <h5><i class="fa-solid fa-video"></i> Camera + Audio</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default \\
  -c:v libx264 -preset veryfast -b:v 2500k \\
  -c:a aac -b:a 128k \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-display"></i> Screen Capture (Linux X11)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f x11grab -s 1920x1080 -r 30 -i :0.0 \\
  -f pulse -i default \\
  -c:v libx264 -preset veryfast -b:v 3000k \\
  -c:a aac -b:a 128k \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-display"></i> Screen Capture (macOS)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f avfoundation -framerate 30 -i "1:0" \\
  -c:v libx264 -preset veryfast -b:v 3000k \\
  -c:a aac -b:a 128k \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-film"></i> MP4 / File Loop</h5>
                <pre class="bc-ws-cli-code">ffmpeg -re -stream_loop -1 -i video.mp4 \\
  -c:v libx264 -preset veryfast -b:v 2500k \\
  -c:a aac -b:a 128k \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-camera-cctv"></i> RTSP / IP Camera</h5>
                <pre class="bc-ws-cli-code">ffmpeg -rtsp_transport tcp -i rtsp://user:pass@192.168.1.100:554/stream \\
  -c:v libx264 -preset veryfast -b:v 2000k \\
  -c:a aac -b:a 96k \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-microchip"></i> Raspberry Pi Camera</h5>
                <pre class="bc-ws-cli-code"># Pi Camera &rarr; RTMP
rpicam-vid -t 0 --width 1280 --height 720 --framerate 30 \\
  --codec h264 --bitrate 2000000 -o - | \\
  ffmpeg -f h264 -i - -c:v copy -an \\
  -f flv ${esc(rtmpServer)}/${esc(streamKey)}</pre>

                <h5><i class="fa-solid fa-robot"></i> GStreamer</h5>
                <pre class="bc-ws-cli-code">gst-launch-1.0 v4l2src ! videoconvert ! \\
  x264enc tune=zerolatency bitrate=2500 ! flvmux ! \\
  rtmpsink location="${esc(rtmpServer)}/${esc(streamKey)}"</pre>
            </div>

            <!-- ═══ WebRTC (WHIP) Tab ═══ -->
            <div class="bc-ws-cli-panel" data-clipanel="whip">
                <p class="bc-ws-cli-desc"><strong>Low latency + high quality</strong> &mdash; WHIP (WebRTC HTTP Ingest Protocol) supports H.264/VP8/VP9 + Opus audio. Sub-second latency with modern codecs. Requires FFmpeg 7+ or GStreamer with WHIP support.</p>

                <div class="bc-ws-method-info-row" style="margin-bottom:4px">
                    <span class="bc-ws-method-info-label">WHIP URL</span>
                    <div class="bc-ws-method-info-val">
                        <code style="word-break:break-all">${esc(whipUrl)}</code>
                        <button class="btn btn-xs btn-ghost" onclick="_wsCopyText('${esc(whipUrl)}')" title="Copy"><i class="fa-solid fa-copy"></i></button>
                    </div>
                </div>
                <div class="bc-ws-method-info-row" style="margin-bottom:8px">
                    <span class="bc-ws-method-info-label">Bearer Token</span>
                    <span class="bc-ws-method-info-note">Use the stream key above</span>
                </div>

                <h5><i class="fa-solid fa-video"></i> Camera + Audio (FFmpeg 7+)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default \\
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \\
  -c:a libopus -b:a 128k -ar 48000 \\
  -f whip "${esc(whipUrl)}"</pre>

                <h5><i class="fa-solid fa-display"></i> Screen Capture (FFmpeg 7+)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -f x11grab -s 1920x1080 -r 30 -i :0.0 \\
  -f pulse -i default \\
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 3000k \\
  -c:a libopus -b:a 128k -ar 48000 \\
  -f whip "${esc(whipUrl)}"</pre>

                <h5><i class="fa-solid fa-film"></i> MP4 / File Loop (FFmpeg 7+)</h5>
                <pre class="bc-ws-cli-code">ffmpeg -re -stream_loop -1 -i video.mp4 \\
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \\
  -c:a libopus -b:a 128k -ar 48000 \\
  -f whip "${esc(whipUrl)}"</pre>

                <h5><i class="fa-solid fa-robot"></i> GStreamer WHIP</h5>
                <pre class="bc-ws-cli-code">gst-launch-1.0 v4l2src ! videoconvert ! \\
  x264enc tune=zerolatency bitrate=2500 ! video/x-h264,profile=baseline ! \\
  whipsink whip-endpoint="${esc(whipUrl)}"</pre>

                <details class="bc-ws-cli-note">
                    <summary>About WHIP via CLI</summary>
                    <p>WHIP support in FFmpeg requires version 7.0+ (released April 2024). Run <code>ffmpeg -version</code> to check.
                    On older systems, use the RTMP tab instead. GStreamer WHIP requires the <code>gst-plugins-rs</code> Rust plugins.
                    The Bearer token goes in the <code>Authorization</code> header automatically when using <code>-f whip</code>.</p>
                </details>
            </div>

            <!-- ═══ Common Reference ═══ -->
            <details class="bc-ws-cli-examples" style="margin-top:12px">
                <summary><i class="fa-solid fa-circle-question"></i> Input Device Reference</summary>
                <div class="bc-ws-cli-examples-inner">
                    <h5>Finding Devices</h5>
                    <pre class="bc-ws-cli-code"># Linux cameras
v4l2-ctl --list-devices

# Linux audio
arecord -l           # ALSA devices
pactl list sources   # PulseAudio sources

# macOS devices
ffmpeg -f avfoundation -list_devices true -i ""

# Windows devices
ffmpeg -f dshow -list_devices true -i dummy</pre>

                    <h5>Common Input Formats</h5>
                    <table class="bc-ws-cli-ref-table">
                        <tr><th>Platform</th><th>Video</th><th>Audio</th></tr>
                        <tr><td>Linux</td><td><code>-f v4l2 -i /dev/video0</code></td><td><code>-f alsa -i default</code> or <code>-f pulse -i default</code></td></tr>
                        <tr><td>macOS</td><td><code>-f avfoundation -i "0"</code></td><td><code>-f avfoundation -i ":0"</code></td></tr>
                        <tr><td>Windows</td><td><code>-f dshow -i video="cam"</code></td><td><code>-f dshow -i audio="mic"</code></td></tr>
                        <tr><td>Pi Camera</td><td><code>rpicam-vid -o -</code></td><td><code>-f alsa -i hw:0</code></td></tr>
                        <tr><td>RTSP</td><td colspan="2"><code>-rtsp_transport tcp -i rtsp://user:pass@ip:554/stream</code></td></tr>
                    </table>
                </div>
            </details>
        </div>`;
    }

    return '';
}

/* ── Device picker init (Class B) ────────────────────────────── */

async function _wsInitDevicePicker(method, browserMode) {
    const wrap = document.getElementById('bc-ws-device-wrap');
    if (wrap) wrap.style.display = method !== 'browser' ? 'none' : '';
    if (method !== 'browser') return;

    // In screen mode, hide the main permission/device section — handled inline
    if (browserMode === 'screen') {
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (permReq) permReq.style.display = 'none';
        if (devSelects) devSelects.style.display = 'none';
        // Check if mic/cam permissions already granted and show inline devices
        await _wsCheckScreenInlinePermissions();
        return;
    }

    // Hide camera selector in mic-only mode
    const camGroup = document.getElementById('bc-ws-camera-group');
    if (camGroup) camGroup.style.display = (browserMode === 'mic_only') ? 'none' : '';

    // Hide audio selector in camera-only mode
    const audioGroup = document.getElementById('bc-ws-audio-group');
    if (audioGroup) audioGroup.style.display = (browserMode === 'camera_only') ? 'none' : '';

    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = devices.some(d => d.label);
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (hasLabels) {
            if (permReq) permReq.style.display = 'none';
            if (devSelects) devSelects.style.display = '';
            if (typeof populateCreateFormDevices === 'function') await populateCreateFormDevices();
            // Restore persisted device selections for this slot (localStorage first, then server profile)
            _wsRestoreSlotDevices();
            _wsRestoreDevicesFromProfile();
        } else {
            if (permReq) permReq.style.display = '';
            if (devSelects) devSelects.style.display = 'none';
        }
    } catch (err) {
        console.warn('[Workspace] Device enumeration failed:', err.message);
    }
}

/** Persist current device selections for the active slot */
function _wsPersistSlotDevices() {
    const slotId = _wsState.selectedId;
    if (!slotId) return;
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    const data = {};
    if (camSel?.value && camSel.value !== 'default') data.camera = camSel.value;
    if (audSel?.value && audSel.value !== 'default') data.audio = audSel.value;
    if (Object.keys(data).length) {
        try { localStorage.setItem(`openvibe-slot-devices-${slotId}`, JSON.stringify(data)); } catch {}
    }
}

/** Restore persisted device selections for the active slot */
function _wsRestoreSlotDevices() {
    const slotId = _wsState.selectedId;
    if (!slotId) return;
    try {
        const raw = localStorage.getItem(`openvibe-slot-devices-${slotId}`);
        if (!raw) return;
        const data = JSON.parse(raw);
        const camSel = document.getElementById('bc-create-camera');
        const audSel = document.getElementById('bc-create-audio');
        if (data.camera && camSel) {
            const opt = Array.from(camSel.options).find(o => o.value === data.camera);
            if (opt) camSel.value = data.camera;
        }
        if (data.audio && audSel) {
            const opt = Array.from(audSel.options).find(o => o.value === data.audio);
            if (opt) audSel.value = data.audio;
        }
    } catch {}
}

/** Restore device selections from server-side profile (fallback when localStorage has nothing) */
function _wsRestoreDevicesFromProfile() {
    const p = _wsState.profile;
    if (!p) return;
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    // Only apply if the selects are still on 'default' (localStorage didn't override)
    if (p.lastCameraDeviceId && camSel && camSel.value === 'default') {
        const opt = Array.from(camSel.options).find(o => o.value === p.lastCameraDeviceId);
        if (opt) camSel.value = p.lastCameraDeviceId;
    }
    if (p.lastAudioDeviceId && audSel && audSel.value === 'default') {
        const opt = Array.from(audSel.options).find(o => o.value === p.lastAudioDeviceId);
        if (opt) audSel.value = p.lastAudioDeviceId;
    }
}

/** Save device selections to server-side profile after going live */
async function _wsSaveDevicesToProfile() {
    const slotId = _wsState.selectedId;
    if (!slotId) return;
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    const camDevice = camSel?.value || null;
    const audDevice = audSel?.value || null;
    if (!camDevice && !audDevice) return;

    try {
        const profileUpdate = { ..._wsState.profile };
        if (camDevice && camDevice !== 'default') profileUpdate.lastCameraDeviceId = camDevice;
        if (audDevice && audDevice !== 'default') profileUpdate.lastAudioDeviceId = audDevice;
        // Find labels for the selected devices
        if (camSel && camSel.selectedOptions?.[0]?.text) profileUpdate.lastCameraLabel = camSel.selectedOptions[0].text;
        if (audSel && audSel.selectedOptions?.[0]?.text) profileUpdate.lastAudioLabel = audSel.selectedOptions[0].text;
        await api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: slotId, settings: profileUpdate },
        });
        _wsState.profile = profileUpdate;
    } catch (err) {
        console.warn('[Workspace] Failed to save device selections to profile:', err.message);
    }
}

/** Sync hidden screen-share checkbox defaults from profile blob */
function _wsSyncScreenShareHiddenDefaults(browserMode) {
    const micEl = document.getElementById('bc-screen-mic-enabled');
    const camEl = document.getElementById('bc-screen-cam-enabled');
    const syaEl = document.getElementById('bc-screenSystemAudio-create');
    if (micEl) micEl.checked = document.getElementById('bc-ws-screen-mic')?.checked ?? true;
    if (camEl) camEl.checked = document.getElementById('bc-ws-screen-cam')?.checked ?? false;
    if (syaEl) syaEl.value = document.getElementById('bc-ws-screen-sysaudio')?.checked ? 'include' : 'exclude';

    // Sync inline screen-mode device selects to hidden form selects
    const screenMicSel = document.getElementById('bc-ws-screen-mic-select');
    const screenCamSel = document.getElementById('bc-ws-screen-cam-select');
    const hiddenAudio = document.getElementById('bc-screen-audio');
    const hiddenCamera = document.getElementById('bc-screen-camera');
    if (screenMicSel && hiddenAudio && screenMicSel.value !== 'default') {
        hiddenAudio.value = screenMicSel.value;
    }
    if (screenCamSel && hiddenCamera && screenCamSel.value !== 'default') {
        hiddenCamera.value = screenCamSel.value;
    }

    // Sync PiP position/size to broadcastState for use in _startPipComposite
    const pipPos = document.getElementById('bc-ws-screen-pip-pos')?.value || 'bottom-right';
    const pipSize = document.getElementById('bc-ws-screen-pip-size')?.value || 'small';
    if (typeof broadcastState !== 'undefined') {
        broadcastState.settings.screenPipPos = pipPos;
        broadcastState.settings.screenPipSize = pipSize;
    }
}

/* ── Control config population ───────────────────────────────── */

async function _wsPopulateControlConfigs(selectedId) {
    const select = document.getElementById('bc-control-config');
    if (!select) return;
    try {
        const data = await api('/controls/configs');
        const configs = data.configs || [];
        select.innerHTML = '<option value="">None (no controls)</option>';
        configs.forEach(cfg => {
            const opt = document.createElement('option');
            opt.value = cfg.id;
            opt.textContent = `${cfg.name} (${cfg.button_count || 0} buttons)`;
            if (cfg.id === selectedId) opt.selected = true;
            select.appendChild(opt);
        });
    } catch { /* leave as None */ }
}

/* ── Stream key tools ────────────────────────────────────────── */

function _wsToggleKeyVisibility() {
    const input = document.getElementById('bc-ws-stream-key');
    const eye = document.getElementById('bc-ws-key-eye');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    if (eye) {
        eye.classList.toggle('fa-eye', input.type === 'password');
        eye.classList.toggle('fa-eye-slash', input.type === 'text');
    }
}

function _wsCopyStreamKey() {
    const key = _wsState.streamKey;
    if (!key) { toast('No stream key available', 'error'); return; }
    _wsCopyText(key, 'Stream key copied');
}

function _wsCopyText(text, message) {
    navigator.clipboard.writeText(text).then(() => {
        toast(message || 'Copied!', 'success');
    }).catch(() => {
        prompt('Copy the value manually:', text);
    });
}

/** Switch CLI protocol tab */
function _wsCliTab(proto) {
    const tabs = document.querySelectorAll('.bc-ws-cli-tab');
    const panels = document.querySelectorAll('.bc-ws-cli-panel');
    tabs.forEach(t => t.classList.toggle('active', t.textContent.toLowerCase().includes(proto) || t.getAttribute('onclick')?.includes(proto)));
    panels.forEach(p => p.classList.toggle('active', p.dataset.clipanel === proto));
}

async function _wsRegenerateKey(managedStreamId) {
    const confirmed = await _wsConfirmAction('This will immediately invalidate the current key. Any active connections using the old key will be disconnected.', { title: 'Regenerate Stream Key?', okLabel: 'Regenerate', okClass: 'btn-danger' });
    if (!confirmed) return;
    try {
        const data = await api(`/streams/managed/${managedStreamId}/regenerate-key`, { method: 'POST' });
        _wsState.streamKey = data.stream_key;
        const input = document.getElementById('bc-ws-stream-key');
        if (input) input.value = data.stream_key;
        const methodEl = document.getElementById('bc-ws-method-endpoint');
        if (methodEl && _wsState.selectedMs) {
            methodEl.innerHTML = _wsRenderMethodEndpoint(_wsState.selectedMs.streaming_method || _wsState.selectedMs.protocol || 'browser', data.stream_key, _wsState.selectedMs.id);
        }
        toast('Stream key regenerated', 'success');
    } catch (err) {
        toast(err?.message || 'Failed to regenerate key', 'error');
    }
}

/* ── Dirty state / Manual Save ───────────────────────────────── */

function _wsMarkDirty() {
    _wsState.dirty = true;
    _wsUpdateSaveButton();
}

function _wsUpdateSaveButton() {
    const bar = document.getElementById('bc-ws-save-bar');
    const btn = document.getElementById('bc-ws-save-btn');
    const status = document.getElementById('bc-ws-save-status');
    if (!bar) return;
    if (_wsState.dirty) {
        bar.style.display = '';
        bar.classList.remove('hidden');
        if (btn) btn.disabled = false;
        if (status) {
            status.textContent = 'Unsaved changes';
            status.className = 'bc-ws-save-status bc-ws-dirty';
        }
    } else {
        bar.classList.add('hidden');
        // Remove after animation
        setTimeout(() => {
            if (!_wsState.dirty && bar) bar.style.display = 'none';
        }, 200);
        if (btn) btn.disabled = true;
        if (status) {
            status.textContent = '';
            status.className = 'bc-ws-save-status';
        }
    }
}

function _wsShowSaveStatus(msg, cls) {
    const el = document.getElementById('bc-ws-save-status');
    const bar = document.getElementById('bc-ws-save-bar');
    if (el) {
        el.textContent = msg;
        el.className = 'bc-ws-save-status' + (cls ? ' ' + cls : '');
    }
    // Show the bar briefly for save/error feedback even when not dirty
    if (bar && msg) bar.style.display = '';
}

/** Save all changes (structured fields + profile blob) */
async function _wsSaveAll() {
    if (!_wsState.selectedId || _wsState.saving || !_wsState.dirty) return;
    _wsState.saving = true;
    const btn = document.getElementById('bc-ws-save-btn');
    if (btn) btn.disabled = true;
    _wsShowSaveStatus('Saving\u2026', 'bc-ws-saving');

    try {
        // Read current values from DOM
        const ms = _wsState.selectedMs;
        const streamFields = {
            title: document.getElementById('bc-title')?.value.trim() || ms.title,
            description: document.getElementById('bc-description')?.value.trim() || '',
            category: document.getElementById('bc-category')?.value || 'irl',
            is_nsfw: document.getElementById('bc-nsfw')?.checked ? 1 : 0,
            protocol: ms.protocol,
            streaming_method: ms.streaming_method || 'browser',
            browser_mode: ms.browser_mode || _wsState.profile.browserMode || 'camera',
            control_config_id: parseInt(document.getElementById('bc-control-config')?.value) || null,
            slug: document.getElementById('bc-slug')?.value.trim().toLowerCase() || null,
            // Slot-level settings
            default_vod_visibility: ms.default_vod_visibility || 'public',
            default_clip_visibility: ms.default_clip_visibility || 'public',
            slot_vod_recording_enabled: ms.slot_vod_recording_enabled !== undefined ? ms.slot_vod_recording_enabled : 1,
            slot_clip_recording_enabled: ms.slot_clip_recording_enabled !== undefined ? ms.slot_clip_recording_enabled : 1,
            slot_clip_notify_enabled: ms.slot_clip_notify_enabled !== undefined ? ms.slot_clip_notify_enabled : 1,
            weather_zip: ms.weather_zip || null,
            weather_detail: ms.weather_detail || 'basic',
            weather_show_location: ms.weather_show_location || 0,
            // '' clears the overlay; the server validates ownership and rejects self-reference.
            pip_source_msid: document.getElementById('bc-ws-pip-source')?.value || null,
            pip_defaults: (() => {
                const w = Number(document.getElementById('bc-ws-pip-size')?.value) || 0.25;
                const corner = document.getElementById('bc-ws-pip-corner')?.value || 'br';
                return { ...(_wsPipCornerToXY(corner, w)), w };
            })(),
        };

        const profileBlob = {
            resolution: document.getElementById('bc-ws-resolution')?.value || '720',
            fps: document.getElementById('bc-ws-fps')?.value || '30',
            bitrate: parseInt(document.getElementById('bc-ws-bitrate')?.value) || 2500,
            browserMode: ms.browser_mode || _wsState.profile.browserMode || 'camera',
            micOnlyImage: _wsState.profile.micOnlyImage || null,
            // Screen share settings
            screenMic: document.getElementById('bc-ws-screen-mic')?.checked ?? true,
            screenCam: document.getElementById('bc-ws-screen-cam')?.checked ?? false,
            screenSysAudio: document.getElementById('bc-ws-screen-sysaudio')?.checked ?? true,
            screenPipPos: document.getElementById('bc-ws-screen-pip-pos')?.value || 'bottom-right',
            screenPipSize: document.getElementById('bc-ws-screen-pip-size')?.value || 'small',
            screenResolution: document.getElementById('bc-ws-screen-resolution')?.value || '1080',
            screenFps: document.getElementById('bc-ws-screen-fps')?.value || '30',
            screenBitrate: parseInt(document.getElementById('bc-ws-screen-bitrate')?.value) || 3000,
            vibeCoding: _wsCollectVibeSettingsFromDom(),
        };

        // Save structured fields
        const updated = await api(`/streams/managed/${_wsState.selectedId}`, {
            method: 'PUT',
            body: streamFields,
        });

        // Save profile blob
        await api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: _wsState.selectedId, settings: profileBlob },
        });

        // Update local state
        if (updated.managed_stream) {
            _wsState.selectedMs = { ..._wsState.selectedMs, ...updated.managed_stream };
            const idx = _wsState.managedStreams.findIndex(m => m.id === _wsState.selectedId);
            if (idx !== -1) _wsState.managedStreams[idx] = { ..._wsState.managedStreams[idx], ...updated.managed_stream };
        }
        _wsState.profile = profileBlob;
        _wsState.dirty = false;

        _wsRenderSidebar();
        _wsShowSaveStatus('Saved \u2713', 'bc-ws-saved');
        setTimeout(() => { if (!_wsState.dirty) _wsShowSaveStatus(''); }, 2500);

        // Update sidebar method display
        const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
        broadcastState.selectedMethod = methodToProtocol[streamFields.streaming_method] || streamFields.protocol;
    } catch (err) {
        _wsShowSaveStatus('Save failed: ' + (err?.message || 'unknown error'), 'bc-ws-save-error');
    } finally {
        _wsState.saving = false;
        _wsUpdateSaveButton();
    }
}

/* ── Method/mode selection ───────────────────────────────────── */

function _wsSelectMethod(method) {
    if (!_wsState.selectedMs) return;

    // Map user-facing method to protocol
    const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
    const protocol = methodToProtocol[method] || 'webrtc';

    _wsState.selectedMs.streaming_method = method;
    _wsState.selectedMs.protocol = protocol;
    _wsMarkDirty();

    // Re-render the panel to update go-live/auto-detect section and endpoint
    _wsRenderPanel();
}

function _wsSelectBrowserMode(mode) {
    _wsState.profile.browserMode = mode;
    if (_wsState.selectedMs) _wsState.selectedMs.browser_mode = mode;
    _wsMarkDirty();

    document.querySelectorAll('[data-wsbrowsermode]').forEach(el =>
        el.classList.toggle('selected', el.dataset.wsbrowsermode === mode)
    );

    // Show/hide sub-mode options
    const micOpts = document.getElementById('bc-ws-mic-only-opts');
    const screenOpts = document.getElementById('bc-ws-screen-opts');
    if (micOpts) micOpts.style.display = mode === 'mic_only' ? '' : 'none';
    if (screenOpts) screenOpts.style.display = mode === 'screen' ? '' : 'none';

    // Hide camera selector for mic-only; hide audio selector for camera-only
    const camGroup = document.getElementById('bc-ws-camera-group');
    if (camGroup) camGroup.style.display = (mode === 'mic_only' || mode === 'screen') ? 'none' : '';
    const audioGroup = document.getElementById('bc-ws-audio-group');
    if (audioGroup) audioGroup.style.display = mode === 'camera_only' ? 'none' : '';

    const permReq = document.getElementById('bc-perm-request');
    const devSelects = document.getElementById('bc-device-selects');

    if (mode === 'screen') {
        // In screen mode, hide the main permission/device section — handled inline
        if (permReq) permReq.style.display = 'none';
        if (devSelects) devSelects.style.display = 'none';
        _wsCheckScreenInlinePermissions();
    } else {
        // Update permission button text/icon per mode
        const permHintText = document.getElementById('bc-perm-hint-text');
        const permBtnText = document.getElementById('bc-perm-btn-text');
        const permBtn = document.getElementById('bc-perm-btn');
        if (permHintText) {
            const hints = { mic_only: 'Browser needs microphone access to stream.',
                camera_only: 'Browser needs camera access to stream.',
                camera: 'Browser needs camera & mic access to stream.' };
            permHintText.textContent = hints[mode] || hints.camera;
        }
        if (permBtnText) {
            const labels = { mic_only: 'Allow Microphone', camera_only: 'Allow Camera',
                camera: 'Allow Camera & Mic' };
            permBtnText.textContent = labels[mode] || labels.camera;
        }
        if (permBtn) {
            const icon = permBtn.querySelector('i');
            if (icon) {
                icon.className = 'fa-solid ' + (mode === 'mic_only' ? 'fa-microphone' : 'fa-video');
            }
        }
    }

    _wsSyncScreenShareHiddenDefaults(mode);
}

/** Handle slot-level settings changes — sync to managed stream state */
function _wsSlotSettingChanged() {
    if (!_wsState.selectedMs) return;
    const ms = _wsState.selectedMs;
    ms.default_vod_visibility = document.getElementById('bc-ws-vod-visibility')?.value || 'public';
    ms.default_clip_visibility = document.getElementById('bc-ws-clip-visibility')?.value || 'public';
    ms.slot_vod_recording_enabled = document.getElementById('bc-ws-vod-recording')?.checked ? 1 : 0;
    ms.slot_clip_recording_enabled = document.getElementById('bc-ws-clip-recording')?.checked ? 1 : 0;
    ms.slot_clip_notify_enabled = document.getElementById('bc-ws-clip-notify')?.checked ? 1 : 0;
    ms.weather_zip = document.getElementById('bc-ws-weather-zip')?.value.trim() || null;
    ms.weather_detail = document.getElementById('bc-ws-weather-detail')?.value || 'basic';
    ms.weather_show_location = document.getElementById('bc-ws-weather-location')?.checked ? 1 : 0;
    _wsState.profile.vibeCoding = _wsCollectVibeSettingsFromDom();
    _wsMarkDirty();
}

/** Handle mic-only placeholder image selection */
function _wsMicImageChanged(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) {
        toast('Image too large (max 2MB)', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        _wsState.profile.micOnlyImage = e.target.result;
        const preview = document.getElementById('bc-ws-mic-image-preview');
        if (preview) preview.innerHTML = `<img src="${e.target.result}" alt="Mic-only placeholder">`;
        _wsMarkDirty();
    };
    reader.readAsDataURL(file);
}

/** Toggle PiP options visibility when camera overlay checkbox changes */
function _wsScreenCamToggle(checked) {
    const opts = document.getElementById('bc-ws-screen-pip-opts');
    if (opts) opts.style.display = checked ? '' : 'none';
    _wsMarkDirty();
    if (checked) _wsRequestCamPermission();
    else _wsUpdateCaptureSummary();
}

function _wsScreenMicToggle(checked) {
    _wsMarkDirty();
    if (checked) {
        _wsRequestMicPermission();
    } else {
        // Release the preview device as soon as the mic is switched off — holding an
        // open input just to draw a meter would keep the OS "in use" indicator lit.
        window.bcMediaSetup?.stopMeter('bc-ws-mic-meter');
        _wsShowEl('bc-ws-mic-meter-wrap', false);
        _wsUpdateCaptureSummary();
    }
}

/** Check if mic/cam permissions are already granted and show inline device selects */
async function _wsCheckScreenInlinePermissions() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput' && d.label);
        const cams = devices.filter(d => d.kind === 'videoinput' && d.label);

        if (mics.length > 0) {
            _wsPopulateInlineDevices('bc-ws-screen-mic-select', mics);
            _wsShowEl('bc-ws-screen-mic-device', true);
            _wsShowEl('bc-ws-screen-mic-perm', false);
            // Grant already held (labels are populated), so preview straight away.
            if (document.getElementById('bc-ws-screen-mic')?.checked) _wsStartMicMeter();
        } else if (document.getElementById('bc-ws-screen-mic')?.checked) {
            _wsShowEl('bc-ws-screen-mic-perm', true);
        }

        if (cams.length > 0 && document.getElementById('bc-ws-screen-cam')?.checked) {
            _wsPopulateInlineDevices('bc-ws-screen-cam-select', cams);
            _wsShowEl('bc-ws-screen-cam-device', true);
            _wsShowEl('bc-ws-screen-cam-perm', false);
        } else if (document.getElementById('bc-ws-screen-cam')?.checked) {
            _wsShowEl('bc-ws-screen-cam-perm', true);
        }
    } catch (err) {
        console.warn('[Workspace] Inline permission check failed:', err.message);
    }
    _wsUpdateCaptureSummary();
}

async function _wsRequestMicPermission() {
    // Explain first, then prompt, then REBUILD the list from a fresh enumerate —
    // labels and deviceIds are both empty until the grant exists, so a list built
    // beforehand can only show "Default" and can only ever select the OS default.
    // (There is no hidden bc-screen-audio mirror any more: createNewStream() reads
    // bc-ws-screen-mic-select directly.)
    const r = await window.bcMediaSetup.request('mic');
    if (!r.granted) {
        if (r.error && r.error !== 'cancelled') console.warn('[Workspace] Mic permission:', r.error);
        _wsShowEl('bc-ws-screen-mic-perm', true);
        _wsShowEl('bc-ws-screen-mic-device', false);
        _wsUpdateCaptureSummary();
        return;
    }
    _wsPopulateInlineDevices('bc-ws-screen-mic-select', r.devices);
    _wsShowEl('bc-ws-screen-mic-device', true);
    _wsShowEl('bc-ws-screen-mic-perm', false);
    _wsStartMicMeter();
    _wsUpdateCaptureSummary();
}

/** Preview the SELECTED mic so "can I be heard" is answerable before going live. */
function _wsStartMicMeter() {
    const sel = document.getElementById('bc-ws-screen-mic-select');
    const on = document.getElementById('bc-ws-screen-mic')?.checked;
    if (!on || !sel) { window.bcMediaSetup?.stopMeter('bc-ws-mic-meter'); return; }
    _wsShowEl('bc-ws-mic-meter-wrap', true);
    window.bcMediaSetup.startMeter('bc-ws-mic-meter', sel.value, 'bc-ws-mic-meter-status');
}

/** Called when the streamer picks a different microphone. */
function _wsOnMicDeviceChange() {
    _wsMarkDirty();
    _wsStartMicMeter();
    _wsUpdateCaptureSummary();
}

function _wsOnCamDeviceChange() {
    _wsMarkDirty();
    _wsUpdateCaptureSummary();
}

/** Keep the "what will be captured" panel honest as toggles change. */
function _wsUpdateCaptureSummary() {
    const el = document.getElementById('bc-ws-capture-summary');
    if (!el || !window.bcMediaSetup) return;
    const micOn = !!document.getElementById('bc-ws-screen-mic')?.checked;
    const camOn = !!document.getElementById('bc-ws-screen-cam')?.checked;
    const micSel = document.getElementById('bc-ws-screen-mic-select');
    const camSel = document.getElementById('bc-ws-screen-cam-select');
    const sysEl = document.getElementById('bc-ws-screen-sysaudio');   // checkbox, not a select
    const labelOf = (sel) => (sel && sel.selectedIndex >= 0 && sel.value !== 'default')
        ? sel.options[sel.selectedIndex].textContent : '';
    window.bcMediaSetup.renderSummary(el, {
        mic: micOn, micLabel: labelOf(micSel),
        camera: camOn, cameraLabel: labelOf(camSel),
        systemAudio: sysEl ? !!sysEl.checked : true,
    });
}

async function _wsRequestCamPermission() {
    // Same explain -> prompt -> re-enumerate flow as the microphone; see there.
    const r = await window.bcMediaSetup.request('camera');
    if (!r.granted) {
        if (r.error && r.error !== 'cancelled') console.warn('[Workspace] Camera permission:', r.error);
        _wsShowEl('bc-ws-screen-cam-perm', true);
        _wsShowEl('bc-ws-screen-cam-device', false);
        _wsUpdateCaptureSummary();
        return;
    }
    _wsPopulateInlineDevices('bc-ws-screen-cam-select', r.devices);
    _wsShowEl('bc-ws-screen-cam-device', true);
    _wsShowEl('bc-ws-screen-cam-perm', false);
    _wsUpdateCaptureSummary();
}


/* ── Picture-in-picture defaults ──────────────────────────────────────────────
   The API stores the starting geometry as FRACTIONS of the player box ({x,y,w}),
   so the overlay lands in the same relative place at any window size. Streamers
   should not have to think in fractions, so the UI offers a corner and a size and
   converts. 0.02 is the margin from each edge. */

const _PIP_MARGIN = 0.02;

function _wsPipCornerToXY(corner, w) {
    const h = w * 9 / 16;                       // the overlay is 16:9
    const right = 1 - w - _PIP_MARGIN;
    const bottom = 1 - h - _PIP_MARGIN;
    switch (corner) {
        case 'bl': return { x: _PIP_MARGIN, y: bottom };
        case 'tr': return { x: right, y: _PIP_MARGIN };
        case 'tl': return { x: _PIP_MARGIN, y: _PIP_MARGIN };
        default:   return { x: right, y: bottom };   // 'br'
    }
}

function _wsPipXYToCorner(x, y) {
    return (y < 0.5 ? 't' : 'b') + (x < 0.5 ? 'l' : 'r');
}

/** Show the geometry controls only when a camera slot is actually selected. */
function _wsPipDefaultsToggle() {
    const on = !!document.getElementById('bc-ws-pip-source')?.value;
    _wsShowEl('bc-ws-pip-defaults', on);
}

/** Restore corner/size from the stored fractions when the panel renders. */
function _wsPipDefaultsRestore(ms) {
    let d = {};
    try { d = typeof ms.pip_defaults === 'string' ? JSON.parse(ms.pip_defaults || '{}') : (ms.pip_defaults || {}); }
    catch { d = {}; }
    const sizeEl = document.getElementById('bc-ws-pip-size');
    const cornerEl = document.getElementById('bc-ws-pip-corner');
    if (sizeEl) {
        const w = Number(d.w);
        // Snap to the nearest offered size rather than showing an option that is not there.
        const opts = [0.18, 0.25, 0.35];
        const nearest = Number.isFinite(w)
            ? opts.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a))
            : 0.25;
        sizeEl.value = String(nearest);
    }
    if (cornerEl) {
        cornerEl.value = (Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y)))
            ? _wsPipXYToCorner(Number(d.x), Number(d.y))
            : 'br';
    }
    _wsPipDefaultsToggle();
}

function _wsPopulateInlineDevices(selectId, devices) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="default">Default</option>' +
        devices.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || d.deviceId)}</option>`).join('');
    if (currentVal) sel.value = currentVal;
}

function _wsShowEl(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
}

/* ── Go Live ─────────────────────────────────────────────────── */

async function goLiveFromWorkspace() {
    if (!_wsState.selectedMs) {
        toast('Select a stream slot first', 'error');
        return;
    }

    // Prompt to save if dirty
    if (_wsState.dirty) {
        const action = await _wsConfirmUnsaved('You have unsaved changes. Save before going live?');
        if (action === 'cancel') return;
        if (action === 'save') await _wsSaveAll();
    }

    const p = _wsState.profile;
    const ms = _wsState.selectedMs;
    const browserMode = ms.browser_mode || p.browserMode || 'camera';
    const streamingMethod = ms.streaming_method || 'browser';

    // Apply quality defaults from saved profile into broadcastState
    if (p.resolution) broadcastState.settings.broadcastRes = String(p.resolution);
    if (p.fps) broadcastState.settings.broadcastFps = String(p.fps);
    if (p.bitrate) broadcastState.settings.broadcastBps = String(p.bitrate);

    // Map streaming_method to protocol for broadcastState
    const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
    const protocol = methodToProtocol[streamingMethod] || ms.protocol || 'webrtc';
    broadcastState.selectedMethod = protocol;

    if (streamingMethod === 'browser') {
        broadcastState.selectedWebRTCSub = 'browser';
        if (browserMode === 'screen') {
            broadcastState.selectedBrowserSource = 'screen';
            broadcastState.settings.screenShare = true;
            // Apply screen-specific quality settings if set
            if (p.screenResolution) broadcastState.settings.screenRes = String(p.screenResolution);
            if (p.screenFps) broadcastState.settings.screenFps = String(p.screenFps);
            if (p.screenBitrate) broadcastState.settings.screenBps = String(p.screenBitrate);
        } else if (browserMode === 'mic_only') {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.micOnly = true;
            broadcastState.settings.screenShare = false;
        } else if (browserMode === 'camera_only') {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.cameraOnly = true;
            broadcastState.settings.screenShare = false;
        } else {
            broadcastState.selectedBrowserSource = 'camera';
            broadcastState.settings.screenShare = false;
            broadcastState.settings.micOnly = false;
            broadcastState.settings.cameraOnly = false;
        }
    } else if (streamingMethod === 'whip') {
        broadcastState.selectedWebRTCSub = 'whip';
    }

    // Class B: sync local device selection
    const camSel = document.getElementById('bc-create-camera');
    const audSel = document.getElementById('bc-create-audio');
    if (camSel && camSel.value) _syncCameraSelectionUI(camSel.value, { persist: false });
    if (audSel && audSel.value) _syncAudioSelectionUI(audSel.value, { persist: false });

    // Persist device selections for this slot (localStorage)
    _wsPersistSlotDevices();

    // Sync screen-share hidden defaults
    _wsSyncScreenShareHiddenDefaults(browserMode);

    await createNewStream();

    // After going live, save device selections to server-side profile
    _wsSaveDevicesToProfile();
}

/* ── Live status refresh (called from broadcast.js) ─────────── */

function updateWorkspaceLiveStatus() {
    _wsRenderSidebar();
    if (!_wsState.selectedId) return;
    const liveSessionId = _wsGetLiveSessionId(_wsState.selectedId);
    const banner = document.getElementById('bc-ws-live-banner');
    const goliveSection = document.getElementById('bc-ws-golive-section');
    if (banner) banner.style.display = liveSessionId ? '' : 'none';
    if (goliveSection) goliveSection.style.display = liveSessionId ? 'none' : '';
}

function _wsGetLiveSessionId(managedStreamId) {
    if (!broadcastState?.streams) return null;
    for (const [sid, ss] of broadcastState.streams) {
        if (ss.streamData?.managed_stream_id === managedStreamId) return sid;
    }
    return null;
}

/* ── Uptime ──────────────────────────────────────────────────── */

function _wsFormatUptime(startedAt) {
    if (!startedAt) return '0:00';
    const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/* ── Session history ─────────────────────────────────────────── */

async function _wsLoadHistory(managedStreamId) {
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;

    try {
        const data = await api(`/streams/managed/${managedStreamId}/history`);
        _wsState.history = data.sessions || [];
        _wsRenderHistory(_wsState.history);
    } catch {
        list.innerHTML = '<p class="muted">Could not load session history.</p>';
    }
}

function _wsRenderHistory(sessions) {
    const list = document.getElementById('bc-ws-history-list');
    if (!list) return;

    if (!sessions.length) {
        list.innerHTML = '<p class="muted" style="padding:8px 0">No past sessions yet. Go live to start your first session.</p>';
        return;
    }

    list.innerHTML = sessions.map(s => {
        const date = new Date(s.started_at || s.created_at);
        const dur = _wsFormatDuration(s.duration_seconds || 0);
        const peakStr = s.peak_viewers != null
            ? `<span><i class="fa-solid fa-eye"></i> ${s.peak_viewers} peak</span>` : '';
        const vodStr = s.vod_id
            ? `<a class="btn btn-xs btn-outline" href="/vods/${s.vod_id}" target="_blank" rel="noopener">
                   <i class="fa-solid fa-film"></i> VOD</a>` : '';
        const liveStr = s.is_live
            ? '<span class="bc-live-badge" style="font-size:0.7rem"><i class="fa-solid fa-circle"></i> LIVE</span>' : '';
        const proto = s.protocol ? `<span class="bc-ws-item-proto">${esc(_wsMethodLabel(s.protocol))}</span>` : '';
        return `
            <div class="bc-ws-session">
                <div class="bc-ws-session-left">
                    <div class="bc-ws-session-title">${esc(s.title || 'Untitled')} ${liveStr}</div>
                    <div class="bc-ws-session-meta">
                        ${proto}
                        <span><i class="fa-solid fa-calendar"></i> ${date.toLocaleDateString()}</span>
                        <span><i class="fa-solid fa-clock"></i> ${dur}</span>
                        ${peakStr}
                    </div>
                </div>
                <div class="bc-ws-session-right">${vodStr}</div>
            </div>`;
    }).join('');
}

function _wsFormatDuration(secs) {
    secs = Math.round(secs);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ── Managed stream CRUD helpers ─────────────────────────────── */

function showCreateManagedStreamModal() {
    showModal('create-managed-stream');
}

async function _wsConfirmDelete(managedStreamId) {
    const ms = _wsState.managedStreams.find(m => m.id === managedStreamId);
    if (!ms) return;
    if (_wsIsManagedStreamLive(managedStreamId)) {
        toast('Cannot delete a live stream slot. End the stream first.', 'error');
        return;
    }
    const confirmed = await _wsConfirmAction(`Past sessions and VODs are not affected. This cannot be undone.`, { title: `Delete "${ms.title || 'Untitled'}"?`, okLabel: 'Delete', okClass: 'btn-danger' });
    if (!confirmed) return;
    _wsDeleteManagedStream(managedStreamId);
}

async function _wsDeleteManagedStream(managedStreamId) {
    try {
        await api(`/streams/managed/${managedStreamId}`, { method: 'DELETE' });
        await _wsLoadManagedStreams();
        if (_wsState.selectedId === managedStreamId) {
            _wsState.selectedId = null;
            _wsState.selectedMs = null;
            _wsState.streamKey = null;
            _wsState.profile = {};
        }
        _wsRenderSidebar();
        if (_wsState.managedStreams.length > 0) {
            await _wsSelectStream(_wsState.managedStreams[0].id);
        } else {
            _wsShowEmpty();
        }
        toast('Stream slot deleted', 'success');
    } catch (err) {
        toast('Could not delete: ' + (err?.message || 'Server error'), 'error');
    }
}

/** Called after a new managed stream is created (e.g. from the create modal) */
async function onManagedStreamCreated(newManagedStreamId) {
    await _wsLoadManagedStreams();
    _wsRenderSidebar();
    if (newManagedStreamId) await _wsSelectStream(newManagedStreamId);
}

/* ══════════════════════════════════════════════════════════════
   RESTREAM DESTINATIONS (per-slot)
   ══════════════════════════════════════════════════════════════ */

const _wsRestreamPlatforms = {
    twitch:        { name: 'Twitch',        icon: 'fa-brands fa-twitch',  color: '#9146ff', defaultUrl: 'rtmps://live.twitch.tv/app' },
    youtube:       { name: 'YouTube',       icon: 'fa-brands fa-youtube', color: '#ff0000', defaultUrl: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:          { name: 'Kick',          icon: 'fa-solid fa-k',        color: '#53fc18', defaultUrl: '' },
    custom:        { name: 'Custom RTMP',   icon: 'fa-solid fa-globe',    color: '#888',    defaultUrl: '' },
    robotstreamer: { name: 'RobotStreamer', icon: 'fa-solid fa-robot',    color: '#4a9eff', defaultUrl: '', isRobotStreamer: true },
};

let _wsRestreamDests = []; // cached for current slot
let _wsSlotRsIntegration = null; // slot-specific RobotStreamer config (null = none for this slot)

async function _wsLoadRestreamDests(managedStreamId) {
    const container = document.getElementById('bc-ws-restream-list');
    if (!container) return;
    try {
        const [data, rsData] = await Promise.all([
            api(`/restream/destinations?managed_stream_id=${managedStreamId}`),
            api(`/robotstreamer/integration?managed_stream_id=${managedStreamId}`).catch(() => null),
        ]);
        _wsRestreamDests = data.destinations || [];
        _wsSlotRsIntegration = (rsData && rsData.exists) ? rsData.integration : null;
        _wsRenderRestreamList(container);
    } catch (err) {
        container.innerHTML = '<p class="muted" style="font-size:0.82rem"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load restream destinations</p>';
    }
}

function _wsRenderSlotRsCard() {
    const rs = _wsSlotRsIntegration;
    if (!rs) return '';
    const plat = _wsRestreamPlatforms.robotstreamer;
    const label = rs.stream_name || (rs.robot_id ? `Robot ${rs.robot_id}` : 'RobotStreamer');
    return `
    <div class="bc-ws-restream-card${rs.enabled ? '' : ' disabled'}" data-restreamid="rs">
        <div class="bc-ws-restream-card-hd">
            <span class="bc-ws-restream-platform" style="color:${plat.color}">
                <i class="${plat.icon}"></i> ${esc(label)}
            </span>
            <span class="bc-ws-restream-badges">
                ${rs.mirror_chat ? '<span class="bc-ws-restream-badge" title="Chat mirror enabled"><i class="fa-solid fa-comments"></i></span>' : ''}
                ${rs.enabled ? '<span class="bc-ws-restream-badge" title="Auto-start when live"><i class="fa-solid fa-bolt"></i></span>' : '<span class="bc-ws-restream-badge muted" title="Disabled"><i class="fa-solid fa-pause"></i></span>'}
            </span>
            <div class="bc-ws-restream-actions">
                <button class="btn btn-small btn-outline" onclick="_wsEditSlotRs()" title="Edit">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="btn btn-small btn-outline" style="color:var(--danger)" onclick="_wsDeleteSlotRs()" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="bc-ws-restream-card-info">
            <span class="muted" style="font-size:0.78rem">RobotStreamer WebSocket · Robot ${esc(rs.robot_id || '?')}${rs.owner_name ? ` · ${esc(rs.owner_name)}` : ''}</span>
            <span class="muted" style="font-size:0.78rem">${rs.has_token ? 'Token saved for this slot' : 'No token — will inherit account default'}</span>
        </div>
    </div>`;
}

function _wsRenderRestreamList(container) {
    if (!container) container = document.getElementById('bc-ws-restream-list');
    if (!container) return;

    const rsCard = _wsRenderSlotRsCard();

    if (_wsRestreamDests.length === 0 && !rsCard) {
        container.innerHTML = '<p class="muted" style="font-size:0.82rem">No restream destinations configured for this stream slot.</p>';
        return;
    }

    container.innerHTML = rsCard + _wsRestreamDests.map(d => {
        const plat = _wsRestreamPlatforms[d.platform] || _wsRestreamPlatforms.custom;
        const statusClass = d.enabled ? '' : ' disabled';
        const coolMs = Number(d.cooldown_ms) || 0;
        const coolMins = coolMs > 0 ? Math.max(1, Math.ceil(coolMs / 60000)) : 0;
        const coolBanner = coolMs > 0 ? `
            <div class="bc-ws-restream-cooldown">
                <span><i class="fa-solid fa-triangle-exclamation"></i> Paused after ${d.consecutive_failures || 'repeated'} failed attempt(s)${d.last_error ? ' — ' + esc(String(d.last_error).slice(0, 80)) : ''}. Retrying in ~${coolMins}m.</span>
                <button class="btn btn-small btn-outline" onclick="_wsRetryRestreamDest(${d.id})" title="Clear the cooldown and try now"><i class="fa-solid fa-rotate-right"></i> Retry now</button>
            </div>` : '';
        return `
        <div class="bc-ws-restream-card${statusClass}${coolMs > 0 ? ' cooling' : ''}" data-restreamid="${d.id}">
            <div class="bc-ws-restream-card-hd">
                <span class="bc-ws-restream-platform" style="color:${plat.color}">
                    <i class="${plat.icon}"></i> ${esc(d.name || plat.name)}
                </span>
                <span class="bc-ws-restream-badges">
                    ${d.chat_relay ? '<span class="bc-ws-restream-badge" title="Chat relay enabled"><i class="fa-solid fa-comments"></i></span>' : ''}
                    ${d.auto_start ? '<span class="bc-ws-restream-badge" title="Auto-start"><i class="fa-solid fa-bolt"></i></span>' : ''}
                    ${!d.enabled ? '<span class="bc-ws-restream-badge muted" title="Disabled"><i class="fa-solid fa-pause"></i></span>' : ''}
                </span>
                <div class="bc-ws-restream-actions">
                    <button class="btn btn-small btn-outline" onclick="_wsEditRestreamDest(${d.id})" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn btn-small btn-outline" style="color:var(--danger)" onclick="_wsDeleteRestreamDest(${d.id})" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="bc-ws-restream-card-info">
                <span class="muted" style="font-size:0.78rem">${esc(d.server_url || '')} · Key: ****${esc(d.stream_key ? d.stream_key.slice(-4) : '')}</span>
                <span class="muted" style="font-size:0.78rem">Quality: ${esc(d.quality_preset || 'auto')}</span>
            </div>
            ${coolBanner}
        </div>`;
    }).join('');
}

/** Clear a destination's failure cooldown and immediately retry the restream. */
async function _wsRetryRestreamDest(id) {
    try {
        // POST /start clears the cooldown server-side and bypasses the circuit breaker for this try.
        await api(`/restream/destinations/${id}/start`, { method: 'POST', body: {} });
        toast('Retrying restream…', 'success');
    } catch (err) {
        // Even if start fails (e.g. the slot isn't live yet), the cooldown was cleared on the attempt.
        toast(err?.message || 'Retry queued — cooldown cleared', 'info');
    }
    try { await _wsLoadRestreamDests(_wsState.selectedId); } catch { /* */ }
}

function _wsAddRestreamDest() {
    _wsShowRestreamForm(null);
}

function _wsEditSlotRs() {
    _wsShowRestreamForm({ __rs: true });
}

async function _wsDeleteSlotRs() {
    const confirmed = await _wsConfirmAction('The RobotStreamer config for this stream slot will be removed. The slot falls back to your account-level RobotStreamer settings (if any).', {
        title: 'Remove RobotStreamer from this slot?', okLabel: 'Remove', okClass: 'btn-danger'
    });
    if (!confirmed) return;
    try {
        await api(`/robotstreamer/integration?managed_stream_id=${_wsState.selectedId}`, { method: 'DELETE' });
        _wsSlotRsIntegration = null;
        _wsApplySlotRsToLiveStreams(_wsState.selectedId, null);
        _wsRenderRestreamList();
        toast('RobotStreamer removed from this slot', 'success');
    } catch (err) {
        toast(err?.message || 'Failed to remove', 'error');
    }
}

/** Push an updated slot RS config into broadcast.js live-stream state and restart/stop the restream */
function _wsApplySlotRsToLiveStreams(managedStreamId, integration) {
    if (typeof broadcastState === 'undefined' || !managedStreamId) return;
    if (typeof _rsSlotIntegrationCache !== 'undefined') {
        _rsSlotIntegrationCache.set(managedStreamId, { fetchedAt: Date.now(), integration });
    }
    for (const [sid, sstate] of broadcastState.streams) {
        if (sstate.streamData?.managed_stream_id !== managedStreamId) continue;
        sstate._rsSlotIntegration = integration;
        if (!sstate.localStream) continue;
        if (typeof stopRobotStreamerRestream !== 'function') continue;
        stopRobotStreamerRestream(sid, { quiet: true }).catch(() => {}).finally(() => {
            if (integration && typeof rsSlotIntegrationUsable === 'function' && rsSlotIntegrationUsable(integration)) {
                startRobotStreamerRestream(sid).catch(() => {});
            }
        });
    }
    if (typeof updateRsRestreamSlotUI === 'function') updateRsRestreamSlotUI();
}

function _wsPopulateSlotRsRobotSelect(robots = [], selectedRobotId = '') {
    const select = document.getElementById('ws-rs-rs-robot-select');
    if (!select) return;
    select.innerHTML = '<option value="">Validate to load your robots</option>';
    (Array.isArray(robots) ? robots : []).forEach((robot) => {
        const option = document.createElement('option');
        option.value = robot.robot_id;
        const viewers = Number(robot.viewers || 0);
        option.textContent = `${robot.robot_name || `Robot ${robot.robot_id}`} (${robot.robot_id}) • ${robot.status || 'offline'} • ${viewers} viewer${viewers === 1 ? '' : 's'}`;
        select.appendChild(option);
    });
    if (selectedRobotId) select.value = String(selectedRobotId);
}

function _wsSetSlotRsStatus(message, tone = 'info') {
    const el = document.getElementById('ws-rs-rs-status');
    if (!el) return;
    const colors = { success: 'var(--success, #22c55e)', error: 'var(--danger, #ef4444)', info: 'var(--text-secondary, #9ca3af)' };
    el.textContent = message;
    el.style.color = colors[tone] || colors.info;
}

function _wsGetSlotRsFormData() {
    const selectRobot = document.getElementById('ws-rs-rs-robot-select')?.value || '';
    const inputRobot = document.getElementById('ws-rs-rs-robot-input')?.value.trim() || '';
    return {
        token: document.getElementById('ws-rs-rs-token')?.value.trim() || '',
        robot_input: selectRobot || inputRobot,
        enabled: !!document.getElementById('ws-rs-rs-enabled')?.checked,
        mirror_chat: !!document.getElementById('ws-rs-rs-mirror-chat')?.checked,
        managed_stream_id: _wsState.selectedId,
    };
}

async function _wsRsLogin() {
    const user_name = document.getElementById('ws-rs-rs-username')?.value.trim() || '';
    const password = document.getElementById('ws-rs-rs-password')?.value || '';
    if (!user_name || !password) {
        _wsSetSlotRsStatus('Enter your RobotStreamer username and password.', 'error');
        return;
    }
    _wsSetSlotRsStatus('Logging in to RobotStreamer…', 'info');
    try {
        const data = await api('/robotstreamer/integration/login', {
            method: 'POST',
            body: { user_name, password, managed_stream_id: _wsState.selectedId },
        });
        const integration = data.integration || {};
        _wsPopulateSlotRsRobotSelect(data.available_robots || integration.available_robots || [], integration.robot_id || '');
        // Token is now stored server-side — clear the password and reflect it in the token field.
        const pw = document.getElementById('ws-rs-rs-password'); if (pw) pw.value = '';
        const tokenField = document.getElementById('ws-rs-rs-token');
        if (tokenField) { tokenField.value = ''; tokenField.placeholder = '✓ Token fetched & stored — leave blank'; }
        const n = data.robot_count ?? (data.available_robots || []).length;
        if (n === 1 && integration.robot_id) {
            _wsSetSlotRsStatus(`Logged in as ${data.user_name}. Selected robot ${integration.stream_name || integration.robot_id} — just click Save.`, 'success');
        } else if (n > 1) {
            _wsSetSlotRsStatus(`Logged in as ${data.user_name}. Pick your robot below, then Save.`, 'success');
        } else {
            _wsSetSlotRsStatus(`Logged in as ${data.user_name}, but no robots were found — create one on RobotStreamer first.`, 'error');
        }
    } catch (err) {
        _wsSetSlotRsStatus(err?.message || 'RobotStreamer login failed', 'error');
    }
}

async function _wsValidateSlotRs() {
    const payload = _wsGetSlotRsFormData();
    _wsSetSlotRsStatus('Validating RobotStreamer settings…', 'info');
    try {
        const data = await api('/robotstreamer/integration/validate', { method: 'POST', body: payload });
        const integration = data.integration || {};
        _wsPopulateSlotRsRobotSelect(integration.available_robots, integration.robot_id);
        _wsSetSlotRsStatus(`Validated ${integration.stream_name || `robot ${integration.robot_id}`} as ${integration.owner_name || integration.owner_id || 'unknown owner'}.`, 'success');
    } catch (err) {
        _wsSetSlotRsStatus(err?.message || 'RobotStreamer validation failed', 'error');
    }
}

function _wsEditRestreamDest(destId) {
    const dest = _wsRestreamDests.find(d => d.id === destId);
    if (!dest) return;
    _wsShowRestreamForm(dest);
}

async function _wsDeleteRestreamDest(destId) {
    const confirmed = await _wsConfirmAction('This restream destination will be permanently removed.', {
        title: 'Delete Restream Destination?', okLabel: 'Delete', okClass: 'btn-danger'
    });
    if (!confirmed) return;
    try {
        await api(`/restream/destinations/${destId}`, { method: 'DELETE' });
        _wsRestreamDests = _wsRestreamDests.filter(d => d.id !== destId);
        _wsRenderRestreamList();
        toast('Restream destination deleted', 'success');
    } catch (err) {
        toast(err?.message || 'Failed to delete', 'error');
    }
}

function _wsShowRestreamForm(existing) {
    const isRsEdit = !!existing?.__rs;
    if (isRsEdit) existing = null; // RS config comes from _wsSlotRsIntegration, not a destination row
    const isEdit = !!existing;
    const overlay = document.createElement('div');
    overlay.className = 'bc-ws-confirm-overlay';

    const selPlatform = isRsEdit ? 'robotstreamer' : (existing?.platform || '');
    const plats = Object.entries(_wsRestreamPlatforms).map(([id, p]) =>
        `<option value="${id}" ${selPlatform === id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');

    const qualityOpts = ['auto', 'low', 'medium', 'high', 'ultra', 'source'].map(q =>
        `<option value="${q}" ${(existing?.quality_preset || 'auto') === q ? 'selected' : ''}>${q.charAt(0).toUpperCase() + q.slice(1)}</option>`
    ).join('');

    overlay.innerHTML = `
    <div class="bc-ws-confirm-dialog" style="max-width:480px">
        <h3><i class="fa-solid fa-tower-broadcast"></i> ${isEdit ? 'Edit' : 'Add'} Restream Destination</h3>
        <div class="form-group">
            <label>Platform</label>
            <select id="ws-rs-platform" class="form-input" onchange="_wsRestreamPlatformChanged()">
                ${plats}
            </select>
        </div>
        <div id="ws-rs-robotstreamer-fields" style="display:none">
            <div style="background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.3);border-radius:8px;padding:12px;margin:8px 0">
                <p style="margin:0;font-size:0.82rem;color:var(--text-secondary)"><i class="fa-solid fa-robot" style="color:#4a9eff"></i> <strong>RobotStreamer</strong> uses a dedicated WebSocket connection (not RTMP). The token and robot below apply to <strong>this stream slot only</strong> — each slot can restream to a different robot.</p>
            </div>
            <div class="form-group">
                <label><i class="fa-solid fa-wand-magic-sparkles" style="color:#4a9eff"></i> Easiest: log in with RobotStreamer</label>
                <div style="display:flex;gap:8px">
                    <input type="text" id="ws-rs-rs-username" class="form-input form-input-sm" style="flex:1" placeholder="RobotStreamer username" autocomplete="off">
                    <input type="password" id="ws-rs-rs-password" class="form-input form-input-sm" style="flex:1" placeholder="Password" autocomplete="off">
                </div>
                <button class="btn btn-small btn-primary" type="button" style="margin-top:6px" onclick="_wsRsLogin()">
                    <i class="fa-solid fa-right-to-bracket"></i> Log in &amp; fetch robots
                </button>
                <p class="muted" style="font-size:0.75rem;margin:6px 0 0">We log in to RobotStreamer to grab your token &amp; robots automatically. Your password is used once and never stored.</p>
            </div>
            <div style="text-align:center;color:var(--text-secondary);font-size:0.75rem;margin:2px 0 8px">— or paste your token manually —</div>
            <div class="form-group">
                <label>RobotStreamer Token</label>
                <input type="password" id="ws-rs-rs-token" class="form-input form-input-sm" placeholder="Paste your robotstreamer-token cookie or JWT" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Robot</label>
                <input type="text" id="ws-rs-rs-robot-input" class="form-input form-input-sm" placeholder="Robot ID or robotstreamer.com/robot/1234 URL">
                <div style="display:flex;gap:8px;margin-top:6px">
                    <select id="ws-rs-rs-robot-select" class="form-input" style="flex:1">
                        <option value="">Validate to load your robots</option>
                    </select>
                    <button class="btn btn-small btn-outline" type="button" onclick="_wsValidateSlotRs()">
                        <i class="fa-solid fa-circle-check"></i> Validate
                    </button>
                </div>
            </div>
            <div class="bc-ws-row" style="gap:16px">
                <label class="bc-toggle-label" style="flex:1">
                    <input type="checkbox" id="ws-rs-rs-enabled" checked>
                    Auto-restream when live
                </label>
                <label class="bc-toggle-label" style="flex:1">
                    <input type="checkbox" id="ws-rs-rs-mirror-chat" checked>
                    <i class="fa-solid fa-comments"></i> Mirror RS chat
                </label>
            </div>
            <p id="ws-rs-rs-status" class="muted" style="font-size:0.8rem;margin:8px 0 0"></p>
        </div>
        <div id="ws-rs-rtmp-fields">
            <div id="ws-rs-connect" style="display:none"></div>
            <div class="form-group">
                <label>Name</label>
                <input type="text" id="ws-rs-name" class="form-input form-input-sm" value="${esc(existing?.name || '')}" placeholder="e.g. My Twitch" maxlength="50">
            </div>
            <div class="form-group">
                <label>Server URL</label>
                <input type="text" id="ws-rs-server-url" class="form-input form-input-sm" value="${esc(existing?.server_url || '')}" placeholder="rtmp://...">
            </div>
            <div class="form-group">
                <label>Stream Key</label>
                <input type="password" id="ws-rs-stream-key" class="form-input form-input-sm" value="${esc(existing?.stream_key || '')}" placeholder="Paste stream key" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Channel URL <span class="muted">(for chat relay)</span></label>
                <input type="text" id="ws-rs-channel-url" class="form-input form-input-sm" value="${esc(existing?.channel_url || '')}" placeholder="https://twitch.tv/username">
            </div>
            <div class="form-group">
                <label>Quality Preset</label>
                <select id="ws-rs-quality" class="form-input">${qualityOpts}</select>
            </div>
            <div class="bc-ws-row" style="gap:16px">
                <label class="bc-toggle-label" style="flex:1">
                    <input type="checkbox" id="ws-rs-enabled" ${existing ? (existing.enabled ? 'checked' : '') : 'checked'}>
                    Enabled
                </label>
                <label class="bc-toggle-label" style="flex:1">
                    <input type="checkbox" id="ws-rs-auto-start" ${existing?.auto_start ? 'checked' : ''}>
                    Auto-start
                </label>
                <label class="bc-toggle-label" style="flex:1">
                    <input type="checkbox" id="ws-rs-chat-relay" ${existing?.chat_relay ? 'checked' : ''}>
                    <i class="fa-solid fa-comments"></i> Chat Relay
                </label>
            </div>
            <details style="margin-top:8px">
                <summary style="font-size:0.82rem;color:var(--text-secondary);cursor:pointer"><i class="fa-solid fa-sliders"></i> Custom Encoding Overrides</summary>
                <div class="bc-ws-row" style="margin-top:8px">
                    <div class="form-group" style="flex:1;margin:0">
                        <label style="font-size:0.78rem">Video Bitrate (kbps)</label>
                        <input type="number" id="ws-rs-video-bitrate" class="form-input form-input-sm" value="${existing?.custom_video_bitrate || ''}" placeholder="Auto" min="500" max="50000">
                    </div>
                    <div class="form-group" style="flex:1;margin:0">
                        <label style="font-size:0.78rem">Audio Bitrate (kbps)</label>
                        <input type="number" id="ws-rs-audio-bitrate" class="form-input form-input-sm" value="${existing?.custom_audio_bitrate || ''}" placeholder="Auto" min="32" max="512">
                    </div>
                    <div class="form-group" style="flex:1;margin:0">
                        <label style="font-size:0.78rem">FPS</label>
                        <input type="number" id="ws-rs-fps" class="form-input form-input-sm" value="${existing?.custom_fps || ''}" placeholder="Auto" min="15" max="120">
                    </div>
                </div>
            </details>
        </div>
        <div class="bc-ws-confirm-actions" style="margin-top:16px">
            <button class="btn btn-small" id="ws-rs-cancel">Cancel</button>
            <button class="btn btn-small btn-primary" id="ws-rs-save">
                <i class="fa-solid fa-floppy-disk"></i> ${isEdit ? 'Save' : 'Add'}
            </button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    // Apply platform-specific UI on open
    _wsRestreamPlatformChanged();
    // Load OAuth connection status, then render the per-platform Connect UI
    _wsLoadOAuthStatus().then(() => {
        _wsRenderRestreamConnect(document.getElementById('ws-rs-platform')?.value);
    });

    overlay.querySelector('#ws-rs-cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#ws-rs-save').onclick = async () => {
        const platform = document.getElementById('ws-rs-platform').value;
        const plat = _wsRestreamPlatforms[platform];

        // RobotStreamer — saved as a per-slot integration, not an RTMP destination row
        if (plat && plat.isRobotStreamer) {
            const payload = _wsGetSlotRsFormData();
            if (!payload.token && !_wsSlotRsIntegration?.has_token && !broadcastState?.robotStreamer?.hasToken) {
                toast('Paste your RobotStreamer token first', 'error');
                return;
            }
            if (!payload.robot_input && !_wsSlotRsIntegration?.robot_id) {
                toast('Enter or select a robot', 'error');
                return;
            }
            try {
                const data = await api('/robotstreamer/integration', { method: 'PUT', body: payload });
                _wsSlotRsIntegration = data.integration || null;
                _wsApplySlotRsToLiveStreams(_wsState.selectedId, _wsSlotRsIntegration);
                _wsRenderRestreamList();
                overlay.remove();
                toast('RobotStreamer configured for this stream slot', 'success');
            } catch (err) {
                _wsSetSlotRsStatus(err?.message || 'Failed to save RobotStreamer settings', 'error');
                toast(err?.message || 'Failed to save RobotStreamer settings', 'error');
            }
            return;
        }

        const body = {
            platform,
            name: document.getElementById('ws-rs-name').value.trim(),
            server_url: document.getElementById('ws-rs-server-url').value.trim(),
            stream_key: document.getElementById('ws-rs-stream-key').value.trim(),
            channel_url: document.getElementById('ws-rs-channel-url').value.trim(),
            quality_preset: document.getElementById('ws-rs-quality').value,
            enabled: document.getElementById('ws-rs-enabled').checked,
            auto_start: document.getElementById('ws-rs-auto-start').checked,
            chat_relay: document.getElementById('ws-rs-chat-relay').checked,
            custom_video_bitrate: parseInt(document.getElementById('ws-rs-video-bitrate').value) || null,
            custom_audio_bitrate: parseInt(document.getElementById('ws-rs-audio-bitrate').value) || null,
            custom_fps: parseInt(document.getElementById('ws-rs-fps').value) || null,
            managed_stream_id: _wsState.selectedId,
        };

        if (!body.stream_key) {
            toast('Stream key is required', 'error');
            return;
        }

        try {
            if (isEdit) {
                const data = await api(`/restream/destinations/${existing.id}`, { method: 'PUT', body });
                const idx = _wsRestreamDests.findIndex(d => d.id === existing.id);
                if (idx >= 0) _wsRestreamDests[idx] = data.destination;
            } else {
                const data = await api('/restream/destinations', { method: 'POST', body });
                _wsRestreamDests.push(data.destination);
            }
            _wsRenderRestreamList();
            overlay.remove();
            toast(isEdit ? 'Destination updated' : 'Destination added', 'success');
        } catch (err) {
            toast(err?.message || 'Failed to save', 'error');
        }
    };
}

// ── Per-platform OAuth "Connect" (Twitch / YouTube / Kick) ──────────────
let _wsOAuthStatus = null; // { platform: { configured, connected, username, providesKey, ... } }

async function _wsLoadOAuthStatus() {
    try {
        const data = await api('/restream/oauth/status');
        _wsOAuthStatus = {};
        (data.platforms || []).forEach(p => { _wsOAuthStatus[p.platform] = p; });
    } catch (err) {
        _wsOAuthStatus = _wsOAuthStatus || {};
    }
    return _wsOAuthStatus;
}

/** Render the Connect box for the chosen platform inside #ws-rs-connect. */
function _wsRenderRestreamConnect(platform) {
    const box = document.getElementById('ws-rs-connect');
    if (!box) return;
    const supported = ['twitch', 'youtube', 'kick'];
    if (!platform || !supported.includes(platform)) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';

    const plat = _wsRestreamPlatforms[platform];
    const st = (_wsOAuthStatus && _wsOAuthStatus[platform]) || null;
    const providesKey = st ? st.providesKey : (platform !== 'kick');

    // Status not loaded yet — show a light placeholder
    if (!st) {
        box.innerHTML = `<div style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 12px">
            <p class="muted" style="font-size:0.78rem;margin:0"><i class="fa-solid fa-spinner fa-spin"></i> Checking ${esc(plat.name)} connection…</p></div>`;
        return;
    }

    if (st.connected) {
        box.innerHTML = `
        <div style="background:rgba(83,252,24,0.08);border:1px solid rgba(83,252,24,0.35);border-radius:8px;padding:10px 12px;margin:0 0 12px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="color:${plat.color};font-weight:600"><i class="${plat.icon}"></i> Connected${st.username ? ' as ' + esc(st.username) : ''}</span>
                <i class="fa-solid fa-circle-check" style="color:#53fc18"></i>
                <span style="flex:1"></span>
                <button class="btn btn-small btn-outline" type="button" onclick="_wsConnectPlatform('${platform}')" title="Reconnect"><i class="fa-solid fa-rotate"></i></button>
                <button class="btn btn-small btn-outline" type="button" style="color:var(--danger)" onclick="_wsDisconnectPlatform('${platform}')"><i class="fa-solid fa-link-slash"></i> Disconnect</button>
            </div>
            <p class="muted" style="font-size:0.75rem;margin:6px 0 0">${providesKey
                ? 'Your ingest URL &amp; stream key are filled in automatically — just save.'
                : 'Account linked for chat &amp; viewer counts. Kick doesn’t expose stream keys via API, so paste your key below.'}</p>
        </div>`;
        return;
    }

    if (st.configured) {
        box.innerHTML = `
        <div style="background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.3);border-radius:8px;padding:12px;margin:0 0 12px;text-align:center">
            <button class="btn btn-primary" type="button" style="background:${plat.color};border-color:${plat.color};width:100%;justify-content:center" onclick="_wsConnectPlatform('${platform}')">
                <i class="${plat.icon}"></i> Connect ${esc(plat.name)}
            </button>
            <p class="muted" style="font-size:0.75rem;margin:8px 0 0">${providesKey
                ? `One click to link your ${esc(plat.name)} account — we’ll fetch your ingest URL and stream key for you.`
                : `Link your ${esc(plat.name)} account for chat &amp; viewer counts. You’ll still paste your stream key below (Kick doesn’t share it via API).`}</p>
        </div>`;
        return;
    }

    // Configured=false → admin hasn't set up OAuth creds for this platform
    box.innerHTML = `
    <div style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 12px">
        <p class="muted" style="font-size:0.78rem;margin:0"><i class="fa-solid fa-circle-info"></i> One-click connect for ${esc(plat.name)} isn’t enabled yet. Enter your server URL &amp; stream key manually below.</p>
    </div>`;
}

/** Open the OAuth popup and finish setup when it reports back. */
function _wsConnectPlatform(platform) {
    const slot = _wsState.selectedId;
    const url = `/api/restream/oauth/${platform}/start?managed_stream_id=${encodeURIComponent(slot)}`;
    const w = 620, h = 800;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(url, 'restream_oauth', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) { toast('Popup blocked — allow popups to connect your account', 'error'); return; }

    // Snapshot the current connection so polling only finalizes on a real change
    // (avoids prematurely finishing when the user is already connected).
    const startState = (_wsOAuthStatus && _wsOAuthStatus[platform]) || {};
    const startConnected = !!startState.connected;
    const startUsername = startState.username || '';

    // Show a live "connecting…" hint in the connect container.
    const box = document.getElementById('ws-rs-connect');
    if (box && !document.getElementById('ws-rs-connecting')) {
        box.insertAdjacentHTML('afterbegin',
            `<div id="ws-rs-connecting" style="text-align:center;padding:6px 0;color:var(--text-secondary);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Waiting for authorization…</div>`);
    }

    let finished = false;
    let pollTimer = null;
    let polls = 0;
    let bc = null;

    const cleanup = () => {
        try { window.removeEventListener('message', onMsg); } catch { /* */ }
        try { if (bc) bc.close(); } catch { /* */ }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        const hint = document.getElementById('ws-rs-connecting');
        if (hint) hint.remove();
    };

    // Update the open form's connect container in place (and reload destinations),
    // then reopen it in edit mode bound to the freshly-provisioned destination so
    // the "Connected" state + auto-filled key show without a manual close/reopen.
    const finalize = async (payload) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (payload && payload.ok === false) {
            toast(payload.error || 'Connection failed', 'error');
            _wsRenderRestreamConnect(document.getElementById('ws-rs-platform')?.value);
            return;
        }
        await _wsLoadOAuthStatus();
        await _wsLoadRestreamDests(_wsState.selectedId);
        const dest = _wsRestreamDests.find(x => x.platform === platform);
        const uname = (payload && payload.username) || (_wsOAuthStatus?.[platform]?.username) || '';
        const needsKey = payload ? payload.needsManualKey : !!(dest && !dest.stream_key);
        document.querySelectorAll('.bc-ws-confirm-overlay').forEach(o => o.remove());
        toast(`Connected ${platform}${uname ? ' as ' + uname : ''}${needsKey ? ' — add your stream key to finish' : ''}`, needsKey ? 'info' : 'success');
        if (dest) _wsShowRestreamForm(dest);
        else _wsRenderRestreamConnect(platform);
    };

    // 1) postMessage (works when the popup keeps its opener reference)
    const onMsg = (e) => {
        if (e.origin !== window.location.origin) return;
        const d = e.data;
        if (!d || d.type !== 'restream-oauth' || d.platform !== platform) return;
        finalize(d);
    };
    window.addEventListener('message', onMsg);

    // 2) BroadcastChannel (survives COOP severing window.opener on cross-origin nav)
    try {
        bc = new BroadcastChannel('restream-oauth');
        bc.onmessage = (e) => {
            const d = e.data;
            if (d && d.type === 'restream-oauth' && d.platform === platform) finalize(d);
        };
    } catch { bc = null; }

    // 3) Polling fallback — the guaranteed path: re-check server status on a timer.
    pollTimer = setInterval(async () => {
        polls++;
        let nowConnected = false, uname = '';
        try {
            await _wsLoadOAuthStatus();
            const st = _wsOAuthStatus && _wsOAuthStatus[platform];
            if (st && st.connected) { nowConnected = true; uname = st.username || ''; }
        } catch { /* keep polling */ }
        // Finalize only on a genuine change (newly connected or a different account).
        if (nowConnected && (!startConnected || uname !== startUsername)) {
            finalize(null);
            return;
        }
        // Popup closed without a new connection (cancel) → stop waiting.
        if (popup && popup.closed && polls >= 2 && !finished) { cleanup(); finished = true; return; }
        if (polls >= 120 && !finished) { cleanup(); finished = true; } // ~4 min safety cap
    }, 2000);
}

async function _wsDisconnectPlatform(platform) {
    try {
        await api(`/restream/oauth/${platform}/connection`, { method: 'DELETE' });
        await _wsLoadOAuthStatus();
        _wsRenderRestreamConnect(document.getElementById('ws-rs-platform')?.value);
        toast(`Disconnected ${platform}`, 'success');
    } catch (err) {
        toast(err?.message || 'Failed to disconnect', 'error');
    }
}

function _wsRestreamPlatformChanged() {
    const platform = document.getElementById('ws-rs-platform')?.value;
    const urlInput = document.getElementById('ws-rs-server-url');
    const nameInput = document.getElementById('ws-rs-name');
    const rtmpFields = document.getElementById('ws-rs-rtmp-fields');
    const rsFields = document.getElementById('ws-rs-robotstreamer-fields');
    if (!platform) return;
    const plat = _wsRestreamPlatforms[platform];

    // Toggle RTMP vs RS view
    const isRs = !!(plat && plat.isRobotStreamer);
    if (rtmpFields) rtmpFields.style.display = isRs ? 'none' : '';
    if (rsFields) rsFields.style.display = isRs ? '' : 'none';

    // Render the per-platform "Connect" (OAuth) UI
    if (!isRs) _wsRenderRestreamConnect(platform);

    if (isRs) {
        // Prefill from the slot's existing RS config (if any)
        const rs = _wsSlotRsIntegration;
        const tokenEl = document.getElementById('ws-rs-rs-token');
        const robotEl = document.getElementById('ws-rs-rs-robot-input');
        const enabledEl = document.getElementById('ws-rs-rs-enabled');
        const mirrorEl = document.getElementById('ws-rs-rs-mirror-chat');
        if (tokenEl) {
            tokenEl.placeholder = rs?.has_token
                ? 'Token saved for this slot — paste a new one only to replace it'
                : (broadcastState?.robotStreamer?.hasToken
                    ? 'Leave empty to reuse your account token, or paste a slot-specific one'
                    : 'Paste your robotstreamer-token cookie or JWT');
        }
        if (robotEl && rs?.robot_id && !robotEl.value) robotEl.value = rs.robot_id;
        if (enabledEl && rs) enabledEl.checked = !!rs.enabled;
        if (mirrorEl && rs) mirrorEl.checked = rs.mirror_chat !== false;
        _wsPopulateSlotRsRobotSelect(rs?.available_robots || [], rs?.robot_id || '');
        _wsSetSlotRsStatus(rs
            ? `Configured for ${rs.stream_name || `robot ${rs.robot_id}`} on this slot.`
            : 'This config applies only to the current stream slot.', 'info');
    } else {
        if (plat && urlInput && !urlInput.value) {
            urlInput.value = plat.defaultUrl || '';
        }
        if (plat && nameInput && !nameInput.value) {
            nameInput.value = plat.name;
        }
    }
}

function _wsCopyOverlayUrl() {
    const input = document.getElementById('bc-ws-overlay-url');
    if (!input) return;
    navigator.clipboard.writeText(input.value).then(() => toast('Overlay URL copied!', 'success'))
        .catch(() => { prompt('Copy manually:', input.value); });
}

function _wsGetVibePublisherUrl() {
    const origin = String(window.location.origin || '').replace(/\/$/, '');
    if (!origin) return '/ws/vibe-coding/publish';
    return origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws/vibe-coding/publish';
}

function _wsGetVibeFeedUrl(ms = _wsState.selectedMs) {
    if (!ms || !currentUser?.username) return '';
    return `${window.location.origin.replace(/\/$/, '')}/api/vibe-coding/channel/${encodeURIComponent(currentUser.username)}/${encodeURIComponent(String(ms.slug || ms.id))}/events`;
}

function _wsCopyVibePublisherUrl() {
    _wsCopyText(_wsGetVibePublisherUrl(), 'Vibe publisher URL copied');
}

function _wsCopyVibeManagedStreamId() {
    if (!_wsState.selectedMs?.id) {
        toast('No managed stream selected', 'error');
        return;
    }
    _wsCopyText(String(_wsState.selectedMs.id), 'Managed stream ID copied');
}

function _wsCopyVibeSlotSlug() {
    if (!_wsState.selectedMs?.slug) {
        toast('This slot does not have a slug yet', 'error');
        return;
    }
    _wsCopyText(String(_wsState.selectedMs.slug), 'Slot slug copied');
}

function _wsCopyVibeFeedUrl() {
    const url = _wsGetVibeFeedUrl();
    if (!url) {
        toast('Public feed URL unavailable', 'error');
        return;
    }
    _wsCopyText(url, 'Public feed URL copied');
}

function _wsCopyVibeSettingsTemplate() {
    if (!_wsState.selectedMs?.id) {
        toast('No managed stream selected', 'error');
        return;
    }
    const template = {
        copilotChatWebSocket: {
            url: _wsGetVibePublisherUrl(),
            apiToken: 'PASTE_VIBE_CODING_TOKEN_HERE',
            managedStreamId: _wsState.selectedMs.id,
            slotSlug: _wsState.selectedMs.slug || '',
            autoConnect: true,
        },
    };
    _wsCopyText(JSON.stringify(template, null, 2), 'Extension settings template copied');
}

function _wsPreviewOverlay() {
    const input = document.getElementById('bc-ws-overlay-url');
    if (!input) return;
    window.open(input.value, '_blank', 'noopener');
}
