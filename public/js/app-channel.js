/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Channel pages (/@user): player activation, tabs, about panels, weather, goals, media requests, analytics, offline screen, edit mode.

   Split out of app.js, which every page used to download and parse. This file loads with its
   route (public/features.json); it runs after app.js and relies on app.js globals.
   ═══════════════════════════════════════════════════════════════ */
let _streamSwitchToken = 0;
/** Cached native HS viewer count from WebSocket — updated by stream-player.js WS handler */
let _cachedHsViewerCount = 0;

function _updateMicOnlyOverlay(browserMode, streamingMethod) {
    const container = document.getElementById('video-container');
    if (!container) return;
    const existing = container.querySelector('.mic-only-overlay');
    if (existing) existing.remove();
    if (browserMode !== 'mic_only' || (streamingMethod && streamingMethod !== 'browser')) return;
    const overlay = document.createElement('div');
    overlay.className = 'mic-only-overlay';
    overlay.innerHTML = `
        <div class="mic-only-visual">
            <div class="mic-only-icon"><i class="fa-solid fa-microphone"></i></div>
            <div class="mic-only-bars">
                <span class="mic-bar"></span><span class="mic-bar"></span><span class="mic-bar"></span>
                <span class="mic-bar"></span><span class="mic-bar"></span>
            </div>
            <div class="mic-only-label">Audio Only Stream</div>
        </div>`;
    container.appendChild(overlay);
}
let _activeChannelIsOwnerRank = false;

/**
 * The category pill. A category the AI inferred from the stream (ai_category) says so, "Gaming ·
 * inferred" (roadmap 33.4); one the streamer chose is shown plain. Stream rows carry `category` as
 * the effective value (ai_category when there is one) and `ai_category` itself.
 */
function _isInferredCategory(row) { return !!(row && row.ai_category && row.ai_category === row.category); }
function _setCategoryBadge(el, value, inferred) {
    if (!el) return;
    el.textContent = _capTag(value);
    el.classList.toggle('is-inferred', !!inferred);
    if (inferred) {
        const mark = document.createElement('span');
        mark.className = 'cat-inferred';
        mark.textContent = ' · inferred';
        el.append(mark);
        el.title = "Category inferred by OpenVibe's AI from the stream";
    } else {
        el.removeAttribute('title');
    }
}
const CHANNEL_VODS_PAGE_SIZE = 12;
const CHANNEL_CLIPS_PAGE_SIZE = 12;
const channelVodsPageByUser = Object.create(null);
const channelClipsPageByUser = Object.create(null);
const channelClipsOfPageByUser = Object.create(null);
const channelAiClipsPageByUser = Object.create(null);
// Channel VOD filter/sort state
let currentChannelVodFilter = null;   // numeric managed stream id or null = all
let currentChannelVodOrder = 'newest'; // newest|oldest|views|peak_viewers
let currentChannelManagedStreams = [];

async function renderChannelVodsSection(username, liveStreams, vods, meta = {}) {
    const vodsGrid = document.getElementById('ch-vods-grid');
    if (!vodsGrid) return;

    // Render the VOD filter bar if we have managed streams
    const filterBar = document.getElementById('ch-vods-filter-bar');
    if (filterBar && currentChannelManagedStreams.length > 0) {
        const msOptions = currentChannelManagedStreams.map(ms =>
            `<option value="${ms.id}" ${currentChannelVodFilter === ms.id ? 'selected' : ''}>${esc(ms.title || ms.slug || ('Stream #' + ms.id))}</option>`
        ).join('');
        const orderOptions = [
            ['newest', 'Newest first'],
            ['oldest', 'Oldest first'],
            ['views', 'Most views'],
            ['peak_viewers', 'Peak viewers'],
        ].map(([val, label]) =>
            `<option value="${val}" ${currentChannelVodOrder === val ? 'selected' : ''}>${label}</option>`
        ).join('');
        filterBar.innerHTML = `
            <select class="ch-vods-filter-select" onchange="setChannelVodFilter(this.value ? parseInt(this.value) : null)">
                <option value="" ${currentChannelVodFilter === null ? 'selected' : ''}>All streams</option>
                ${msOptions}
            </select>
            <select class="ch-vods-filter-select" onchange="setChannelVodOrder(this.value)">
                ${orderOptions}
            </select>
        `;
        filterBar.style.display = '';
    } else if (filterBar) {
        filterBar.style.display = 'none';
    }

    const pageSize = meta.limit || CHANNEL_VODS_PAGE_SIZE;
    const offset = meta.offset || 0;
    const total = meta.total || vods.length;
    const page = Math.floor(offset / pageSize) + 1;
    let liveVodHtml = '';

    if (liveStreams.length > 0) {
        for (const ls of liveStreams) {
            try {
                const liveVod = await api(`/vods/stream/${ls.id}/live`);
                if (liveVod && liveVod.vod) {
                    const v = liveVod.vod;
                    liveVodHtml += `
                        <a class="stream-card" href="/vod/${v.id}" onclick="return handleLinkClick(event, '/vod/${v.id}')" style="border:2px solid var(--accent);position:relative">
                            <div class="stream-card-thumb">
                                ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
                                <span class="stream-card-nsfw" style="background:#e53e3e;animation:pulse 2s infinite">● RECORDING</span>
                                <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || 0)}</span>
                            </div>
                            <div class="stream-card-info">
                                <div class="stream-card-title">${esc(v.title || 'Live Recording')}</div>
                                <div class="stream-card-streamer muted">In progress — ${esc(ls.title || 'Live Stream')}</div>
                            </div>
                        </a>`;
                }
            } catch {}
        }
    }

    if (liveVodHtml || vods.length) {
        const canManage = _channelCanManage(username);
        _selSetContext(canManage, () => _reloadChannelContent(username));
        vodsGrid.innerHTML = liveVodHtml + vods.map(v => _selWrap('vod', v.id, `
            <a class="stream-card" href="/vod/${v.id}" onclick="return handleLinkClick(event, '/vod/${v.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
                    ${_visBadge(v.visibility, v.is_public, canManage)}
                    ${v.stream_protocol ? protocolBadge(v.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
                    <div class="stream-card-streamer muted">${formatDateTime(v.created_at)}</div>
                    ${_cardAiHTML(v.ai_overview_short, v.ai_overview)}
                </div>
            </a>
        `, _activeChannelIsOwnerRank || !!v.owner_is_owner)).join('');
    } else {
        vodsGrid.innerHTML = '<p class="muted">No VODs yet</p>';
    }

    renderVodsPagination('ch-vods-pagination', page, total, pageSize, 'setChannelVodsPage', 'videos');
    _selSyncAllBtns();
}

// Can the current user manage a channel's content (its owner, or any admin)?
// OpenVibe staff badge for a user (admin/owner -> Staff · Admin, mod -> Staff · Mod).
function _staffBadge(role, isOwner) {
    if (role === 'admin' || isOwner) return '<span class="staff-badge staff-badge-admin" data-tip="Staff - Admin"><i class="fa-solid fa-shield-halved"></i></span>';
    if (role === 'global_mod') return '<span class="staff-badge staff-badge-mod" data-tip="Staff - Mod"><i class="fa-solid fa-shield"></i></span>';
    return '';
}

function _channelCanManage(username) {
    return !!((currentUser && currentUser.username === username) || _isContentAdmin());
}
// A small visibility badge for a VOD/clip card (shown only to managers).
function _visBadge(visibility, isPublic, canManage) {
    if (!canManage) return '';
    const vis = visibility || (isPublic ? 'public' : 'private');
    if (vis === 'public') return '';
    const label = vis === 'unlisted' ? 'UNLISTED' : 'PRIVATE';
    return `<span class="stream-card-nsfw" style="background:var(--text-muted)">${label}</span>`;
}
// Reload all manageable channel content after a bulk action.
function _reloadChannelContent(username) {
    try { refreshChannelVodsPage(username); } catch { /* */ }
    try { loadChannelPastes(username); } catch { /* */ }
}

function renderChannelClipsSection(username, clips, meta = {}) {
    const clipsGrid = document.getElementById('ch-clips-grid');
    if (!clipsGrid) return;

    const pageSize = meta.limit || CHANNEL_CLIPS_PAGE_SIZE;
    const offset = meta.offset || 0;
    const total = meta.total || clips.length;
    const page = Math.floor(offset / pageSize) + 1;

    if (clips.length) {
        const canManage = _channelCanManage(username);
        _selSetContext(canManage, () => _reloadChannelContent(username));
        clipsGrid.innerHTML = clips.map(cl => _selWrap('clip', cl.id, `
            <a class="stream-card" href="/clip/${cl.id}" onclick="return handleLinkClick(event, '/clip/${cl.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
                    ${_visBadge(cl.visibility, cl.is_public, canManage)}
                    ${cl.stream_protocol ? protocolBadge(cl.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    <div class="stream-card-streamer muted">${formatDateTime(cl.created_at)}</div>
                    ${_cardAiHTML(cl.ai_overview_short, cl.ai_overview)}
                </div>
            </a>
        `, _activeChannelIsOwnerRank || !!(cl.owner_is_owner || cl.streamer_is_owner))).join('');
    } else {
        clipsGrid.innerHTML = '<p class="muted">No clips yet</p>';
    }

    renderVodsPagination('ch-clips-pagination', page, total, pageSize, 'setChannelClipsPage', 'clips');
    _selSyncAllBtns();
}

// ── "Clips Taken" tab: filterable clips this streamer created ──
let _clipsTaken = { username: null, sort: 'newest', of: null, includeSelf: false, page: 1, facets: [], total: 0 };
const CLIPS_TAKEN_PAGE_SIZE = 12;

async function loadClipsTaken(username = currentChannelUsername, { reset = false } = {}) {
    if (!username) return;
    if (reset || _clipsTaken.username !== username) {
        _clipsTaken = { username, sort: 'newest', of: null, includeSelf: false, page: 1, facets: [], total: 0 };
    }
    const st = _clipsTaken;
    const grid = document.getElementById('ch-clips-grid');
    const offset = (st.page - 1) * CLIPS_TAKEN_PAGE_SIZE;
    const params = new URLSearchParams({ sort: st.sort, limit: String(CLIPS_TAKEN_PAGE_SIZE), offset: String(offset) });
    if (st.of) params.set('of', String(st.of));
    if (st.includeSelf) params.set('includeSelf', '1');
    if (grid) grid.innerHTML = '<p class="muted">Loading…</p>';
    let data;
    try { data = await api(`/streams/channel/${encodeURIComponent(username)}/clips-taken?${params.toString()}`); }
    catch { if (grid) grid.innerHTML = '<p class="muted">Failed to load clips</p>'; return; }
    if (_clipsTaken.username !== username) return; // navigated away mid-fetch
    st.facets = data.facets || [];
    st.total = data.total || 0;
    _renderClipsTakenBar();
    _renderClipsTakenGrid(username, data);
}

