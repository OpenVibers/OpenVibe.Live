/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Dashboard (Streamer Panel)
   ═══════════════════════════════════════════════════════════════ */

let activeStreamData = null;
let activeStreams = [];

/* ── Tabbed dashboard ──────────────────────────────────────────────
   Cards are authored in a hidden #dash-staging grid, then relocated by id
   into their tab panel. Each tab's data loads lazily the first time it's opened
   (so the dashboard paints instantly and only does the work you look at). Other
   modules (e.g. moderation) register their loader on window._dashTabLoaders. */
const _DASH_TAB_CARDS = {
    home:       ['dash-card-profile', 'dash-card-ai-derivation', 'dash-card-offline'],
    chatai:     ['dash-aibot-card', 'dash-card-overlay', 'dash-card-chatlogs'],
    moderation: [],  // injected by dashboard-moderation.js into #dash-grid-moderation
    controls:   ['dash-card-bot-embed', 'dash-card-tokens'],
    money:      ['dash-card-bucks', 'dash-card-goals', 'dash-powerchat-card'],
    points:     ['dash-card-points-config', 'dash-card-rewards', 'dash-card-redemptions'],
    content:    [],  // content cards go into sub-grids (see _DASH_CONTENT_SUBCARDS)
};
// Content tab has its own sub-tabs; each card relocates into a sub-grid.
const _DASH_CONTENT_SUBCARDS = {
    videos:      ['dash-my-videos-card'],
    streamclips: ['dash-card-streamclips'],
    myclips:     ['dash-card-myclips'],
    aimoments:   ['dash-card-aimoments'],
    pastes:      ['dash-card-pastes'],
};
window._dashTabLoaders = window._dashTabLoaders || {};
let _dashRelocated = false;
const _dashLoadedTabs = new Set();
const _dashLoadedContentSubs = new Set();

function _dashRelocateCards() {
    if (_dashRelocated) return;
    _dashRelocated = true;
    for (const [tab, ids] of Object.entries(_DASH_TAB_CARDS)) {
        const grid = document.getElementById('dash-grid-' + tab);
        if (!grid) continue;
        for (const id of ids) {
            const card = document.getElementById(id);
            if (card && card.parentElement !== grid) grid.appendChild(card);
        }
    }
    // Content sub-tabs.
    for (const [sub, ids] of Object.entries(_DASH_CONTENT_SUBCARDS)) {
        const grid = document.getElementById('dash-grid-content-' + sub);
        if (!grid) continue;
        for (const id of ids) {
            const card = document.getElementById(id);
            if (card && card.parentElement !== grid) grid.appendChild(card);
        }
    }
}

