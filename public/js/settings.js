/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Settings Page
   Offline screen and profile forms used by the dashboard, plus the
   openvibe.network URL helper.
   ═══════════════════════════════════════════════════════════════ */

/* ── Offline Screen Tab ───────────────────────────────────────── */
let _offlineChannel = null;
async function loadSettingsOffline() {
    try {
        const data = await api('/streams/channel');
        _offlineChannel = (data && data.channel) || data || {};   // GET /streams/channel answers the channel row itself
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
