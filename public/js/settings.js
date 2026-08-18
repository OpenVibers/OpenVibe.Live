/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Settings Page
   Account settings with tabs: Profile, Appearance
   (Broadcaster & My Streams moved to per-slot workspace)
   ═══════════════════════════════════════════════════════════════ */

let settingsActiveTab = 'profile';

async function loadSettingsPage() {
    if (!currentUser) {
        toast('Login required', 'error');
        return navigate('/');
    }
    switchSettingsTab('profile');
}

function switchSettingsTab(tab) {
    settingsActiveTab = tab;
    document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.id === `settings-${tab}`));

    switch (tab) {
        case 'profile': loadSettingsProfile(); break;
        case 'appearance': loadSettingsAppearance(); break;
        case 'offline': loadSettingsOffline(); break;
    }
}

/* ── Offline Screen Tab ───────────────────────────────────────── */
let _offlineChannel = null;
async function loadSettingsOffline() {
    try {
        const data = await api('/streams/channel');
        _offlineChannel = data.channel || {};
        const type = _offlineChannel.offline_screen_type || 'none';
        document.getElementById('offline-screen-type').value = ['none', 'image', 'video', 'html'].includes(type) ? (type === 'video' ? 'image' : type) : 'none';
        document.getElementById('offline-html').value = _offlineChannel.offline_html || '';
        document.getElementById('offline-css').value = _offlineChannel.offline_css || '';
        _renderOfflinePreview();
        onOfflineTypeChange();
    } catch (e) { toast('Failed to load channel settings', 'error'); }
}
function _renderOfflinePreview() {
    const box = document.getElementById('offline-preview');
    if (!box) return;
    const url = _offlineChannel && _offlineChannel.offline_screen_url;
    const t = _offlineChannel && _offlineChannel.offline_screen_type;
    if (url && t === 'image') box.innerHTML = `<img src="${escapeHtml(url)}" style="max-width:320px;max-height:180px;border-radius:8px;border:1px solid var(--border)">`;
    else if (url && t === 'video') box.innerHTML = `<video src="${escapeHtml(url)}" autoplay muted loop playsinline style="max-width:320px;max-height:180px;border-radius:8px;border:1px solid var(--border)"></video>`;
    else box.innerHTML = '<span class="muted" style="font-size:0.82rem">No asset uploaded yet.</span>';
}
function onOfflineTypeChange() {
    const t = document.getElementById('offline-screen-type').value;
    document.getElementById('offline-media-row').style.display = (t === 'image') ? '' : 'none';
    document.getElementById('offline-html-row').style.display = (t === 'html') ? '' : 'none';
}
async function uploadOfflineScreen(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const status = document.getElementById('offline-save-status');
    status.textContent = 'Uploading & optimizing…';
    try {
        const fd = new FormData();
        fd.append('file', file);
        const token = localStorage.getItem('token');
        const res = await fetch(`${API}/api/streams/channel/offline-screen`, {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
            body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        _offlineChannel.offline_screen_url = data.url;
        _offlineChannel.offline_screen_type = data.type;
        _renderOfflinePreview();
        status.textContent = '';
        toast('Offline screen uploaded', 'success');
    } catch (e) { status.textContent = ''; toast(e.message || 'Upload failed', 'error'); }
    input.value = '';
}
async function saveOfflineScreen() {
    const sel = document.getElementById('offline-screen-type').value;
    const status = document.getElementById('offline-save-status');
    // 'image' in the selector covers both stored image + video assets — keep whichever
    // asset type was uploaded; only force 'none'/'html' explicitly.
    let type = sel;
    if (sel === 'image') type = (_offlineChannel.offline_screen_type === 'video') ? 'video' : 'image';
    try {
        const body = {
            offline_screen_type: type,
            offline_html: document.getElementById('offline-html').value,
            offline_css: document.getElementById('offline-css').value,
        };
        await api('/streams/channel', { method: 'PUT', body });
        status.textContent = 'Saved ✓';
        setTimeout(() => { status.textContent = ''; }, 1500);
        toast('Offline screen saved', 'success');
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
}

/* ── Profile Tab ──────────────────────────────────────────────── */
async function loadSettingsProfile() {
    try {
        const data = await api('/auth/me');
        const u = data.user || data;

        _renderSettingsAvatar(u);
        _loadAvatarHistory();
        document.getElementById('settings-banner-name').textContent = u.display_name || u.username;

        const _sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        _sv('set-username', u.username || '');
        _sv('set-display-name', u.display_name || '');
        _sv('set-email', u.email || '');
        _sv('set-bio', u.bio || '');
        _sv('set-profile-color', u.profile_color || '#8b5cf6'); // removed from UI; harmless if absent
    } catch (e) {
        toast('Failed to load profile', 'error');
    }
}

// Show the current avatar (image or letter) + the camera edit chip in the banner.
function _renderSettingsAvatar(u) {
    const el = document.getElementById('settings-banner-initial');
    if (!el) return;
    const letter = (u.username || '?')[0].toUpperCase();
    const chip = '<span class="settings-avatar-edit"><i class="fa-solid fa-camera"></i></span>';
    el.innerHTML = (u.avatar_url
        ? `<img src="${u.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" onerror="var p=this.parentNode;this.remove();if(p)p.insertAdjacentText('afterbegin','${letter}')">`
        : letter) + chip;
}

// Render the user's avatar upload history (backed by avatar-tagged pastes).
async function _loadAvatarHistory() {
    const card = document.getElementById('settings-avatar-history-card');
    const wrap = document.getElementById('settings-avatar-history');
    if (!card || !wrap) return;
    try {
        const data = await api('/auth/avatar/history');
        const avatars = data.avatars || [];
        if (!avatars.length) { card.style.display = 'none'; return; }
        card.style.display = '';
        wrap.innerHTML = avatars.map(a => `
            <button type="button" class="settings-avatar-hist-item${a.active ? ' active' : ''}"
                    title="${a.active ? 'Current avatar' : 'Use this avatar'}"
                    onclick="reuseAvatarPaste('${a.slug}')">
                <img src="${a.url}" alt="" loading="lazy">
                ${a.active ? '<span class="settings-avatar-hist-active"><i class="fa-solid fa-check"></i></span>' : ''}
            </button>`).join('');
    } catch { card.style.display = 'none'; }
}

// Re-activate a previously uploaded avatar from history.
async function reuseAvatarPaste(slug) {
    try {
        const data = await api(`/pastes/${slug}/set-avatar`, { method: 'POST' });
        toast('Avatar updated', 'success');
        if (data.avatar_url && currentUser) currentUser.avatar_url = data.avatar_url;
        _renderSettingsAvatar(currentUser);
        _loadAvatarHistory();
        if (typeof onAuthChange === 'function') onAuthChange();
    } catch (e) { toast(e.message || 'Failed to set avatar', 'error'); }
}

async function uploadSettingsAvatar(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('Image too large (max 20MB)', 'error'); return; }
    if (!/^image\//.test(file.type)) { toast('Please choose an image file', 'error'); return; }
    try {
        const fd = new FormData();
        fd.append('avatar', file);
        const pubCheck = document.getElementById('avatar-public-check');
        fd.append('public', (pubCheck ? pubCheck.checked : true) ? 'true' : 'false');
        const token = localStorage.getItem('token');
        const r = await fetch('/api/auth/avatar', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Upload failed');
        toast('Avatar updated', 'success');
        currentUser = data.user || currentUser;
        _renderSettingsAvatar(currentUser);
        _loadAvatarHistory();
        if (typeof onAuthChange === 'function') onAuthChange();
    } catch (e) { toast(e.message || 'Avatar upload failed', 'error'); }
}

async function saveSettingsProfile() {
    const uname = (document.getElementById('set-username').value || '').trim();
    const dname = document.getElementById('set-display-name').value.trim();
    // Display name may only re-case the username (matches the server rule).
    if (uname && dname && dname.toLowerCase() !== uname.toLowerCase()) {
        toast(`Display name can only change the capitalization of "${uname}"`, 'error');
        return;
    }
    const data = {
        display_name: dname,
        email: document.getElementById('set-email').value.trim() || null,
        bio: document.getElementById('set-bio').value.trim(),
    };
    // Profile color is managed centrally at openvibe.network now (its SSO sync overrides any
    // local value on every login) — only send it if the field is still present.
    const _pc = document.getElementById('set-profile-color');
    if (_pc) data.profile_color = _pc.value;

    try {
        await api('/auth/profile', { method: 'PUT', body: data });
        toast('Profile saved', 'success');
        // Refresh user data
        const me = await api('/auth/me');
        currentUser = me.user || me;
        onAuthChange();
    } catch (e) {
        toast(e.message || 'Failed to save', 'error');
    }
}

function getDefaultOpenVibeToolsUrl() {
    const host = window.location.hostname;
    const isLocalHost = ['localhost', '127.0.0.1'].includes(host);
    const isTopenvibeAlias = ['topenvibe.tools', 'topenvibe.live', 'topenvibe.quest'].includes(host);
    return isLocalHost ? 'http://localhost:3100' : (isTopenvibeAlias ? 'https://topenvibe.tools' : 'https://openvibe.network');
}

function getOpenVibeToolsUrl() {
    const urls = window.OpenVibeNetworkUrls || { tools: getDefaultOpenVibeToolsUrl() };
    return urls.tools || getDefaultOpenVibeToolsUrl();
}

function getOpenVibeToolsAdminUrl() {
    const url = getOpenVibeToolsUrl();
    try {
        const u = new URL(url);
        u.hostname = u.hostname.replace(/^www\./, 'my.');
        return u.toString().replace(/\/$/, '');
    } catch {
        return `${url.replace(/\/$/, '')}/admin`;
    }
}

// Password management handled on openvibe.network
function changePassword() {
    window.open(getOpenVibeToolsAdminUrl(), '_blank');
}

/* ── Broadcaster Tab ──────────────────────────────────────────── */
async function loadSettingsBroadcaster() {
    // Load stream key
    try {
        const data = await api('/auth/stream-key');
        document.getElementById('set-stream-key').value = data.stream_key || data.streamKey || '';
    } catch { /* silent */ }

    // Load broadcast defaults from localStorage
    loadBroadcastSettings();
    const s = broadcastState.settings;

    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };

    setVal('set-default-res', s.broadcastRes);
    setVal('set-default-fps', s.broadcastFps);
    setVal('set-default-codec', s.broadcastCodec);
    setVal('set-default-bitrate', s.broadcastBps);
    setVal('set-default-bitrate-min', s.broadcastBpsMin);
    setVal('set-broadcast-limit', s.broadcastLimit);
    setCheck('set-auto-gain', s.autoGain);
    setCheck('set-echo-cancellation', s.echoCancellation);
    setCheck('set-noise-suppression', s.noiseSuppression);

    // Load VOD/clip visibility defaults + weather settings from channel
    try {
        const ch = await api('/streams/channel');
        if (ch) {
            setVal('set-default-vod-visibility', ch.default_vod_visibility || 'public');
            setVal('set-default-clip-visibility', ch.default_clip_visibility || 'public');
            setCheck('set-vod-recording-enabled', ch.vod_recording_enabled !== 0 && ch.force_vod_recording_disabled !== 1);
            const vodToggle = document.getElementById('set-vod-recording-enabled');
            if (vodToggle) {
                vodToggle.disabled = ch.force_vod_recording_disabled === 1;
                vodToggle.title = ch.force_vod_recording_disabled === 1
                    ? 'VOD recording is force-disabled by admin for this channel'
                    : '';
            }
            setVal('set-weather-zip', ch.weather_zip || '');
            setVal('set-weather-detail', ch.weather_detail || 'basic');
            setCheck('set-weather-show-location', !!ch.weather_show_location);
        }
    } catch { /* channel may not exist yet */ }
}

function saveSettingsBroadcaster() {
    const s = broadcastState.settings;
    s.broadcastRes = document.getElementById('set-default-res')?.value || s.broadcastRes;
    s.broadcastFps = document.getElementById('set-default-fps')?.value || s.broadcastFps;
    s.broadcastCodec = document.getElementById('set-default-codec')?.value || s.broadcastCodec;
    s.broadcastBps = document.getElementById('set-default-bitrate')?.value || s.broadcastBps;
    s.broadcastBpsMin = document.getElementById('set-default-bitrate-min')?.value || s.broadcastBpsMin;
    s.broadcastLimit = document.getElementById('set-broadcast-limit')?.value || s.broadcastLimit;
    s.autoGain = document.getElementById('set-auto-gain')?.checked || false;
    s.echoCancellation = document.getElementById('set-echo-cancellation')?.checked || false;
    s.noiseSuppression = document.getElementById('set-noise-suppression')?.checked || false;
    saveBroadcastSettings();

    // Save VOD/clip visibility defaults + weather settings to channel
    const vodVis = document.getElementById('set-default-vod-visibility')?.value;
    const clipVis = document.getElementById('set-default-clip-visibility')?.value;
    const vodRecordingEnabled = document.getElementById('set-vod-recording-enabled')?.checked;
    const weatherZip = document.getElementById('set-weather-zip')?.value;
    const weatherDetail = document.getElementById('set-weather-detail')?.value;
    {
        const body = {};
        if (vodVis) body.default_vod_visibility = vodVis;
        if (clipVis) body.default_clip_visibility = clipVis;
        if (vodRecordingEnabled !== undefined) body.vod_recording_enabled = vodRecordingEnabled ? 1 : 0;
        body.weather_zip = weatherZip || '';
        if (weatherDetail) body.weather_detail = weatherDetail;
        body.weather_show_location = document.getElementById('set-weather-show-location')?.checked ? 1 : 0;
        api('/streams/channel', { method: 'PUT', body }).catch(() => {});
    }

    toast('Broadcaster settings saved', 'success');
}

function toggleSetKeyVis() {
    const el = document.getElementById('set-stream-key');
    el.type = el.type === 'password' ? 'text' : 'password';
}

function copySetKey() {
    const v = document.getElementById('set-stream-key').value;
    navigator.clipboard.writeText(v).then(() => toast('Copied!', 'success'));
}

async function regenSetKey() {
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        document.getElementById('set-stream-key').value = data.stream_key || data.streamKey || '';
        toast('Stream key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── My Streams Tab ───────────────────────────────────────────── */
async function loadSettingsStreams() {
    const container = document.getElementById('settings-streams-list');
    if (!container) return;

    try {
        const data = await api('/streams/mine');
        const allStreams = data.streams || [];

        if (!allStreams.length) {
            container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-nodes fa-3x" style="color:var(--accent)"></i><p>No streams yet</p><p class="muted">Go live from the <a href="#" onclick="event.preventDefault();navigate('/broadcast')">Go Live</a> page to create your first stream!</p></div>`;
            return;
        }

        container.innerHTML = allStreams.map(s => `
            <div class="stream-config-card">
                <h4>
                    ${s.is_live ? '<i class="fa-solid fa-circle live-dot"></i>' : '<i class="fa-solid fa-video muted"></i>'}
                    ${esc(s.title || 'Untitled')}
                    <span class="muted">#${s.id}</span>
                </h4>
                <div class="settings-row">
                    <span class="settings-row-label">Status</span>
                    <span class="settings-row-content">
                        ${s.is_live ? '<span class="badge badge-live">LIVE</span>' : '<span class="badge">Ended</span>'}
                    </span>
                </div>
                <div class="settings-row">
                    <span class="settings-row-label">Started</span>
                    <span class="settings-row-content">${new Date(s.started_at || s.created_at).toLocaleString()}</span>
                </div>
                ${s.category ? `<div class="settings-row">
                    <span class="settings-row-label">Category</span>
                    <span class="settings-row-content">${esc(s.category)}</span>
                </div>` : ''}
                ${s.is_live ? `<button class="btn btn-danger btn-small" onclick="endStreamFromSettings(${s.id})">
                    <i class="fa-solid fa-stop"></i> End Stream
                </button>` : ''}
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<p class="muted">Failed to load streams</p>';
    }
}

async function endStreamFromSettings(streamId) {
    try {
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'success');
        loadSettingsStreams();
    } catch (e) { toast(e.message, 'error'); }
}

/* ═══════════════════════════════════════════════════════════════
   APPEARANCE TAB — Theme picker + custom editor
   ═══════════════════════════════════════════════════════════════ */

let settingsThemeFilter = '';

async function loadSettingsAppearance() {
    await fetchAllThemes();
    renderThemeGrid();
    renderThemeEditor();
}

function filterThemes(mode) {
    settingsThemeFilter = mode;
    document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderThemeGrid();
}

function renderThemeGrid() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;

    let themes = allThemes;
    if (settingsThemeFilter) {
        themes = themes.filter(t => t.mode === settingsThemeFilter);
    }

    if (!themes.length) {
        grid.innerHTML = '<p class="muted">No themes found.</p>';
        return;
    }

    const dark = themes.filter(t => t.mode !== 'light');
    const light = themes.filter(t => t.mode === 'light');
    const section = (title, icon, list) => list.length ? `
        <div class="theme-grid-section">
            <h4 class="theme-grid-section-title"><i class="fa-solid ${icon}"></i> ${title} <span class="theme-grid-section-count">${list.length}</span></h4>
            <div class="theme-grid-cards">${list.map(_settingsThemeCardHTML).join('')}</div>
        </div>` : '';
    grid.innerHTML = section('Dark Themes', 'fa-moon', dark) + section('Light Themes', 'fa-sun', light);
}

function _settingsThemeCardHTML(t) {
    const p = t.preview_colors || {};
    const isActive = activeTheme?.id === t.id && !isCustomMode;
    return `
        <div class="theme-card ${isActive ? 'theme-card-active' : ''}" onclick="selectTheme(${t.id}).then(()=>renderThemeGrid())" title="${esc(t.name)}">
            <div class="theme-card-preview" style="background:${esc(p.bg || '#0d0d0f')}">
                <div class="theme-card-accent" style="background:${esc(p.accent || '#8b5cf6')}"></div>
                <div class="theme-card-text" style="color:${esc(p.text || '#e8e6e3')}">Aa</div>
            </div>
            <div class="theme-card-info">
                <span class="theme-card-name">${esc(t.name)}</span>
                ${t.mode === 'light' ? '<i class="fa-solid fa-sun" title="Light"></i>' : '<i class="fa-solid fa-moon" title="Dark"></i>'}
            </div>
            ${isActive ? '<div class="theme-card-check"><i class="fa-solid fa-check-circle"></i></div>' : ''}
        </div>
    `;
}

function renderThemeEditor() {
    const container = document.getElementById('theme-editor-groups');
    if (!container) return;

    container.innerHTML = VAR_GROUPS.map(group => `
        <div class="theme-editor-group">
            <h4><i class="fa-solid ${group.icon}"></i> ${group.label}</h4>
            <div class="theme-editor-vars">
                ${group.vars.map(v => {
                    const cur = getThemeVar(v);
                    const isColor = cur.startsWith('#') || cur.startsWith('rgb');
                    const isShadow = v.includes('shadow');
                    return `
                        <div class="theme-editor-row">
                            <label>${VAR_LABELS[v] || v}</label>
                            ${isShadow
                                ? `<input type="text" value="${esc(cur)}" oninput="setCustomVar('${v}',this.value)" class="theme-editor-input" style="width:200px">`
                                : `<input type="color" value="${cur}" oninput="setCustomVar('${v}',this.value)" class="theme-editor-color">
                                   <span class="theme-editor-hex">${cur}</span>`
                            }
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `).join('');
}

async function submitCurrentTheme() {
    const name = document.getElementById('submit-theme-name')?.value?.trim();
    const desc = document.getElementById('submit-theme-desc')?.value?.trim();
    if (!name) return toast('Enter a theme name', 'error');
    if (!currentUser) return toast('Login required', 'error');

    try {
        await submitThemeToDirectory(name, desc || '', activeTheme?.mode || 'dark');
        toast('Theme submitted to directory!', 'success');
        document.getElementById('submit-theme-name').value = '';
        document.getElementById('submit-theme-desc').value = '';
        // Refresh lists
        await fetchAllThemes();
        renderThemeGrid();
    } catch (e) {
        toast(e.message || 'Failed to submit theme', 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   THEME DIRECTORY PAGE  (/themes)
   ═══════════════════════════════════════════════════════════════ */

let dirThemes = [];
let dirModeFilter = '';

async function loadThemesPage() {
    dirModeFilter = '';
    document.querySelectorAll('.theme-dir-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === ''));
    const searchEl = document.getElementById('theme-dir-search');
    if (searchEl) searchEl.value = '';
    const sortEl = document.getElementById('theme-dir-sort');
    if (sortEl) sortEl.value = 'name';

    // Populate allThemes cache so selectTheme() works from directory page
    await fetchAllThemes();
    await refreshDirThemes();
}

async function refreshDirThemes() {
    const search = document.getElementById('theme-dir-search')?.value?.trim() || '';
    const sort = document.getElementById('theme-dir-sort')?.value || 'name';

    try {
        const data = await api(`/themes?mode=${dirModeFilter}&search=${encodeURIComponent(search)}&sort=${sort}`);
        dirThemes = data.themes || [];
    } catch {
        dirThemes = [];
    }
    renderDirGrid();
}

function filterDirThemes(mode) {
    dirModeFilter = mode;
    document.querySelectorAll('.theme-dir-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    refreshDirThemes();
}

let _dirSearchTimerId;
function searchDirThemes() {
    clearTimeout(_dirSearchTimerId);
    _dirSearchTimerId = setTimeout(refreshDirThemes, 300);
}

function sortDirThemes() {
    refreshDirThemes();
}

function renderDirGrid() {
    const grid = document.getElementById('theme-dir-grid');
    if (!grid) return;

    if (!dirThemes.length) {
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-palette fa-3x" style="color:var(--accent)"></i><p>No themes found</p></div>';
        return;
    }

    const dark = dirThemes.filter(t => t.mode !== 'light');
    const light = dirThemes.filter(t => t.mode === 'light');
    const section = (title, icon, list) => list.length ? `
        <div class="theme-dir-section">
            <h3 class="theme-dir-section-title"><i class="fa-solid ${icon}"></i> ${title} <span class="theme-dir-section-count">${list.length}</span></h3>
            <div class="theme-dir-cards">${list.map(_dirThemeCardHTML).join('')}</div>
        </div>` : '';
    grid.innerHTML = section('Dark Themes', 'fa-moon', dark) + section('Light Themes', 'fa-sun', light);
}

function _dirThemeCardHTML(t) {
        const p = t.preview_colors || {};
        const isActive = activeTheme?.id === t.id && !isCustomMode;
        return `
            <div class="theme-dir-card">
                <div class="theme-dir-preview" style="background:${esc(p.bg || '#0d0d0f')}" onclick="previewDirTheme(${t.id})">
                    <div class="theme-dir-preview-bar" style="background:${esc(p.accent || '#8b5cf6')}"></div>
                    <div class="theme-dir-preview-text" style="color:${esc(p.text || '#e8e6e3')}">
                        <span style="font-size:1.2em;font-weight:bold">Aa</span>
                        <span style="font-size:0.8em;opacity:0.7">Preview</span>
                    </div>
                    ${isActive ? '<div class="theme-dir-active-badge"><i class="fa-solid fa-check"></i> Active</div>' : ''}
                </div>
                <div class="theme-dir-info">
                    <div class="theme-dir-name">
                        ${esc(t.name)}
                        ${t.is_builtin ? '<span class="badge" style="font-size:0.65em">Built-in</span>' : ''}
                    </div>
                    <div class="theme-dir-meta">
                        ${t.mode === 'light' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>'}
                        ${t.author_name ? `<span>by ${esc(t.author_name)}</span>` : ''}
                        <span><i class="fa-solid fa-download"></i> ${t.downloads || 0}</span>
                    </div>
                    ${t.description ? `<p class="theme-dir-desc muted">${esc(t.description)}</p>` : ''}
                    <div class="theme-dir-actions">
                        <button class="btn btn-primary btn-small" onclick="activateDirTheme(${t.id})">
                            ${isActive ? '<i class="fa-solid fa-check"></i> Active' : '<i class="fa-solid fa-paintbrush"></i> Apply'}
                        </button>
                        ${!t.is_builtin && currentUser && t.author_id === currentUser.id ? `
                            <button class="btn btn-danger btn-small" onclick="deleteDirTheme(${t.id})">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
}

async function previewDirTheme(themeId) {
    const t = dirThemes.find(x => x.id === themeId);
    if (t) applyTheme(t);
}

async function activateDirTheme(themeId) {
    await selectTheme(themeId);
    renderDirGrid();
    toast('Theme applied!', 'success');
}

async function deleteDirTheme(themeId) {
    if (!confirm('Delete this theme from the directory?')) return;
    try {
        await api(`/themes/${themeId}`, { method: 'DELETE' });
        toast('Theme deleted', 'success');
        await refreshDirThemes();
    } catch (e) {
        toast(e.message || 'Failed to delete', 'error');
    }
}