// Content sub-tab loaders (lazy per sub-tab).
const _DASH_CONTENT_LOADERS = {
    videos:      () => _call('loadDashVods'),
    streamclips: () => { _call('loadDashStreamClips'); _call('loadClipSettings'); },
    myclips:     () => _call('loadDashMyClips'),
    aimoments:   () => _call('loadDashAiClips'),
    pastes:      () => _call('loadDashPastes'),
};
function switchDashContentTab(sub, btn) {
    document.querySelectorAll('#dash-content-subtabs .ch-tab').forEach(b => {
        b.classList.toggle('active', b === btn || b.dataset.cdtab === sub);
    });
    document.querySelectorAll('#dash-panel-content .dash-subpanel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('dash-content-' + sub);
    if (panel) panel.classList.add('active');
    if (!_dashLoadedContentSubs.has(sub)) {
        _dashLoadedContentSubs.add(sub);
        try { (_DASH_CONTENT_LOADERS[sub] || (() => {}))(); } catch (e) { console.warn('[dash] content sub', sub, e); }
    }
}
window.switchDashContentTab = switchDashContentTab;

function switchDashTab(tab, btn) {
    // The tab is in the address (/dashboard/money), so a refresh or a shared link opens it again; Home is /dashboard.
    if (location.pathname.startsWith('/dashboard')) {
        const want = tab === 'home' ? '/dashboard' : '/dashboard/' + tab;
        if (location.pathname !== want) history.replaceState(history.state, '', want + location.search);
    }
    document.querySelectorAll('#dash-tabs .ch-tab').forEach(b => {
        const on = b === btn || b.dataset.dtab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#page-dashboard .dash-tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('dash-panel-' + tab);
    if (panel) panel.classList.add('active');
    // Lazy-load this tab's data once.
    if (!_dashLoadedTabs.has(tab)) {
        _dashLoadedTabs.add(tab);
        try { (window._dashTabLoaders[tab] || (() => {}))(); } catch (e) { console.warn('[dash] tab loader', tab, e); }
    }
}
window.switchDashTab = switchDashTab;

// Per-tab loaders (guarded so a missing fn never breaks the tab).
function _call(name) { try { if (typeof window[name] === 'function') window[name](); } catch (e) { console.warn('[dash]', name, e); } }
window._dashTabLoaders.home = () => { _call('loadSettingsProfile'); _call('loadAiDerivationSetting'); _call('loadSettingsOffline'); _call('loadDashFunds'); };
window._dashTabLoaders.chatai = () => { _call('updateDashObsOverlayUrl'); _call('loadAiViewers'); };
window._dashTabLoaders.controls = () => { _call('loadBotEmbedSetting'); _call('loadDashTokens'); };
window._dashTabLoaders.money = () => { _call('loadDashFunds'); _call('loadDashGoals'); _call('loadPowerchatStatus'); };
window._dashTabLoaders.points = () => { _call('loadDashPointsConfig'); _call('loadDashRewards'); _call('loadDashRedemptions'); };
window._dashTabLoaders.content = () => { switchDashContentTab('videos', document.querySelector('#dash-content-subtabs .ch-tab[data-cdtab="videos"]')); _call('loadDashAiMomentsCount'); };
// moderation loader is registered by dashboard-moderation.js

/**
 * Load the dashboard page — build the tab layout, then load only the default (Home) tab.
 */
async function loadDashboard() {
    if (!currentUser) {
        toast('Login required', 'error');
        return navigate('/');
    }
    loadDashChannel();
    _dashRelocateCards();
    _dashLoadedTabs.clear();
    const fromUrl = (location.pathname.match(/^\/dashboard\/([a-z]+)/) || [])[1];
    const tab = fromUrl && document.querySelector(`#dash-tabs .ch-tab[data-dtab="${fromUrl}"]`) ? fromUrl : 'home';
    switchDashTab(tab, document.querySelector(`#dash-tabs .ch-tab[data-dtab="${tab}"]`));
}

/* ── Channel Info ──────────────────────────────────────────────── */
async function loadDashChannel() {
    // No-op: stream creation is handled by the Broadcast page
}

/* ── Stream Key ───────────────────────────────────────────────── */
async function loadDashStreamKey() {
    try {
        const data = await api('/auth/stream-key');
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
    } catch { /* silent */ }
}

function toggleKeyVisibility() {
    const el = document.getElementById('dash-stream-key');
    el.type = el.type === 'password' ? 'text' : 'password';
}

function copyStreamKey() {
    const key = document.getElementById('dash-stream-key').value;
    if (!key) return toast('No stream key', 'error');
    navigator.clipboard.writeText(key).then(() => toast('Stream key copied!', 'success'));
}

function getDashObsOverlayUrl() {
    if (!currentUser?.username) return '';
    return `${window.location.origin}/overlay/chat/${encodeURIComponent(currentUser.username)}`;
}

function updateDashObsOverlayUrl() {
    const input = document.getElementById('dash-obs-chat-overlay-url');
    if (!input) return;
    input.value = getDashObsOverlayUrl();
}

function copyDashObsOverlayUrl() {
    const url = getDashObsOverlayUrl();
    if (!url) return toast('Overlay URL unavailable', 'error');
    navigator.clipboard.writeText(url).then(() => toast('Overlay URL copied!', 'success'));
}

function openDashObsOverlay() {
    const url = getDashObsOverlayUrl();
    if (!url) return toast('Overlay URL unavailable', 'error');
    window.open(url, '_blank', 'noopener');
}

/**
 * The dashboard's own key rotation.
 *
 * This was called `regenerateStreamKey`, the same name broadcast.js uses. broadcast.js loads ten
 * scripts later, so its version won and the dashboard button silently ran it: that version writes
 * the new key into the broadcast page's fields, which do not exist on the dashboard, and never
 * touches #dash-stream-key. With a managed stream active it also rotated a *different* key than
 * the one on screen. The user clicked regenerate and saw the old key.
 */
async function regenerateDashStreamKey() {
    if (!confirm('Are you sure? Your old key will stop working.')) return;
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        const key = data.streamKey || data.stream_key || '';
        document.getElementById('dash-stream-key').value = key;
        toast('Stream key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── Go Live / End Stream ─────────────────────────────────────── */
// Stream creation is handled by the Broadcast page (/broadcast).
// goLive() has been removed — use broadcast.js instead.

async function loadDashActiveStreams() {
    const listEl = document.getElementById('dash-active-streams');
    if (!listEl) return;
    try {
        const data = await api('/streams/mine');
        const all = data.streams || [];
        activeStreams = all.filter(s => s.is_live);

        if (!activeStreams.length) {
            listEl.innerHTML = '<p class="muted">No active streams</p>';
            activeStreamData = null;
            document.getElementById('dash-endpoint-info').style.display = 'none';
            return;
        }

        listEl.innerHTML = activeStreams.map(s => {
            const proto = (s.protocol || 'webrtc').toUpperCase();
            const icon = s.protocol === 'jsmpeg' ? 'fa-terminal' : s.protocol === 'rtmp' ? 'fa-server' : 'fa-globe';
            const raw = s.started_at || '';
            const ts = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
            const started = new Date(ts);
            const elapsed = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
                <i class="fa-solid ${icon}" style="color:var(--accent)"></i>
                <div style="flex:1;min-width:0">
                    <strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title || 'Untitled')}</strong>
                    <span class="muted" style="font-size:0.8rem">${proto} · ${formatDuration(elapsed)} live</span>
                </div>
                <button class="btn btn-small" onclick="showEndpointInfoById(${s.id})"><i class="fa-solid fa-info-circle"></i></button>
                <button class="btn btn-small btn-danger" onclick="endStreamById(${s.id})"><i class="fa-solid fa-stop"></i> End</button>
            </div>`;
        }).join('');

        // Set first active stream if not already set
        if (!activeStreamData) activeStreamData = activeStreams[0];
    } catch { listEl.innerHTML = '<p class="muted">Failed to load streams</p>'; }
}

async function endStreamById(streamId) {
    try {
        await api(`/streams/${streamId}`, { method: 'DELETE' });
        toast('Stream ended', 'info');
        if (activeStreamData && activeStreamData.id === streamId) activeStreamData = null;
        activeStreams = activeStreams.filter(s => s.id !== streamId);
        loadDashActiveStreams();
        loadDashControls();
    } catch (e) { toast(e.message, 'error'); }
}

async function endStream() {
    if (!activeStreamData) return;
    await endStreamById(activeStreamData.id);
}

function showEndpointInfoById(streamId) {
    const s = activeStreams.find(x => x.id === streamId);
    if (s) showEndpointInfo(s);
}

function showEndpointInfo(stream) {
    const el = document.getElementById('dash-endpoint-info');
    el.style.display = '';

    const host = window.location.hostname;
    const proto = stream.protocol || 'jsmpeg';

    let info = '';
    if (proto === 'jsmpeg') {
            const vp = stream.endpoint?.videoPort || stream.endpoint?.video_port || 9710;
        info = `Protocol: JSMPEG\n\nFFmpeg command:\nffmpeg -i <source> \\\n  -f mpegts \\\n  -codec:v mpeg1video -b:v 800k -r 24 \\\n  -codec:a mp2 -ar 44100 -ac 1 -b:a 64k \\\n  http://${host}:${vp}/stream_key`;
    } else if (proto === 'webrtc') {
        info = `Protocol: WebRTC\n\nUse the browser "Start Broadcasting" feature.\nYour webcam/screen will be shared via Mediasoup SFU.`;
    } else if (proto === 'rtmp') {
        info = `Protocol: RTMP\n\nServer: rtmp://${host}:1935/live\nStream Key: ${stream.stream_key || '(use your stream key)'}\n\nIn OBS: Settings → Stream → Custom → paste above.`;
    }

    el.textContent = info;
}

/* ── Goals ─────────────────────────────────────────────────────── */
async function loadDashGoals() {
    if (!currentUser) return;
    const list = document.getElementById('dash-goals-list');
    if (!list) return;
    try {
        const data = await api('/funds/goals/manage/mine');
        const goals = data.goals || [];
        window._dashGoals = goals;
        if (!goals.length) {
            list.innerHTML = '<p class="muted">No goals yet — add one for viewers to donate toward.</p>';
            return;
        }
        list.innerHTML = goals.map(dashGoalCardHTML).join('');
    } catch { list.innerHTML = '<p class="muted">Failed to load goals</p>'; }
}

function dashGoalCardHTML(g) {
    const pct = g.target_amount ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
    const reached = !g.is_active && g.reached_at;
    const media = g.image_url
        ? (g.media_type === 'video'
            ? `<video class="dash-goal-thumb" src="${esc(g.image_url)}" muted loop autoplay playsinline></video>`
            : `<img class="dash-goal-thumb" src="${esc(g.image_url)}" alt="">`)
        : '<div class="dash-goal-thumb dash-goal-thumb-ph"><i class="fa-solid fa-bullseye"></i></div>';
    return `
        <div class="dash-goal ${reached ? 'reached' : ''}">
            ${media}
            <div class="dash-goal-body">
                <div class="dash-goal-top">
                    <strong>${esc(g.title)}</strong>
                    <span class="muted">${pct}%${reached ? ' · ✓ reached' : (g.is_active ? '' : ' · closed')}</span>
                </div>
                <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
                <div class="muted" style="font-size:0.8rem;margin-top:2px">${Number(g.current_amount).toLocaleString()} / ${Number(g.target_amount).toLocaleString()} Vibes</div>
                <div class="dash-goal-actions">
                    <button class="btn btn-xs btn-outline" onclick="editGoalModal(${g.id})"><i class="fa-solid fa-pen"></i> Edit</button>
                    ${g.is_active ? '' : `<button class="btn btn-xs btn-outline" onclick="reactivateGoal(${g.id})"><i class="fa-solid fa-rotate-left"></i> Reopen</button>`}
                    <button class="btn btn-xs btn-danger" onclick="deleteGoal(${g.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        </div>`;
}

async function deleteGoal(id) {
    if (!confirm('Delete this donation goal?')) return;
    try { await api(`/funds/goals/${id}`, { method: 'DELETE' }); loadDashGoals(); }
    catch (e) { toast(e.message, 'error'); }
}
async function reactivateGoal(id) {
    try { await api(`/funds/goals/${id}`, { method: 'PUT', body: { is_active: true } }); loadDashGoals(); }
    catch (e) { toast(e.message, 'error'); }
}

/* ── VODs ──────────────────────────────────────────────────────── */
const DASH_PAGE_SIZE = 12;
let dashVodPage = 0, dashVodTotal = 0;
let dashMyClipsPage = 0, dashMyClipsTotal = 0;
let dashStreamClipsPage = 0, dashStreamClipsTotal = 0;

function dashPaginationHtml(prefix, page, total) {
    const totalPages = Math.ceil(total / DASH_PAGE_SIZE);
    if (totalPages <= 1) return '';
    return `<div class="dash-pagination" style="margin-top:12px;display:flex;gap:8px;align-items:center;justify-content:center">
        <button class="btn btn-small btn-outline" ${page <= 0 ? 'disabled' : ''} onclick="${prefix}GoPage(${page - 1})"><i class="fa-solid fa-chevron-left"></i> Prev</button>
        <span class="muted" style="font-size:0.85rem">Page ${page + 1} of ${totalPages}</span>
        <button class="btn btn-small btn-outline" ${page >= totalPages - 1 ? 'disabled' : ''} onclick="${prefix}GoPage(${page + 1})">Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
}

// ── Bulk selection wiring for the dashboard (uses the shared _sel system in app.js) ──
function _dashWrap(type, id, html) { return (typeof _selWrap === 'function') ? _selWrap(type, id, html) : html; }
function _dashReloadMedia() {
    loadDashVods();
    if (typeof loadDashMyClips === 'function') loadDashMyClips();
    if (typeof loadDashStreamClips === 'function') loadDashStreamClips();
    if (document.getElementById('dash-ai-clips')?.childElementCount) loadDashAiClips();
}
function _dashSelInit() { if (typeof _selSetContext === 'function') _selSetContext(true, _dashReloadMedia); }
function _dashSelSync() { if (typeof _selSyncAllBtns === 'function') _selSyncAllBtns(); }

async function loadDashVods() {
    const list = document.getElementById('dash-vods-list');
    _dashSelInit();
    try {
        const data = await api(`/vods/mine?limit=${DASH_PAGE_SIZE}&offset=${dashVodPage * DASH_PAGE_SIZE}`);
        const vods = data.vods || [];
        dashVodTotal = data.total ?? vods.length;
        if (!vods.length && dashVodPage === 0) {
            list.innerHTML = '<p class="muted">No recordings yet. Videos are created automatically when you stream.</p>';
            return;
        }
        list.innerHTML = vods.map(v => _dashWrap('vod', v.id, `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(v.thumbnail_url, 'fa-video', v.title) : '<i class="fa-solid fa-video"></i>'}
                    ${_dashVisBadge(v.visibility, v.is_public)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(v.title || 'Untitled Video')}</div>
                    <div style="display:flex;gap:6px;margin-top:6px">
                        ${!v.is_public
                            ? `<button class="btn btn-small btn-success" onclick="publishVod('${v.id}')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="unpublishVod('${v.id}')"><i class="fa-solid fa-eye-slash"></i> Private</button>`}
                        <button class="btn btn-small" onclick="navigate('/vod/${v.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="deleteVod('${v.id}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `)).join('') + dashPaginationHtml('dashVod', dashVodPage, dashVodTotal);
        _dashSelSync();
    } catch { list.innerHTML = '<p class="muted">Failed to load videos</p>'; }
}

// 3-state visibility badge for dashboard media cards.
function _dashVisBadge(visibility, isPublic) {
    const vis = visibility || (isPublic ? 'public' : 'private');
    const map = { public: ['PUBLIC', 'var(--accent)'], unlisted: ['UNLISTED', 'var(--text-muted)'], private: ['PRIVATE', 'var(--text-muted)'] };
    const [label, bg] = map[vis] || map.public;
    return `<span class="stream-card-nsfw" style="background:${bg}">${label}</span>`;
}

function dashVodGoPage(page) { dashVodPage = page; loadDashVods(); }

async function publishVod(vodId) {
    try {
        await api(`/vods/${vodId}/publish`, { method: 'POST' });
        toast('Video published', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function unpublishVod(vodId) {
    try {
        await api(`/vods/${vodId}`, { method: 'PUT', body: { is_public: false } });
        toast('Video set to private', 'info');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteVod(vodId) {
    if (!confirm('Delete this video forever?')) return;
    try {
        await api(`/vods/${vodId}`, { method: 'DELETE' });
        toast('Video deleted', 'success');
        loadDashVods();
    } catch (e) { toast(e.message, 'error'); }
}

async function dashBulkActionByAge() {
    const ageInput = document.getElementById('dash-bulk-delete-age-days');
    const vodsToggle = document.getElementById('dash-bulk-delete-vods');
    const clipsToggle = document.getElementById('dash-bulk-delete-clips');
    const action = document.getElementById('dash-bulk-action')?.value || 'delete';
    const olderThanDays = parseInt(ageInput?.value, 10);
    const deleteVods = !!vodsToggle?.checked;
    const deleteClips = !!clipsToggle?.checked;

    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
        return toast('Enter a valid age in days (minimum 1)', 'error');
    }
    if (!deleteVods && !deleteClips) {
        return toast('Select VODs and/or Clips', 'error');
    }

    const targets = [deleteVods ? 'VODs' : null, deleteClips ? 'clips' : null].filter(Boolean).join(' and ');
    const verb = action === 'delete' ? 'Delete' : (action === 'public' ? 'Make public' : (action === 'unlisted' ? 'Unlist' : 'Make private'));
    const warn = action === 'delete' ? ' This cannot be undone.' : '';
    if (!confirm(`${verb} ${targets} older than ${olderThanDays} day(s)?${warn}`)) return;

    try {
        const result = await api('/vods/bulk-delete-old', {
            method: 'POST',
            body: { olderThanDays, deleteVods, deleteClips, action },
        });

        if (action === 'delete') {
            const deletedVods = result?.deleted?.vods || 0;
            const deletedClips = result?.deleted?.clips || 0;
            const fileErrors = result?.fileDeleteErrors || 0;
            toast(`Deleted ${deletedVods} VOD(s) and ${deletedClips} clip(s) older than ${olderThanDays} day(s)`, 'success');
            if (fileErrors > 0) toast(`Deleted records, but ${fileErrors} file(s) could not be removed`, 'warning');
        } else {
            const uv = result?.updated?.vods || 0;
            const uc = result?.updated?.clips || 0;
            toast(`${verb}: ${uv} VOD(s), ${uc} clip(s)`, 'success');
        }

        if (deleteVods) loadDashVods();
        if (deleteClips) {
            loadDashMyClips();
            loadDashStreamClips();
        }
    } catch (e) {
        toast(e.message || 'Bulk action failed', 'error');
    }
}
// Back-compat alias.
const dashBulkDeleteByAge = dashBulkActionByAge;

/* ── My Clips (clips I created) ───────────────────────────────── */
async function loadDashMyClips() {
    const list = document.getElementById('dash-my-clips');
    if (!list) return;
    _dashSelInit();
    try {
        const data = await api(`/clips/mine?limit=${DASH_PAGE_SIZE}&offset=${dashMyClipsPage * DASH_PAGE_SIZE}`);
        const clips = data.clips || [];
        dashMyClipsTotal = data.total ?? clips.length;
        if (!clips.length && dashMyClipsPage === 0) {
            list.innerHTML = '<p class="muted">You haven\'t clipped anything yet. Use the clip button while watching a stream!</p>';
            _dashSelSync();
            return;
        }
        list.innerHTML = clips.map(cl => _dashWrap('clip', cl.id, `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${_dashVisBadge(cl.visibility, cl.is_public)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">${new Date(cl.created_at).toLocaleDateString()}</div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true, 'mine')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false, 'mine')"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        ${cl.can_delete ? `<button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'mine')"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                </div>
            </div>
        `)).join('') + dashPaginationHtml('dashMyClips', dashMyClipsPage, dashMyClipsTotal);
        _dashSelSync();
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

function dashMyClipsGoPage(page) { dashMyClipsPage = page; loadDashMyClips(); }

/* ── Clips of My Stream ───────────────────────────────────────── */
async function loadDashStreamClips() {
    const list = document.getElementById('dash-stream-clips');
    if (!list) return;
    _dashSelInit();
    try {
        // People's clips only; the AI's are under AI Moments (loadDashAiClips).
        const data = await api(`/clips/my-stream?auto_generated=0&limit=${DASH_PAGE_SIZE}&offset=${dashStreamClipsPage * DASH_PAGE_SIZE}`);
        const clips = data.clips || [];
        dashStreamClipsTotal = data.total ?? clips.length;
        if (!clips.length && dashStreamClipsPage === 0) {
            list.innerHTML = '<p class="muted">No one has clipped your streams yet.</p>';
            _dashSelSync();
            return;
        }
        list.innerHTML = clips.map(cl => _dashWrap('clip', cl.id, `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${_dashVisBadge(cl.visibility, cl.is_public)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Untitled Clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px">
                        <i class="fa-solid fa-scissors"></i> ${esc(cl.display_name || cl.username || 'Unknown')} &bull; ${new Date(cl.created_at).toLocaleDateString()}
                    </div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${cl.id}, true)"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${cl.id}, false)"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${cl.id}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${cl.id}, 'stream')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `)).join('') + dashPaginationHtml('dashStreamClips', dashStreamClipsPage, dashStreamClipsTotal);
        _dashSelSync();
    } catch { list.innerHTML = '<p class="muted">Failed to load clips</p>'; }
}

function dashStreamClipsGoPage(page) { dashStreamClipsPage = page; loadDashStreamClips(); }

/* ── AI Moments of My Stream (auto-clips) ─────────────────────────
   What the AI cut from my streams. Never in "My Clips" (the streamer did not make them) and never
   credited to a clipper; the count rides on the sub-tab. Built with DOM nodes: titles come from the AI. */
let dashAiClipsPage = 0;
let dashAiClipsTotal = 0;
function _setDashAiMomentsCount(n) {
    const el = document.getElementById('dash-ai-moments-count');
    if (!el) return;
    const num = Number(n) || 0;
    el.textContent = num ? String(num) : '';
    el.hidden = !num;
}
async function loadDashAiMomentsCount() {
    try { const d = await api('/clips/my-stream?auto_generated=1&limit=1'); _setDashAiMomentsCount(d.total); } catch { /* the count is a hint */ }
}
async function loadDashAiClips() {
    const list = document.getElementById('dash-ai-clips');
    if (!list) return;
    _dashSelInit();
    try {
        const data = await api(`/clips/my-stream?auto_generated=1&limit=${DASH_PAGE_SIZE}&offset=${dashAiClipsPage * DASH_PAGE_SIZE}`);
        const clips = data.clips || [];
        dashAiClipsTotal = data.total ?? clips.length;
        _setDashAiMomentsCount(dashAiClipsTotal);
        list.textContent = '';
        if (!clips.length && dashAiClipsPage === 0) {
            const p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'The AI has not cut any clips from your streams.';
            list.append(p);
            _dashSelSync();
            return;
        }
        list.innerHTML = clips.map(cl => _dashWrap('clip', cl.id, `
            <div class="stream-card" style="display:inline-block;width:240px;margin-right:12px;vertical-align:top">
                <div class="stream-card-thumb" style="height:135px">
                    ${typeof thumbImg === 'function' ? thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title) : '<i class="fa-solid fa-scissors"></i>'}
                    ${_dashVisBadge(cl.visibility, cl.is_public)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'AI clip')}</div>
                    <div class="muted" style="font-size:0.8rem;margin-bottom:4px"><span class="dash-ai-badge">AI clip</span> ${new Date(cl.created_at).toLocaleDateString()}</div>
                    <div style="display:flex;gap:6px">
                        ${!cl.is_public
                            ? `<button class="btn btn-small btn-success" onclick="dashToggleClipVisibility(${Number(cl.id)}, true, 'ai')"><i class="fa-solid fa-eye"></i> Publish</button>`
                            : `<button class="btn btn-small btn-outline" onclick="dashToggleClipVisibility(${Number(cl.id)}, false, 'ai')"><i class="fa-solid fa-eye-slash"></i> Unlist</button>`}
                        <button class="btn btn-small" onclick="navigate('/clip/${Number(cl.id)}')"><i class="fa-solid fa-play"></i></button>
                        <button class="btn btn-small btn-danger" onclick="dashDeleteClip(${Number(cl.id)}, 'ai')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `)).join('') + dashPaginationHtml('dashAiClips', dashAiClipsPage, dashAiClipsTotal);
        _dashSelSync();
    } catch { list.innerHTML = '<p class="muted">Failed to load AI Moments</p>'; }
}
function dashAiClipsGoPage(page) { dashAiClipsPage = page; loadDashAiClips(); }

/* ── AI Moments from my streams: the channel's AI derivation switch ──────────
   channels.ai_derivation_enabled (on by default). Off: the auto-clip, AI moments and caught-live
   jobs skip this channel and its after-show report is the stats-only one. */
async function loadAiDerivationSetting() {
    const box = document.getElementById('dash-ai-derivation');
    if (!box) return;
    try {
        const data = await api('/streams/channel');
        const ch = (data && data.channel) || data || {};
        box.checked = ch.ai_derivation_enabled == null || Number(ch.ai_derivation_enabled) !== 0;
    } catch { /* keep the default */ }
}
async function saveAiDerivationSetting(box) {
    const status = document.getElementById('dash-ai-derivation-status');
    const on = !!box.checked;
    try {
        await api('/streams/channel', { method: 'PUT', body: { ai_derivation_enabled: on ? 1 : 0 } });
        if (status) status.textContent = on ? 'On: the AI may make Moments from your streams.' : 'Off: the AI makes no new Moments from your streams.';
        toast(on ? 'AI Moments turned on for your channel' : 'AI Moments turned off for your channel', 'success');
    } catch (e) {
        box.checked = !on;
        toast(e.message || 'Save failed', 'error');
    }
}

/* ── Bot robot on the channel page (roadmap T15 R9) ──────────────────────────
   The card shows only when the channel JSON carries bot_embed (LIVE_BOT_EMBED on). Saving PUTs
   /api/streams/channel/<me>/bot; an empty id unbinds. */
async function loadBotEmbedSetting() {
    const card = document.getElementById('dash-card-bot-embed');
    if (!card || !currentUser) return;
    try {
        const data = await api(`/streams/channel/${encodeURIComponent(currentUser.username)}?pollOnly=1`);
        const be = data && data.bot_embed;
        if (!be || !be.enabled) { card.style.display = 'none'; return; }
        document.getElementById('dash-bot-robot-id').value = be.robot_id || '';
        card.style.display = '';
    } catch { card.style.display = 'none'; }
}
async function saveBotEmbedSetting() {
    const input = document.getElementById('dash-bot-robot-id');
    const status = document.getElementById('dash-bot-robot-status');
    if (!input || !currentUser) return;
    const id = input.value.trim();
    try {
        const data = await api(`/streams/channel/${encodeURIComponent(currentUser.username)}/bot`, { method: 'PUT', body: { robot_id: id || null } });
        const bound = data && data.bot_embed && data.bot_embed.robot_id;
        if (status) status.textContent = bound ? `Bound to ${bound}` : 'No robot bound';
    } catch (e) {
        if (status) status.textContent = e.message || 'Save failed';
    }
}

async function loadClipSettings() {
    const el = document.getElementById('dash-clips-allow-creator-delete');
    if (!el) return;
    try {
        const data = await api('/clips/settings/channel');
        el.checked = !!data.clips_allow_creator_delete;
    } catch { /* silent */ }
}

async function saveClipSettings() {
    const el = document.getElementById('dash-clips-allow-creator-delete');
    if (!el) return;
    try {
        await api('/clips/settings/channel', { method: 'PUT', body: { clips_allow_creator_delete: el.checked ? 1 : 0 } });
        toast('Clip settings saved', 'success');
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
}

async function loadDashPastes() {
    const list = document.getElementById('dash-pastes-list');
    if (!list || !currentUser?.username) return;
    try {
        const data = await api(`/pastes/by-user/${encodeURIComponent(currentUser.username)}?limit=30`);
        const pastes = data.pastes || [];
        if (!pastes.length) { list.innerHTML = '<p class="muted">You haven\'t shared any pastes yet.</p>'; return; }
        list.innerHTML = (typeof renderPasteCard === 'function')
            ? pastes.map(p => renderPasteCard(p)).join('')
            : '<p class="muted">Paste renderer unavailable</p>';
    } catch { list.innerHTML = '<p class="muted">Failed to load pastes</p>'; }
}

async function dashToggleClipVisibility(clipId, makePublic, source) {
    try {
        await api(`/clips/${clipId}/visibility`, {
            method: 'PUT',
            body: { is_public: makePublic }
        });
        toast(makePublic ? 'Clip published' : 'Clip unlisted', 'success');
        if (source === 'mine') loadDashMyClips();
        else if (source === 'ai') loadDashAiClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Failed to update visibility', 'error'); }
}

async function dashDeleteClip(clipId, source) {
    if (!confirm('Delete this clip permanently?')) return;
    try {
        await api(`/clips/${clipId}`, { method: 'DELETE' });
        toast('Clip deleted', 'success');
        if (source === 'mine') loadDashMyClips();
        else if (source === 'ai') loadDashAiClips();
        else loadDashStreamClips();
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
}

/* ── Vibes ───────────────────────────────────────────────── */
async function loadDashFunds() {
    if (!currentUser) return;
    try {
        const data = await api('/funds/balance');
        const bal = Math.round(parseFloat(data.balance || 0));
        const cash = Math.round(parseFloat(data.cashout_balance || 0));
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        // Integer Vibes; USD shown is the cashout value (100 bucks = $1).
        set('dash-funds-amount', bal.toLocaleString());
        set('dash-funds-usd', `(${bal.toLocaleString()} Vibes)`);
        set('dash-cashout-amount', cash.toLocaleString());
        set('dash-cashout-usd', `($${(cash / 100).toFixed(2)})`);
    } catch { /* silent */ }
}

// Spendable Vibes history — opened from the badge on the profile card.
function _bucksTxRow(t) {
    const me = currentUser?.id;
    const dt = new Date(t.created_at + (String(t.created_at).includes('Z') ? '' : 'Z'));
    const when = isNaN(dt) ? (t.created_at || '') : dt.toLocaleString();
    const amt = Math.round(parseFloat(t.amount || 0));
    let icon = 'fa-coins', label = t.type || 'transaction', sign = '', cls = '';
    if (t.type === 'purchase') { icon = 'fa-cart-shopping'; label = 'Purchased Vibes'; sign = '+'; cls = 'pos'; }
    else if (t.type === 'donation' && t.from_user_id === me) { icon = 'fa-hand-holding-heart'; label = `Tipped ${esc(t.to_display || t.to_username || 'a streamer')}`; sign = '−'; cls = 'neg'; }
    else if (t.type === 'donation') { icon = 'fa-gift'; label = `Received from ${esc(t.from_display || t.from_username || 'someone')}`; sign = '+'; cls = 'pos'; }
    else if (t.type === 'cashout') { icon = 'fa-money-bill-transfer'; label = 'Cashout requested'; sign = '−'; cls = 'neg'; }
    else if (t.type === 'refund') { icon = 'fa-rotate-left'; label = 'Cashout refunded'; sign = '+'; cls = 'pos'; }
    else if (t.type === 'recycle') { icon = 'fa-recycle'; label = 'Moved cashout → spendable'; sign = ''; cls = ''; }
    const note = t.message ? `<div class="bucks-log-note">${esc(t.message)}</div>` : '';
    return `<div class="bucks-log-row">
        <div class="bucks-log-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="bucks-log-main"><div class="bucks-log-label">${label}</div><div class="bucks-log-when">${esc(when)}</div>${note}</div>
        <div class="bucks-log-amt ${cls}">${sign}${amt.toLocaleString()} Vibes</div>
    </div>`;
}

async function showBucksLogs() {
    let rows = '<p class="muted">Loading…</p>';
    const overlay = document.createElement('div');
    overlay.className = 'bucks-log-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div class="bucks-log-modal">
        <div class="bucks-log-head"><h3><i class="fa-solid fa-coins"></i> Vibes history</h3>
        <button class="bucks-log-close" onclick="this.closest('.bucks-log-overlay').remove()"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="bucks-log-body" id="bucks-log-body">${rows}</div></div>`;
    document.body.appendChild(overlay);
    try {
        const data = await api('/funds/history?limit=100');
        const txs = data.transactions || [];
        const body = document.getElementById('bucks-log-body');
        if (body) body.innerHTML = txs.length ? txs.map(_bucksTxRow).join('') : '<p class="muted">No Vibes activity yet.</p>';
    } catch {
        const body = document.getElementById('bucks-log-body');
        if (body) body.innerHTML = '<p class="muted">Failed to load history.</p>';
    }
}

// Move cashout balance → spendable Vibes (recycle / give back).
async function dashRecycleBucks() {
    const raw = prompt('How many Vibes to move from your cashout balance into your spendable balance?');
    if (raw === null) return;
    const amount = Math.round(parseFloat(raw));
    if (!(amount > 0)) return toast('Enter a positive amount', 'error');
    try {
        await api('/funds/recycle', { method: 'POST', body: { amount } });
        toast(`Moved ${amount.toLocaleString()} Vibes to your spendable balance`, 'success');
        loadDashFunds();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
}

/* ── OpenCoins ─────────────────────────────────────────────── */
async function loadDashCoins() {
    if (!currentUser) return;
    try {
        const data = await api('/coins/balance');
        document.getElementById('dash-coins-amount').textContent = data.balance == null ? '—' : Number(data.balance).toLocaleString();
    } catch { /* silent */ }
}

/* ── API Tokens (Bot / Integration) ─────────────────────────── */
const DASH_TOKEN_DEFAULT_LIMIT = 10;
const DASH_TOKEN_SCOPE_FALLBACKS = Object.freeze([
    {
        id: 'chat',
        label: 'chat',
        title: 'Chat bot access',
        description: 'Send and receive authenticated chat messages via WebSocket and related chat APIs.',
    },
    {
        id: 'read',
        label: 'read',
        title: 'Read access',
        description: 'Read streams, VODs, user info, and other non-mutating integration surfaces.',
    },
    {
        id: 'stream',
        label: 'stream',
        title: 'Stream control',
        description: 'Start or stop streams and update stream state or metadata.',
    },
    {
        id: 'vibe_coding_publish',
        label: 'vibe_coding_publish',
        title: 'Vibe coding publisher',
        description: 'Publish sanitized coding-feed events to /ws/vibe-coding/publish for a managed stream slot.',
    },
]);
const DASH_TOKEN_PRESET_FALLBACKS = Object.freeze([
    {
        id: 'chat-bot',
        label: 'Chat Bot',
        description: 'Recommended for bots that read chat and post messages back into chat.',
        suggested_label: 'Chat Bot',
        scopes: ['chat', 'read'],
    },
    {
        id: 'vibe-coding-publisher',
        label: 'GitHub Copilot Companion',
        description: 'Recommended for the OpenVibe.Live VS Code companion and other coding-feed publishers.',
        suggested_label: 'Copilot Companion',
        scopes: ['read', 'vibe_coding_publish'],
    },
    {
        id: 'stream-controller',
        label: 'Stream Controller',
        description: 'Recommended for integrations that control live state and stream metadata.',
        suggested_label: 'Stream Controller',
        scopes: ['read', 'stream'],
    },
]);

let dashTokenScopeDefinitions = DASH_TOKEN_SCOPE_FALLBACKS.map((definition) => ({ ...definition }));
let dashTokenPresets = DASH_TOKEN_PRESET_FALLBACKS.map((preset) => ({ ...preset, scopes: [...preset.scopes] }));

function normalizeDashTokenScopeDefinitions(definitions) {
    const source = Array.isArray(definitions) && definitions.length ? definitions : DASH_TOKEN_SCOPE_FALLBACKS;
    const normalized = source.map((definition) => {
        const id = String(definition?.id || definition?.label || '').trim();
        if (!id) return null;
        return {
            id,
            label: String(definition?.label || id).trim() || id,
            title: String(definition?.title || definition?.label || id).trim() || id,
            description: String(definition?.description || '').trim(),
        };
    }).filter(Boolean);

    return normalized.length
        ? normalized
        : DASH_TOKEN_SCOPE_FALLBACKS.map((definition) => ({ ...definition }));
}

function normalizeDashTokenPresets(presets) {
    const validScopeIds = new Set((dashTokenScopeDefinitions || []).map((definition) => definition.id));
    const source = Array.isArray(presets) && presets.length ? presets : DASH_TOKEN_PRESET_FALLBACKS;
    const normalized = source.map((preset) => {
        const id = String(preset?.id || '').trim();
        if (!id) return null;
        const scopes = Array.isArray(preset?.scopes)
            ? [...new Set(preset.scopes.map((scope) => String(scope || '').trim()).filter((scope) => validScopeIds.has(scope)))]
            : [];
        if (!scopes.length) return null;
        return {
            id,
            label: String(preset?.label || id).trim() || id,
            description: String(preset?.description || '').trim(),
            suggested_label: String(preset?.suggested_label || '').trim(),
            scopes,
        };
    }).filter(Boolean);

    return normalized.length
        ? normalized
        : DASH_TOKEN_PRESET_FALLBACKS.map((preset) => ({ ...preset, scopes: [...preset.scopes] }));
}

function renderDashTokenScopeOptions(selectedScopes) {
    const selected = new Set(Array.isArray(selectedScopes) && selectedScopes.length ? selectedScopes : ['chat', 'read']);
    return (dashTokenScopeDefinitions || []).map((definition) => `
        <label style="font-size:0.85rem;display:flex;align-items:flex-start;gap:8px">
            <input type="checkbox" data-token-scope="${definition.id}" ${selected.has(definition.id) ? 'checked' : ''}>
            <span>
                <strong>${esc(definition.label || definition.id)}</strong>
                ${definition.description ? ` — ${esc(definition.description)}` : ''}
            </span>
        </label>`).join('');
}

function renderDashTokenPresetButtons() {
    if (!Array.isArray(dashTokenPresets) || !dashTokenPresets.length) {
        return '';
    }
    return `
        <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${dashTokenPresets.map((preset) => `
                <button type="button" class="btn btn-small btn-outline" onclick="applyDashTokenPreset('${preset.id}')">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(preset.label)}
                </button>`).join('')}
        </div>
        <p class="muted" id="token-preset-hint" style="font-size:0.78rem;margin-top:8px">Use a preset to preselect the scopes needed for a common integration.</p>`;
}

function applyDashTokenPreset(presetId) {
    const preset = (dashTokenPresets || []).find((entry) => entry.id === presetId);
    if (!preset) return;

    const labelInput = document.getElementById('token-label');
    if (labelInput && (!labelInput.value || labelInput.value === 'Bot Token')) {
        labelInput.value = preset.suggested_label || preset.label || 'Bot Token';
    }

    document.querySelectorAll('[data-token-scope]').forEach((input) => {
        const scopeId = input?.dataset?.tokenScope;
        input.checked = !!scopeId && preset.scopes.includes(scopeId);
    });

    const hint = document.getElementById('token-preset-hint');
    if (hint) {
        hint.textContent = preset.description || 'Preset applied.';
    }
}

async function loadDashTokens() {
    const list = document.getElementById('dash-token-list');
    const summary = document.getElementById('dash-token-summary');
    const createButton = document.getElementById('dash-token-create-btn');
    if (!list) return;
    list.innerHTML = '<p class="muted" style="font-size:0.82rem">Loading tokens...</p>';
    try {
        const data = await api('/auth/tokens');
        dashTokenScopeDefinitions = normalizeDashTokenScopeDefinitions(data.scope_definitions);
        dashTokenPresets = normalizeDashTokenPresets(data.token_presets);
        const tokens = Array.isArray(data.tokens) ? data.tokens : [];
        const maxActiveTokens = Number.isInteger(data.max_active_tokens)
            ? data.max_active_tokens
            : DASH_TOKEN_DEFAULT_LIMIT;
        const activeTokenCount = Number.isInteger(data.active_token_count)
            ? data.active_token_count
            : tokens.filter(token => token.is_active).length;

        if (summary) summary.textContent = `${activeTokenCount} / ${maxActiveTokens} active tokens`;
        if (createButton) {
            const atLimit = activeTokenCount >= maxActiveTokens;
            createButton.disabled = atLimit;
            createButton.title = atLimit
                ? `Maximum ${maxActiveTokens} active tokens reached`
                : 'Create a new API token';
        }

        if (!tokens.length) {
            list.innerHTML = '<p class="muted" style="font-size:0.82rem">No API tokens yet. Create one to connect bots or integrations.</p>';
            return;
        }
        list.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">${tokens.map(t => {
            const scopes = (t.scopes || []).join(', ') || 'None';
            const created = t.created_at ? new Date(t.created_at).toLocaleDateString() : 'Unknown';
            const lastUsed = t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'Never';
            const expires = t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'Never';
            const statusClass = t.is_active ? 'color:var(--success)' : 'color:var(--danger)';
            const statusLabel = t.is_active ? 'Active' : 'Revoked';
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border)">
                <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:0.85rem">${esc(t.label)}</div>
                    <div style="font-size:0.75rem;color:var(--text-muted)">Scopes: ${esc(scopes)} · Created: ${created} · Last used: ${lastUsed} · Expires: ${expires} · <span style="${statusClass}">${statusLabel}</span></div>
                </div>
                ${t.is_active ? `<button class="btn btn-small btn-danger" onclick="revokeDashToken(${t.id})" title="Revoke"><i class="fa-solid fa-ban"></i></button>` : ''}
            </div>`;
        }).join('')}</div>`;
    } catch (e) {
        if (summary) summary.textContent = 'Failed to load tokens';
        if (createButton) {
            createButton.disabled = false;
            createButton.title = 'Create a new API token';
        }
        list.innerHTML = `<p class="muted" style="font-size:0.82rem">Failed to load tokens</p>`;
    }
}

function showCreateTokenModal() {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    const createButton = document.getElementById('dash-token-create-btn');
    if (createButton?.disabled) {
        return toast(createButton.title || 'Token limit reached', 'error');
    }
    if (!overlay || !content) return;
    content.innerHTML = `
        <div class="modal-header"><h3><i class="fa-solid fa-key"></i> Create API Token</h3></div>
        <div class="modal-body">
            <div class="form-group">
                <label>Label</label>
                <input type="text" id="token-label" class="form-input" placeholder="My Chat Bot" maxlength="50">
            </div>
            <div class="form-group">
                <label>Quick Presets</label>
                ${renderDashTokenPresetButtons()}
            </div>
            <div class="form-group">
                <label>Scopes</label>
                <div style="display:flex;flex-direction:column;gap:6px">
                    ${renderDashTokenScopeOptions(['chat', 'read'])}
                </div>
                <p class="muted" style="font-size:0.78rem;margin-top:8px">Use <strong>vibe_coding_publish</strong> for coding-feed publishers such as the OpenVibe.Live VS Code companion.</p>
            </div>
            <div class="form-group">
                <label>Expires</label>
                <select id="token-expires" class="form-input">
                    <option value="">Never</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                </select>
            </div>
            <div id="token-result" style="display:none;margin-top:12px;padding:12px;background:var(--bg-secondary);border:2px solid var(--accent);border-radius:8px">
                <p style="font-weight:700;color:var(--accent);margin-bottom:6px"><i class="fa-solid fa-triangle-exclamation"></i> Copy this token now — it will not be shown again!</p>
                <div style="display:flex;gap:6px">
                    <input type="text" id="token-raw-value" class="form-input" readonly style="font-family:monospace;font-size:0.82rem">
                    <button class="btn btn-small btn-primary" onclick="navigator.clipboard.writeText(document.getElementById('token-raw-value').value);toast('Token copied!','success')"><i class="fa-solid fa-copy"></i></button>
                </div>
            </div>
        </div>
        <div class="modal-footer" id="token-create-footer">
            <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" id="token-create-btn" onclick="createDashToken()"><i class="fa-solid fa-plus"></i> Create Token</button>
        </div>
    `;
    overlay.classList.add('show');
}

async function createDashToken() {
    const label = document.getElementById('token-label')?.value?.trim() || 'Bot Token';
    const scopes = Array.from(document.querySelectorAll('[data-token-scope]'))
        .filter((input) => input.checked && input.dataset?.tokenScope)
        .map((input) => input.dataset.tokenScope);
    if (!scopes.length) { toast('Select at least one scope', 'error'); return; }

    const expDays = document.getElementById('token-expires')?.value;
    const expiresAt = expDays ? new Date(Date.now() + parseInt(expDays) * 86400000).toISOString() : null;

    const btn = document.getElementById('token-create-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';

    try {
        const data = await api('/auth/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, scopes, expiresAt })
        });
        document.getElementById('token-raw-value').value = data.token;
        document.getElementById('token-result').style.display = '';
        document.getElementById('token-create-footer').style.display = 'none';
        toast('Token created!', 'success');
        loadDashTokens();
    } catch (e) {
        toast(`Failed: ${e.message}`, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Token';
    }
}

async function revokeDashToken(id) {
    if (!confirm('Revoke this token? Any bots using it will immediately lose access.')) return;
    try {
        await api(`/auth/tokens/${id}`, { method: 'DELETE' });
        toast('Token revoked', 'success');
        loadDashTokens();
    } catch (e) {
        toast(`Failed: ${e.message}`, 'error');
    }
}

/* ── Chat Logs (Streamer Self-Service) ─────────────────────── */
let _chatLogPage = 1;

async function loadDashChatLogs(page) {
    _chatLogPage = page || 1;
    const results = document.getElementById('dash-chatlog-results');
    const pagination = document.getElementById('dash-chatlog-pagination');
    if (!results) return;

    const search = document.getElementById('dash-chatlog-search')?.value?.trim() || '';
    const username = document.getElementById('dash-chatlog-username')?.value?.trim() || '';
    const from = document.getElementById('dash-chatlog-from')?.value || '';
    const to = document.getElementById('dash-chatlog-to')?.value || '';

    // Find the user's most recent stream for scoping
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (username) params.set('username', username);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(to).toISOString());
    params.set('page', String(_chatLogPage));
    params.set('limit', '50');

    results.innerHTML = '<p class="muted">Loading...</p>';

    try {
        // Use the owner-accessible admin logs endpoint (stream owner auth checks server-side)
        // The endpoint accepts streamId filter — query without it first (endpoint checks ownership server-side)
        const data = await api(`/chat/admin/logs?${params.toString()}`);
        const rows = data.rows || [];
        if (!rows.length) {
            results.innerHTML = '<p class="muted">No messages found for the selected filters.</p>';
            if (pagination) pagination.innerHTML = '';
            return;
        }

        results.innerHTML = `<table style="width:100%;border-collapse:collapse">
            <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
                <th style="padding:4px 8px">Time</th>
                <th style="padding:4px 8px">User</th>
                <th style="padding:4px 8px">Message</th>
            </tr></thead>
            <tbody>${rows.map(m => {
                const time = new Date(m.timestamp).toLocaleString();
                const user = esc(m.username || m.anon_id || '?');
                const msg = esc(m.message || '');
                return `<tr style="border-bottom:1px solid var(--border-light)">
                    <td style="padding:3px 8px;white-space:nowrap;font-size:0.78rem;color:var(--text-muted)">${time}</td>
                    <td style="padding:3px 8px;font-weight:600;font-size:0.82rem">${user}</td>
                    <td style="padding:3px 8px;font-size:0.82rem;word-break:break-word">${msg}</td>
                </tr>`;
            }).join('')}</tbody></table>`;

        // Pagination
        if (pagination && data.totalPages > 1) {
            let pHtml = '';
            if (_chatLogPage > 1) pHtml += `<button class="btn btn-small btn-outline" onclick="loadDashChatLogs(${_chatLogPage - 1})"><i class="fa-solid fa-chevron-left"></i></button>`;
            pHtml += `<span class="muted" style="font-size:0.82rem">Page ${_chatLogPage} of ${data.totalPages}</span>`;
            if (_chatLogPage < data.totalPages) pHtml += `<button class="btn btn-small btn-outline" onclick="loadDashChatLogs(${_chatLogPage + 1})"><i class="fa-solid fa-chevron-right"></i></button>`;
            pagination.innerHTML = pHtml;
        } else if (pagination) {
            pagination.innerHTML = '';
        }
    } catch (e) {
        results.innerHTML = `<p class="muted" style="color:var(--danger)">Failed to load chat logs: ${esc(e.message)}</p>`;
    }
}

async function dashPurgeChatRange() {
    const from = document.getElementById('dash-chatlog-from')?.value;
    const to = document.getElementById('dash-chatlog-to')?.value;
    if (!from || !to) {
        toast('Set both From and To dates to purge a range', 'error');
        return;
    }

    const fromISO = new Date(from).toISOString();
    const toISO = new Date(to).toISOString();

    try {
        // Preview count first (endpoint auto-scopes to user's stream when streamId absent for owner)
        const preview = await api('/chat/admin/purge/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromISO, to: toISO })
        });
        const count = preview.count || 0;
        if (count === 0) { toast('No messages in that range', 'info'); return; }
        if (!confirm(`Delete ${count} message(s) from ${new Date(from).toLocaleString()} to ${new Date(to).toLocaleString()}?`)) return;

        const result = await api('/chat/admin/purge', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromISO, to: toISO })
        });
        toast(`Purged ${result.deleted || 0} messages`, 'success');
        loadDashChatLogs(_chatLogPage);
    } catch (e) {
        toast(`Purge failed: ${e.message}`, 'error');
    }
}