function _renderClipsTakenBar() {
    const bar = document.getElementById('clips-taken-filters');
    if (!bar) return;
    const st = _clipsTaken;
    if (!st.facets.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = '';
    const sortSel = `<select class="ct-sort" onchange="setClipsTakenSort(this.value)">
            <option value="newest" ${st.sort === 'newest' ? 'selected' : ''}>Newest</option>
            <option value="oldest" ${st.sort === 'oldest' ? 'selected' : ''}>Oldest</option>
            <option value="views" ${st.sort === 'views' ? 'selected' : ''}>Most viewed</option>
        </select>`;
    const allActive = !st.of;
    let badges = `<button class="ct-badge ${allActive ? 'active' : ''}" onclick="setClipsTakenFilter(null,false)">All others</button>`;
    for (const f of st.facets) {
        const active = st.of === f.streamer_id;
        const label = f.is_self ? 'Yourself' : esc(f.display_name || f.username || 'Unknown');
        badges += `<button class="ct-badge ${active ? 'active' : ''} ${f.is_self ? 'ct-self' : ''}" onclick="setClipsTakenFilter(${f.streamer_id}, ${f.is_self ? 'true' : 'false'})">${label} <span class="ct-count">${f.count}</span></button>`;
    }
    bar.innerHTML = `<div class="ct-sort-wrap"><i class="fa-solid fa-arrow-down-wide-short"></i> ${sortSel}</div><div class="ct-badges">${badges}</div>`;
}

function _renderClipsTakenGrid(username, data) {
    const grid = document.getElementById('ch-clips-grid');
    if (!grid) return;
    const clips = data.clips || [];
    const canManage = _channelCanManage(username);
    _selSetContext(canManage, () => loadClipsTaken(username));
    if (!clips.length) {
        grid.innerHTML = '<p class="muted">No clips found for this filter.</p>';
        renderVodsPagination('ch-clips-pagination', 1, 0, CLIPS_TAKEN_PAGE_SIZE, 'setClipsTakenPage', 'clips');
        return;
    }
    grid.innerHTML = clips.map(cl => _selWrap('clip', cl.id, `
            <a class="stream-card" href="/clip/${cl.id}" onclick="return handleLinkClick(event, '/clip/${cl.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
                    ${_visBadge(cl.visibility, cl.is_public, canManage)}
                    ${ovViewsBadge(cl.view_count)}
                    <span class="stream-card-duration">${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    <div class="stream-card-streamer muted">${cl.source_streamer_username ? 'of ' + esc(cl.source_streamer_display_name || cl.source_streamer_username) + ' · ' : ''}${formatDateTime(cl.created_at)}</div>
                    ${_cardAiHTML(cl.ai_overview_short, cl.ai_overview)}
                </div>
            </a>
        `, _activeChannelIsOwnerRank || !!(cl.owner_is_owner || cl.streamer_is_owner))).join('');
    const page = Math.floor((data.offset || 0) / CLIPS_TAKEN_PAGE_SIZE) + 1;
    renderVodsPagination('ch-clips-pagination', page, data.total || 0, CLIPS_TAKEN_PAGE_SIZE, 'setClipsTakenPage', 'clips');
    _selSyncAllBtns();
}

function setClipsTakenSort(sort) { _clipsTaken.sort = sort; _clipsTaken.page = 1; loadClipsTaken(_clipsTaken.username); }
function setClipsTakenFilter(of, isSelf) {
    _clipsTaken.of = of || null;
    _clipsTaken.includeSelf = !!isSelf;
    _clipsTaken.page = 1;
    loadClipsTaken(_clipsTaken.username);
}
function setClipsTakenPage(page) { _clipsTaken.page = page; loadClipsTaken(_clipsTaken.username); }

function renderChannelClipsOfSection(username, clips, meta = {}) {
    const grid = document.getElementById('ch-clips-of-grid');
    const header = document.getElementById('ch-clips-of-header');
    if (!grid) return;

    const pageSize = meta.limit || CHANNEL_CLIPS_PAGE_SIZE;
    const offset = meta.offset || 0;
    const total = meta.total || clips.length;
    const page = Math.floor(offset / pageSize) + 1;

    if (total === 0) { grid.innerHTML = '<p class="muted">No one has clipped these streams yet</p>'; return; }

    if (clips.length) {
        grid.innerHTML = clips.map(cl => `
            <a class="stream-card" href="/clip/${cl.id}" onclick="return handleLinkClick(event, '/clip/${cl.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
                    ${cl.stream_protocol ? protocolBadge(cl.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    <div class="stream-card-streamer muted">by ${esc(cl.clip_creator_display_name || cl.clip_creator_username || 'Unknown')} &middot; ${formatDateTime(cl.created_at)}</div>
                    ${_cardAiHTML(cl.ai_overview_short, cl.ai_overview)}
                </div>
            </a>
        `).join('');
    } else {
        grid.innerHTML = '<p class="muted">No clips yet</p>';
    }

    renderVodsPagination('ch-clips-of-pagination', page, total, pageSize, 'setChannelClipsOfPage', 'clips of streams');
}

// ── AI Moments on the Clips tab: auto-clips of this channel's streams, after people's clips ──
// Built with DOM nodes (titles come from the AI). Each card says it is an AI clip from this
// streamer's stream; none is credited to a clipper (roadmap 33.4/33.6).
function renderChannelAiClipsSection(username, clips, meta = {}) {
    const section = document.getElementById('ch-ai-clips-section');
    const grid = document.getElementById('ch-ai-clips-grid');
    if (!section || !grid) return;
    const pageSize = meta.limit || CHANNEL_CLIPS_PAGE_SIZE;
    const offset = meta.offset || 0;
    const total = meta.total || clips.length;
    section.hidden = !(total > 0);
    grid.textContent = '';
    if (!total) { renderVodsPagination('ch-ai-clips-pagination', 1, 0, pageSize, 'setChannelAiClipsPage', 'AI clips'); return; }
    for (const cl of clips) {
        const href = `/clip/${Number(cl.id)}`;
        const card = document.createElement('a');
        card.className = 'stream-card';
        card.href = href;
        card.addEventListener('click', (event) => handleLinkClick(event, href));
        const thumb = document.createElement('div');
        thumb.className = 'stream-card-thumb';
        thumb.innerHTML = thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${Number(cl.id)}`);
        const badge = document.createElement('span');
        badge.className = 'ch-ai-badge';
        badge.textContent = 'AI clip';
        const dur = document.createElement('span');
        dur.className = 'stream-card-viewers';
        dur.innerHTML = '<i class="fa-solid fa-clock"></i> ';
        dur.append(formatDuration(cl.duration_seconds));
        thumb.append(badge, dur);
        const info = document.createElement('div');
        info.className = 'stream-card-info';
        const title = document.createElement('div');
        title.className = 'stream-card-title';
        title.textContent = cl.title || 'AI clip';
        const by = document.createElement('div');
        by.className = 'stream-card-streamer muted';
        by.textContent = `from ${cl.source_streamer_display_name || cl.source_streamer_username || username}'s stream · ${formatDateTime(cl.created_at)}`;
        info.append(title, by);
        if (cl.ai_overview_short) info.insertAdjacentHTML('beforeend', _cardAiHTML(cl.ai_overview_short, cl.ai_overview));
        card.append(thumb, info);
        grid.append(card);
    }
    renderVodsPagination('ch-ai-clips-pagination', Math.floor(offset / pageSize) + 1, total, pageSize, 'setChannelAiClipsPage', 'AI clips');
}

async function setChannelAiClipsPage(page) {
    if (!currentChannelUsername) return;
    const safePage = Math.max(1, page | 0);
    if (safePage === (channelAiClipsPageByUser[currentChannelUsername] || 1)) return;
    channelAiClipsPageByUser[currentChannelUsername] = safePage;
    const offset = (safePage - 1) * CHANNEL_CLIPS_PAGE_SIZE;
    const data = await api(`/streams/channel/${currentChannelUsername}?aiClipsLimit=${CHANNEL_CLIPS_PAGE_SIZE}&aiClipsOffset=${offset}`);
    renderChannelAiClipsSection(currentChannelUsername, data.aiClips || [], { total: data.aiClipsTotal || 0, limit: CHANNEL_CLIPS_PAGE_SIZE, offset });
    const top = document.getElementById('ch-ai-clips-section');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshChannelVodsPage(username = currentChannelUsername) {
    if (!username) return;

    const page = channelVodsPageByUser[username] || 1;
    const limit = CHANNEL_VODS_PAGE_SIZE;
    const offset = (page - 1) * limit;
    const clipPage = channelClipsPageByUser[username] || 1;
    const clipOffset = (clipPage - 1) * CHANNEL_CLIPS_PAGE_SIZE;

    // Build filter/order query params — persist state across pagination
    let extraParams = `&vodOrderBy=${encodeURIComponent(currentChannelVodOrder || 'newest')}`;
    if (currentChannelVodFilter !== null && currentChannelVodFilter !== undefined) {
        extraParams += `&vodManagedStreamId=${encodeURIComponent(currentChannelVodFilter)}`;
    }

    const data = await api(`/streams/channel/${username}?vodLimit=${limit}&vodOffset=${offset}&clipLimit=${CHANNEL_CLIPS_PAGE_SIZE}&clipOffset=${clipOffset}${extraParams}`);
    const liveStreams = (data.streams || []).filter(s => s && s.is_live);
    const totalPages = Math.max(1, Math.ceil((data.vodTotal || 0) / limit));

    if (page > totalPages) {
        channelVodsPageByUser[username] = totalPages;
        return refreshChannelVodsPage(username);
    }

    await renderChannelVodsSection(username, liveStreams, data.vods || [], {
        total: data.vodTotal || (data.vods || []).length,
        limit: data.vodLimit || limit,
        offset: data.vodOffset || offset,
    });

    // Load the channel's Pastes section + (re)start its periodic auto-refresh.
    loadChannelPastes(username);
    _startChannelPastesAutoRefresh(username);
}

/* ── Channel Pastes section (auto-refresh + sortable) ─────────── */
let _channelPastesTimer = null;
const channelPastesSortByUser = Object.create(null);

function _startChannelPastesAutoRefresh(username) {
    if (_channelPastesTimer) clearInterval(_channelPastesTimer);
    _channelPastesTimer = setInterval(() => {
        if (currentChannelUsername !== username) { clearInterval(_channelPastesTimer); _channelPastesTimer = null; return; }
        loadChannelPastes(username);
    }, 60000);
}

async function loadChannelPastes(username = currentChannelUsername) {
    if (!username) return;
    const grid = document.getElementById('ch-pastes-grid');
    const header = document.getElementById('ch-pastes-header');
    const pager = document.getElementById('ch-pastes-pagination');
    if (!grid) return;
    const sort = channelPastesSortByUser[username] || 'newest';
    try {
        const data = await api(`/pastes/by-user/${encodeURIComponent(username)}?limit=30&sort=${sort}`);
        const pastes = data.pastes || [];
        if (!pastes.length) {
            // Tab context: keep the panel readable with an empty state.
            grid.style.display = ''; grid.innerHTML = '<p class="muted">No pastes yet</p>';
            if (pager) { pager.style.display = 'none'; pager.innerHTML = ''; }
            return;
        }
        const canManage = !!data.canManage || _channelCanManage(username);
        _selSetContext(canManage, () => _reloadChannelContent(username));
        if (header) header.style.display = '';
        grid.style.display = '';
        grid.innerHTML = pastes.map(p => _selWrap('paste', p.slug, _channelPasteCardHTML(p, canManage), !!(p.owner_is_owner || data.owner_is_owner))).join('');
        if (pager) {
            pager.style.display = '';
            pager.innerHTML = (typeof sortToggleHTML === 'function') ? sortToggleHTML(sort, 'setChannelPastesSort') : '';
        }
        _selSyncAllBtns();
    } catch { /* silent */ }
}

function setChannelPastesSort(sort) {
    const u = currentChannelUsername;
    if (!u) return;
    channelPastesSortByUser[u] = sort === 'oldest' ? 'oldest' : 'newest';
    loadChannelPastes(u);
}

function _channelPasteCardHTML(p, canManage) {
    const isShot = p.type === 'screenshot';
    const vis = (canManage && p.visibility && p.visibility !== 'public')
        ? `<span class="ch-paste-vis">${esc(p.visibility)}</span>` : '';
    const thumb = (isShot && p.screenshot_url)
        ? `<div class="ch-paste-thumb"><img src="${esc(p.screenshot_url)}" alt="" loading="lazy"></div>`
        : `<div class="ch-paste-thumb ch-paste-thumb-icon"><i class="fa-solid ${isShot ? 'fa-image' : 'fa-code'}"></i></div>`;
    return `<a class="ch-paste-card" href="/p/${esc(p.slug)}" onclick="return handleLinkClick(event, '/p/${esc(p.slug)}')">
        ${thumb}
        <div class="ch-paste-info">
            <div class="ch-paste-title">${esc(p.title || 'Untitled')} ${vis}</div>
            <div class="ch-paste-meta muted"><span>${timeAgo(p.created_at)}</span> · <span><i class="fa-solid fa-eye"></i> ${p.views || 0}</span></div>
            ${(typeof _cardAiHTML === 'function') ? _cardAiHTML(p.ai_summary) : ((p.ai_summary && p.ai_summary.trim()) ? `<div class="card-ai-overview"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(p.ai_summary)}</div>` : '')}
        </div>
    </a>`;
}

function setChannelVodFilter(managedStreamId) {
    // Accept null (all streams) or a numeric managed stream id
    currentChannelVodFilter = managedStreamId === null || managedStreamId === '' ? null : (parseInt(managedStreamId, 10) || null);
    channelVodsPageByUser[currentChannelUsername] = 1; // reset to page 1 when filter changes
    refreshChannelVodsPage();
}

function setChannelVodOrder(order) {
    const ALLOWED = ['newest', 'oldest', 'views', 'peak_viewers'];
    currentChannelVodOrder = ALLOWED.includes(order) ? order : 'newest';
    channelVodsPageByUser[currentChannelUsername] = 1; // reset to page 1 when order changes
    refreshChannelVodsPage();
}

async function setChannelVodsPage(page) {
    if (!currentChannelUsername) return;
    const safePage = Math.max(1, page | 0);
    if (safePage === (channelVodsPageByUser[currentChannelUsername] || 1)) return;

    channelVodsPageByUser[currentChannelUsername] = safePage;
    const grid = document.getElementById('ch-vods-grid');
    if (grid) {
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading videos...</p></div>';
    }
    await refreshChannelVodsPage(currentChannelUsername);
    const top = document.getElementById('ch-vods-grid');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function setChannelClipsPage(page) {
    if (!currentChannelUsername) return;
    const safePage = Math.max(1, page | 0);
    if (safePage === (channelClipsPageByUser[currentChannelUsername] || 1)) return;

    channelClipsPageByUser[currentChannelUsername] = safePage;
    const grid = document.getElementById('ch-clips-grid');
    if (grid) {
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading clips...</p></div>';
    }

    const vodPage = channelVodsPageByUser[currentChannelUsername] || 1;
    const vodOffset = (vodPage - 1) * CHANNEL_VODS_PAGE_SIZE;
    const clipOffset = (safePage - 1) * CHANNEL_CLIPS_PAGE_SIZE;
    const data = await api(`/streams/channel/${currentChannelUsername}?vodLimit=${CHANNEL_VODS_PAGE_SIZE}&vodOffset=${vodOffset}&clipLimit=${CHANNEL_CLIPS_PAGE_SIZE}&clipOffset=${clipOffset}`);
    renderChannelClipsSection(currentChannelUsername, data.clips || [], {
        total: data.clipTotal || (data.clips || []).length,
        limit: data.clipLimit || CHANNEL_CLIPS_PAGE_SIZE,
        offset: data.clipOffset || clipOffset,
    });

    const top = document.getElementById('ch-clips-grid');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function setChannelClipsOfPage(page) {
    if (!currentChannelUsername) return;
    const safePage = Math.max(1, page | 0);
    if (safePage === (channelClipsOfPageByUser[currentChannelUsername] || 1)) return;

    channelClipsOfPageByUser[currentChannelUsername] = safePage;
    const grid = document.getElementById('ch-clips-of-grid');
    if (grid) {
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading clips...</p></div>';
    }

    const offset = (safePage - 1) * CHANNEL_CLIPS_PAGE_SIZE;
    const data = await api(`/streams/channel/${currentChannelUsername}?clipsOfLimit=${CHANNEL_CLIPS_PAGE_SIZE}&clipsOfOffset=${offset}`);
    renderChannelClipsOfSection(currentChannelUsername, data.clipsOfStreams || [], {
        total: data.clipsOfTotal || 0,
        limit: CHANNEL_CLIPS_PAGE_SIZE,
        offset,
    });

    const top = document.getElementById('ch-clips-of-grid');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadChannelPage(username, managedStreamRef = null, legacySessionId = null) {
    try {
        const isNewChannel = currentChannelUsername !== username;
        currentChannelUsername = username;
        if (isNewChannel) {
            channelVodsPageByUser[username] = 1;
            channelClipsPageByUser[username] = 1;
            // Reset VOD filter/sort state for fresh channel navigation
            currentChannelVodFilter = null;
            currentChannelVodOrder = 'newest';
        }
        const channelVodPage = channelVodsPageByUser[username] || 1;
        const channelClipPage = channelClipsPageByUser[username] || 1;
        const channelVodOffset = (channelVodPage - 1) * CHANNEL_VODS_PAGE_SIZE;
        const channelClipOffset = (channelClipPage - 1) * CHANNEL_CLIPS_PAGE_SIZE;

        // If managedStreamRef is given on fresh navigation, pass it as a filter for the initial VOD load
        let initialVodExtra = '';
        if (isNewChannel && managedStreamRef) {
            if (/^\d+$/.test(String(managedStreamRef))) {
                initialVodExtra = `&vodManagedStreamId=${encodeURIComponent(managedStreamRef)}`;
            } else {
                initialVodExtra = `&vodManagedStreamSlug=${encodeURIComponent(managedStreamRef)}`;
            }
        }

        const data = await api(`/streams/channel/${username}?vodLimit=${CHANNEL_VODS_PAGE_SIZE}&vodOffset=${channelVodOffset}&clipLimit=${CHANNEL_CLIPS_PAGE_SIZE}&clipOffset=${channelClipOffset}${initialVodExtra}`);
        const ch = data.channel;
        if (typeof applyChatLimits === 'function') applyChatLimits(ch && ch.chat_limits);
        if (typeof setChatLimitsContext === 'function') {
            const _canManageChat = !!(currentUser && ch && (ch.user_id === currentUser.id || currentUser.role === 'admin' || ch.viewer_can_edit_about));
            setChatLimitsContext(ch && ch.id, _canManageChat);
        }
        const streams = data.streams || (data.stream ? [data.stream] : []);
        const vods = data.vods || [];
        const clips = data.clips || [];
        const clipsOfStreams = data.clipsOfStreams || [];
        const managedStreams = data.managed_streams || [];
        const liveStreams = streams.filter(s => s && s.is_live);
        const rsRestream = data.rs_restream || {};
        const restreamLinks = data.restream_links || null;
        const externalViewers = data.external_viewers || null;

        // Populate managed streams for the VOD filter bar and resolve managedStreamRef → filter ID
        currentChannelManagedStreams = managedStreams;
        if (isNewChannel && managedStreamRef && managedStreams.length > 0) {
            const ref = String(managedStreamRef);
            const resolved = managedStreams.find(ms => String(ms.slug) === ref || String(ms.id) === ref);
            if (resolved) currentChannelVodFilter = resolved.id;
        }

        // Legacy backward compat: resolve ?stream=sessionId to managed stream
        let preferredStreamId = null;
        if (legacySessionId && !managedStreamRef) {
            preferredStreamId = legacySessionId;
        }

        // Stable chat-room key for this channel (used by all initChat calls below).
        _activeChannelUserId = ch.user_id || null;

        // Donation goal widget at the top of chat (works live + offline).
        initGoalWidget(ch.user_id);

        // Reset the channel tabs + render the About tab (About is default/first when set).
        // Weather is rendered on demand inside weather panels (see _fillWeatherPanels).
        _renderChannelAbout(ch);
        _applyChannelLanguage(data.language, ch, liveStreams.length > 0);
        _resetChannelTabs(ch);
        _applyChannelTabMeta(data);
        _applyChannelHashTab(); // deep-link: #ai-timeline / #about / #videos … opens that tab
        // Reveal the Media Request tab if the streamer has it enabled (non-blocking).
        _initMediaRequestTab(username);

        // Follow button helper
        const setupFollowBtn = (btn) => {
            if (!btn) return;
            if (currentUser && currentUser.username === username) {
                btn.style.display = 'none';
            } else {
                btn.style.display = '';
                btn.classList.toggle('following', ch.is_following);
                btn.innerHTML = ch.is_following
                    ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
                    : '<i class="fa-solid fa-heart"></i> Follow';
                btn.onclick = () => toggleChannelFollow(username);
            }
        };

        // Ban button helper (admin / global_mod only)
        const setupBanBtn = (btn) => {
            if (!btn) return;
            const canBan = currentUser?.capabilities?.manage_site_bans;
            const isSelf = currentUser && currentUser.username === username;
            if (!canBan || isSelf) { btn.style.display = 'none'; return; }
            btn.style.display = '';
            btn.onclick = () => banChannelUser(ch.user_id, ch.username || username);
        };

        if (liveStreams.length > 0) {
            // ── LIVE STATE ──
            document.getElementById('ch-live-area').style.display = '';
            document.getElementById('ch-offline-area').style.display = 'none';

            // Populate streamer info bar (below video). Avatar image (letter fallback)
            // + display name both link to the channel; the @handle is dropped.
            const _chPath = channelPath(ch.username);
            const _chAvatar = document.getElementById('ch-avatar');
            if (_chAvatar) {
                _chAvatar.innerHTML = ch.avatar_url
                    ? `<img src="${esc(ch.avatar_url)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${((ch.username || '?')[0] || '?').toUpperCase()}'">`
                    : ((ch.username || '?')[0] || '?').toUpperCase();
                _chAvatar.style.cursor = 'pointer';
                _chAvatar.onclick = () => navigate(_chPath);
            }
            const _chName = document.getElementById('ch-display-name');
            if (_chName) {
                // Name only — the h2 clips with ellipsis, so the staff badge lives in
                // its own sibling span (below) to stay visible and keep its tooltip.
                _chName.innerHTML = `<a href="${esc(_chPath)}" onclick="event.preventDefault();navigate('${esc(_chPath)}')" style="color:inherit;text-decoration:none">${esc(ch.display_name || ch.username)}</a>`;
            }
            const _chStaff = document.getElementById('ch-staff-badge');
            if (_chStaff) _chStaff.innerHTML = _staffBadge(ch.role, ch.is_owner);
            _activeChannelIsOwnerRank = !!ch.is_owner;
            const _chUser = document.getElementById('ch-username');
            if (_chUser) _chUser.style.display = 'none';
            { const _ls0 = liveStreams[0], _liveCat = _ls0 && _ls0.category;
              _setCategoryBadge(document.getElementById('ch-category-badge'), _liveCat || ch.ai_category || ch.category || 'Live',
                  _liveCat ? _isInferredCategory(_ls0) : !!ch.ai_category); }
            document.getElementById('ch-follower-count').textContent = `${ch.follower_count || 0} followers`;
            setupFollowBtn(document.getElementById('ch-btn-follow'));
            setupBanBtn(document.getElementById('ch-btn-ban'));

            // Pick the preferred stream:
            // 0. URL /@username/:managedStreamRef (managed stream deep link)
            // 1. URL ?stream=ID (legacy deep link / shared link)
            // 2. Last viewed stream in this session (sessionStorage)
            // 3. Highest viewer count stream (default)
            let targetStream;
            if (managedStreamRef && !preferredStreamId) {
                const ref = String(managedStreamRef);
                targetStream = liveStreams.find(s =>
                    String(s.managed_stream_slug) === ref || String(s.managed_stream_id) === ref
                );
            }
            if (!targetStream && preferredStreamId) {
                targetStream = liveStreams.find(s => s.id === preferredStreamId);
            }
            if (!targetStream) {
                const lastId = getLastStream(username);
                if (lastId) targetStream = liveStreams.find(s => s.id === lastId);
            }
            if (!targetStream) {
                targetStream = liveStreams.reduce((best, s) =>
                    (s.viewer_count || 0) > (best.viewer_count || 0) ? s : best
                , liveStreams[0]);
                // Clean up stale ?stream= param — the requested stream isn't live
                if (preferredStreamId && targetStream) {
                    const msRef = targetStream.managed_stream_slug || targetStream.managed_stream_id || null;
                    history.replaceState(null, '', channelPath(username, msRef));
                }
            }

            // Remember selection and update URL
            rememberLastStream(username, targetStream.id);
            if (!preferredStreamId && liveStreams.length > 1) {
                const msRef = targetStream.managed_stream_slug || targetStream.managed_stream_id || null;
                history.replaceState(null, '', channelPath(username, msRef));
            }

            loadLiveStreamTabs(username, targetStream.id, liveStreams, rsRestream);

            // Activate the selected stream
            activateChannelStream(targetStream);

            // Show cumulative viewers across all streams
            updateCumulativeViewers(liveStreams, rsRestream, restreamLinks, externalViewers);
        } else {
            // ── OFFLINE STATE ──
            document.getElementById('ch-live-area').style.display = 'none';
            document.getElementById('ch-offline-area').style.display = '';

            // Populate offline header
            document.getElementById('ch-avatar-offline').textContent = (ch.username || '?')[0].toUpperCase();
            document.getElementById('ch-display-name-offline').innerHTML = `${esc(ch.display_name || ch.username)} ${_staffBadge(ch.role, ch.is_owner)}`;
            _activeChannelIsOwnerRank = !!ch.is_owner;
            document.getElementById('ch-username-offline').textContent = '@' + ch.username;
            document.getElementById('ch-description-offline').textContent = ch.description || '';
            document.getElementById('ch-follower-count-offline').textContent = `${ch.follower_count || 0} followers`;
            _setCategoryBadge(document.getElementById('ch-category-badge-offline'), ch.ai_category || ch.category || 'Offline', !!ch.ai_category);
            setupFollowBtn(document.getElementById('ch-btn-follow-offline'));
            setupBanBtn(document.getElementById('ch-btn-ban-offline'));

            // Customizable offline screen (image / video / custom HTML)
            _renderOfflineScreen(ch);

            // Offline: join the streamer's PERSISTENT chat room (not global) so
            // viewers can keep chatting + see history while the streamer is offline.
            initChat(null, ch.user_id);

            // Hide stream tabs on offline channels
            const tabsC = document.getElementById('live-stream-tabs');
            if (tabsC) tabsC.style.display = 'none';

            // Poll for when streamer comes online
            startOfflineStatusPoll(username);
        }

        await renderChannelVodsSection(username, liveStreams, vods, {
            total: data.vodTotal || vods.length,
            limit: data.vodLimit || CHANNEL_VODS_PAGE_SIZE,
            offset: data.vodOffset || channelVodOffset,
        });

        // Clips section (clips BY this user)
        renderChannelClipsSection(username, clips, {
            total: data.clipTotal || clips.length,
            limit: data.clipLimit || CHANNEL_CLIPS_PAGE_SIZE,
            offset: data.clipOffset || channelClipOffset,
        });

        // Clips OF this user's streams (by other users)
        renderChannelClipsOfSection(username, clipsOfStreams, {
            total: data.clipsOfTotal || clipsOfStreams.length,
            limit: data.clipsOfLimit || CHANNEL_CLIPS_PAGE_SIZE,
            offset: data.clipsOfOffset || 0,
        });
        // …then what the AI cut from them, labelled as such
        renderChannelAiClipsSection(username, data.aiClips || [], {
            total: data.aiClipsTotal || (data.aiClips || []).length,
            limit: data.aiClipsLimit || CHANNEL_CLIPS_PAGE_SIZE,
            offset: data.aiClipsOffset || 0,
        });

        // Analytics is loaded lazily when its tab is first opened (see switchChannelTab).

    } catch (e) {
        console.error('Channel load error:', e);
        toast('Channel not found', 'error');
        navigate('/');
    }
}

// ── Channel Analytics ────────────────────────────────────────
let _chAnalyticsChart = null;

async function loadChannelAnalytics(username, days = 30) {
    try {
        const res = await fetch(`/api/analytics/channel/${encodeURIComponent(username)}?days=${days}`);
        if (!res.ok) return; // silently skip if no data
        const data = await res.json();

        const header = document.getElementById('ch-analytics-header');
        const section = document.getElementById('ch-analytics-section');
        if (!header || !section) return;

        const { summary, streams, all_time } = data;
        if (!summary || (!summary.total_streams && !all_time?.total_streams)) return;

        header.style.display = '';
        section.style.display = '';

        // Period toggle buttons
        const periodBtns = document.getElementById('ch-analytics-period-btns');
        if (periodBtns && !periodBtns._wired) {
            periodBtns._wired = true;
            periodBtns.addEventListener('click', e => {
                const btn = e.target.closest('[data-days]');
                if (!btn) return;
                periodBtns.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                loadChannelAnalytics(username, parseInt(btn.dataset.days));
            });
        }

        // Stat cards
        const cards = document.getElementById('ch-analytics-cards');
        const s = summary;
        const statItems = [
            { value: s.total_streams || 0, label: 'Streams' },
            { value: formatDurationShort(s.total_duration_seconds || 0), label: 'Stream Time' },
            { value: s.peak_viewers || 0, label: 'Peak Viewers' },
            { value: s.avg_viewers_per_stream != null ? s.avg_viewers_per_stream : '—', label: 'Avg Viewers' },
            { value: s.total_messages || 0, label: 'Chat Messages' },
            { value: s.total_unique_chatters || 0, label: 'Unique Chatters' },
        ];
        cards.innerHTML = statItems.map(i => `
            <div class="analytics-stat-card">
                <div class="stat-value">${typeof i.value === 'number' ? i.value.toLocaleString() : i.value}</div>
                <div class="stat-label">${i.label}</div>
            </div>
        `).join('');

        // Recent streams table
        const tableWrap = document.getElementById('ch-streams-table-wrap');
        const tbody = document.getElementById('ch-streams-tbody');
        if (streams && streams.length) {
            tableWrap.style.display = '';
            tbody.innerHTML = streams.slice(0, 20).map(st => `
                <tr>
                    <td>${formatDate(st.started_at)}</td>
                    <td>${esc(st.title || 'Untitled')}</td>
                    <td>${formatDuration(st.duration_seconds || 0)}</td>
                    <td>${st.peak_viewers ?? '—'}</td>
                    <td>${st.avg_viewers != null ? (Math.round(st.avg_viewers * 10) / 10) : '—'}</td>
                    <td>${st.total_messages ?? '—'}</td>
                </tr>
            `).join('');
        } else {
            tableWrap.style.display = 'none';
        }

        // Viewer chart for most recent stream with snapshots
        const chartWrap = document.getElementById('ch-viewer-chart-wrap');
        if (streams && streams.length) {
            // Load chart data for the most recent stream
            try {
                const sRes = await fetch(`/api/analytics/stream/${streams[0].id}`);
                if (sRes.ok) {
                    const sData = await sRes.json();
                    if (sData.viewer_chart && sData.viewer_chart.length > 1) {
                        await renderViewerChart(sData, streams[0]);
                        chartWrap.style.display = '';
                    } else {
                        chartWrap.style.display = 'none';
                    }
                }
            } catch { chartWrap.style.display = 'none'; }
        } else {
            chartWrap.style.display = 'none';
        }

    } catch (err) {
        console.error('[Analytics] Load error:', err);
    }
}

async function renderViewerChart(data, stream) {
    // Lazy-load Chart.js if not already loaded
    if (typeof Chart === 'undefined') {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    const canvas = document.getElementById('ch-viewer-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Destroy previous chart
    if (_chAnalyticsChart) { _chAnalyticsChart.destroy(); _chAnalyticsChart = null; }

    const title = document.getElementById('ch-chart-title');
    if (title) title.textContent = `Viewers — ${esc(stream.title || 'Latest Stream')}`;

    const points = data.viewer_chart;
    const labels = points.map(p => {
        const d = new Date(p.t);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });

    _chAnalyticsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Viewers',
                data: points.map(p => p.v),
                borderColor: 'rgba(99, 102, 241, 1)',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => points[items[0].dataIndex]
                            ? new Date(points[items[0].dataIndex].t).toLocaleTimeString()
                            : '',
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#888', maxTicksLimit: 10, font: { size: 11 } },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: '#888', precision: 0, font: { size: 11 } },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
            },
        },
    });
}

function formatDurationShort(seconds) {
    if (!seconds) return '0m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format uptime from a started_at timestamp to a short human string (e.g. "2h 14m").
 */
/* formatUptime lived here a second time, and because it was declared later it was the one that
   actually ran. It was the worse of the two: it appended 'Z' unconditionally, so any timestamp
   that already carried a T or an offset became Invalid Date and rendered as an empty string, and
   it dropped seconds entirely — a stream ten seconds old showed "0m". The version near the top of
   this file handles both shapes and keeps seconds; it is now the only one. */

/**
 * Show/hide the stream switch loading overlay on the video container.
 */
function showStreamSwitchOverlay(show) {
    const el = document.getElementById('stream-switch-overlay');
    if (!el) return;
    if (show) {
        el.classList.add('visible');
    } else {
        el.classList.remove('visible');
    }
}

/**
 * Remember the last viewed stream for a channel (sessionStorage).
 */
function rememberLastStream(username, streamId) {
    try { sessionStorage.setItem(`last-stream:${username}`, String(streamId)); } catch {}
}
function getLastStream(username) {
    try { const v = sessionStorage.getItem(`last-stream:${username}`); return v ? parseInt(v) : null; } catch { return null; }
}

/**
 * Auto-scroll the active tab into view within the tab bar.
 */
let _lastScrolledTab = '';
function scrollActiveTabIntoView() {
    const active = document.querySelector('.live-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

/**
 * Copy the current stream-specific URL to clipboard.
 */
function shareStreamUrl() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(
        () => toast('Stream link copied!', 'success'),
        () => toast('Failed to copy link', 'error')
    );
}

/**
 * Load tabs for the current channel's live streams.
 * Shows tabs when the channel has multiple concurrent streams.
 * Each tab shows: number badge, live dot, title, protocol badge, RS icon, viewers, uptime.
 * Supports keyboard navigation (arrow keys) between tabs.
 */
function loadLiveStreamTabs(currentUsername, activeStreamId, channelStreams = [], rsRestream = {}) {
    const tabsContainer = document.getElementById('live-stream-tabs');
    const tabsScroll = document.getElementById('live-tabs-scroll');
    const pageEl = document.getElementById('page-channel');
    if (!tabsContainer || !tabsScroll) return;

    // Only show tabs if the channel has more than one concurrent live stream
    const filtered = channelStreams.filter(s =>
        !s.username || s.username.toLowerCase() === currentUsername.toLowerCase()
    );
    if (filtered.length <= 1) {
        tabsContainer.style.display = 'none';
        if (pageEl) pageEl.classList.remove('has-live-tabs');
        return;
    }

    tabsContainer.style.display = '';
    if (pageEl) pageEl.classList.add('has-live-tabs');

    // Per-slot count includes external (Twitch/Kick/RS) viewers when the server
    // provides it; the summary sums those so tabs + total agree.
    const tabViewers = (s) => (s.total_viewer_count != null ? s.total_viewer_count : (s.viewer_count || 0));
    const totalViewers = filtered.reduce((sum, s) => sum + tabViewers(s), 0);

    tabsScroll.innerHTML = filtered.map((s, idx) => {
        const isActive = s.id === activeStreamId;
        const title = s.title || `Stream ${idx + 1}`;
        const viewers = tabViewers(s);
        const uptime = formatUptime(s.started_at);
        const hasRs = !!rsRestream[s.id];
        const uptimeTag = uptime ? `<span class="live-tab-uptime"><i class="fa-solid fa-clock"></i> ${uptime}</span>` : '';
        const sep = idx > 0 ? '<span class="live-tab-separator" aria-hidden="true"></span>' : '';
        // RS icon only (the WEBRTC/RTMP protocol tag lives in the player's stats overlay now)
        const badgeSpan = hasRs ? `<span class="live-tab-badges"><i class="fa-solid fa-robot" style="color:#4fc3f7;font-size:0.62rem" title="RobotStreamer"></i></span>` : '';
        return `${sep}<button class="live-tab ${isActive ? 'active' : ''}"
                    onclick="switchToLiveStream('${esc(currentUsername)}', ${s.id}, this)"
                    data-stream-id="${s.id}" data-username="${esc(currentUsername)}"
                    role="tab" aria-selected="${isActive}" tabindex="${isActive ? '0' : '-1'}"
                    title="${esc(title)} — ${viewers} viewer${viewers !== 1 ? 's' : ''}${uptime ? ' — Live for ' + uptime : ''}">
            <span class="live-tab-dot"></span>
            <span class="live-tab-title">${esc(title)}</span>
            ${badgeSpan}
            <span class="live-tab-viewers"><i class="fa-solid fa-eye"></i> ${viewers}</span>
            ${uptimeTag}
        </button>`;
    }).join('') +
    `<span class="live-tabs-summary" title="${totalViewers} viewers across ${filtered.length} streams">
        <i class="fa-solid fa-tower-broadcast"></i> <strong>${filtered.length}</strong> streams &middot;
        <i class="fa-solid fa-eye"></i> <strong>${totalViewers}</strong> total
    </span>`;

    // Auto-scroll the active tab into view, but only when it actually changed. This render runs
    // on the 15-second channel poll (every 2 seconds during a go-live burst), and smooth-scrolling
    // the strip on every tick moved it under the reader's finger for no reason.
    const activeNow = document.querySelector('.live-tab.active')?.dataset.username || '';
    if (activeNow !== _lastScrolledTab) { _lastScrolledTab = activeNow; requestAnimationFrame(scrollActiveTabIntoView); }

    // Setup keyboard navigation (arrow keys between tabs)
    setupTabKeyboardNav(tabsScroll, currentUsername);
}

/**
 * Keyboard navigation for stream tabs — left/right arrows move between tabs.
 */
function setupTabKeyboardNav(container, username) {
    // Remove old listener if any
    if (container._tabKeyHandler) container.removeEventListener('keydown', container._tabKeyHandler);
    container._tabKeyHandler = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = Array.from(container.querySelectorAll('.live-tab'));
        if (!tabs.length) return;
        const currentIdx = tabs.findIndex(t => t === document.activeElement);
        if (currentIdx === -1) return;
        e.preventDefault();
        const nextIdx = e.key === 'ArrowRight'
            ? (currentIdx + 1) % tabs.length
            : (currentIdx - 1 + tabs.length) % tabs.length;
        tabs[currentIdx].setAttribute('tabindex', '-1');
        tabs[nextIdx].setAttribute('tabindex', '0');
        tabs[nextIdx].focus();
    };
    container.addEventListener('keydown', container._tabKeyHandler);
}

/**
 * Update cumulative viewer display below the video player.
 * Shows total viewers across all streams + external platforms, RS restream indicator, and share button.
 */
// ── Weather Widget ───────────────────────────────────────────
const WMO_WEATHER = {
    0: { label: 'Clear', icon: 'fa-sun', iconNight: 'fa-moon' },
    1: { label: 'Mostly Clear', icon: 'fa-sun', iconNight: 'fa-moon' },
    2: { label: 'Partly Cloudy', icon: 'fa-cloud-sun', iconNight: 'fa-cloud-moon' },
    3: { label: 'Overcast', icon: 'fa-cloud' },
    45: { label: 'Fog', icon: 'fa-smog' },
    48: { label: 'Rime Fog', icon: 'fa-smog' },
    51: { label: 'Light Drizzle', icon: 'fa-cloud-rain' },
    53: { label: 'Drizzle', icon: 'fa-cloud-rain' },
    55: { label: 'Heavy Drizzle', icon: 'fa-cloud-showers-heavy' },
    56: { label: 'Freezing Drizzle', icon: 'fa-icicles' },
    57: { label: 'Heavy Freezing Drizzle', icon: 'fa-icicles' },
    61: { label: 'Light Rain', icon: 'fa-cloud-rain' },
    63: { label: 'Rain', icon: 'fa-cloud-showers-heavy' },
    65: { label: 'Heavy Rain', icon: 'fa-cloud-showers-heavy' },
    66: { label: 'Freezing Rain', icon: 'fa-icicles' },
    67: { label: 'Heavy Freezing Rain', icon: 'fa-icicles' },
    71: { label: 'Light Snow', icon: 'fa-snowflake' },
    73: { label: 'Snow', icon: 'fa-snowflake' },
    75: { label: 'Heavy Snow', icon: 'fa-snowflake' },
    77: { label: 'Snow Grains', icon: 'fa-snowflake' },
    80: { label: 'Light Showers', icon: 'fa-cloud-rain' },
    81: { label: 'Showers', icon: 'fa-cloud-showers-heavy' },
    82: { label: 'Heavy Showers', icon: 'fa-cloud-showers-heavy' },
    85: { label: 'Light Snow Showers', icon: 'fa-snowflake' },
    86: { label: 'Heavy Snow Showers', icon: 'fa-snowflake' },
    95: { label: 'Thunderstorm', icon: 'fa-cloud-bolt' },
    96: { label: 'Thunderstorm w/ Hail', icon: 'fa-cloud-bolt' },
    99: { label: 'Thunderstorm w/ Heavy Hail', icon: 'fa-cloud-bolt' },
};

function getWeatherInfo(code, isDay = true) {
    const w = WMO_WEATHER[code] || { label: 'Unknown', icon: 'fa-cloud' };
    const icon = (!isDay && w.iconNight) ? w.iconNight : w.icon;
    return { label: w.label, icon };
}

function formatHour(isoTime, utcOffsetSec) {
    // Open-Meteo times are naive (no TZ) in the streamer's local timezone.
    // Append the streamer's UTC offset so JS parses them correctly,
    // then getHours() returns the viewer's local hour automatically.
    let d;
    if (utcOffsetSec != null) {
        const sign = utcOffsetSec >= 0 ? '+' : '-';
        const abs = Math.abs(utcOffsetSec);
        const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
        const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
        d = new Date(isoTime + sign + hh + ':' + mm);
    } else {
        d = new Date(isoTime);
    }
    const h = d.getHours();
    if (h === 0) return '12am';
    if (h === 12) return '12pm';
    return h > 12 ? `${h - 12}pm` : `${h}am`;
}

function isCurrentHour(isoTime, utcOffsetSec) {
    let d;
    if (utcOffsetSec != null) {
        const sign = utcOffsetSec >= 0 ? '+' : '-';
        const abs = Math.abs(utcOffsetSec);
        const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
        const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
        d = new Date(isoTime + sign + hh + ':' + mm);
    } else {
        d = new Date(isoTime);
    }
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate() && d.getHours() === now.getHours();
}

function windDir(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

let _channelWeatherData = null;

function getWeatherUnitPreference() {
    return localStorage.getItem('weather_unit') === 'c' ? 'c' : 'f';
}

function setWeatherUnitPreference(unit) {
    localStorage.setItem('weather_unit', unit === 'c' ? 'c' : 'f');
}

function weatherTemp(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    if (getWeatherUnitPreference() === 'c') {
        return `${Math.round((num - 32) * 5 / 9)}°C`;
    }
    return `${Math.round(num)}°F`;
}

function toggleWeatherUnit() {
    setWeatherUnitPreference(getWeatherUnitPreference() === 'f' ? 'c' : 'f');
    const widgets = [document.getElementById('ch-weather-widget'), document.getElementById('ch-weather-widget-offline')];
    if (!_channelWeatherData) return;
    const html = renderWeatherWidget(_channelWeatherData);
    widgets.forEach(w => {
        if (w) { w.innerHTML = html; w.style.display = ''; }
    });
}


function renderWeatherWidget(data) {
    const c = data.current;
    const w = getWeatherInfo(c.weather_code, c.is_day);
    const loc = data.location || {};
    const locStr = loc.name ? [loc.name, loc.region].filter(Boolean).join(', ') : '';
    const unit = getWeatherUnitPreference();

    let html = `<div class="weather-current">`;
    html += `<div class="weather-main">`;
    html += `<i class="fa-solid ${w.icon} weather-icon"></i>`;
    html += `<span class="weather-temp">${weatherTemp(c.temperature)}</span>`;
    html += `</div>`;
    html += `<div class="weather-details">`;
    html += `<div class="weather-topline"><span class="weather-condition">${w.label}</span><button type="button" class="weather-unit-toggle" onclick="toggleWeatherUnit()">°${unit === 'c' ? 'C' : 'F'}</button></div>`;
    if (locStr) html += `<span class="weather-location">${locStr}</span>`;
    html += `<span class="weather-meta">Feels ${weatherTemp(c.feels_like)} · ${c.humidity}% humidity · Wind ${Math.round(c.wind_speed)} mph ${windDir(c.wind_direction)}</span>`;
    html += `</div></div>`;

    const hasHourly = data.hourly && data.hourly.length > 0;
    const hasDaily = data.daily && data.daily.length > 0;

    // Tabs for hourly / 7-day
    if (hasHourly || hasDaily) {
        html += `<div class="weather-tabs">`;
        if (hasHourly) html += `<button type="button" class="weather-tab active" onclick="switchWeatherTab(this,'hourly')">Hourly</button>`;
        if (hasDaily) html += `<button type="button" class="weather-tab${hasHourly ? '' : ' active'}" onclick="switchWeatherTab(this,'daily')">7-Day</button>`;
        html += `</div>`;
    }

    // Hourly forecast
    if (hasHourly) {
        const utcOff = data.utc_offset_seconds;
        html += `<div class="weather-hourly weather-tab-panel" data-panel="hourly">`;
        html += `<div class="weather-hourly-scroll">`;
        for (const h of data.hourly) {
            const hw = getWeatherInfo(h.weather_code, true);
            const isCurrent = isCurrentHour(h.time, utcOff);
            const timeLabel = isCurrent ? 'Now' : formatHour(h.time, utcOff);
            html += `<div class="weather-hour${isCurrent ? ' wh-now' : ''}" title="${hw.label}, ${weatherTemp(h.temperature)}, ${h.precipitation_probability}% precip, Wind ${Math.round(h.wind_speed)} mph">`;
            html += `<span class="wh-time">${timeLabel}</span>`;
            html += `<i class="fa-solid ${hw.icon} wh-icon"></i>`;
            html += `<span class="wh-temp">${weatherTemp(h.temperature).replace(/°[CF]$/, '°')}</span>`;
            if (h.precipitation_probability > 0) {
                html += `<span class="wh-precip"><i class="fa-solid fa-droplet"></i> ${h.precipitation_probability}%</span>`;
            }
            if (data.detail === 'detailed' && h.uv_index !== undefined) {
                html += `<span class="wh-extra">${Math.round(h.wind_speed)} mph`;
                if (h.wind_gusts > h.wind_speed + 5) html += ` (${Math.round(h.wind_gusts)})`;
                html += `</span>`;
            }
            html += `</div>`;
        }
        html += `</div></div>`;
    }

    // 7-day daily forecast
    if (hasDaily) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        html += `<div class="weather-daily weather-tab-panel" data-panel="daily"${hasHourly ? ' style="display:none"' : ''}>`;
        for (const d of data.daily) {
            const dw = getWeatherInfo(d.weather_code, true);
            const date = new Date(d.date + 'T12:00:00');
            const isToday = new Date().toDateString() === date.toDateString();
            const dayLabel = isToday ? 'Today' : dayNames[date.getDay()];
            html += `<div class="weather-day" title="${dw.label}, High ${weatherTemp(d.temp_max)}, Low ${weatherTemp(d.temp_min)}">`;
            html += `<span class="wd-day">${dayLabel}</span>`;
            html += `<i class="fa-solid ${dw.icon} wd-icon"></i>`;
            html += `<span class="wd-temps"><span class="wd-hi">${weatherTemp(d.temp_max).replace(/°[CF]$/, '°')}</span><span class="wd-lo">${weatherTemp(d.temp_min).replace(/°[CF]$/, '°')}</span></span>`;
            if (d.precipitation_probability > 0) {
                html += `<span class="wd-precip"><i class="fa-solid fa-droplet"></i> ${d.precipitation_probability}%</span>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    }

    return html;
}

function switchWeatherTab(btn, panel) {
    const widget = btn.closest('.weather-widget, [id^="ch-weather-widget"]') || btn.parentElement.parentElement;
    widget.querySelectorAll('.weather-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    widget.querySelectorAll('.weather-tab-panel').forEach(p => {
        p.style.display = p.dataset.panel === panel ? '' : 'none';
    });
}

function updateCumulativeViewers(liveStreams, rsRestream = {}, restreamLinks = null, externalViewers = null) {
    // Cache stream-id → slot title so the floating chat widget can label each message
    // with which stream slot it came from.
    window._fcwStreamLabels = window._fcwStreamLabels || {};
    for (const s of (liveStreams || [])) {
        if (s && s.id) window._fcwStreamLabels[s.id] = s.title || `Stream #${s.id}`;
    }

    const el = document.getElementById('ch-cumulative-viewers');
    if (!el) return;

    const hasRs = Object.keys(rsRestream).length > 0;
    const hasRestream = restreamLinks?.length > 0;
    const hasExternal = externalViewers && externalViewers.total > 0;
    const hasMultiStream = liveStreams.length > 1;
    // Whether live tabs are already showing multi-stream summary
    const tabsVisible = document.getElementById('live-stream-tabs')?.style.display !== 'none';

    if (liveStreams.length < 1 && !hasRs && !hasRestream && !hasExternal) {
        el.style.display = 'none';
        return;
    }

    const hsTotal = liveStreams.reduce((sum, s) => sum + (s.viewer_count || 0), 0);
    const externalTotal = externalViewers?.total || 0;   // channel-wide (cumulative line only)
    const combinedTotal = hsTotal + externalTotal;
    const streamCount = liveStreams.length;

    // The stream slot actually being watched — its counts/links drive the main badge.
    const watched = liveStreams.find(s => String(s.id) === String(typeof currentStreamId !== 'undefined' ? currentStreamId : ''))
        || liveStreams[0] || null;
    const watchedMsId = watched?.managed_stream_id ?? null;
    const watchedNative = watched?.viewer_count || 0;
    const watchedExternal = watched?.external_viewer_count || 0;

    // Cache the WATCHED slot's external count so the live WS update adds the right number.
    _cachedExternalViewerCount = watchedExternal;
    // Main viewer badge = this slot's native + this slot's restream viewers.
    const vcEl = document.getElementById('vc-viewers');
    if (vcEl) {
        const bestHs = Math.max(_cachedHsViewerCount || 0, watchedNative);
        vcEl.textContent = bestHs + watchedExternal;
    }

    let html = '';

    // Show combined viewer total — but skip when live tabs already show per-stream counts
    if ((streamCount > 1 || hasExternal) && !tabsVisible) {
        const totalLabel = hasExternal ? 'total' : '';
        html += `<span class="ch-viewer-total"><i class="fa-solid fa-layer-group"></i> <strong>${combinedTotal}</strong> viewer${combinedTotal !== 1 ? 's' : ''} ${totalLabel}${streamCount > 1 ? ` across <strong>${streamCount}</strong> streams` : ''}</span>`;
    }

    // OpenVibe.Live-native viewer badge — styled like the platform restream badges, in brand
    // green, so it reads as "this is the count HERE" alongside the RS/Twitch/etc badges.
    if (liveStreams.length > 0) {
        html += `<span class="ch-restream-badge" style="color:var(--accent)" title="Watching live on OpenVibe.Live${streamCount > 1 ? ` (across ${streamCount} streams)` : ''}"><span class="ov-mark" data-size="14" data-static="1"></span> OV <i class="fa-solid fa-eye" style="font-size:0.75em"></i> ${hsTotal}</span>`;
    }

    // RS restream badge — reflect the WATCHED slot's robot only (not the first slot's).
    const rsWatched = (watched && rsRestream[watched.id] && rsRestream[watched.id].active) ? rsRestream[watched.id] : null;
    if (rsWatched) {
        const rsViewers = rsWatched.viewer_count || 0;
        const viewerStr = rsViewers > 0 ? ` · <i class="fa-solid fa-eye" style="font-size:0.75em"></i> ${rsViewers}` : '';
        if (rsWatched.robot_id) {
            const rsUrl = `https://robotstreamer.com/robot/${esc(rsWatched.robot_id)}`;
            html += `<a href="${rsUrl}" target="_blank" rel="noopener" class="ch-rs-badge" title="Also live on RobotStreamer${rsWatched.robot_name ? ': ' + esc(rsWatched.robot_name) : ''}${rsViewers ? ' (' + rsViewers + ' viewers)' : ''}"><i class="fa-solid fa-robot"></i> RS${viewerStr}</a>`;
        } else {
            html += `<span class="ch-rs-badge" title="Also live on RobotStreamer"><i class="fa-solid fa-robot"></i> RS${viewerStr}</span>`;
        }
    }

    // Restream platform link badges (Twitch/Kick/YouTube) — only for the WATCHED slot,
    // so links point at the platform channel for the stream you're actually watching.
    const watchedLinks = hasRestream
        ? restreamLinks.filter(l => (l.managed_stream_id ?? null) === watchedMsId)
        : [];
    if (watchedLinks.length > 0) {
        const platformIcons = { twitch: 'fa-brands fa-twitch', kick: 'fa-brands fa-kickstarter-k', youtube: 'fa-brands fa-youtube', custom: 'fa-solid fa-globe' };
        const platformColors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', custom: '#888' };
        for (const link of watchedLinks) {
            const icon = platformIcons[link.platform] || platformIcons.custom;
            const color = platformColors[link.platform] || platformColors.custom;
            const liveDot = link.is_live ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e91916;margin-right:4px;animation:pulse-live 1.5s infinite"></span>' : '';
            const name = esc(link.name || link.platform);
            // Show viewer count: real count when available, 0 when live but no data, hidden when offline
            const vc = link.viewer_count != null ? link.viewer_count : (link.is_live ? 0 : null);
            const viewerStr = vc != null ? ` · <i class="fa-solid fa-eye" style="font-size:0.75em"></i> ${vc}` : '';
            // YouTube: link straight to the live stream (channel/@handle + /live).
            let href = link.channel_url || '';
            if (link.platform === 'youtube' && href && !/\/live\/?$/.test(href) && !/[?&]v=/.test(href)) {
                href = href.replace(/\/+$/, '') + '/live';
            }
            html += `<a href="${esc(href)}" target="_blank" rel="noopener" class="ch-restream-badge" style="color:${color}" title="${link.is_live ? 'Live on' : 'Also on'} ${name}${vc != null ? ' (' + vc + ' viewers)' : ''}">${liveDot}<i class="${icon}"></i> ${name}${viewerStr}</a>`;
        }
    }

    // Share button (copies stream-specific URL)
    if (streamCount > 1) {
        html += `<button class="ch-share-stream" onclick="shareStreamUrl()" title="Copy link to this specific stream"><i class="fa-solid fa-link"></i> Share stream</button>`;
    }

    if (html) {
        el.innerHTML = html;
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}

/**
 * Switch to a different live stream within the same channel.
 * Shows loading overlay, destroys current player, fetches fresh data, initializes new stream.
 */
function switchToLiveStream(username, streamId, btn) {
    // If switching to a different channel, navigate there with stream preference
    if (username !== currentChannelUsername) {
        // When navigating to a different channel, we don't know the managed stream ref from here
        // so just navigate to the channel; the channel page will pick the right stream
        navigate(channelPath(username));
        return;
    }

    // Don't re-switch to the already active stream
    if (streamId === currentStreamId) return;

    // Guard against overlapping fast switches: only the latest one may apply its
    // result, so a slow fetch from an earlier click can't clobber the new player.
    const myToken = ++_streamSwitchToken;

    // Update tab UI immediately — highlight the target tab
    const tabsScroll = document.getElementById('live-tabs-scroll');
    if (tabsScroll) {
        tabsScroll.querySelectorAll('.live-tab').forEach(t => {
            const isTarget = parseInt(t.dataset.streamId) === streamId;
            t.classList.toggle('active', isTarget);
            t.setAttribute('aria-selected', String(isTarget));
            t.setAttribute('tabindex', isTarget ? '0' : '-1');
        });
    }
    if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    // Show loading overlay
    showStreamSwitchOverlay(true);

    // Destroy current player before fetching the new stream
    if (typeof destroyPlayer === 'function') destroyPlayer();

    // Fetch the full stream data (with endpoint info) from the /channel API
    api(`/streams/channel/${username}`).then(data => {
        // A newer switch superseded this one — drop the stale result.
        if (myToken !== _streamSwitchToken) return;
        const streams = data.streams || [];
        const target = streams.find(s => s.id === streamId && s.is_live);
        if (target) {
            activateChannelStream(target);
            // Push a history entry so Back returns to the previous slot.
            const msRef = target.managed_stream_slug || target.managed_stream_id || null;
            history.pushState({ streamHop: true, streamId }, '', channelPath(username, msRef));
            // Remember for return visits
            rememberLastStream(username, streamId);
            // Update cumulative viewers with fresh data
            const liveStreams = streams.filter(s => s && s.is_live);
            updateCumulativeViewers(liveStreams, data.rs_restream || {}, data.restream_links || null, data.external_viewers || null);
            // Refresh tabs with latest viewer counts
            loadLiveStreamTabs(username, streamId, liveStreams, data.rs_restream || {});
        } else {
            toast('Stream is no longer live', 'error');
        }
    }).catch(() => { if (myToken === _streamSwitchToken) toast('Failed to load stream', 'error'); })
      .finally(() => { if (myToken === _streamSwitchToken) showStreamSwitchOverlay(false); });
}

function activateChannelStream(stream) {
    // NSFW age gate — block player init until viewer confirms
    if (stream.is_nsfw && !sessionStorage.getItem('nsfw-ok-stream-' + stream.id)) {
        currentStreamId = stream.id;
        currentStreamData = stream;
        document.getElementById('ch-stream-title').textContent = stream.title || 'Untitled Stream';
        const container = document.getElementById('video-container');
        if (container) {
            const existingGate = container.querySelector('#stream-nsfw-gate-overlay');
            if (existingGate) existingGate.remove();

            container.classList.add('nsfw-gated');

            const gate = document.createElement('div');
            gate.id = 'stream-nsfw-gate-overlay';
            gate.className = 'stream-nsfw-gate-overlay';
            gate.innerHTML = `
                <div class="stream-nsfw-gate-card">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <h2>NSFW Content (18+)</h2>
                    <p>This stream has been marked as containing content that may not be suitable for all audiences. You must be 18 or older to view.</p>
                    <div class="stream-nsfw-gate-actions">
                        <button class="btn btn-outline" id="nsfw-stream-back-btn">Go Back</button>
                        <button class="btn btn-primary" id="nsfw-stream-continue-btn">I'm 18+ - Continue</button>
                    </div>
                </div>`;
            container.appendChild(gate);

            const backBtn = gate.querySelector('#nsfw-stream-back-btn');
            const continueBtn = gate.querySelector('#nsfw-stream-continue-btn');
            if (backBtn) backBtn.addEventListener('click', () => navigate('/'));
            if (continueBtn) {
                continueBtn.addEventListener('click', () => {
                    sessionStorage.setItem('nsfw-ok-stream-' + stream.id, '1');
                    gate.remove();
                    container.classList.remove('nsfw-gated');
                    activateChannelStream(stream);
                });
            }

            if (typeof destroyPlayer === 'function') {
                try { destroyPlayer(); } catch { /* ignore */ }
            }
            startStreamStatusPoll(stream);
        }
        return;
    }

    const container = document.getElementById('video-container');
    if (container) {
        const existingGate = container.querySelector('#stream-nsfw-gate-overlay');
        if (existingGate) existingGate.remove();
        container.classList.remove('nsfw-gated');
    }

    // Avoid no-op reactivation of same stream (prevents double-init bugs)
    const isSameStream = currentStreamId === stream.id;
    currentStreamId = stream.id;
    currentStreamData = stream;
    document.getElementById('ch-stream-title').textContent = stream.title || 'Untitled Stream';
    setPageTitle(`${stream.title || 'Live'} — ${stream.display_name || stream.username || ''}`.trim());
    // Category pill reflects THIS live slot's category (set in /broadcast), not the
    // channel's stale default.
    if (stream.category) _setCategoryBadge(document.getElementById('ch-category-badge'), stream.category, _isInferredCategory(stream));
    // Stream-type badge only (Screen Share / Audio Only / Camera). The WEBRTC/RTMP
    // protocol tag was removed from the header — that info now lives in the player's
    // stats overlay, which is more useful than the raw transport for viewers.
    const chProtoEl = document.getElementById('ch-protocol-badge');
    if (chProtoEl) chProtoEl.innerHTML = streamTypeBadge(stream.browser_mode, stream.streaming_method);

    // Mic-only audio overlay for viewers
    _updateMicOnlyOverlay(stream.browser_mode, stream.streaming_method);

    // Description on live channel page
    const chDescEl = document.getElementById('ch-stream-description');
    if (chDescEl) {
        const desc = stream.description || '';
        chDescEl.textContent = desc;
        chDescEl.style.display = desc ? '' : 'none';
    }
    // Live AI overview of this stream (rolling summary of its memories). Refreshed
    // from the 15s status poll — see startStreamStatusPoll.
    _renderChStreamAi(stream.ai_overview, stream.ai_overview_short);
    // Always destroy before init to prevent stale player state
    if (typeof destroyPlayer === 'function') {
        try { destroyPlayer(); } catch (e) { console.warn('[Player] destroy failed', e); }
    }
    if (typeof initPlayer === 'function') {
        try {
            initPlayer(stream);
        } catch (e) {
            console.error('[Player] init failed', e);
        }
    }
    if (typeof initChat === 'function') initChat(stream.id, stream.user_id || _activeChannelUserId);
    if (typeof loadStreamControls === 'function') loadStreamControls(stream.id);
    if (typeof startCoinHeartbeat === 'function') startCoinHeartbeat(stream.id);
    if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(stream.user_id);
    startUptime(stream.started_at);

    // Start polling for stream status changes
    startStreamStatusPoll(stream);
}
const STREAM_POLL_INTERVAL = 15000; // 15 seconds
// After the player reports the stream ended (or we otherwise know the channel just
// flipped state), poll far more aggressively for a short window. A streamer who
// bounces offline→online in a couple of seconds would otherwise leave viewers
// parked on the "Stream has ended" card for up to 2 × STREAM_POLL_INTERVAL: one
// interval for the live poll to notice the stream died, another for the offline
// poll to notice it came back.
const STREAM_POLL_FAST_INTERVAL = 2000;

function stopStreamStatusPoll() {
    if (_streamPollTimer) { clearInterval(_streamPollTimer); _streamPollTimer = null; }
    _streamPollFast = false;
}

/**
 * Currently-desired poll cadence — fast while inside the burst window. The fast
 * cadence carries per-client jitter so that when a popular channel drops, its
 * waiting viewers don't all hit the endpoint on the same 2s beat.
 */
function _streamPollInterval() {
    if (Date.now() >= _streamPollFastUntil) return STREAM_POLL_INTERVAL;
    return STREAM_POLL_FAST_INTERVAL + Math.floor(Math.random() * 1500);
}

// Render/update the live stream's AI overview under the stream info. Only re-renders
// when the text actually changes, so it never clobbers a viewer's expanded state.
function _renderChStreamAi(overview, short) {
    const el = document.getElementById('ch-stream-ai');
    if (!el) return;
    const longTxt = (overview || '').trim();
    const shortTxt = (short || '').trim() || longTxt;
    const key = shortTxt + '|' + longTxt;
    if (el.dataset.ai === key) return;
    el.dataset.ai = key;
    const html = _cardAiHTML(shortTxt, longTxt);
    el.innerHTML = html;
    el.style.display = html ? '' : 'none';
}

// ── Channel below-fold tabs ──────────────────────────────────
let _channelTab = 'videos';
function switchChannelTab(tab, btn) {
    _channelTab = tab;
    document.querySelectorAll('#ch-tabs .ch-tab').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.ch-tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('ch-panel-' + tab);
    if (panel) panel.classList.add('active');
    // Lazy-load the fetched-separately tabs the first time they're opened.
    if (tab === 'analytics' && currentChannelUsername && !_chTabLoaded.analytics) {
        _chTabLoaded.analytics = true;
        try { loadChannelAnalytics(currentChannelUsername, _chAnalyticsDays || 7); } catch {}
    }
    if (tab === 'pastes' && currentChannelUsername && !_chTabLoaded.pastes) {
        _chTabLoaded.pastes = true;
        try { loadChannelPastes(currentChannelUsername); _startChannelPastesAutoRefresh(currentChannelUsername); } catch {}
    }
    if (tab === 'clips-taken' && currentChannelUsername && !_chTabLoaded.clipsTaken) {
        _chTabLoaded.clipsTaken = true;
        try { loadClipsTaken(currentChannelUsername, { reset: true }); } catch {}
    }
    if (tab === 'ai-timeline' && currentChannelUsername && !_chTabLoaded.aiTimeline) {
        _chTabLoaded.aiTimeline = true;
        try { loadChannelAiTimeline(currentChannelUsername); } catch {}
    }
    // Media queue changes constantly — reload every time the tab opens.
    if (tab === 'media' && currentChannelUsername) {
        try { loadChannelMedia(currentChannelUsername); } catch {}
    }
}

// A URL hash like #ai-timeline / #about / #videos auto-opens that channel tab on load and
// scrolls the tab content into view (used by "view full AI timeline" links, deep links, etc.).
const CHANNEL_TAB_HASHES = ['about', 'videos', 'clips', 'clips-taken', 'pastes', 'media', 'analytics', 'ai-timeline'];
function _applyChannelHashTab() {
    const h = (location.hash || '').replace(/^#/, '').toLowerCase();
    if (!h || !CHANNEL_TAB_HASHES.includes(h)) return;
    const btn = document.querySelector(`#ch-tabs .ch-tab[data-tab="${h}"]`);
    if (!btn || btn.style.display === 'none') return; // tab hidden / not present for this channel
    switchChannelTab(h, btn);
    // Jump to the tab strip once the panel has had a beat to render its content.
    setTimeout(() => {
        (document.getElementById('ch-tabs') || document.getElementById('ch-panel-' + h))
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
}
let _chTabLoaded = {};
let _chAnalyticsDays = 7;
// Does this channel have written About content (bio or panels)?
function _channelHasBio(ch) {
    if (!ch) return false;
    const bio = (ch.bio || ch.description || '').trim();
    let panels = [];
    try { panels = typeof ch.panels === 'string' ? JSON.parse(ch.panels || '[]') : (ch.panels || []); } catch { panels = []; }
    return !!bio || (Array.isArray(panels) && panels.length > 0);
}
// Effective visibility of the About-tab AI overview. 'auto' (default) shows it ONLY when the
// streamer hasn't written a bio/About yet; 'show' always; 'hide' never.
function _effAiOverviewShow(ch) {
    if (!ch || !ch.ai_overview) return false;
    const pref = ch.ai_overview_pref || (ch.hide_ai_overview ? 'hide' : 'auto');
    if (pref === 'show') return true;
    if (pref === 'hide') return false;
    return !_channelHasBio(ch); // auto
}

// About tab visibility + default open tab depend on whether the streamer has any
// About content (bio/panels) or weather enabled.
function _resetChannelTabs(ch) {
    _chTabLoaded = {};
    let hasAbout = false;
    if (ch) {
        const bio = (ch.bio || ch.description || '').trim();
        let panels = [];
        try { panels = typeof ch.panels === 'string' ? JSON.parse(ch.panels || '[]') : (ch.panels || []); } catch { panels = []; }
        hasAbout = !!bio || (Array.isArray(panels) && panels.length > 0);
    }
    // The AI overview at the top of About also counts as About content, so the tab shows
    // even when the streamer hasn't written a bio (per the auto/show/hide preference).
    const hasAiOverview = _effAiOverviewShow(ch);
    // Anyone who can edit (the streamer, or a mod the streamer allowed) always sees
    // the About tab — even when empty + hidden for everyone else — so they can set it up.
    const canEdit = !!(ch && ch.viewer_can_edit_about);
    const showAbout = hasAbout || hasAiOverview || canEdit;
    const aboutBtn = document.getElementById('ch-tab-btn-about');
    if (aboutBtn) aboutBtn.style.display = showAbout ? '' : 'none';
    // Pencil edit button on the About tab — only for people who can edit.
    const aboutEditBtn = document.getElementById('ch-tab-about-edit');
    if (aboutEditBtn) aboutEditBtn.style.display = canEdit ? '' : 'none';
    // Default to About when it has real content (bio/panels or a shown AI overview).
    const defTab = (hasAbout || hasAiOverview) ? 'about' : 'videos';
    switchChannelTab(defTab, document.querySelector(`#ch-tabs .ch-tab[data-tab="${defTab}"]`));
    // Media tab starts hidden; revealed by _initMediaRequestTab when applicable.
    // (Controls are no longer a tab — they render in a section under the player.)
    const medBtn = document.getElementById('ch-tab-btn-media');
    if (medBtn) medBtn.style.display = 'none';
}

// ── AI Timeline tab ───────────────────────────────────────────────
// The streamer's whole AI-observed history: overall AI overview + every session's AI
// overview + captured "moments" that deep-link into the VOD at the exact timestamp.
function _aiTimeFmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function _aiTimelineMomentHTML(mom, vodId) {
    const off = mom.offset_seconds || 0;
    const stamp = _aiTimeFmt(off);
    const desc = esc(mom.description || '');
    let tags = [];
    try { tags = typeof mom.tags === 'string' ? JSON.parse(mom.tags) : (mom.tags || []); } catch { tags = []; }
    const tagHTML = (Array.isArray(tags) ? tags : []).slice(0, 4)
        .map(t => `<span class="ai-tl-tag">${esc(String(t))}</span>`).join('');
    // Older moments point at the rotating live thumbnail, which is gone (the server answers
    // those with a placeholder pixel, so onerror never fires and a white box appears).
    // Newer moments carry their own persisted frame under /data/ai-moments/.
    const thumbUrl = (mom.thumbnail_url && !/\/api\/thumbnails\/stream-/.test(mom.thumbnail_url)) ? mom.thumbnail_url : '';
    const thumb = thumbUrl
        ? `<img class="ai-tl-moment-thumb" src="${esc(thumbUrl)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
    const jump = vodId
        ? `<a class="ai-tl-stamp" href="/vod/${vodId}?t=${off}" onclick="return handleLinkClick(event, '/vod/${vodId}?t=${off}')" title="Watch this moment"><i class="fa-solid fa-play"></i> ${stamp}</a>`
        : `<span class="ai-tl-stamp ai-tl-stamp--novod" title="No VOD available for this moment"><i class="fa-solid fa-clock"></i> ${stamp}</span>`;
    return `<div class="ai-tl-moment">${thumb}<div class="ai-tl-moment-body">${jump}<div class="ai-tl-moment-desc">${desc}</div>${tagHTML ? `<div class="ai-tl-tags">${tagHTML}</div>` : ''}</div></div>`;
}

let _aiTl = null; // AI Timeline pagination state (per channel load)

// A collapsible AI-overview body — long ones clamp with a fade + "Show more" toggle.
// Shared by the AI Timeline tab and the About tab.
function _collapsibleOverview(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (t.length <= 320) return `<div class="ai-ov-text">${esc(t)}</div>`;
    return `<div class="ai-ov-collapse"><div class="ai-ov-text ai-ov-clamped">${esc(t)}</div><button type="button" class="ai-ov-toggle" onclick="_toggleOverview(this)">Show more <i class="fa-solid fa-chevron-down"></i></button></div>`;
}
function _toggleOverview(btn) {
    const box = btn.previousElementSibling;
    if (!box) return;
    const open = box.classList.toggle('ai-ov-expanded');
    box.classList.toggle('ai-ov-clamped', !open);
    btn.innerHTML = open ? 'Show less <i class="fa-solid fa-chevron-up"></i>' : 'Show more <i class="fa-solid fa-chevron-down"></i>';
}
window._toggleOverview = _toggleOverview;

// Short AI-generated session title (streamers reuse the same literal title). Generated in the
// background server-side and stored on the session; fall back to the real stream title.
function _aiSessionTitle(s) {
    const t = (s.ai_title || '').trim();
    return t || null;
}

function _aiTimelineSessionHTML(s) {
    const when = s.started_at || s.created_at;
    const dateStr = when ? new Date((String(when).includes('T') ? when : when.replace(' ', 'T') + 'Z')).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const ov = (s.ai_overview || s.ai_overview_short || '').trim();
    const memCount = s.memory_count != null ? s.memory_count : (Array.isArray(s.memories) ? s.memories.length : 0);
    const _vodHref = s.vod_id ? `/vod/${s.vod_id}` : null;
    const _asLink = (label) => _vodHref ? `<a href="${_vodHref}" onclick="return handleLinkClick(event, '${_vodHref}')">${label}</a>` : label;
    const aiTitle = _aiSessionTitle(s);
    const mainTitle = aiTitle ? _asLink(esc(aiTitle)) : _asLink(esc(s.title || 'Untitled stream'));
    const meta = [];
    // Stream-title → VOD link leads the meta row (only when the heading is an AI title, so it's
    // not a duplicate of the heading). Rendered inline for every item incl. lazy-loaded ones.
    if (aiTitle && _vodHref) meta.push(`<a class="ai-tl-session-vodlink" href="${_vodHref}" onclick="return handleLinkClick(event, '${_vodHref}')"><i class="fa-solid fa-film"></i> ${esc(s.title || 'stream')}</a>`);
    if (dateStr) meta.push(`<i class="fa-solid fa-calendar-day"></i> ${dateStr}`);
    if (s.duration_seconds) meta.push(`<i class="fa-solid fa-hourglass-half"></i> ${_aiTimeFmt(s.duration_seconds)}`);
    if (s.peak_viewers) meta.push(`<i class="fa-solid fa-eye"></i> ${s.peak_viewers} peak`);
    // Stash moments for lazy DOM build on expand — keeps thousands of moments OUT of the DOM.
    if (_aiTl && Array.isArray(s.memories)) { _aiTl.moments[s.id] = s.memories; _aiTl.vodBySid[s.id] = s.vod_id || null; }
    const momentsBtn = memCount
        ? `<button type="button" class="ai-tl-moments-toggle" onclick="_aiTlToggleMoments(this)"><i class="fa-solid fa-chevron-right"></i> <span>${memCount} moment${memCount === 1 ? '' : 's'}</span></button>`
        : '';
    // Transcript button (word count) — loads the audio transcription on demand.
    const transcriptBtn = (s.has_transcript && s.word_count)
        ? `<button type="button" class="ai-tl-moments-toggle ai-tl-transcript-toggle" data-sid="${s.id}" data-vod="${s.vod_id || ''}" onclick="_aiTlToggleTranscript(this)"><i class="fa-solid fa-closed-captioning"></i> <span>${_fmtCount(s.word_count)} words</span></button>`
        : '';
    return `<div class="ai-tl-session" data-sid="${s.id}">
        <div class="ai-tl-session-head">
            <div class="ai-tl-node"></div>
            <div class="ai-tl-session-title">${mainTitle}</div>
            <div class="ai-tl-session-meta">${meta.join('<span class="ai-tl-dot">·</span>')}</div>
        </div>
        ${ov ? `<div class="ai-tl-session-overview">${esc(ov)}</div>` : ''}
        <div class="ai-tl-session-actions">${momentsBtn}${transcriptBtn}</div>
        <div class="ai-tl-moments" hidden></div>
        <div class="ai-tl-transcript" hidden></div>
    </div>`;
}
// Map the audio model's many labels onto a few readable families with an icon. Returns
// null for labels that are speech-like or pure noise — those are not "sounds" worth a chip.
const _AI_SOUND_FAMILIES = [
    { key: 'rain',      icon: 'fa-cloud-rain',      label: 'Rain',        re: /rain|drizzle|water|drip|splash|stream|river/i },
    { key: 'thunder',   icon: 'fa-bolt',            label: 'Thunder',     re: /thunder/i },
    { key: 'wind',      icon: 'fa-wind',            label: 'Wind',        re: /wind|breeze|rustl/i },
    { key: 'music',     icon: 'fa-music',           label: 'Music',       re: /music|song|guitar|piano|drum|synth|beat|melody|singing|choir|hip hop|rock|jazz|techno|electronic/i },
    { key: 'laugh',     icon: 'fa-face-laugh',      label: 'Laughter',    re: /laugh|giggle|chuckle|snicker/i },
    { key: 'explosion', icon: 'fa-burst',           label: 'Explosion',   re: /explos|gunshot|gunfire|blast|boom|artillery|fireworks/i },
    { key: 'vehicle',   icon: 'fa-car',             label: 'Vehicle',     re: /vehicle|car\b|engine|motor|truck|bus|traffic|boat|train|aircraft|helicopter|siren/i },
    { key: 'animal',    icon: 'fa-paw',             label: 'Animal',      re: /dog|cat|bird|animal|bark|meow|chirp|insect|cricket|goose|duck|cow|horse/i },
    { key: 'keys',      icon: 'fa-keyboard',        label: 'Clicks & keys', re: /typing|keyboard|click|mouse|keys|jangl|tick|tap/i },
    { key: 'alarm',     icon: 'fa-bell',            label: 'Alarm / ding', re: /alarm|beep|ding|bell|ring|notification|chime/i },
    { key: 'crowd',     icon: 'fa-people-group',    label: 'Crowd',       re: /crowd|applause|cheer|chatter|hubbub/i },
    { key: 'kitchen',   icon: 'fa-utensils',        label: 'Kitchen',     re: /siz{1,2}l|fry|boil|cutlery|dish|kitchen|microwave|blender|chop/i },
    { key: 'tools',     icon: 'fa-screwdriver-wrench', label: 'Tools',    re: /drill|hammer|saw|tool|grind|sand|screw|crackl|rattle|clank|clink|chink|metal/i },
    { key: 'breath',    icon: 'fa-lungs',           label: 'Breath / sigh', re: /sigh|breath|gasp|yawn|cough|sneeze|snif/i },
    { key: 'door',      icon: 'fa-door-open',       label: 'Doors & steps', re: /door|footstep|walk|knock|creak/i },
    { key: 'game',      icon: 'fa-gamepad',         label: 'Game audio',  re: /video game|game|sound effect|whoosh|swoosh|zap|arcade/i },
];
function _aiSoundFamily(label) {
    const l = String(label || '').trim();
    if (!l || /^(speech|conversation|narration|monologue|male speech|female speech|child speech|silence|noise|white noise|static|hum|inside|outside|room)/i.test(l)) return null;
    for (const f of _AI_SOUND_FAMILIES) if (f.re.test(l)) return { key: f.key, icon: f.icon, label: f.label };
    return { key: 'other', icon: 'fa-volume-high', label: l.length > 28 ? l.slice(0, 26) + '…' : l };
}

// Expand/collapse a session's moments, building the moment DOM only on first expand.
function _aiTlToggleMoments(btn) {
    const session = btn.closest('.ai-tl-session');
    const box = session?.querySelector('.ai-tl-moments');
    if (!session || !box) return;
    if (!box.hidden) { box.hidden = true; btn.classList.remove('open'); return; }
    if (!box.dataset.built) {
        const sid = session.dataset.sid;
        const mems = (_aiTl && _aiTl.moments[sid]) || [];
        box.innerHTML = mems.map(m => _aiTimelineMomentHTML(m, _aiTl && _aiTl.vodBySid[sid])).join('') || '<p class="muted" style="padding:6px">No moment details.</p>';
        box.dataset.built = '1';
    }
    box.hidden = false; btn.classList.add('open');
}

// Expand/collapse a session's audio transcript, fetched on demand. Each segment deep-links
// to the VOD at that moment's timestamp.
async function _aiTlToggleTranscript(btn) {
    const session = btn.closest('.ai-tl-session');
    const box = session?.querySelector('.ai-tl-transcript');
    if (!session || !box) return;
    if (!box.hidden) { box.hidden = true; btn.classList.remove('open'); return; }
    box.hidden = false; btn.classList.add('open');
    if (!box.dataset.built) {
        box.dataset.built = '1';
        box.innerHTML = '<div class="loading" style="padding:8px"><i class="fa-solid fa-spinner fa-spin"></i> Loading transcript…</div>';
        try {
            const data = await api(`/chat-ai/transcript/${session.dataset.sid}`);
            const segs = data.segments || [];
            const vod = data.vodId;
            // Speech and detected sounds are different things: speech reads as lines, sounds
            // as a quiet strip of chips between them (grouped, deduplicated, family-merged —
            // "Rain / Raindrop / Rain on surface / Water" is one "Rain" chip, not four rows).
            const rows = [
                ...segs.map(sg => ({ t: sg.start || 0, kind: 'speech', text: String(sg.text || '').replace(/^\s*(?:>>|--?|•)\s*/, '').trim() })).filter(r => r.text),
                ...(data.events || []).map(e => ({ t: e.start_sec || 0, kind: 'sound', label: String(e.label || ''), conf: Number(e.confidence) || 0 })),
            ].sort((a, b) => a.t - b.t);
            if (!rows.length) { box.innerHTML = '<p class="muted" style="padding:6px">No transcript available.</p>'; return; }
            const blocks = [];
            for (const r of rows) {
                if (r.kind === 'speech') { blocks.push(r); continue; }
                const fam = _aiSoundFamily(r.label);
                if (!fam) continue;                          // speech-like / noise labels are not "sounds"
                if (r.conf && r.conf < 0.3) continue;        // too unsure to show
                const last = blocks[blocks.length - 1];
                if (last && last.kind === 'sounds') {
                    const hit = last.items.find(i => i.key === fam.key);
                    if (hit) { hit.n++; hit.conf = Math.max(hit.conf, r.conf); } else last.items.push({ ...fam, n: 1, conf: r.conf, t: r.t });
                    last.tEnd = r.t;
                } else blocks.push({ kind: 'sounds', t: r.t, tEnd: r.t, items: [{ ...fam, n: 1, conf: r.conf, t: r.t }] });
            }
            const nSpeech = blocks.filter(b => b.kind === 'speech').length, nSound = blocks.filter(b => b.kind === 'sounds').length;
            const cov = data.coverageSec ? `${_aiTimeFmt(data.coverageSec)} of speech transcribed` : '';
            const jumpFor = (t, cls = 'ai-tl-ts') => vod ? `<a class="${cls}" href="/vod/${vod}?t=${Math.floor(t)}" onclick="return handleLinkClick(event, '/vod/${vod}?t=${Math.floor(t)}')" title="Watch from here">${_aiTimeFmt(t)}</a>` : `<span class="${cls}">${_aiTimeFmt(t)}</span>`;
            const toolbar = `<div class="ai-tl-tr-bar">
                <div class="ai-tl-tr-filter" role="tablist">
                    <button type="button" class="active" data-f="all">All</button>
                    <button type="button" data-f="speech"><i class="fa-solid fa-comment"></i> Speech <span>${nSpeech}</span></button>
                    <button type="button" data-f="sounds"><i class="fa-solid fa-wave-square"></i> Sounds <span>${nSound}</span></button>
                </div>
                <span class="ai-tl-tr-hint">${cov ? cov + ' · ' : ''}sounds are detected by the audio model — hover a chip for its confidence</span>
            </div>`;
            box.innerHTML = toolbar + blocks.map(b => {
                if (b.kind === 'speech') return `<div class="ai-tl-tr-line ai-tl-tr-speech">${jumpFor(b.t)}<span class="ai-tl-tr-text">${esc(b.text)}</span></div>`;
                const span = b.tEnd > b.t + 2 ? `${_aiTimeFmt(b.t)}–${_aiTimeFmt(b.tEnd)}` : _aiTimeFmt(b.t);
                const chips = b.items.sort((x, y) => y.n - x.n).map(i => `<span class="ai-tl-sound ai-tl-sound--${i.key}" title="${esc(i.label)} · confidence ${(i.conf * 100).toFixed(0)}%"><i class="fa-solid ${i.icon}"></i>${esc(i.label)}${i.n > 1 ? `<b>×${i.n}</b>` : ''}</span>`).join('');
                return `<div class="ai-tl-tr-line ai-tl-tr-sounds">${jumpFor(b.t, 'ai-tl-ts ai-tl-ts--sound')}<div class="ai-tl-sound-strip" title="${esc(span)}">${chips}</div></div>`;
            }).join('');
            box.querySelectorAll('.ai-tl-tr-filter button').forEach(btn => btn.addEventListener('click', () => {
                box.querySelectorAll('.ai-tl-tr-filter button').forEach(b => b.classList.toggle('active', b === btn));
                box.dataset.filter = btn.dataset.f;
            }));
        } catch { box.innerHTML = '<p class="muted" style="padding:6px">Couldn\'t load transcript.</p>'; box.dataset.built = ''; }
    }
}

function _aiTlMonthKey(when) {
    if (!when) return null;
    const d = new Date(String(when).includes('T') ? when : when.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// Month-jump bar built from the lightweight index (all sessions, newest first).
function _aiTlBuildMonthBar() {
    if (!_aiTl || !_aiTl.index) return '';
    const order = [], firstSid = {};
    for (const s of _aiTl.index) {
        const k = _aiTlMonthKey(s.when);
        if (!k) continue;
        if (firstSid[k] == null) { firstSid[k] = s.id; order.push(k); }
    }
    if (order.length <= 1) return '';
    const chips = order.map(k => {
        const [y, m] = k.split('-');
        const label = new Date(y, +m - 1, 1).toLocaleDateString([], { month: 'short', year: 'numeric' });
        return `<button type="button" class="ai-tl-month" data-sid="${firstSid[k]}" onclick="_aiTlJumpTo(this.dataset.sid)">${esc(label)}</button>`;
    }).join('');
    return `<div class="ai-tl-months"><span class="ai-tl-months-label"><i class="fa-solid fa-calendar-days"></i> Jump to</span>${chips}</div>`;
}

// Jump to a session: load pages until it's in the DOM, then scroll + flash it.
// Switch between the "As a streamer" / "As a chatter" panes.
function _aiTlSwitchSide(side, btn) {
    document.querySelectorAll('#ch-ai-timeline .ai-tl-subtab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#ch-ai-timeline .ai-tl-pane').forEach(p => p.classList.toggle('ai-tl-pane--hidden', p.dataset.side !== side));
}

async function _aiTlJumpTo(sid) {
    // Make sure the streamer pane (which holds the sessions + month bar) is the active one.
    const btn = document.querySelector('#ch-ai-timeline .ai-tl-subtab[data-side="streamer"]');
    if (btn && !btn.classList.contains('active')) _aiTlSwitchSide('streamer', btn);

    let guard = 0;
    while (!document.querySelector(`.ai-tl-session[data-sid="${sid}"]`) && _aiTl && _aiTl.hasMore && guard++ < 60) {
        await _aiTlLoadMore();
    }
    const scrollToTarget = () => {
        const el = document.querySelector(`.ai-tl-session[data-sid="${sid}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return el;
    };
    // Wait for images/content above to settle before measuring (a plain single scroll lands
    // "halfway" because lazy content shifts positions after the scroll). Re-scroll a couple
    // of times to correct for reflow, and pause the infinite-scroll loader during the jump.
    _aiTl.jumping = true;
    const el = scrollToTarget();
    if (el) {
        el.classList.add('ai-tl-flash');
        setTimeout(() => el.classList.remove('ai-tl-flash'), 1600);
        // Wait for any images currently in the timeline to finish, then re-align.
        const imgs = Array.from(document.querySelectorAll('#ai-tl-track img')).filter(i => !i.complete);
        await Promise.race([
            Promise.all(imgs.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
            new Promise(r => setTimeout(r, 700)),
        ]);
        scrollToTarget();
        setTimeout(scrollToTarget, 250);
    }
    _aiTl.jumping = false;
}

async function _aiTlLoadMore() {
    if (!_aiTl || _aiTl.loading || !_aiTl.hasMore) return;
    _aiTl.loading = true;
    const track = document.getElementById('ai-tl-track');
    try {
        const data = await api(`/chat-ai/timeline/${encodeURIComponent(_aiTl.username)}?offset=${_aiTl.offset}&limit=${_aiTl.limit}`);
        const sessions = data.sessions || [];
        if (track && sessions.length) track.insertAdjacentHTML('beforeend', sessions.map(_aiTimelineSessionHTML).join(''));
        _aiTl.offset += sessions.length;
        _aiTl.hasMore = !!data.hasMore && sessions.length > 0;
        if (!_aiTl.hasMore) document.getElementById('ai-tl-sentinel')?.remove();
    } catch { _aiTl.hasMore = false; }
    finally { _aiTl.loading = false; }
}

async function loadChannelAiTimeline(username) {
    const wrap = document.getElementById('ch-ai-timeline');
    if (!wrap) return;
    try { _aiTl?.io?.disconnect(); } catch { /* */ }
    wrap.innerHTML = '<div class="loading">Loading AI timeline…</div>';
    _aiTl = { username, offset: 0, limit: 12, hasMore: false, loading: false, moments: {}, vodBySid: {}, index: null, io: null };
    try {
        const data = await api(`/chat-ai/timeline/${encodeURIComponent(username)}?offset=0&limit=12`);
        const sessions = data.sessions || [];
        const dn = esc(data.display_name || username);
        const streamerOv = data.overview && (data.overview.overview || data.overview.overview_short);
        const chat = data.chatInsight;
        const chatOverall = chat && (chat.overview_alltime || chat.overview_24h);
        const chatMoments = (chat && Array.isArray(chat.timeline)) ? chat.timeline.slice().reverse() : [];
        const hasStreamer = !!(sessions.length || streamerOv);
        const hasChatter = !!(chatOverall || chatMoments.length);
        const combined = data.combinedOverview;
        if (!combined && !hasStreamer && !hasChatter) {
            wrap.innerHTML = `<div class="ai-tl-empty"><i class="fa-solid fa-brain"></i><p>No AI timeline yet.</p><p class="muted">As ${dn} streams and chats, the AI builds an overview here — with links straight to the VOD moments.</p></div>`;
            return;
        }
        _aiTl.index = data.index || [];
        _aiTl.offset = sessions.length;
        _aiTl.hasMore = !!data.hasMore;

        // Combined "whole person" overview at the very top — ONLY when they have BOTH a streamer
        // and a chatter overview. With only one, this would just duplicate the single "As a
        // streamer"/"As a chatter" card below it, so we omit it.
        const hasBothOverviews = !!(streamerOv && chatOverall);
        const topText = hasBothOverviews ? (combined || `${streamerOv}\n\n${chatOverall}`) : '';
        const header = topText
            ? `<div class="ai-tl-overview-card"><div class="ai-tl-overview-label"><i class="fa-solid fa-wand-magic-sparkles"></i> Overall AI overview <span class="ai-tl-ov-sub">as a streamer &amp; chatter</span></div>${_collapsibleOverview(topText)}</div>`
            : '';

        // ── As a streamer (inner content, no label — the sub-tab / side-label supplies it) ──
        let streamerInner = '';
        if (hasStreamer) {
            // The streamer's own AI overview leads this pane (mirrors the chatter pane).
            const streamerOvCard = streamerOv
                ? `<div class="ai-tl-overview-card"><div class="ai-tl-overview-label"><i class="fa-solid fa-tower-broadcast"></i> As a streamer</div>${_collapsibleOverview(streamerOv)}</div>`
                : '';
            const summary = `<div class="ai-tl-summary">${data.sessionCount || sessions.length} session${(data.sessionCount || sessions.length) === 1 ? '' : 's'} · ${data.momentCount || 0} AI moment${(data.momentCount || 0) === 1 ? '' : 's'} tracked</div>`;
            streamerInner = streamerOvCard + summary + _aiTlBuildMonthBar()
                + `<div class="ai-tl-track" id="ai-tl-track">${sessions.map(_aiTimelineSessionHTML).join('')}</div>`
                + `<div id="ai-tl-sentinel" class="ai-tl-sentinel">${_aiTl.hasMore ? '<i class="fa-solid fa-spinner fa-spin"></i> Loading more…' : ''}</div>`;
        }

        // ── As a chatter (inner content) ──
        let chatterInner = '';
        if (hasChatter) {
            const momentsHTML = chatMoments.length ? `<div class="ai-tl-track">${chatMoments.map(t => `
                <div class="ai-tl-session">
                    <div class="ai-tl-session-head"><div class="ai-tl-node"></div>
                        <div class="ai-tl-session-title">${esc(t.label || 'Moment')}</div>
                        <div class="ai-tl-session-meta"><i class="fa-solid fa-clock"></i> ${_aiTimeAgo(t.ts)}</div></div>
                    ${t.detail ? `<div class="ai-tl-session-overview">${esc(t.detail)}</div>` : ''}
                </div>`).join('')}</div>` : '';
            chatterInner = (chatOverall ? `<div class="ai-tl-overview-card"><div class="ai-tl-overview-label"><i class="fa-solid fa-comments"></i> As a chatter</div>${_collapsibleOverview(chatOverall)}${chat.message_count ? `<p class="ai-tl-summary" style="margin:8px 0 0">~${chat.message_count} messages analyzed</p>` : ''}</div>` : '')
                + momentsHTML;
        }

        // Both sides → sub-tabs (so you don't scroll past the whole streamer timeline to reach
        // chat). One side → a plain labelled section.
        const bothSides = hasStreamer && hasChatter;
        let sidesHTML;
        if (bothSides) {
            sidesHTML = `<div class="ai-tl-subtabs">
                    <button class="ai-tl-subtab active" data-side="streamer" onclick="_aiTlSwitchSide('streamer', this)"><i class="fa-solid fa-tower-broadcast"></i> As a streamer</button>
                    <button class="ai-tl-subtab" data-side="chatter" onclick="_aiTlSwitchSide('chatter', this)"><i class="fa-solid fa-comments"></i> As a chatter</button>
                </div>
                <div class="ai-tl-pane" data-side="streamer">${streamerInner}</div>
                <div class="ai-tl-pane ai-tl-pane--hidden" data-side="chatter">${chatterInner}</div>`;
        } else if (hasStreamer) {
            sidesHTML = `<div class="ai-tl-side-label"><i class="fa-solid fa-tower-broadcast"></i> As a streamer</div>${streamerInner}`;
        } else {
            sidesHTML = `<div class="ai-tl-side-label"><i class="fa-solid fa-comments"></i> As a chatter</div>${chatterInner}`;
        }

        wrap.innerHTML = header + sidesHTML;
        const sentinel = document.getElementById('ai-tl-sentinel');
        if (sentinel && _aiTl.hasMore && 'IntersectionObserver' in window) {
            _aiTl.io = new IntersectionObserver(ents => { if (!_aiTl.jumping && ents.some(e => e.isIntersecting)) _aiTlLoadMore(); }, { rootMargin: '700px' });
            _aiTl.io.observe(sentinel);
        } else if (sentinel && !_aiTl.hasMore) {
            sentinel.remove();
        }
    } catch (err) {
        wrap.innerHTML = `<div class="ai-tl-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Couldn't load the AI timeline.</p><button class="btn btn-small btn-outline" onclick="loadChannelAiTimeline('${esc(username)}')">Retry</button></div>`;
    }
}

// Apply per-channel tab metadata from the channel response: count badges on the
// Videos/Clips/Clips-Taken/Pastes tabs, and hide the Videos/Clips tabs entirely when the
// streamer keeps them private across all slots with nothing public to show.
function _applyChannelTabMeta(data) {
    if (!data) return;
    const setBadge = (id, n) => {
        const el = document.getElementById(id);
        if (!el) return;
        const num = Number(n) || 0;
        if (num > 0) {
            el.textContent = num >= 1000 ? (num / 1000).toFixed(num >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(num);
            el.hidden = false;
        } else {
            el.textContent = '';
            el.hidden = true;
        }
    };
    setBadge('ch-tab-badge-videos', data.vodTotal);
    setBadge('ch-tab-badge-clips', (Number(data.clipsOfTotal) || 0) + (Number(data.aiClipsTotal) || 0));
    setBadge('ch-tab-badge-clips-taken', data.clipsTakenTotal);
    setBadge('ch-tab-badge-pastes', data.pasteTotal);
    setBadge('ch-tab-badge-ai-timeline', data.aiEventTotal);

    // Never hide tabs for the channel owner — they manage their own content.
    const isOwner = !!(currentUser && currentChannelUsername && currentUser.username === currentChannelUsername);
    const hideTab = (tab, hidden) => {
        const doHide = !!hidden && !isOwner;
        const btn = document.querySelector(`#ch-tabs .ch-tab[data-tab="${tab}"]`);
        const panel = document.getElementById('ch-panel-' + tab);
        if (btn) btn.style.display = doHide ? 'none' : '';
        if (panel && doHide) panel.classList.remove('active');
    };
    hideTab('videos', data.videos_tab_hidden);
    hideTab('clips', data.clips_tab_hidden);

    // If the tab that _resetChannelTabs made active just got hidden, fall back to the first
    // still-visible tab so the panel area isn't left blank.
    const activeBtn = document.querySelector('#ch-tabs .ch-tab.active');
    if (!activeBtn || activeBtn.style.display === 'none') {
        const firstVisible = Array.from(document.querySelectorAll('#ch-tabs .ch-tab'))
            .find(b => b.style.display !== 'none');
        if (firstVisible) switchChannelTab(firstVisible.dataset.tab, firstVisible);
    }
}

// Render the About tab: bio + streamer-defined info panels. (Weather is injected
// separately at the top of the panel by loadChannelWeather.)
/* ── About tab: inline live panel editor (Twitch/Kick-style under-stream area) ── */
let _aboutPanels = [];        // working array of panels
let _aboutBio = '';
let _aboutIsOwner = false;    // is the viewer the streamer?
let _aboutCanEdit = false;    // can the viewer edit (streamer, or an allowed mod)?
let _aboutEditMode = false;
let _aboutDirty = false;      // has anything changed since entering edit mode?
let _aboutModsCanEdit = false;// owner setting: may channel mods edit About?
let _aboutChannelId = null;   // owner's channel id (for saving the mods setting)
const ABOUT_WIDTHS = ['sm', 'md', 'lg', 'full'];

function _normalizeAboutPanel(p) {
    p = p || {};
    return {
        type: p.type === 'weather' ? 'weather' : 'info',
        title: p.title || '',
        body: p.body || p.text || p.description || '',
        image: p.image || p.image_url || '',
        link: p.link || p.url || '',
        width: ABOUT_WIDTHS.includes(p.width) ? p.width : 'md',
    };
}

function _renderChannelAbout(ch) {
    const host = document.getElementById('ch-about-content');
    if (!host || !ch) return;
    _aboutIsOwner = !!(currentUser && ch.username && currentUser.username &&
        currentUser.username.toLowerCase() === String(ch.username).toLowerCase());
    // The server decides who can edit (owner always; mods only when the streamer opted in).
    _aboutCanEdit = !!ch.viewer_can_edit_about || _aboutIsOwner;
    _aboutBio = (ch.bio || ch.description || '').trim();
    let panels = [];
    try { panels = typeof ch.panels === 'string' ? JSON.parse(ch.panels || '[]') : (ch.panels || []); } catch { panels = []; }
    _aboutPanels = (Array.isArray(panels) ? panels : []).map(_normalizeAboutPanel);
    _aboutAiOverview = ch.ai_overview || '';
    _aboutAiPref = ch.ai_overview_pref || (ch.hide_ai_overview ? 'hide' : 'auto');
    _aboutEditMode = false;
    _renderAboutView();
}
let _aboutAiOverview = '';
let _aboutAiPref = 'auto';
// Effective show for the About view, given the current pref + whether a bio/panels exist.
function _aboutAiEffectiveShow() {
    if (!_aboutAiOverview) return false;
    if (_aboutAiPref === 'show') return true;
    if (_aboutAiPref === 'hide') return false;
    return !(_aboutBio || (_aboutPanels && _aboutPanels.length)); // auto → only when no bio/panels
}
// The AI overview card shown at the top of the About tab (view mode).
function _aboutAiOverviewHTML() {
    if (!_aboutAiEffectiveShow()) return '';
    return `<div class="ai-tl-overview-card about-ai-overview">
        <div class="ai-tl-overview-label"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Overview</div>
        ${_collapsibleOverview(_aboutAiOverview)}
    </div>`;
}

function _renderAboutView() {
    const host = document.getElementById('ch-about-content');
    if (!host) return;
    const aiHtml = _aboutAiOverviewHTML();
    const hasContent = _aboutBio || _aboutPanels.length || aiHtml;
    let html = '';
    if (!hasContent) {
        html += _aboutCanEdit
            ? `<div class="ch-about-empty"><i class="fa-solid fa-address-card" style="font-size:2rem;opacity:0.5"></i><p style="font-size:1.05rem;font-weight:600;margin-top:8px">${_aboutIsOwner ? 'Your' : 'This'} About section is empty</p><p class="muted">Click the <i class="fa-solid fa-pen"></i> pencil on the <b>About</b> tab to add a bio, info panels (links, images), and a weather panel — this is the under-stream area viewers see.</p><button class="btn btn-sm btn-primary" onclick="editAboutFromTab()"><i class="fa-solid fa-pen"></i> Set up About</button></div>`
            : `<div class="ch-about-empty">This streamer hasn't set up an About section yet.</div>`;
        host.innerHTML = html;
        return;
    }
    html += aiHtml; // AI overview card leads the About tab
    if (_aboutBio) html += `<div class="ch-about-bio">${_linkify(esc(_aboutBio))}</div><div class="ch-about-bio-en" id="ch-about-bio-en"></div>`;
    html += '<div class="ch-about-panels">' + _aboutPanels.map((p, i) => _aboutPanelViewHTML(p, i)).join('') + '</div>';
    host.innerHTML = html;
    _fillWeatherPanels();
    void _fillBioTranslation();
}

// Non-English bio → an auto-translated English copy right under it (cached server-side).
const _NON_LATIN_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0590-\u05ff\u0370-\u03ff\u0900-\u097f]/;
async function _fillBioTranslation() {
    const host = document.getElementById('ch-about-bio-en');
    if (!host || !_aboutBio || !_NON_LATIN_RE.test(_aboutBio)) return;
    const uname = currentChannelUsername;
    let d = null;
    try { d = await api(`/streams/channel/${encodeURIComponent(uname)}/bio-en`); } catch { d = null; }
    if (!d || !d.text || uname !== currentChannelUsername) return;
    const still = document.getElementById('ch-about-bio-en');
    if (!still) return;
    still.innerHTML = `<div class="ch-about-bio-translated"><div class="ch-about-bio-translated-label"><i class="fa-solid fa-language"></i> English · auto-translated from ${esc(d.from_name || d.from || '')}</div>${_linkify(esc(d.text))}</div>`;
}

/* ── Channel language: info-bar chip + live captions panel ───────────────────────────
   `language` comes from /api/streams/channel/:username ({ code, name, flag, translate }).
   Non-English channels get a chip ("🇯🇵 Japanese stream · chat auto-translated") and,
   while live, a captions panel under the player fed by /api/chat-ai/live-captions. */
let _chLang = null, _captionsTimer = null, _captionsAfter = 0;
function _applyChannelLanguage(language, ch, isLive) {
    _chLang = language || null;
    // One chip in the live info bar, one in the offline header — whichever is showing.
    const targets = [
        ['ch-lang-chip', document.querySelector('#ch-info-bar .ch-info-bar-top')],
        ['ch-lang-chip-offline', document.querySelector('#ch-offline-header .ch-meta')],
    ];
    const off = !_chLang || !_chLang.code || _chLang.code === 'en';
    for (const [id, host] of targets) {
        let chip = document.getElementById(id);
        if (off) { if (chip) chip.remove(); continue; }
        if (!chip && host) { chip = document.createElement('span'); chip.id = id; chip.className = 'ch-lang-chip'; host.appendChild(chip); }
        if (!chip) continue;
        chip.innerHTML = `${esc(_chLang.flag || '🌐')} ${esc(_chLang.name || _chLang.code)} stream${_chLang.translate ? ' · <i class="fa-solid fa-language"></i> chat auto-translated' : ''}`;
        chip.title = `${_chLang.name}-speaking streamer. Chat is translated both ways automatically — type in your own language.`;
    }
    if (off) { _stopCaptions(); const p = document.getElementById('ch-captions'); if (p) p.style.display = 'none'; return; }
    _startCaptions(ch.username, ch.display_name || ch.username, isLive);
}
function _startCaptions(username, displayName, isLive) {
    _stopCaptions();
    const panel = document.getElementById('ch-captions');
    if (!panel) return;
    if (!isLive) { panel.style.display = 'none'; return; }
    _captionsAfter = 0;
    panel.classList.remove('collapsed');
    panel.innerHTML = `<div class="ch-captions-head">
            <span class="ch-captions-title"><span class="ch-captions-dot"></span> <i class="fa-solid fa-closed-captioning"></i> Live translation</span>
            <span class="ch-captions-sub">${esc(_chLang.flag || '')} ${esc(_chLang.name || '')} → 🇺🇸 English · what ${esc(displayName)} is saying</span>
            <button class="ch-captions-toggle" type="button" onclick="toggleCaptionsPanel()" title="Collapse / expand"><i class="fa-solid fa-chevron-up"></i></button>
        </div>
        <div class="ch-captions-lines" id="ch-captions-lines"><div class="ch-captions-wait">Listening… lines land a few seconds behind live.</div></div>`;
    panel.style.display = 'none'; // revealed once the server says captions are available
    const tick = async () => {
        const onPage = document.getElementById('page-channel')?.classList.contains('active');
        if (!onPage || currentChannelUsername !== username) { _stopCaptions(); return; }
        let d = null;
        try { d = await api(`/chat-ai/live-captions/${encodeURIComponent(username)}?after=${_captionsAfter}`); } catch { return; }
        if (!d || !d.available || !d.live) { panel.style.display = 'none'; return; }
        panel.style.display = '';
        const lines = d.lines || [];
        if (!lines.length) return;
        const box = document.getElementById('ch-captions-lines');
        if (!box) return;
        box.querySelector('.ch-captions-wait')?.remove();
        // Is the reader following the live edge right now? Decide before we touch the DOM.
        const wasPinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        for (const l of lines) {
            _captionsAfter = Math.max(_captionsAfter, Number(l.id) || 0);
            const row = document.createElement('div');
            row.className = 'ch-caption';
            row.innerHTML = l.text_en
                ? `<div class="ch-caption-en">${esc(l.text_en)}</div><div class="ch-caption-src">${esc(l.text)}</div>`
                : `<div class="ch-caption-en">${esc(l.text)}</div>`;
            box.appendChild(row);
        }
        // Measure BEFORE trimming and before deciding to follow: scrollHeight already includes
        // whatever we just appended, and trimming from the top moves the content up under the
        // reader. Someone who scrolled back to re-read a caption should stay where they put
        // themselves instead of being yanked to the bottom every six seconds.
        const follow = wasPinned;
        while (box.children.length > 14) {
            const gone = box.firstChild.getBoundingClientRect().height;
            box.removeChild(box.firstChild);
            if (!follow) box.scrollTop = Math.max(0, box.scrollTop - gone);
        }
        if (follow) box.scrollTop = box.scrollHeight;
    };
    void tick();
    _captionsTimer = setInterval(tick, 6000);
}
function _stopCaptions() { if (_captionsTimer) { clearInterval(_captionsTimer); _captionsTimer = null; } }
function toggleCaptionsPanel() { document.getElementById('ch-captions')?.classList.toggle('collapsed'); }

function _aboutPanelViewHTML(p, i) {
    const w = ABOUT_WIDTHS.includes(p.width) ? p.width : 'md';
    if (p.type === 'weather') {
        return `<div class="ch-about-panel ch-panel-w-${w} ch-panel-weather" data-weather-panel="${i}">
            ${p.title ? `<div class="ch-about-panel-title">${esc(p.title)}</div>` : ''}
            <div class="ch-weather-panel-body"><div class="muted" style="padding:16px"><i class="fa-solid fa-cloud-sun fa-spin-pulse"></i> Loading weather…</div></div>
        </div>`;
    }
    const img = p.image
        ? (p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener"><img src="${esc(p.image)}" alt="" loading="lazy"></a>`
                  : `<img src="${esc(p.image)}" alt="" loading="lazy">`)
        : '';
    const title = p.title ? `<div class="ch-about-panel-title">${esc(p.title)}</div>` : '';
    const body = p.body ? `<div class="ch-about-panel-text">${_linkify(esc(p.body))}</div>` : '';
    const linkBtn = (p.link && !p.image) ? `<a class="ch-about-panel-link" href="${esc(p.link)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>` : '';
    const content = p.title || p.body || p.link ? `<div class="ch-about-panel-content">${title}${body}${linkBtn}</div>` : '';
    return `<div class="ch-about-panel ch-panel-w-${w}">${img}${content}</div>`;
}

// Fetch weather for the CURRENTLY-WATCHED slot and fill any weather panels.
async function _fillWeatherPanels() {
    const nodes = document.querySelectorAll('#ch-about-content [data-weather-panel]');
    if (!nodes.length || !currentChannelUsername) return;
    try {
        const q = currentStreamId ? `?stream=${currentStreamId}` : '';
        const data = await api(`/streams/channel/${encodeURIComponent(currentChannelUsername)}/weather${q}`);
        const html = (data && data.enabled && data.current)
            ? renderWeatherWidget(data)
            : `<div class="muted" style="padding:16px"><i class="fa-solid fa-cloud-slash"></i> Weather isn't set for this stream.</div>`;
        nodes.forEach(n => { const b = n.querySelector('.ch-weather-panel-body'); if (b) b.innerHTML = html; });
    } catch {
        nodes.forEach(n => { const b = n.querySelector('.ch-weather-panel-body'); if (b) b.innerHTML = ''; });
    }
}
async function initGoalWidget(userId) {
    stopGoalWidget();
    if (!userId) return;
    _goalWidget.userId = userId;
    try { const data = await api(`/funds/goals/${userId}`); _goalWidget.goals = data.goals || []; }
    catch { _goalWidget.goals = []; }
    renderGoalWidget();
    // Refresh periodically so a reached goal's celebration auto-clears after the
    // server's 1-hour window. Only polls while the channel page is visible.
    _goalWidget.timer = setInterval(async () => {
        const page = document.getElementById('page-channel');
        if (!page || !page.classList.contains('active') || !_goalWidget.userId) return;
        try { const d = await api(`/funds/goals/${_goalWidget.userId}`); _goalWidget.goals = d.goals || []; renderGoalWidget(); } catch { /* */ }
    }, 120000);
}
function stopGoalWidget() {
    if (_goalWidget.timer) { clearInterval(_goalWidget.timer); _goalWidget.timer = null; }
    _goalWidget.goals = []; _goalWidget.userId = null;
    document.querySelectorAll('#ch-goal-widget, #ch-goal-widget-offline').forEach(el => { el.style.display = 'none'; el.innerHTML = ''; });
} // scroll time per goal during the once-per-30-min pass
let _goalCycleTimer = null;

// ── Media Request tab ────────────────────────────────────────
let _mediaState = null;
let _mediaCanManage = false;
let _mediaPricing = null;
let _mediaQuote = null;        // the price the viewer has been shown and not yet confirmed
// Reveal the Media Request tab if the streamer has it enabled.
async function _initMediaRequestTab(username) {
    const btn = document.getElementById('ch-tab-btn-media');
    try {
        const data = await api(`/media/channel/${encodeURIComponent(username)}`);
        _mediaState = data.state || null;
        const enabled = !!(_mediaState && _mediaState.settings && _mediaState.settings.enabled);
        if (btn) btn.style.display = enabled ? '' : 'none';
    } catch { if (btn) btn.style.display = 'none'; }
}
// How a price reads to a viewer, e.g. "5 Vibes/min" or "free".
function _mediaPriceLabel(p) {
    if (!p || p.currency === 'free') return 'Free requests.';
    if (p.cost_mode === 'per_minute') return `${p.cost_per_minute} ${p.currency_label} per minute of video.`;
    return `${p.request_cost} ${p.currency_label} per request.`;
}
function _mediaCurrencyIcon(currency) {
    if (currency === 'vibes') return 'fa-solid fa-bolt';
    if (currency === 'points') return 'fa-solid fa-star';
    if (currency === 'free') return 'fa-solid fa-gift';
    return 'fa-solid fa-coins';
}
async function loadChannelMedia(username = currentChannelUsername) {
    const host = document.getElementById('ch-media-content');
    if (!host || !username) return;
    try {
        const data = await api(`/media/channel/${encodeURIComponent(username)}`);
        _mediaState = data.state || {};
        _mediaCanManage = !!data.can_manage;
        _mediaPricing = data.pricing || null;
        const s = _mediaState.settings || {};
        if (!s.enabled) { host.innerHTML = '<div class="ch-about-empty">Media requests are off for this channel.</div>'; return; }
        const maxMin = Math.floor((Number(s.max_duration_seconds) || 0) / 60);
        const np = _mediaState.now_playing;
        const queue = _mediaState.queue || [];
        const loggedIn = !!currentUser;
        const sources = [s.allow_youtube && 'YouTube', s.allow_vimeo && 'Vimeo', s.allow_direct_media && 'direct media', s.allow_live && 'live'].filter(Boolean).join(', ');
        const p = _mediaPricing;
        host.innerHTML = `
          <div class="ch-media">
            <form class="ch-media-req" onsubmit="return submitMediaRequest(event)">
              <input id="ch-media-input" type="text" placeholder="Paste a ${esc(sources || 'media')} URL to request…" ${loggedIn ? '' : 'disabled'} oninput="_clearMediaQuote()">
              <button class="btn btn-primary" ${loggedIn ? '' : 'disabled'}><i class="fa-solid fa-magnifying-glass"></i> Check price</button>
            </form>
            <div class="ch-media-hint muted">${loggedIn ? '' : '<i class="fa-solid fa-lock"></i> Log in to request. '}<i class="${_mediaCurrencyIcon(p && p.currency)}"></i> ${esc(_mediaPriceLabel(p))}${maxMin ? ` Max ${maxMin} min.` : ''}</div>
            <div id="ch-media-quote"></div>
            <div id="ch-media-status" class="ch-media-status"></div>
            ${_mediaCanManage ? `<div class="ch-media-mod-bar"><span class="muted"><i class="fa-solid fa-shield-halved"></i> You can manage this queue</span><button class="btn btn-sm btn-outline" onclick="_mediaAdvance('played')"><i class="fa-solid fa-forward-step"></i> Next</button><button class="btn btn-sm btn-outline" onclick="_mediaAdvance('skipped')"><i class="fa-solid fa-ban"></i> Skip &amp; refund</button></div>` : ''}
            ${np ? `<div class="ch-media-now"><div class="ch-media-section-label"><i class="fa-solid fa-play"></i> Now Playing</div>${_mediaItemHTML(np)}</div>` : ''}
            <div class="ch-media-section-label"><i class="fa-solid fa-list-ol"></i> Up Next (${queue.length})</div>
            <div class="ch-media-queue">${queue.length ? queue.map((q, i) => _mediaItemHTML(q, i + 1)).join('') : '<div class="muted" style="padding:12px">Queue is empty — be the first to request something!</div>'}</div>
          </div>`;
    } catch { host.innerHTML = '<div class="ch-about-empty">Failed to load the media queue.</div>'; }
}
// Thumbnails come from third-party CDNs and 404 often enough (maxresdefault does not
// exist for every video) that an unhandled failure leaves a broken-image glyph. The
// placeholder always sits underneath, and a failed image simply removes itself to reveal
// it — no HTML-in-an-attribute quoting to get wrong.
function _mediaThumbHTML(url) {
    const ph = '<div class="ch-media-thumb-ph"><i class="fa-solid fa-music"></i></div>';
    if (!url) return ph;
    return `${ph}<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">`;
}
function _mediaItemHTML(m, pos) {
    const dur = m.duration_seconds ? formatDuration(m.duration_seconds) : '';
    const thumb = _mediaThumbHTML(m.thumbnail_url);
    const cost = Number(m.cost || 0) > 0
        ? `<span class="ch-media-cost"><i class="${_mediaCurrencyIcon(m.currency)}"></i> ${m.cost}</span>` : '';
    // Mods get the same controls as the streamer; the server re-checks permission on each.
    const controls = _mediaCanManage && pos ? `
        <div class="ch-media-actions">
            <button class="btn btn-xs btn-outline" title="Play now" onclick="_mediaQueueAction(${m.id}, 'play')"><i class="fa-solid fa-play"></i></button>
            <button class="btn btn-xs btn-outline" title="Move up" onclick="_mediaQueueAction(${m.id}, 'up')"><i class="fa-solid fa-arrow-up"></i></button>
            <button class="btn btn-xs btn-outline" title="Move down" onclick="_mediaQueueAction(${m.id}, 'down')"><i class="fa-solid fa-arrow-down"></i></button>
            <button class="btn btn-xs btn-outline danger" title="Remove &amp; refund" onclick="_mediaQueueAction(${m.id}, 'remove')"><i class="fa-solid fa-trash"></i></button>
        </div>` : '';
    // A request that cannot play should say so where it sits, not look like a normal item.
    const problem = (m.download_status === 'failed' || m.status === 'failed')
        ? `<div class="ch-media-problem"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(_mediaShortError(m.last_error))}</div>` : '';
    return `<div class="ch-media-item">${pos ? `<span class="ch-media-pos">${pos}</span>` : ''}<div class="ch-media-thumb">${thumb}</div><div class="ch-media-meta"><div class="ch-media-title">${esc(m.title || m.input || 'Media')}</div><div class="ch-media-sub muted">${dur ? dur + ' · ' : ''}requested by ${esc(m.username || 'someone')} ${cost}</div>${problem}</div>${controls}</div>`;
}
// yt-dlp errors are paragraphs; the queue only has room for the part that matters.
function _mediaShortError(err) {
    const m = String(err || '').toLowerCase();
    if (m.includes('yt-dlp is not available')) return 'The server cannot play media right now.';
    if (m.includes('bot')) return 'YouTube blocked this on the server (sign-in check).';
    if (m.includes('private')) return 'This video is private.';
    if (m.includes('members-only')) return 'This video is members-only.';
    if (m.includes('age')) return 'This video is age-restricted.';
    if (m.includes('unavailable') || m.includes('not available')) return 'This video is unavailable.';
    return 'This media could not be prepared.';
}

// ── Queue management (streamer + channel mods) ───────────────
async function _mediaQueueAction(id, action) {
    const body = { channelUsername: currentChannelUsername };
    const status = document.getElementById('ch-media-status');
    try {
        if (action === 'play')        await api(`/media/queue/${id}/play`, { method: 'POST', body });
        else if (action === 'remove') await api(`/media/queue/${id}`, { method: 'DELETE', body });
        else                          await api(`/media/queue/${id}/move`, { method: 'POST', body: { ...body, direction: action } });
        loadChannelMedia(currentChannelUsername);
    } catch (err) { if (status) { status.className = 'ch-media-status err'; status.textContent = err.message || 'Action failed'; } }
}
async function _mediaAdvance(status_) {
    const status = document.getElementById('ch-media-status');
    try {
        await api('/media/advance', { method: 'POST', body: { channelUsername: currentChannelUsername, status: status_ } });
        loadChannelMedia(currentChannelUsername);
    } catch (err) { if (status) { status.className = 'ch-media-status err'; status.textContent = err.message || 'Failed to advance'; } }
}

// ── Quote → confirm → charge ─────────────────────────────────
// The viewer is shown the real title, real length and exact price for THIS link before
// anything is taken, then confirms. What they agreed to is what gets charged.
function _clearMediaQuote() {
    _mediaQuote = null;
    const q = document.getElementById('ch-media-quote');
    if (q) q.innerHTML = '';
}
async function submitMediaRequest(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('ch-media-input');
    const status = document.getElementById('ch-media-status');
    const quoteEl = document.getElementById('ch-media-quote');
    const val = input && input.value.trim();
    if (!val) return false;
    if (status) { status.className = 'ch-media-status'; status.textContent = ''; }
    if (quoteEl) quoteEl.innerHTML = '<div class="ch-media-quote loading muted"><i class="fa-solid fa-spinner fa-spin"></i> Checking that link…</div>';
    try {
        const q = await api('/media/quote', { method: 'POST', body: { username: currentChannelUsername, input: val } });
        _mediaQuote = { ...q, input: val };
        _renderMediaQuote(_mediaQuote);
    } catch (err) {
        _mediaQuote = null;
        if (quoteEl) quoteEl.innerHTML = '';
        if (status) { status.className = 'ch-media-status err'; status.textContent = err.message || 'Could not read that link'; }
    }
    return false;
}
function _renderMediaQuote(q) {
    const el = document.getElementById('ch-media-quote');
    if (!el) return;
    const dur = q.duration_seconds ? formatDuration(q.duration_seconds) : 'unknown length';
    const thumb = _mediaThumbHTML(q.thumbnail_url);

    let priceLine, action;
    if (!q.allowed) {
        priceLine = `<div class="ch-media-quote-price err">${esc(q.reason || 'This request is not allowed.')}</div>`;
        action = '';
    } else if (q.cost <= 0) {
        priceLine = '<div class="ch-media-quote-price ok"><i class="fa-solid fa-gift"></i> Free</div>';
        action = `<button class="btn btn-primary" onclick="confirmMediaRequest()"><i class="fa-solid fa-plus"></i> Add to queue</button>`;
    } else {
        const per = q.cost_mode === 'per_minute'
            ? ` <span class="muted">(${q.cost_per_minute}/min × ${Math.ceil((q.duration_seconds || 0) / 60)} min)</span>` : '';
        const bal = q.balance == null ? ''
            : ` <span class="muted">· you have ${q.balance}</span>`;
        priceLine = `<div class="ch-media-quote-price"><i class="${_mediaCurrencyIcon(q.currency)}"></i> ${q.cost} ${esc(q.currency_label)}${per}${bal}</div>`;
        action = q.affordable === false
            ? `<div class="ch-media-status err">Not enough ${esc(q.currency_label)}.</div>`
            : `<button class="btn btn-primary" onclick="confirmMediaRequest()"><i class="fa-solid fa-check"></i> Confirm &amp; pay ${q.cost}</button>`;
    }

    el.innerHTML = `
      <div class="ch-media-quote">
        <div class="ch-media-thumb">${thumb}</div>
        <div class="ch-media-quote-meta">
          <div class="ch-media-title">${esc(q.title || 'Media')}</div>
          <div class="ch-media-sub muted">${esc(dur)}${q.provider ? ' · ' + esc(q.provider) : ''}</div>
          ${priceLine}
        </div>
        <div class="ch-media-quote-actions">
          ${action}
          <button class="btn btn-sm btn-outline" onclick="_clearMediaQuote()">Cancel</button>
        </div>
      </div>`;
}
async function confirmMediaRequest() {
    const q = _mediaQuote;
    const status = document.getElementById('ch-media-status');
    if (!q) return;
    if (status) { status.className = 'ch-media-status'; status.textContent = 'Adding…'; }
    try {
        await api('/media/request', { method: 'POST', body: { username: currentChannelUsername, streamId: currentStreamId || undefined, input: q.input } });
        const input = document.getElementById('ch-media-input');
        if (input) input.value = '';
        _clearMediaQuote();
        if (status) { status.className = 'ch-media-status ok'; status.textContent = '✓ Added to the queue!'; setTimeout(() => { status.textContent = ''; }, 2500); }
        loadChannelMedia(currentChannelUsername);
    } catch (err) { if (status) { status.className = 'ch-media-status err'; status.textContent = err.message || 'Request failed'; } }
}

// ── Edit mode ────────────────────────────────────────────────
// Entered from the pencil button on the About tab: switch to About and open the editor.
function editAboutFromTab() {
    if (!_aboutCanEdit) return;
    const btn = document.getElementById('ch-tab-btn-about');
    switchChannelTab('about', btn);
    if (!_aboutEditMode) toggleAboutEdit();
}
function toggleAboutEdit() {
    if (!_aboutCanEdit) return;
    _aboutEditMode = !_aboutEditMode;
    if (_aboutEditMode) _renderAboutEdit(); else _renderAboutView();
}
function _renderAboutEdit() {
    const host = document.getElementById('ch-about-content');
    if (!host) return;
    _aboutDirty = false;
    const modsToggle = _aboutIsOwner ? `
            <label class="ch-about-mods-toggle" title="Let your channel moderators edit your About section & panels">
                <input type="checkbox" id="ch-about-mods-edit" ${_aboutModsCanEdit ? 'checked' : ''} onchange="_setAboutModsCanEdit(this.checked)">
                <span>Mods can edit</span>
            </label>` : '';
    host.innerHTML = `
        <div class="ch-about-toolbar">
            <div class="ch-about-toolbar-left">
                <button class="btn btn-sm btn-outline" onclick="addAboutPanel('info')"><i class="fa-solid fa-plus"></i> Add panel</button>
                <button class="btn btn-sm btn-outline" onclick="addAboutPanel('weather')"><i class="fa-solid fa-cloud-sun"></i> Add weather panel</button>
                <span class="muted ch-about-drag-hint"><i class="fa-solid fa-arrows-up-down-left-right"></i> Drag to reorder</span>
            </div>
            <div class="ch-about-toolbar-right">
                ${modsToggle}
                <button class="btn btn-sm btn-primary ch-about-save-btn" id="ch-about-save-btn" onclick="saveAboutInline()"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                <button class="btn btn-sm btn-outline" onclick="cancelAboutEdit()"><i class="fa-solid fa-xmark"></i> Cancel</button>
            </div>
        </div>
        ${_aboutAiOverview ? `
        <div class="ch-about-ai-toggle">
            <label class="ch-about-mods-toggle" title="Show the AI-generated overview at the top of your About tab">
                <input type="checkbox" id="ch-about-ai-overview-toggle" ${_aboutAiEffectiveShow() ? 'checked' : ''} onchange="_aboutAiPref=this.checked?'show':'hide';_markAboutDirty()">
                <span><i class="fa-solid fa-wand-magic-sparkles"></i> Show AI overview</span>
            </label>
            <span class="muted ch-about-ai-hint">An AI-written summary of your streams. Shown automatically until you add a bio; turn it on here to keep showing it, or off to hide it.</span>
        </div>` : ''}
        <div class="ch-about-edit-bio">
            <label class="ch-edit-label">Bio</label>
            <textarea id="ch-about-bio-edit" rows="3" placeholder="Tell viewers about yourself…" oninput="_aboutBio=this.value;_markAboutDirty()">${esc(_aboutBio)}</textarea>
        </div>
        <div class="ch-about-panels ch-about-panels-edit" id="ch-about-panels-edit">
            ${_aboutPanels.map((p, i) => _aboutPanelEditHTML(p, i)).join('')}
        </div>`;
    _wireAboutDrag();
    _updateAboutSaveBtn();
    if (_aboutIsOwner && _aboutChannelId === null) _loadAboutModsSetting();
}
function _markAboutDirty() { _aboutDirty = true; _updateAboutSaveBtn(); }
function _updateAboutSaveBtn() {
    const btn = document.getElementById('ch-about-save-btn');
    if (btn) btn.classList.toggle('is-visible', !!_aboutDirty);
}
// Apply a panel's width live (no full re-render, so inputs keep focus/value).
function _setAboutPanelWidth(i, w, sel) {
    _aboutPanels[i].width = w;
    const panel = sel && sel.closest ? sel.closest('.ch-about-panel') : null;
    if (panel) {
        panel.classList.remove('ch-panel-w-sm', 'ch-panel-w-md', 'ch-panel-w-lg', 'ch-panel-w-full');
        panel.classList.add('ch-panel-w-' + w);
    }
    _markAboutDirty();
}
async function _loadAboutModsSetting() {
    if (!currentUser) return;
    try {
        const data = await api('/channels/moderation/mine');
        const mine = (data.channels || []).find(c => c.user_id === currentUser.id) || (data.channels || [])[0];
        if (mine) {
            _aboutChannelId = mine.id;
            _aboutModsCanEdit = !!(mine.moderation_settings && mine.moderation_settings.mods_can_edit_about);
            const cb = document.getElementById('ch-about-mods-edit');
            if (cb) cb.checked = _aboutModsCanEdit;
        }
    } catch { /* silent */ }
}
async function _setAboutModsCanEdit(v) {
    _aboutModsCanEdit = !!v;
    if (!_aboutChannelId) { await _loadAboutModsSetting(); }
    if (!_aboutChannelId) return;
    try {
        await api(`/channels/${_aboutChannelId}/moderation`, { method: 'PUT', body: { mods_can_edit_about: v ? 1 : 0 } });
        toast(v ? 'Mods can now edit your About' : 'Mods can no longer edit your About', 'success');
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
}
function _aboutPanelEditHTML(p, i) {
    const widthSel = ABOUT_WIDTHS.map(w => `<option value="${w}" ${p.width === w ? 'selected' : ''}>${{ sm: 'Small', md: 'Medium', lg: 'Large', full: 'Full' }[w]}</option>`).join('');
    const head = `<div class="ch-panel-edit-head">
            <span class="ch-panel-drag" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <span class="ch-panel-type">${p.type === 'weather' ? '<i class="fa-solid fa-cloud-sun"></i> Weather' : '<i class="fa-solid fa-window-maximize"></i> Panel'}</span>
            <select onchange="_setAboutPanelWidth(${i}, this.value, this)" title="Width">${widthSel}</select>
            <button class="ch-panel-del" onclick="removeAboutPanel(${i})" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    if (p.type === 'weather') {
        return `<div class="ch-about-panel ch-panel-w-${p.width} ch-panel-edit" draggable="true" data-idx="${i}">
            ${head}
            <input type="text" placeholder="Panel title (optional)" value="${esc(p.title)}" oninput="_aboutPanels[${i}].title=this.value;_markAboutDirty()">
            <p class="muted" style="font-size:0.8rem;margin:6px 0 0"><i class="fa-solid fa-location-dot"></i> Shows the weather for the slot the viewer is watching (set each slot's zip in the slot's broadcast settings).</p>
        </div>`;
    }
    return `<div class="ch-about-panel ch-panel-w-${p.width} ch-panel-edit" draggable="true" data-idx="${i}">
        ${head}
        <input type="text" placeholder="Title" value="${esc(p.title)}" oninput="_aboutPanels[${i}].title=this.value;_markAboutDirty()">
        <div class="ch-panel-img-row">
            <img class="ch-panel-img-preview" src="${p.image ? esc(p.image) : ''}" style="${p.image ? '' : 'display:none'}">
            <input type="file" accept="image/*" onchange="uploadAboutPanelImage(${i}, this)">
            ${p.image ? `<button class="btn btn-xs btn-outline" onclick="_aboutPanels[${i}].image='';_markAboutDirty();_renderAboutEdit()">Remove image</button>` : ''}
        </div>
        <textarea rows="2" placeholder="Text (URLs become links)" oninput="_aboutPanels[${i}].body=this.value;_markAboutDirty()">${esc(p.body)}</textarea>
        <input type="text" placeholder="Link URL (optional)" value="${esc(p.link)}" oninput="_aboutPanels[${i}].link=this.value;_markAboutDirty()">
    </div>`;
}
function addAboutPanel(type) {
    _aboutPanels.push(_normalizeAboutPanel({ type, width: type === 'weather' ? 'md' : 'md' }));
    _renderAboutEdit();
    _markAboutDirty();
}
function removeAboutPanel(i) { _aboutPanels.splice(i, 1); _renderAboutEdit(); _markAboutDirty(); }
function cancelAboutEdit() { _aboutEditMode = false; _aboutDirty = false; _renderAboutView(); }
async function uploadAboutPanelImage(i, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
        const fd = new FormData(); fd.append('file', file);
        const token = localStorage.getItem('token');
        const res = await fetch(`${API}/api/streams/panel-image`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        _aboutPanels[i].image = data.url;
        _renderAboutEdit();
    } catch (e) { toast(e.message || 'Image upload failed', 'error'); }
    input.value = '';
}
async function saveAboutInline() {
    try {
        // Targets the channel by username, so an allowed mod writes to the STREAMER's
        // channel (not their own). Server enforces the edit permission.
        await api(`/streams/channel/${encodeURIComponent(currentChannelUsername)}/about`, {
            method: 'PUT', body: { bio: _aboutBio, panels: JSON.stringify(_aboutPanels), ai_overview_pref: _aboutAiPref, hide_ai_overview: _aboutAiPref === 'hide' ? 1 : 0 },
        });
        if (_aboutIsOwner && currentUser) currentUser.bio = _aboutBio;
        _aboutEditMode = false;
        _renderAboutView();
        toast('About saved', 'success');
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
}
// Native drag-and-drop reordering of edit panels.
let _aboutDragIdx = null;
function _wireAboutDrag() {
    const wrap = document.getElementById('ch-about-panels-edit');
    if (!wrap) return;
    wrap.querySelectorAll('.ch-panel-edit').forEach(el => {
        el.addEventListener('dragstart', e => { _aboutDragIdx = parseInt(el.dataset.idx, 10); el.classList.add('dragging'); });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.addEventListener('dragover', e => e.preventDefault());
        el.addEventListener('drop', e => {
            e.preventDefault();
            const to = parseInt(el.dataset.idx, 10);
            if (_aboutDragIdx == null || to === _aboutDragIdx) return;
            const [moved] = _aboutPanels.splice(_aboutDragIdx, 1);
            _aboutPanels.splice(to, 0, moved);
            _aboutDragIdx = null;
            _renderAboutEdit();
            _markAboutDirty();
        });
    });
}

// Render a streamer's customizable offline screen into #ch-offline-screen.
// image/video → served asset; html → sandboxed iframe (no same-origin, so the
// streamer's markup can't touch viewers' session). Falls back to a tasteful default.
function _renderOfflineScreen(ch) {
    const host = document.getElementById('ch-offline-screen');
    if (!host) return;
    _stopOfflineCycler(); // clear any prior offline cycler before re-rendering
    const type = ch && ch.offline_screen_type;
    const url = ch && ch.offline_screen_url;
    if (type === 'image' && url) {
        // Show the streamer's offline image AND float the "most watched" cycler over it, with a
        // close button so a viewer can dismiss it and see just the background image. (HTML
        // offline screens are left untouched — they own their whole canvas.)
        host.innerHTML = `<img class="ch-offline-media" src="${esc(url)}" alt="Offline">
            <div class="ch-offline-overlay" id="ch-offline-overlay">
                <button class="ch-offline-overlay-close" onclick="_dismissOfflineOverlay()" title="Hide — show just the background image"><i class="fa-solid fa-xmark"></i></button>
                <div class="ch-offline-explore ch-offline-explore--over" id="ch-offline-explore"></div>
            </div>
            <button class="ch-offline-reopen" id="ch-offline-reopen" onclick="_reopenOfflineOverlay()" title="Show most-watched content"><i class="fa-solid fa-fire"></i> Top content</button>`;
        _fillOfflineExplore(ch && ch.username);
    } else if (type === 'video' && url) {
        host.innerHTML = `<video class="ch-offline-media" src="${esc(url)}" autoplay muted loop playsinline></video>`;
    } else if (type === 'html' && (ch.offline_html || ch.offline_css)) {
        // The server sanitizes offline_html/offline_css to basic markup with no script, frames,
        // forms or event handlers (server/streaming/offline-html-sanitize.js), on both save and
        // every read — so this iframe needs no script/form/popup privileges at all. `allow-popups`
        // is the one grant kept, so a plain `<a target="_blank">` still opens; it carries no
        // sandbox-escape (no allow-popups-to-escape-sandbox), no allow-scripts, no allow-forms,
        // and (as before) no allow-same-origin.
        const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;color:#eee;font-family:system-ui,sans-serif;overflow:auto}a{color:#e0a44a}${ch.offline_css || ''}</style></head><body>${ch.offline_html || ''}</body></html>`;
        const iframe = document.createElement('iframe');
        iframe.className = 'ch-offline-html';
        iframe.setAttribute('sandbox', 'allow-popups');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.srcdoc = doc;
        host.innerHTML = '';
        host.appendChild(iframe);
    } else {
        const av = _avatarInner(ch && ch.avatar_url, ch && (ch.display_name || ch.username));
        const name = esc((ch && (ch.display_name || ch.username)) || 'Streamer');
        host.innerHTML = `<div class="ch-offline-default">
            <div class="ch-offline-default-avatar">${av}</div>
            <div class="ch-offline-default-name">${name}</div>
            <div class="ch-offline-default-sub">is offline — explore their top content, or say hi in chat</div>
            <div class="ch-offline-explore" id="ch-offline-explore"></div>
        </div>`;
        _fillOfflineExplore(ch && ch.username);
    }
}

// Compact "top content" cycler for the offline screen: the #1 VOD + #1 clip for the
// streamer, cycling through time windows (all-time / this month / this week) by views.
let _offlineRanges = [];
let _offlineIdx = 0;
let _offlineCyclerTimer = null;
const _OFFLINE_RANGE_META = [
    { key: 'all', label: 'All time' },
    { key: 'month', label: 'This month' },
    { key: 'week', label: 'This week' },
];

function _stopOfflineCycler() {
    if (_offlineCyclerTimer) { clearInterval(_offlineCyclerTimer); _offlineCyclerTimer = null; }
}

// Over-image offline overlay: dismiss to reveal just the background image; reopen to bring
// the "most watched" cycler back.
function _dismissOfflineOverlay() {
    const ov = document.getElementById('ch-offline-overlay');
    const re = document.getElementById('ch-offline-reopen');
    if (ov) ov.style.display = 'none';
    if (re) re.classList.add('show');
    _stopOfflineCycler();
}
function _reopenOfflineOverlay() {
    const ov = document.getElementById('ch-offline-overlay');
    const re = document.getElementById('ch-offline-reopen');
    if (ov) ov.style.display = '';
    if (re) re.classList.remove('show');
    _startOfflineCycler();
}

async function _fillOfflineExplore(username) {
    if (!username) return;
    _stopOfflineCycler();
    let data;
    try { data = await api(`/streams/channel/${encodeURIComponent(username)}/popular`); }
    catch { return; }
    const host = document.getElementById('ch-offline-explore');
    if (!host) return; // navigated away / offline screen re-rendered
    const ranges = data.ranges || {};

    // Build the range list (all → month → week), keep only windows that actually have
    // content, and drop a window that is identical to the one before it (so a streamer with
    // only recent content doesn't see "All time" and "This week" show the exact same pair).
    const built = [];
    let lastSig = '';
    for (const meta of _OFFLINE_RANGE_META) {
        const r = ranges[meta.key];
        if (!r || (!r.vod && !r.clip)) continue;
        const sig = `${r.vod ? 'v' + r.vod.id : ''}|${r.clip ? 'c' + r.clip.id : ''}`;
        if (sig === lastSig) continue;
        lastSig = sig;
        built.push({ ...meta, vod: r.vod || null, clip: r.clip || null });
    }
    // Fall back to the legacy single top vod/clip if the ranges came back empty.
    if (!built.length && (data.vod || data.clip)) {
        built.push({ key: 'all', label: 'Top content', vod: data.vod || null, clip: data.clip || null });
    }
    // The discover board (live now, hot clips, fresh reports, star of the day, streamers like
    // this one) fills the rest of the offline screen — with or without this channel's own content.
    // Over a custom offline image, #ch-offline-screen is clipped to the image's own aspect ratio
    // (overflow:hidden), so the board has to anchor after that whole box, not after the explore
    // host nested inside its overlay, or it renders clipped away and invisible.
    const overlay = host.closest('.ch-offline-overlay');
    const mountDiscover = () => {
        const anchor = overlay ? document.getElementById('ch-offline-screen') : host;
        if (!anchor) return;
        let d = document.getElementById('ch-discover');
        if (!d) { d = document.createElement('div'); d.id = 'ch-discover'; }
        anchor.insertAdjacentElement('afterend', d);
        if (typeof renderOfflineDiscover === 'function') renderOfflineDiscover(username, d);
    };
    if (!built.length) {
        host.innerHTML = '';
        // Nothing to show → don't leave an empty overlay (just an X) floating over the image.
        const ov = document.getElementById('ch-offline-overlay');
        const re = document.getElementById('ch-offline-reopen');
        if (ov) ov.style.display = 'none';
        if (re) re.classList.remove('show');
        mountDiscover();
        return;
    }
    mountDiscover();

    _offlineRanges = built;
    _offlineIdx = 0;
    const chips = built.length > 1
        ? `<div class="off-cyc-ranges">${built.map((r, i) =>
            `<button class="off-cyc-chip${i === 0 ? ' active' : ''}" data-i="${i}" onclick="_offlineCyclerGo(${i}, true)">${esc(r.label)}</button>`).join('')}</div>`
        : `<span class="off-cyc-single-label">${esc(built[0].label)}</span>`;
    const nav = built.length > 1
        ? `<div class="off-cyc-nav">
             <button class="off-cyc-arrow" onclick="_offlineCyclerStep(-1, true)" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>
             <button class="off-cyc-arrow" onclick="_offlineCyclerStep(1, true)" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>
           </div>` : '';

    host.innerHTML = `
        <div class="off-cyc" id="off-cyc" onmouseenter="_stopOfflineCycler()" onmouseleave="_startOfflineCycler()">
            <div class="off-cyc-head">
                <span class="off-cyc-title"><i class="fa-solid fa-fire"></i> Most watched</span>
                ${chips}
                ${nav}
            </div>
            <div class="off-cyc-body" id="off-cyc-body"></div>
        </div>`;
    _offlineCyclerRender();
    _startOfflineCycler();
}

function _startOfflineCycler() {
    _stopOfflineCycler();
    if (_offlineRanges.length > 1 && document.getElementById('off-cyc-body')) {
        _offlineCyclerTimer = setInterval(() => _offlineCyclerStep(1, false), 6500);
    }
}
function _offlineCyclerStep(dir, userAction) {
    if (!_offlineRanges.length) return;
    _offlineCyclerGo((_offlineIdx + dir + _offlineRanges.length) % _offlineRanges.length, userAction);
}
function _offlineCyclerGo(i, userAction) {
    if (!_offlineRanges.length) return;
    _offlineIdx = ((i % _offlineRanges.length) + _offlineRanges.length) % _offlineRanges.length;
    document.querySelectorAll('.off-cyc-chip').forEach(c => c.classList.toggle('active', +c.dataset.i === _offlineIdx));
    _offlineCyclerRender();
    // A manual pick restarts the dwell timer so it doesn't jump again immediately.
    if (userAction) _startOfflineCycler();
}
function _offlineCyclerRender() {
    const body = document.getElementById('off-cyc-body');
    if (!body) { _stopOfflineCycler(); return; } // navigated away — stop firing
    const r = _offlineRanges[_offlineIdx];
    const cards = [];
    if (r.vod) cards.push(_offlineTopCard('vod', r.vod));
    if (r.clip) cards.push(_offlineTopCard('clip', r.clip));
    body.classList.remove('off-cyc-fade');
    // reflow to restart the fade-in animation
    void body.offsetWidth;
    body.innerHTML = cards.join('');
    body.classList.add('off-cyc-fade');
}
function _offlineTopCard(kind, item) {
    const isVod = kind === 'vod';
    const href = isVod ? `/vod/${item.id}` : `/clip/${item.id}`;
    const icon = isVod ? 'fa-video' : 'fa-scissors';
    const label = isVod ? 'VOD' : 'Clip';
    const thumbGen = isVod ? `/api/thumbnails/generate/vod/${item.id}` : `/api/thumbnails/generate/clip/${item.id}`;
    return `<a class="off-top-card" href="${href}" onclick="return handleLinkClick(event, '${href}')">
        <div class="off-top-thumb">
            ${thumbImg(item.thumbnail_url, icon, item.title, thumbGen)}
            <span class="off-top-rank">#1 ${label}</span>
            ${item.duration_seconds ? `<span class="off-top-dur">${formatDuration(item.duration_seconds)}</span>` : ''}
        </div>
        <div class="off-top-info">
            <div class="off-top-title">${esc(item.title || label)}</div>
            <div class="off-top-meta">
                <span><i class="fa-solid fa-eye"></i> ${_fmtCount ? _fmtCount(item.view_count || 0) : (item.view_count || 0)}</span>
                <span class="off-top-dot">·</span>
                <span>${timeAgo(item.created_at)}</span>
            </div>
        </div>
    </a>`;
}

function startStreamStatusPoll(stream) {
    stopStreamStatusPoll();
    if (!currentChannelUsername) return;
    const username = currentChannelUsername;
    // We're on a healthy live player, so the viewer isn't stranded any more — close
    // any open burst window. Keeping it open would have every viewer of a busy
    // channel hitting the poll endpoint every 2s for no benefit; the WS
    // 'stream-ended' push already tells us the moment this stream dies.
    _streamPollFastUntil = 0;

    const tick = async () => {
        // Stop polling if user navigated away from the channel page
        if (currentChannelUsername !== username) { stopStreamStatusPoll(); return; }
        // Drop back to the lazy cadence once the burst window has expired.
        if (_streamPollFast && Date.now() >= _streamPollFastUntil) arm();
        try {
            // pollOnly=1 skips the heavy VOD/clip listing queries — the poll only needs
            // live status + viewer counts + restream info.
            const data = await api(`/streams/channel/${username}?pollOnly=1`);
            const streams = data.streams || (data.stream ? [data.stream] : []);
            const liveStreams = streams.filter(s => s && s.is_live);

            if (liveStreams.length === 0 && currentStreamId) {
                // Stream went offline — show offline state
                stopStreamStatusPoll();
                loadChannelPage(username);
                return;
            }

            if (liveStreams.length > 0 && !currentStreamId) {
                // Stream came online — switch to live state
                stopStreamStatusPoll();
                loadChannelPage(username);
                return;
            }

            // Check if current stream is still live
            const current = liveStreams.find(s => s.id === currentStreamId);
            if (current) _renderChStreamAi(current.ai_overview, current.ai_overview_short);
            const rsRestream = data.rs_restream || {};
            const restreamLinks = data.restream_links || null;
            const extViewers = data.external_viewers || null;
            if (!current && liveStreams.length > 0) {
                // Current stream ended, but others are live — auto-switch to best
                const best = liveStreams.reduce((b, s) =>
                    (s.viewer_count || 0) > (b.viewer_count || 0) ? s : b
                , liveStreams[0]);
                const bestTitle = best.title || 'another stream';
                loadLiveStreamTabs(username, best.id, liveStreams, rsRestream);
                activateChannelStream(best);
                updateCumulativeViewers(liveStreams, rsRestream, restreamLinks, extViewers);
                rememberLastStream(username, best.id);
                const bestMsRef = best.managed_stream_slug || best.managed_stream_id || null;
                history.replaceState(null, '', channelPath(username, bestMsRef));
                toast(`Stream ended — switched to "${bestTitle}"`, 'info');
                return;
            }

            // Update tabs with fresh viewer counts and uptime
            if (liveStreams.length > 1) {
                loadLiveStreamTabs(username, currentStreamId, liveStreams, rsRestream);
            } else {
                // Single stream — ensure tabs are hidden
                const tabsC = document.getElementById('live-stream-tabs');
                if (tabsC) tabsC.style.display = 'none';
                const pageEl = document.getElementById('page-channel');
                if (pageEl) pageEl.classList.remove('has-live-tabs');
            }

            // Update cumulative viewers
            updateCumulativeViewers(liveStreams, rsRestream, restreamLinks, extViewers);
        } catch { /* silent — network error, retry next interval */ }
    };

    const arm = () => {
        if (_streamPollTimer) clearInterval(_streamPollTimer);
        _streamPollFast = Date.now() < _streamPollFastUntil;
        _streamPollTimer = setInterval(tick, _streamPollInterval());
    };
    _streamPollRearm = arm;
    arm();
}

function startOfflineStatusPoll(username) {
    stopStreamStatusPoll();

    const tick = async () => {
        if (currentChannelUsername !== username) { stopStreamStatusPoll(); return; }
        // Drop back to the lazy cadence once the burst window has expired.
        if (_streamPollFast && Date.now() >= _streamPollFastUntil) arm();
        try {
            // Lightweight live-only endpoint — offline viewers only need to detect go-live,
            // not refetch VODs/clips/counts every 15s (the heavy channel endpoint).
            const data = await api(`/streams/channel/${username}/live`);
            const liveStreams = (data.streams || []).filter(s => s && s.is_live);
            if (liveStreams.length > 0) {
                stopStreamStatusPoll();
                loadChannelPage(username);
                toast(`${username} is now live!`, 'success');
            }
        } catch { /* silent */ }
    };

    const arm = () => {
        if (_streamPollTimer) clearInterval(_streamPollTimer);
        _streamPollFast = Date.now() < _streamPollFastUntil;
        _streamPollTimer = setInterval(tick, _streamPollInterval());
    };
    _streamPollRearm = arm;
    arm();
    // A viewer landing on the offline card right after the stream dropped is the
    // most likely person to be waiting on a quick restart — check once immediately
    // rather than burning the first full interval.
    if (Date.now() < _streamPollFastUntil) tick();
}

async function toggleChannelFollow(username) {
    if (!currentUser) return showModal('login');
    try {
        const data = await api(`/streams/channel/${username}/follow`, { method: 'POST' });
        // Update both live and offline follow buttons
        ['ch-btn-follow', 'ch-btn-follow-offline'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.toggle('following', data.following);
            btn.innerHTML = data.following
                ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
                : '<i class="fa-solid fa-heart"></i> Follow';
        });
        ['ch-follower-count', 'ch-follower-count-offline'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = `${data.count || 0} followers`;
        });
        toast(data.following ? 'Followed!' : 'Unfollowed', 'info');
    } catch (e) { toast(e.message, 'error'); }
}

async function banChannelUser(userId, username) {
    if (!userId || !username) return;
    const reason = prompt(`⚠️ GLOBAL BAN: Ban ${username} from the entire site?\n\nEnter reason:`);
    if (reason === null) return;
    try {
        if (typeof staffBanUser === 'function') {
            await staffBanUser(userId, username, reason || 'Banned from channel page', 0);
        } else {
            await api('/mod/global-ban', {
                method: 'POST',
                body: { user_id: userId, reason: reason || 'Banned from channel page' },
            });
            toast(`${username} banned from site`, 'success');
        }
    } catch (e) { toast(e.message || 'Ban failed', 'error'); }
}

/* ── Stream Viewer (legacy /stream/:id) ──────────────────────── */
async function openStream(streamId) {
    if (!streamId) return navigate('/');
    currentStreamId = streamId;

    try {
        const data = await api(`/streams/${streamId}`);
        const s = data.stream || data;
        currentStreamData = s;

        // If stream has a username, redirect to channel
        if (s.username) {
            return navigate(channelPath(s.username), true);
        }

        document.getElementById('stream-title').textContent = s.title || 'Untitled';
        document.getElementById('stream-streamer').textContent = s.username || 'Unknown';
        document.getElementById('streamer-avatar').textContent = (s.username || '?')[0].toUpperCase();
        document.getElementById('stream-description').textContent = s.description || '';
        document.getElementById('follower-count').textContent = `${s.follower_count || 0} followers`;

        if (typeof initPlayer === 'function') initPlayer(s);
        if (typeof initChat === 'function') initChat(streamId, s.user_id || _activeChannelUserId);
        if (typeof loadStreamControls === 'function') loadStreamControls(streamId);
        if (typeof startCoinHeartbeat === 'function') startCoinHeartbeat(streamId);
        if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(s.user_id);
        loadStreamGoals(streamId);
        startUptime(s.started_at);
    } catch (e) {
        toast('Stream not found', 'error');
        navigate('/');
    }
}

async function loadStreamGoals(streamId) {
    try {
        const data = await api(`/streams/${streamId}`);
        const s = data.stream || data;
        const goalsResp = await api(`/funds/goals/${s.user_id}`).catch(() => ({ goals: [] }));
        const goals = goalsResp.goals || [];
        const active = goals.find(g => g.is_active);
        if (active) {
            document.getElementById('goal-bar-wrap').style.display = '';
            document.getElementById('goal-label').textContent = active.title;
            const pct = Math.min(100, (active.current_amount / active.target_amount) * 100);
            document.getElementById('goal-fill').style.width = pct + '%';
            document.getElementById('goal-current').textContent = active.current_amount;
            document.getElementById('goal-target').textContent = active.target_amount;
        }
    } catch { /* silent */ }
}
function startUptime(startedAt) {
    clearInterval(uptimeInterval);
    if (!startedAt) return;
    const start = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
    const update = () => {
        const d = Date.now() - start;
        const h = Math.floor(d / 3600000);
        const m = Math.floor((d % 3600000) / 60000);
        const sec = Math.floor((d % 60000) / 1000);
        const el = document.getElementById('vc-uptime');
        if (el) el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };
    update();
    uptimeInterval = setInterval(update, 1000);
}
