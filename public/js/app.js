/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Core Application (SPA Router, Auth, API)
   URL-based routing with history.pushState
   ═══════════════════════════════════════════════════════════════ */

const API = '';   // same-origin
let currentUser = null;
let currentPage = 'home';
let currentStreamId = null;
let currentStreamData = null;
let _streamSwitchToken = 0; // increments each stream switch; guards against fast-switch races
let openvibeAppMetaData = null;
let openvibeAppMetaPromise = null;

function getDefaultOpenVibeNetworkUrls() {
    const host = window.location.hostname;
    const isLocalHost = ['localhost', '127.0.0.1'].includes(host);
    const isTopenvibeAlias = ['topenvibe.tools', 'topenvibe.live', 'topenvibe.quest'].includes(host);
    return {
        tools: isLocalHost ? 'http://localhost:3100' : (isTopenvibeAlias ? 'https://topenvibe.tools' : 'https://openvibe.network'),
        quest: isLocalHost ? 'http://localhost:3200' : (isTopenvibeAlias ? 'https://topenvibe.quest' : 'https://openvibe.games'),
    };
}

function getOpenVibeNetworkUrl(service) {
    const urls = window.OpenVibeNetworkUrls || getDefaultOpenVibeNetworkUrls();
    return (urls && urls[service]) ? urls[service] : getDefaultOpenVibeNetworkUrls()[service];
}

function getOpenVibeToolsUrl() {
    return getOpenVibeNetworkUrl('tools');
}

function getScraplandiaUrl() {
    return getOpenVibeNetworkUrl('quest');
}
/** Cached external viewer count (Kick/Twitch/RS) — updated by cumulative viewer poll */
let _cachedExternalViewerCount = 0;
/** Cached native HS viewer count from WebSocket — updated by stream-player.js WS handler */
let _cachedHsViewerCount = 0;

/* ── Capability helpers ────────────────────────────────────── */
function mergeUserWithCapabilities(user, capabilities) {
    if (!user) return null;
    return { ...user, capabilities: capabilities || user.capabilities || {} };
}

function getUserCapabilities(user = currentUser) {
    return user?.capabilities || {};
}

function hasCapability(capability, user = currentUser) {
    return !!getUserCapabilities(user)?.[capability];
}

function isStaffUser(user = currentUser) {
    return hasCapability('can_access_staff_console', user);
}

// Reserved paths (not usernames)
const RESERVED = new Set(['vods', 'clips', 'vod', 'clip', 'dashboard', 'settings', 'broadcast', 'admin', 'themes', 'game', 'canvas', 'chat', 'api', 'ws', 'media', 'pastes', 'p', 'updates', 'dmca', 'tos', 'terms', 'arena']);
const CHANNEL_USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function normalizeChannelUsername(username) {
    return String(username || '').trim().replace(/^@+/, '');
}

function channelPath(username, managedStreamIdOrSlug = null) {
    const clean = normalizeChannelUsername(username);
    if (!clean) return '/';
    const base = `/@${encodeURIComponent(clean)}`;
    if (managedStreamIdOrSlug === null || managedStreamIdOrSlug === undefined || managedStreamIdOrSlug === '') return base;
    return `${base}/${encodeURIComponent(String(managedStreamIdOrSlug))}`;
}

/** Inner img-or-letter for an element that is itself the avatar circle. */
function _avatarInner(url, name) {
    const letter = ((String(name || '?'))[0] || '?').toUpperCase();
    return url
        ? `<img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block" onerror="var p=this.parentNode;this.remove();if(p)p.textContent='${letter}'">`
        : letter;
}

/** Render a card avatar as the user's uploaded image (letter fallback on error/none). */
function _avatarSpan(url, name, color, extraCls) {
    const letter = ((String(name || '?'))[0] || '?').toUpperCase();
    const cls = extraCls ? ` ${extraCls}` : '';
    const bg = color ? ` style="background:${esc(color)}"` : '';
    return url
        ? `<span class="stream-card-avatar${cls}"${bg}><img src="${esc(url)}" alt="" onerror="var p=this.parentNode;this.remove();if(p)p.textContent='${letter}'"></span>`
        : `<span class="stream-card-avatar${cls}"${bg}>${letter}</span>`;
}

// AI-overview snippet for a card. Shows the cached SHORT summary; when a longer
// full overview exists, "Read overview" expands to it in place. `full` is optional.
function _cardAiHTML(text, full) {
    const short = (text || '').trim();
    const long = (full || '').trim();
    const display = short || long;
    if (!display) return '';
    const hasMore = long && long !== display && long.length > display.length;
    // Show the expander when there's a longer version, or the summary is long
    // enough that it's likely clamped. `_refineAiToggle` measures after layout and
    // removes the chevron if the text actually fits and there's nothing more — so
    // the button only stays when there's genuinely something to expand.
    // The chevron is a sibling of the clamped text (not inside it) so the 2-line
    // -webkit-line-clamp overflow can't clip it away; it sits at the bottom-right.
    const showToggle = hasMore || display.length > 100;
    return `<div class="card-ai-overview${showToggle ? '' : ' card-ai-static'}" role="button" tabindex="0" onclick="toggleCardAi(event,this)" onkeydown="if(event.key==='Enter'||event.key===' ')toggleCardAi(event,this)"${hasMore ? ` data-full="${esc(long)}"` : ''}>
        <div class="card-ai-clamp"><i class="fa-solid fa-wand-magic-sparkles"></i> <span class="card-ai-text">${esc(display)}</span></div>
        ${showToggle ? '<i class="card-ai-toggle fa-solid fa-chevron-down" aria-label="Toggle overview"></i>' : ''}
    </div>`;
}

// Toggle in-card AI-overview expansion — swaps the short summary for the full text.
function toggleCardAi(e, el) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const box = (el.closest && el.closest('.card-ai-overview')) || el;
    const expanded = box.classList.toggle('expanded');
    const textEl = box.querySelector('.card-ai-text');
    const full = box.dataset.full;
    if (textEl && full) {
        if (expanded) { box.dataset.short = textEl.textContent; textEl.textContent = full; }
        else if (box.dataset.short != null) { textEl.textContent = box.dataset.short; }
    }
}

// After layout, drop the expand chevron on overviews that have nothing to expand:
// no longer full version AND the summary isn't actually truncated by the clamp.
function _refineAiToggle(box) {
    if (!box || box.dataset.aiRefined || box.classList.contains('expanded')) return;
    const clamp = box.querySelector('.card-ai-clamp');
    if (!clamp || clamp.clientHeight === 0) return; // not laid out yet — try again later
    box.dataset.aiRefined = '1';
    const hasFull = !!box.dataset.full;
    const truncated = clamp.scrollHeight > clamp.clientHeight + 1;
    if (!hasFull && !truncated) {
        box.querySelector('.card-ai-toggle')?.remove();
        box.classList.add('card-ai-static');
        box.removeAttribute('role');
        box.removeAttribute('tabindex');
    }
}
function _scanAiToggles() {
    document.querySelectorAll('.card-ai-overview:not([data-ai-refined])').forEach(_refineAiToggle);
}
// Overviews are injected across many render paths — observe the DOM and refine
// each new one on the next frame (once it's laid out and measurable).
if (typeof MutationObserver !== 'undefined') {
    let _aiPending = false;
    const _aiObserver = new MutationObserver((muts) => {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.matches?.('.card-ai-overview') || n.querySelector?.('.card-ai-overview'))) {
                    if (!_aiPending) { _aiPending = true; requestAnimationFrame(() => { _aiPending = false; _scanAiToggles(); }); }
                    return;
                }
            }
        }
    });
    if (document.body) _aiObserver.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => _aiObserver.observe(document.body, { childList: true, subtree: true }));
}

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
}

// How long a stream slot has been live, from its started_at (SQLite UTC datetime).
function formatUptime(startedAt) {
    if (!startedAt) return '';
    const raw = String(startedAt);
    const isUTC = raw.includes('Z') || raw.includes('+') || raw.includes('T');
    const start = new Date(isUTC ? raw : raw.replace(' ', 'T') + 'Z').getTime();
    if (!Number.isFinite(start)) return '';
    let sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
}

/* ── API helpers ──────────────────────────────────────────────── */
function parseJwtExp(token) {
    if (!token) return null;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload || typeof payload.exp !== 'number') return null;
        return payload.exp;
    } catch {
        return null;
    }
}

function getStoredAuthToken() {
    const candidates = [
        localStorage.getItem('token'),
        localStorage.getItem('ov_token'),
        (document.cookie.match(/(?:^|; )ov_token=([^;]+)/) || [])[1],
        (document.cookie.match(/(?:^|; )token=([^;]+)/) || [])[1],
    ].filter(Boolean);

    if (!candidates.length) return null;

    const now = Math.floor(Date.now() / 1000);
    const valid = candidates.map(token => ({
        token,
        exp: parseJwtExp(token),
    })).filter(item => item.token && (item.exp === null || item.exp > now));

    const chosen = valid.length
        ? valid.sort((a, b) => (b.exp || 0) - (a.exp || 0))[0].token
        : candidates[0];

    if (chosen && chosen !== localStorage.getItem('token')) {
        try {
            localStorage.setItem('token', chosen);
            localStorage.setItem('ov_token', chosen);
        } catch {
            // ignore quota issues
        }
    }

    return chosen;
}

function authHeaders() {
    const tok = getStoredAuthToken();
    return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function api(path, opts = {}) {
    const res = await fetch(`${API}/api${path}`, {
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers },
        ...opts,
        body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });

    // Auto-refresh on 401 (expired JWT) — try once
    if (res.status === 401 && !opts._retried) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
            return api(path, { ...opts, _retried: true });
        }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { status: res.status, message: data.error || 'Request failed', data };
    return data;
}

/** Attempt to refresh the access token using the httpOnly refresh cookie */
let _refreshPromise = null;
async function tryRefreshToken() {
    // Coalesce concurrent refresh attempts
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
        try {
            const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
            if (!res.ok) return false;
            const data = await res.json();
            if (data.access_token) {
                // Sync both localStorage keys so shared libs (account-switcher) stay in sync
                localStorage.setItem('token', data.access_token);
                localStorage.setItem('ov_token', data.access_token);
                // Update account-switcher token for the active account
                _syncAccountSwitcherToken(data.access_token);
                return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            _refreshPromise = null;
        }
    })();
    return _refreshPromise;
}

/** Keep the shared account-switcher's stored token in sync */
function _syncAccountSwitcherToken(newToken) {
    try {
        const raw = localStorage.getItem('openvibe_accounts');
        if (!raw) return;
        const accounts = JSON.parse(raw);
        const activeId = localStorage.getItem('openvibe_active_account');
        for (const acct of accounts) {
            if (String(acct.id) === activeId) {
                acct.token = newToken;
                break;
            }
        }
        localStorage.setItem('openvibe_accounts', JSON.stringify(accounts));
    } catch { /* non-critical */ }
}

/** Check if stored token is expiring soon or already expired */
function _isTokenExpiringSoon() {
    const token = localStorage.getItem('token');
    if (!token) return false;
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const expiresIn = (payload.exp * 1000) - Date.now();
        return expiresIn < 2 * 60 * 60 * 1000; // < 2 hours remaining (or already expired)
    } catch { return true; } // malformed = treat as expiring
}

/** Proactively refresh token before it expires */
function startTokenRefreshTimer() {
    // Periodic check every 15 min
    setInterval(async () => {
        if (_isTokenExpiringSoon()) await tryRefreshToken();
    }, 15 * 60 * 1000);

    // Also check immediately when tab becomes visible (handles background throttling)
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && _isTokenExpiringSoon()) {
            await tryRefreshToken();
        }
    });
}

/* ── Protocol Badge ───────────────────────────────────────────── */
function protocolBadge(protocol) {
    if (!protocol) return '';
    const labels = { jsmpeg: 'JSMPEG', webrtc: 'WebRTC', rtmp: 'RTMP' };
    return `<span class="protocol-badge protocol-${protocol}">${labels[protocol] || protocol.toUpperCase()}</span>`;
}

function streamTypeBadge(browserMode, streamingMethod) {
    if (!browserMode || (streamingMethod && streamingMethod !== 'browser')) return '';
    const types = {
        screen: { icon: 'fa-display', label: 'Screen Share' },
        mic_only: { icon: 'fa-microphone', label: 'Audio Only' },
        camera_only: { icon: 'fa-video', label: 'Camera' },
        camera: { icon: 'fa-video', label: 'Camera & Mic' },
    };
    const t = types[browserMode];
    if (!t || browserMode === 'camera') return '';
    return `<span class="stream-type-badge stream-type-${browserMode}"><i class="fa-solid ${t.icon}"></i> ${t.label}</span>`;
}

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

/* ── Toast ────────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const icons = {
        success: 'fa-check-circle',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info: 'fa-info-circle',
    };
    while (c.children.length >= 3) c.firstChild?.remove();
    const text = msg == null ? '' : String(msg);
    const isPassiveEarnToast = /\+\d+\s+OpenVibe\s+(Coins|OpenCoins)\s+earned/i.test(text);
    const durations = { success: 2400, info: 2400, warning: 3000, error: 3400 };
    const el = document.createElement('div');
    el.className = `toast ${type}${isPassiveEarnToast ? ' toast-passive' : ''}`;
    el.setAttribute('role', 'status');
    el.title = 'Left-click to dismiss · right-click to copy';
    const icon = document.createElement('i');
    icon.className = `fa-solid ${icons[type] || icons.info}`;
    el.appendChild(icon);
    // Text in its own span so it can be selected/copied cleanly.
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = ` ${text}`;
    el.appendChild(span);
    c.appendChild(el);

    let removed = false;
    const dismiss = () => {
        if (removed) return; removed = true;
        el.style.opacity = '0';
        el.style.transform = 'translate3d(0, -8px, 0) scale(0.98)';
        setTimeout(() => el.remove(), 220);
    };
    const baseTimeout = isPassiveEarnToast ? 1600 : (durations[type] || 2600);
    let timer = setTimeout(dismiss, baseTimeout);
    // Hovering pauses auto-dismiss so you can read / select / copy long error text.
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { clearTimeout(timer); timer = setTimeout(dismiss, 1200); });
    // Left-click dismisses — unless you're mid-selection inside the toast.
    el.addEventListener('click', () => {
        const sel = (window.getSelection && window.getSelection().toString()) || '';
        if (!sel) dismiss();
    });
    // Right-click copies the toast text to the clipboard (and keeps it up a moment).
    el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const flash = () => { el.classList.add('toast-copied'); clearTimeout(timer); timer = setTimeout(dismiss, 1400); };
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove();
            } catch { /* */ }
            flash();
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(flash, fallback);
            } else fallback();
        } catch { fallback(); }
    });
}
// Expose app-level toast under a stable name so chat.js (loaded after this file)
// can delegate to it without triggering infinite recursion.
window._appToast = toast;

/* ── OpenVibeApp Popover ─────────────────────────────────────────── */
function toggleOpenVibeAppPopover() {
    const popover = document.getElementById('openvibeapp-popover');
    const link = document.querySelector('.promo-bar-link');
    if (!popover) return;
    const isOpen = popover.classList.toggle('open');
    if (link) link.classList.toggle('open', isOpen);
    if (isOpen) void loadOpenVibeAppMeta();
}
// Close popover when clicking outside
document.addEventListener('click', (e) => {
    const popover = document.getElementById('openvibeapp-popover');
    if (!popover || !popover.classList.contains('open')) return;
    if (e.target.closest('.openvibeapp-popover') || e.target.closest('.promo-bar-link')) return;
    popover.classList.remove('open');
    const link = document.querySelector('.promo-bar-link');
    if (link) link.classList.remove('open');
});

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderOpenVibeAppMeta(data) {
    if (!data) return;

    const version = data.displayVersion || data.packageVersion || 'Unknown';
    const latestRelease = data.latestRelease;
    const latestCommit = data.latestCommit || {};
    const repo = data.repo || {};

    setText('openvibeapp-version', version);
    setText('openvibeapp-meta-version', version);
    setText(
        'openvibeapp-meta-version-sub',
        latestRelease?.publishedAt
            ? `Released ${timeAgo(latestRelease.publishedAt)} · ${formatDateTime(latestRelease.publishedAt)}`
            : data.packageVersion
                ? `Package version on ${repo.defaultBranch || 'main'}`
                : 'No tagged release yet'
    );

    setText('openvibeapp-meta-commit', latestCommit.shortSha || 'Unknown');
    setText(
        'openvibeapp-meta-commit-sub',
        latestCommit.committedAt
            ? `Committed ${timeAgo(latestCommit.committedAt)} · ${formatDateTime(latestCommit.committedAt)}`
            : 'Latest commit time unavailable'
    );

    setText('openvibeapp-meta-pushed', repo.pushedAt ? timeAgo(repo.pushedAt) : 'Unknown');
    setText(
        'openvibeapp-meta-pushed-sub',
        repo.pushedAt ? formatDateTime(repo.pushedAt) : 'Repository push time unavailable'
    );

    setText('openvibeapp-meta-stars', Number(repo.stars || 0).toLocaleString());
    setText('openvibeapp-meta-stars-sub', `${Number(repo.forks || 0).toLocaleString()} forks · ${Number(repo.openIssues || 0).toLocaleString()} open issues`);
    setText('openvibeapp-commit-message', latestCommit.message || 'Latest commit message unavailable');

    const commitLink = document.getElementById('openvibeapp-commit-link');
    if (commitLink) commitLink.href = latestCommit.htmlUrl || repo.htmlUrl || 'https://github.com/OpenVibe.Live/OpenVibeApp';

    const ctaSub = document.getElementById('openvibeapp-cta-sub');
    if (ctaSub) {
        ctaSub.innerHTML = `<i class="fa-solid fa-code-branch"></i> Latest push ${esc(repo.pushedAt ? timeAgo(repo.pushedAt) : 'unknown')} &nbsp;·&nbsp; <i class="fa-solid fa-code-commit"></i> ${esc(latestCommit.shortSha || 'n/a')} &nbsp;·&nbsp; <i class="fa-brands fa-windows"></i> <i class="fa-brands fa-linux"></i> <i class="fa-brands fa-apple"></i> Windows, Linux & macOS`;
    }
}

function renderOpenVibeAppMetaError(message = 'Unable to load OpenVibeApp GitHub data right now') {
    setText('openvibeapp-version', 'GitHub offline');
    setText('openvibeapp-meta-version', 'Unavailable');
    setText('openvibeapp-meta-version-sub', message);
    setText('openvibeapp-meta-commit', 'Unavailable');
    setText('openvibeapp-meta-commit-sub', 'Could not fetch latest commit');
    setText('openvibeapp-meta-pushed', 'Unavailable');
    setText('openvibeapp-meta-pushed-sub', 'Could not fetch repository activity');
    setText('openvibeapp-meta-stars', '—');
    setText('openvibeapp-meta-stars-sub', 'GitHub metadata unavailable');
    setText('openvibeapp-commit-message', message);
}

async function loadOpenVibeAppMeta(force = false) {
    if (!force && openvibeAppMetaData) {
        renderOpenVibeAppMeta(openvibeAppMetaData);
        return openvibeAppMetaData;
    }
    if (!force && openvibeAppMetaPromise) return openvibeAppMetaPromise;

    openvibeAppMetaPromise = api('/meta/openvibeapp')
        .then((data) => {
            openvibeAppMetaData = data;
            renderOpenVibeAppMeta(data);
            return data;
        })
        .catch((error) => {
            renderOpenVibeAppMetaError(error?.message || 'Failed to load latest OpenVibeApp GitHub info');
            throw error;
        })
        .finally(() => {
            openvibeAppMetaPromise = null;
        });

    return openvibeAppMetaPromise;
}

/* ── Modal ────────────────────────────────────────────────────── */
function showModal(id) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    const templates = {
        login: `
            <h3><i class="fa-solid fa-right-to-bracket"></i> Sign In</h3>
            <p style="color:var(--text-muted);margin-bottom:16px">Sign in with your OpenVibe account to continue.</p>
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;text-decoration:none;border:none;cursor:pointer">
                <i class="fa-solid fa-network-wired"></i> Sign in with OpenVibe
            </a>
            <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Don't have an account? One will be created when you sign in.</p>`,
        register: `
            <h3><i class="fa-solid fa-user-plus"></i> Sign Up</h3>
            <p style="color:var(--text-muted);margin-bottom:16px">Create your account on the OpenVibe.</p>
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;text-decoration:none;border:none;cursor:pointer">
                <i class="fa-solid fa-network-wired"></i> Sign in with OpenVibe
            </a>
            <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Registration is handled on openvibe.network</p>`,
        donate: openvibeBucksDonateModal(),
        'buy-funds': openvibeBucksBuyModal(),
        cashout: openvibeBucksCashoutModal(),
        'stream-key': streamKeyModal(),
        'add-camera': addCameraModal(),
        'discover-cameras': discoverCamerasModal(),
        'create-config': createConfigModal(),
        'add-config-button': addConfigButtonModal(),
        'add-goal': addGoalModal(),
        'add-reward': addRewardModal(),
        'redeem-reward': (data) => redeemRewardModal(data),
        'create-managed-stream': createManagedStreamModal,
    };
    content.innerHTML = typeof templates[id] === 'function' ? templates[id]() : (templates[id] || `<p>Unknown modal: ${id}</p>`);
    overlay.classList.add('show');
    if (id === 'buy-funds' && typeof _initBuyBucks === 'function') _initBuyBucks();
    if (id === 'donate' && typeof _loadDonateGoals === 'function') _loadDonateGoals();
    // Balance-first donate flow + the streamer's direct-PowerChat option.
    if (id === 'donate' && typeof _initDonateModal === 'function') _initDonateModal();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('show');
}

/* ── Auth ──────────────────────────────────────────────────────── */
// Local login/register removed — all auth goes through OpenVibe SSO
function doLogin() { window.location.href = '/api/auth/sso/login'; }
function doRegister() { window.location.href = '/api/auth/sso/login'; }

function logout() {
    // Clear server-side cookies via API
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    // Clear client-side storage (both keys)
    localStorage.removeItem('token');
    localStorage.removeItem('ov_token');
    // Also clear cookies client-side as fallback
    document.cookie = 'token=;Max-Age=0;path=/';
    document.cookie = 'ov_token=;Max-Age=0;path=/';
    currentUser = null;
    onAuthChange();
    if (typeof destroyCall === 'function') destroyCall();
    if (typeof destroyCanvasPage === 'function') destroyCanvasPage();
    // Clear notification bell
    if (window.OpenVibeNotifications) OpenVibeNotifications.setToken(null);
    const bellMount = document.getElementById('openvibe-bell-mount');
    if (bellMount) bellMount.innerHTML = '';
    if (['dashboard', 'admin', 'broadcast', 'settings'].includes(currentPage)) navigate('/');
    toast('Logged out', 'info');
}

async function loadUser() {
    let tok = localStorage.getItem('token');
    if (!tok) {
        // No token in localStorage — try refreshing from httpOnly cookie
        const refreshed = await tryRefreshToken();
        if (!refreshed) return;
        tok = localStorage.getItem('token');
    }
    // If token is already expired, proactively refresh before making the API call
    // (avoids a wasted 401 round-trip)
    if (tok && _isTokenExpiringSoon()) {
        await tryRefreshToken();
    }
    try {
        const data = await api('/auth/me');
        currentUser = mergeUserWithCapabilities(data.user || data, data.capabilities);
    } catch (err) {
        // If still 401 after auto-refresh attempt in api(), give up
        localStorage.removeItem('token');
        localStorage.removeItem('ov_token');
    }
}

function onAuthChange() {
    const anon = document.getElementById('nav-auth-anon');
    const user = document.getElementById('nav-auth-user');
    const admin = document.getElementById('nav-admin');

    // The nav chrome doesn't exist in every document that loads app.js (e.g. the
    // popout chat window), so guard it — the auth-changed event below must still fire.
    if (anon && user) {
        if (currentUser) {
            anon.style.display = 'none';
            user.style.display = 'flex';
            if (admin) admin.style.display = (currentUser.capabilities?.admin_panel || hasCapability('can_access_staff_console')) ? '' : 'none';
            // Admin Panel link in the user dropdown — admins/owners only (mods can't access it).
            const ddAdmin = document.getElementById('user-dropdown-admin');
            if (ddAdmin) ddAdmin.style.display = (currentUser.role === 'admin' || currentUser.capabilities?.is_owner) ? '' : 'none';
            const navAv = document.getElementById('nav-avatar');
            if (navAv) navAv.innerHTML = _avatarInner(currentUser.avatar_url, currentUser.username);
            const navUn = document.getElementById('nav-username');
            if (navUn) navUn.textContent = currentUser.display_name || currentUser.username;
            loadBalance();
        } else {
            anon.style.display = '';
            user.style.display = 'none';
            if (admin) admin.style.display = 'none';
        }
    } else if (currentUser) {
        loadBalance();
    }
    // Go Live nav is always visible (logged out → prompts sign-up); its Dashboard
    // sub-menu + caret only apply when logged in.
    const goliveMenu = document.getElementById('nav-golive-menu');
    if (goliveMenu) goliveMenu.style.display = currentUser ? '' : 'none';
    const goliveCaret = document.querySelector('#nav-golive-dropdown .nav-dd-caret');
    if (goliveCaret) goliveCaret.style.display = currentUser ? '' : 'none';
    document.getElementById('user-dropdown')?.classList.remove('show');

    // Sync canvas auth state if canvas page is loaded
    if (typeof syncCanvasAuthState === 'function') syncCanvasAuthState();

    try {
        window.dispatchEvent(new CustomEvent('openvibe-auth-changed', {
            detail: {
                user: currentUser || null,
                token: localStorage.getItem('token') || null,
            },
        }));
    } catch {}
}

async function loadBalance() {
    if (!currentUser) return;
    try {
        const data = await api('/funds/balance');
        const bal = Math.round(data.balance || 0);
        const balEl = document.getElementById('nav-balance-amount');
        if (balEl) balEl.textContent = bal.toLocaleString();
    } catch { /* silent */ }
    // Navbar OpenCoins = the GLOBAL currency (game / cosmetics / media wallet).
    try {
        const coinData = await api('/coins/balance');
        const coins = coinData.balance || 0;
        const coinEl = document.getElementById('nav-coins-amount');
        if (coinEl) coinEl.textContent = coins.toLocaleString();
    } catch { /* silent */ }
}

// The viewer's per-streamer CHANNEL POINTS (shown in the in-chat button + rewards
// panel), for the streamer they're currently watching. Not the navbar (that's the
// global OpenCoins wallet).
let _navPointsStreamerId = null;
async function updateChannelPointsNav(streamerId) {
    _navPointsStreamerId = (streamerId && (!currentUser || String(streamerId) !== String(currentUser.id))) ? streamerId : null;
    if (!_navPointsStreamerId) return;
    try {
        const d = await api(`/coins/channel-balance?streamerId=${_navPointsStreamerId}`);
        const bal = (d.balance || 0).toLocaleString();
        document.querySelectorAll('.rewards-coin-balance').forEach(x => { x.textContent = bal; });
    } catch { /* silent */ }
}
function openChannelRewards() {
    if (typeof toggleRewardsPanel === 'function') toggleRewardsPanel();
}

function toggleUserMenu() {
    document.getElementById('user-dropdown').classList.toggle('show');
}

function closeMobileNav() {
    document.querySelector('.nav-links')?.classList.remove('show');
    document.querySelector('.nav-hamburger')?.classList.remove('open');
}

function toggleMobileNav() {
    const navLinks = document.querySelector('.nav-links');
    const hamburger = document.querySelector('.nav-hamburger');
    navLinks.classList.toggle('show');
    hamburger?.classList.toggle('open', navLinks.classList.contains('show'));
}

function isModifiedLinkClick(event) {
    return !!(event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey));
}

function handleLinkClick(event, urlPath, replace = false) {
    if (isModifiedLinkClick(event)) return true;
    event?.preventDefault?.();
    navigate(urlPath, replace);
    return false;
}

function handleDropdownLinkClick(event, dropdownId) {
    if (isModifiedLinkClick(event)) return true;
    event?.preventDefault?.();
    toggleNavDropdown(dropdownId);
    return false;
}

// Go Live nav button — always visible. Logged in → the broadcast workspace;
// logged out → prompt to sign up ("begin your streaming journey").
function goLiveNav(event) {
    if (isModifiedLinkClick(event)) return true;
    event?.preventDefault?.();
    if (currentUser) navigate('/broadcast');
    else if (typeof showModal === 'function') showModal('register');
    return false;
}
// Dashboard (Go Live sub-menu). Logged out → sign-up prompt.
function dashNav(event) {
    if (isModifiedLinkClick(event)) return true;
    event?.preventDefault?.();
    if (typeof closeNavDropdowns === 'function') closeNavDropdowns();
    if (currentUser) navigate('/dashboard');
    else if (typeof showModal === 'function') showModal('register');
    return false;
}

/* ── SPA Router (URL-based) ───────────────────────────────────── */
function navigate(urlPath, replace = false) {
    closeMobileNav();

    // Clean up existing page state (destroy player, disconnect chat, etc.)
    if (typeof destroyPlayer === 'function') destroyPlayer();
    if (typeof destroyChat === 'function') destroyChat();
    if (typeof destroyCanvasPage === 'function') destroyCanvasPage();
    if (typeof stopCoinHeartbeat === 'function') stopCoinHeartbeat();
    if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(null);
    if (typeof stopHomeRefresh === 'function') stopHomeRefresh();
    if (typeof stopStreamStatusPoll === 'function') stopStreamStatusPoll();
    clearInterval(uptimeInterval);

    // Clean up live VOD poll timer
    if (window._liveVodPollTimer) {
        clearInterval(window._liveVodPollTimer);
        window._liveVodPollTimer = null;
        window._liveVodIsLive = false;
    }
    if (window._globalAiPollTimer) {
        clearInterval(window._globalAiPollTimer);
        window._globalAiPollTimer = null;
    }

    // Normalize path
    if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;

    // Push to browser history
    if (replace) {
        history.replaceState(null, '', urlPath);
    } else {
        history.pushState(null, '', urlPath);
    }

    routeFromURL();
}

const DEFAULT_PAGE_TITLE = 'OpenVibe.Live — Free Open Source Live Streaming Platform';
/** Set the browser tab title to the content being viewed (stream/VOD/clip/paste). */
function setPageTitle(name) {
    document.title = name ? `${String(name).slice(0, 90)} · OpenVibe.Live` : DEFAULT_PAGE_TITLE;
}
window.setPageTitle = setPageTitle;

function routeFromURL() {
    // Remove the server-rendered SEO prerender block once the SPA takes over (it's crawlable
    // content for no-JS scrapers; JS clients render the real interactive page instead).
    try { document.getElementById('seo-prerender')?.remove(); } catch { /* */ }
    setPageTitle(null); // reset to default; per-route loaders set it once content loads
    const path = window.location.pathname;
    const segments = path.split('/').filter(Boolean);

    // Clean up existing page state
    if (typeof destroyPlayer === 'function') destroyPlayer();

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.nav-links')?.classList.remove('show');

    window.scrollTo(0, 0);

    // Route matching
    if (segments.length === 0) {
        // Home: /
        showPage('home');
        loadHome();
    } else if (segments[0] === 'vods') {
        showPage('vods');
        loadVodsPage();
    } else if (segments[0] === 'clips') {
        showPage('clips');
        loadClipsPage();
    } else if (segments[0] === 'vod' && segments[1]) {
        // VOD player: /vod/:id  (optional ?t=<seconds> to auto-seek, e.g. from a clip link)
        showPage('vod-player');
        const _t = parseFloat(new URLSearchParams(window.location.search).get('t'));
        loadVodPlayer(segments[1], Number.isFinite(_t) && _t > 0 ? _t : null);
    } else if (segments[0] === 'clip' && segments[1]) {
        // Clip player: /clip/:id
        showPage('clip-player');
        loadClipPlayer(segments[1]);
    } else if (segments[0] === 'dashboard') {
        showPage('dashboard');
        loadDashboard();
    } else if (segments[0] === 'settings') {
        // /settings was merged into the dashboard — redirect there.
        navigate('/dashboard', true);
        return;
    } else if (segments[0] === 'broadcast') {
        showPage('broadcast');
        loadBroadcastPage();
    } else if (segments[0] === 'admin') {
        window.location.href = `${getOpenVibeToolsUrl()}/admin`;
        return;
    } else if (segments[0] === 'themes') {
        // Theme management moved to the central openvibe.network account app.
        window.location.href = 'https://openvibe.network/themes';
        return;
    } else if (segments[0] === 'chat') {
        showPage('chat');
        loadChatPage();
    } else if (segments[0] === 'game') {
        window.location.href = `${getScraplandiaUrl()}/game`;
        return;
    } else if (segments[0] === 'canvas') {
        window.location.href = `${getScraplandiaUrl()}/canvas`;
        return;
    } else if (segments[0] === 'pastes') {
        showPage('pastes');
        loadPastesPage();
        // Handle ?edit=slug
        const editSlug = new URLSearchParams(window.location.search).get('edit');
        if (editSlug) {
            api(`/pastes/${editSlug}`).then(data => {
                if (data.paste) openNewPasteModal({
                    title: data.paste.title,
                    content: data.paste.content,
                    language: data.paste.language,
                    visibility: data.paste.visibility,
                    slug: editSlug,
                });
            }).catch(() => {});
        }
    } else if (segments[0] === 'arena') {
        showPage('arena');
        if (typeof loadArenaPage === 'function') loadArenaPage(segments);
    } else if (segments[0] === 'updates') {
        showPage('updates');
        loadUpdatesPage();
    } else if (segments[0] === 'dmca') {
        window.location.replace('/dmca');
        return;
    } else if (segments[0] === 'tos' || segments[0] === 'terms') {
        window.location.replace('/tos');
        return;
    } else if (segments[0] === 'privacy') {
        window.location.replace('/privacy');
        return;
    } else if (segments[0] === 'p' && segments[1]) {
        showPage('paste-viewer');
        loadPasteViewer(segments[1]);
    } else if (segments[0] === 'documentation') {
        showPage('documentation');
        initDocsTabScroller();
    } else if (segments[0] === 'stream' && segments[1]) {
        // Legacy stream URL: /stream/:id
        showPage('stream');
        openStream(segments[1]);
    } else if (segments.length >= 1 && segments[0].startsWith('@')) {
        // Channel page: /@username or /@username/:managedStreamIdOrSlug
        // Backward compat: /@username?stream=sessionId
        const username = normalizeChannelUsername(segments[0]);
        if (CHANNEL_USERNAME_RE.test(username)) {
            showPage('channel');
            const managedStreamRef = segments[1] || null;
            const legacyStreamParam = new URLSearchParams(window.location.search).get('stream');
            loadChannelPage(username, managedStreamRef, legacyStreamParam ? parseInt(legacyStreamParam, 10) : null);
        } else {
            showPage('home');
            loadHome();
        }
    } else {
        // 404 fallback
        showPage('home');
        loadHome();
    }
}

function showPage(page) {
    currentPage = page;
    const el = document.getElementById(`page-${page}`);
    if (el) el.classList.add('active');

    // Game/Canvas: hide footer only, keep navbar visible; other pages restore both
    const navbar = document.querySelector('.navbar');
    const footer = document.querySelector('.footer');
    if (page === 'game' || page === 'canvas') {
        if (footer) footer.style.display = 'none';
        document.body.style.overflow = 'hidden';
    } else {
        if (navbar) navbar.style.display = '';
        if (footer) footer.style.display = '';
        document.body.style.overflow = '';
    }

    // Highlight nav link
    const pageToNav = { home: 'home', vods: 'vods', clips: 'clips', broadcast: 'broadcast', dashboard: 'dashboard', admin: 'admin', chat: 'chat', game: 'game', canvas: 'game', pastes: 'pastes', 'paste-viewer': 'pastes', arena: 'arena' };
    const navPage = pageToNav[page];
    if (navPage) {
        const link = document.querySelector(`.nav-link[data-page="${navPage}"]`);
        if (link) link.classList.add('active');
    }
    updateNavHeroTransparency();
}

// Transparent nav over the home hero: it blends into the hero at the very top and its glass
// background fades in as soon as you scroll down. Only on the home page — every other page
// keeps its solid nav from the top.
function updateNavHeroTransparency() {
    const nav = document.querySelector('.navbar');
    if (!nav) return;
    const homeActive = document.getElementById('page-home')?.classList.contains('active');
    const atTop = (window.scrollY || window.pageYOffset || 0) < 28;
    nav.classList.toggle('nav-hero-top', !!homeActive && atTop);
}
// One class toggle per animation frame at most — the handler fired on every scroll event,
// which on phones (with a blurred nav over an animated hero) showed up as scroll jank.
let _navScrollRaf = 0;
window.addEventListener('scroll', () => { if (_navScrollRaf) return; _navScrollRaf = requestAnimationFrame(() => { _navScrollRaf = 0; updateNavHeroTransparency(); }); }, { passive: true });
window.addEventListener('resize', updateNavHeroTransparency, { passive: true });

/* ── Nav Dropdown Helpers ──────────────────────────────────────── */
function toggleNavDropdown(id) {
    const dd = document.getElementById(id);
    if (!dd) return;
    const wasOpen = dd.classList.contains('open');
    closeNavDropdowns();
    if (!wasOpen) dd.classList.add('open');
}

function closeNavDropdowns() {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
}

// Close nav dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-dropdown')) closeNavDropdowns();
});

/* ── Nav Scroll Overflow Detection ─────────────────────────────── */
function checkNavOverflow() {
    const nl = document.querySelector('.nav-links');
    if (!nl) return;
    const hasOverflow = nl.scrollWidth > nl.clientWidth + 2;
    const left = document.getElementById('nav-scroll-left');
    const right = document.getElementById('nav-scroll-right');
    const atStart = nl.scrollLeft <= 1;
    const atEnd = nl.scrollLeft >= nl.scrollWidth - nl.clientWidth - 1;
    if (left) left.classList.toggle('visible', hasOverflow && !atStart);
    if (right) right.classList.toggle('visible', hasOverflow && !atEnd);
}

function scrollNavLinks(dir) {
    const nl = document.querySelector('.nav-links');
    if (!nl) return;
    nl.scrollBy({ left: dir * 160, behavior: 'smooth' });
    // Poll until scroll settles (smooth scroll can take 300-600ms)
    let checks = 0;
    let lastPos = nl.scrollLeft;
    const poll = setInterval(() => {
        checkNavOverflow();
        if (nl.scrollLeft === lastPos || ++checks > 12) clearInterval(poll);
        lastPos = nl.scrollLeft;
    }, 60);
}

// Position fixed dropdown menus below their triggers
function positionNavDropdownMenu(dropdown) {
    const menu = dropdown?.querySelector('.nav-dropdown-menu');
    const trigger = dropdown?.querySelector('.nav-link');
    if (!menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom}px`;
    menu.style.left = `${rect.left}px`;
}

// Observe hover/open to position dropdown menus
document.querySelectorAll('.nav-dropdown').forEach(dd => {
    dd.addEventListener('mouseenter', () => positionNavDropdownMenu(dd));
    dd.addEventListener('click', () => positionNavDropdownMenu(dd));
});

// Listen for scroll and resize to update nav overflow arrows
{
    const nl = document.querySelector('.nav-links');
    if (nl) {
        nl.addEventListener('scroll', checkNavOverflow, { passive: true });
        new ResizeObserver(checkNavOverflow).observe(nl);
    }
    // Also check on login (new nav items may appear)
    window.addEventListener('load', () => setTimeout(checkNavOverflow, 500));
}

/* ── Home Page ────────────────────────────────────────────────── */
const HERO_ROTATE_WORDS = [
    'stealth campers', 'nomads', 'outdoor enthusiasts',
    'nerds', 'IRL streamers', 'desktop gamers', 'openvibes',
    'van dwellers', 'digital nomads', 'backpackers',
    'overlanders', 'thru-hikers', 'urban explorers',
    'tinkerers', 'makers', 'coders',
];
let _heroRotateIdx = 0;
let _heroRotateTimer = null;

function startHeroRotation(words) {
    const list = (Array.isArray(words) && words.length) ? words : HERO_ROTATE_WORDS;
    const el = document.getElementById('hero-rotate');
    if (!el) return;
    _heroRotateIdx = 0;
    el.textContent = list[0];
    el.classList.add('visible');
    if (_heroRotateTimer) clearInterval(_heroRotateTimer);
    _heroRotateTimer = setInterval(() => {
        el.classList.remove('visible');
        setTimeout(() => {
            _heroRotateIdx = (_heroRotateIdx + 1) % list.length;
            el.textContent = list[_heroRotateIdx];
            el.classList.add('visible');
        }, 400);
    }, 3000);
}

// ── Hero quip rotator (funny AI-generated slogans) ──────────────
const HERO_FALLBACK_QUIPS = [
    'No ads. No investors. No suits. Just vibes.',
    'Built by openvibes, for openvibes.',
    "Corporate streaming? We don't know her.",
    'Open source and proud of it.',
    'Low latency, high chaos.',
    'The internet campfire you forgot you wanted.',
];
let _heroQuipIdx = 0, _heroQuipTimer = null;
function startHeroQuips(quips) {
    const el = document.getElementById('hero-quip');
    if (!el) return;
    const list = (Array.isArray(quips) && quips.length) ? quips : HERO_FALLBACK_QUIPS;
    _heroQuipIdx = 0;
    el.textContent = list[0];
    el.classList.add('visible');
    if (_heroQuipTimer) clearInterval(_heroQuipTimer);
    _heroQuipTimer = setInterval(() => {
        el.classList.remove('visible');
        setTimeout(() => {
            _heroQuipIdx = (_heroQuipIdx + 1) % list.length;
            el.textContent = list[_heroQuipIdx];
            el.classList.add('visible');
        }, 400);
    }, 5000);
}

// ── Hero stats bar (animated count-up) ──────────────────────────
function _heroStatFmt(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    return n.toLocaleString();
}
function _heroCountUp(el, target) {
    const dur = 1100, start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = _heroStatFmt(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step); else el.textContent = _heroStatFmt(target);
    };
    requestAnimationFrame(step);
}
function renderHeroStats(stats) {
    const wrap = document.getElementById('hero-stats');
    if (!wrap || !stats) return;
    // One stat BOARD: every themed group is a full-width row (kicker on the left, chips
    // on a shared column grid), so rows line up edge to edge instead of floating as
    // differently-sized islands. Chips keep short uniform labels (full meaning in the
    // title tooltip) so a long label never dwarfs its number.
    const R = stats.recent || {};
    const groups = [];

    // ── Right now ────────────────────────────────────────────────
    const now = [
        { cls: stats.liveNow > 0 ? 'hero-stat--live' : '', icon: stats.liveNow > 0 ? 'fa-circle' : 'fa-circle-dot', num: stats.liveNow, label: 'Live', title: stats.liveNow > 0 ? 'Streams live right now' : 'Nobody is live right now — check Recently Online below' },
        { cls: stats.viewersNow > 0 ? 'hero-stat--live' : '', icon: 'fa-eye', num: stats.viewersNow, label: 'Watching', title: 'Viewers watching right now' },
        { icon: 'fa-fire', num: stats.weeklyActive, label: 'Active · 7d', title: 'People who chatted in the last 7 days', desc: 'Distinct chatters in the last 7 days — signed-in users, anonymous chatters and relayed (Twitch/Kick/YouTube) chatters, each counted once.', metric: 'active' },
        { icon: 'fa-user-plus', num: stats.weeklyVisitors, label: 'Visitors · 7d', title: 'First-time visitors in the last 7 days', desc: 'Browsers seen on the site for the first time in the last 7 days (a privacy-safe fingerprint, no account needed). A proxy for new people showing up, not just chatting.', metric: 'visitors' },
    ];
    // 24h viewer sparkline (5-minute samples) — trends read better than a snapshot.
    const trend = Array.isArray(stats.viewerTrend) ? stats.viewerTrend : [];
    if (trend.length >= 2 && trend.some(t => (t.viewers || 0) > 0)) {
        const max = Math.max(...trend.map(t => t.viewers || 0), 1);
        const W = 220, H = 30;
        const pts = trend.map((t, i) => `${(i / (trend.length - 1) * W).toFixed(1)},${(H - 2 - ((t.viewers || 0) / max) * (H - 4)).toFixed(1)}`).join(' ');
        now.push({
            html: `<div class="hero-stat hero-stat--spark" title="Viewers over the last 24h (peak ${max})">
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                </svg><span class="hero-stat-label">24h viewers · peak ${max}</span></div>`,
        });
    }
    groups.push({ kicker: 'Right now', icon: 'fa-bolt', rows: now });

    // ── Community ────────────────────────────────────────────────
    groups.push({
        kicker: 'Community', icon: 'fa-people-group', rows: [
            { icon: 'fa-satellite-dish', num: stats.streamers, label: 'Streamers', metric: 'streamers', title: 'People who have gone live' },
            { icon: 'fa-users', num: stats.users, label: 'Users', metric: 'users', title: 'Registered users', recent: R.users },
            { icon: 'fa-user-secret', num: stats.anons, label: 'Anons', metric: 'anons', title: 'Anonymous chatters ever seen', recent: R.anons },
            { icon: 'fa-heart', num: stats.follows, label: 'Follows', metric: 'follows', title: 'Channel follows', recent: R.follows },
            { icon: 'fa-comments', num: stats.chatMessages, label: 'Messages', metric: 'messages', title: 'Chat messages sent', recent: R.messages },
            { icon: 'fa-couch', num: stats.hoursWatched, label: 'Hrs Watched', metric: 'hoursWatched', title: 'Hours the community has spent watching streams', unit: 'h' },
        ],
    });

    // ── Economy ──────────────────────────────────────────────────
    groups.push({
        kicker: 'Economy', icon: 'fa-coins', rows: [
            { icon: 'fa-hand-holding-dollar', num: stats.vibesTipped, label: 'Vibes Tipped', metric: 'vibes', title: 'Vibes donated between people (100 Vibes = $1)', recent: R.vibes },
            { icon: 'fa-hand-holding-heart', num: stats.supporters, label: 'Supporters', metric: 'supporters', title: 'People who have tipped Vibes to a streamer' },
            { icon: 'fa-cart-shopping', num: stats.vibesBought, label: 'Vibes Bought', metric: 'vibesBought', title: 'Vibes purchased with real money (PowerChat, card, PayPal, crypto)', recent: R.vibesBought },
            { icon: 'fa-star', num: stats.activeSubs, label: 'Subs', metric: 'subs', title: 'Active channel subscriptions', recent: R.subs },
            { icon: 'fa-coins', num: stats.pointsEarned, label: 'Points Earned', metric: 'points', title: 'Channel points earned by viewers (watching, chatting, following)', recent: R.points },
            { icon: 'fa-gift', num: stats.pointsSpent, label: 'Points Spent', metric: 'pointsSpent', title: `Channel points spent on rewards · ${_fmtCount(stats.redemptions || 0)} rewards redeemed`, recent: R.pointsSpent, sub: stats.redemptions ? `${_fmtCount(stats.redemptions)} rewards` : '' },
            { icon: 'fa-bullseye', num: stats.goalsActive, label: 'Goals', title: `Donation goals running now · ${stats.goalsReached || 0} reached so far`, sub: stats.goalsReached ? `${_fmtCount(stats.goalsReached)} reached` : '' },
        ],
    });

    // ── Archive ──────────────────────────────────────────────────
    groups.push({
        kicker: 'Archive', icon: 'fa-box-archive', rows: [
            { icon: 'fa-tower-broadcast', num: stats.liveSessions, label: 'Sessions', metric: 'sessions', title: 'Total stream sessions', recent: R.sessions },
            { icon: 'fa-film', num: stats.vods, label: 'VODs', metric: 'vods', title: 'Recorded videos', recent: R.vods },
            { icon: 'fa-scissors', num: stats.clips, label: 'Clips', metric: 'clips', title: 'Clips created', recent: R.clips },
            { icon: 'fa-clock', num: stats.streamHours, label: 'Hours', metric: 'hours', title: 'Hours of video archived', recent: R.hours, unit: 'h' },
            { icon: 'fa-brain', num: stats.aiMemories, label: 'AI Moments', metric: 'aiMoments', title: 'Moments the AI remembers across every stream', recent: R.aiMoments },
            { icon: 'fa-face-grin-squint', num: stats.emotes, label: 'Emotes', metric: 'emotes', title: 'Custom channel emotes uploaded' },
            { icon: 'fa-paste', num: stats.pastes, label: 'Pastes', title: `${stats.pasteText || 0} text · ${stats.pasteImages || 0} image pastes`, sub: (stats.pasteText != null && stats.pasteImages != null) ? `${_fmtCount(stats.pasteText)} txt · ${_fmtCount(stats.pasteImages)} img` : '' },
        ],
    });

    // Rolling-window deltas: the small sub-line is "+N in 7d" (was the cryptic "+N wk"); the
    // custom tooltip (data-tip, see _heroTooltip) spells out 24h / 7d / 30d and what the
    // number means. Every chip with a series behind it is clickable → over-time chart.
    const recSub = (rec, u = '') => (rec && rec.w > 0) ? `+${_fmtCount(rec.w)}${u} in 7d` : '';
    const chip = (r) => {
        if (r.html) return r.html; // pre-rendered chips (sparkline)
        const sub = r.sub || recSub(r.recent, r.unit || '');
        const tip = {
            label: r.label, title: r.title || '', desc: r.desc || '',
            recent: r.recent ? { d: r.recent.d, w: r.recent.w, m: r.recent.m, unit: r.unit || '' } : null,
            metric: r.metric || null,
        };
        const clickable = !!r.metric;
        return `<div class="hero-stat ${r.cls || ''} ${clickable ? 'hero-stat--clickable' : ''}" data-tip="${esc(JSON.stringify(tip))}" ${clickable ? `data-metric="${r.metric}" role="button" tabindex="0" aria-label="${esc(r.label)} — show over time"` : ''}><i class="fa-solid ${r.icon}"></i><div class="hero-stat-meta"><span class="hero-stat-num" data-n="${r.num || 0}">0</span><span class="hero-stat-label">${r.label}${clickable ? ' <i class="fa-solid fa-chart-line hero-stat-chart-hint"></i>' : ''}</span>${sub ? `<span class="hero-stat-sub">${sub}</span>` : ''}</div></div>`;
    };
    wrap.innerHTML = groups.filter(g => g.rows.length).map(g => `
        <div class="hero-stat-group">
            <span class="hero-stat-kicker"><i class="fa-solid ${g.icon}"></i>${g.kicker}</span>
            <div class="hero-stat-row">${g.rows.map(chip).join('')}</div>
        </div>`).join('');
    wrap.querySelectorAll('.hero-stat-num').forEach(el => _heroCountUp(el, parseInt(el.dataset.n, 10) || 0));
    _heroBindInteractions(wrap);
}

// ── Hero stat tooltips + click-through charts ───────────────────
let _heroTipEl = null;
function _heroTipShow(chip) {
    let tip; try { tip = JSON.parse(chip.dataset.tip || 'null'); } catch { tip = null; }
    if (!tip) return;
    if (!_heroTipEl) { _heroTipEl = document.createElement('div'); _heroTipEl.className = 'hero-tip'; document.body.appendChild(_heroTipEl); }
    const u = tip.recent?.unit || '';
    _heroTipEl.innerHTML = `<div class="hero-tip-title">${esc(tip.label)}</div>
        <div class="hero-tip-desc">${esc(tip.desc || tip.title)}</div>
        ${tip.recent ? `<div class="hero-tip-recent">
            <div><b>+${_fmtCount(tip.recent.d)}${u}</b><span>24 h</span></div>
            <div><b>+${_fmtCount(tip.recent.w)}${u}</b><span>7 days</span></div>
            <div><b>+${_fmtCount(tip.recent.m)}${u}</b><span>30 days</span></div>
        </div>` : ''}
        ${tip.metric ? '<div class="hero-tip-cta"><i class="fa-solid fa-chart-line"></i> Tap for the last 30 / 90 days</div>' : ''}`;
    const r = chip.getBoundingClientRect();
    _heroTipEl.style.left = '0px'; _heroTipEl.style.top = '0px';
    _heroTipEl.classList.add('is-visible');
    const w = _heroTipEl.offsetWidth, h = _heroTipEl.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.top - h - 10;
    if (top < 8) top = r.bottom + 10;
    _heroTipEl.style.left = `${left}px`; _heroTipEl.style.top = `${top}px`;
}
function _heroTipHide() { if (_heroTipEl) _heroTipEl.classList.remove('is-visible'); }
function _heroBindInteractions(wrap) {
    const fine = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    wrap.querySelectorAll('.hero-stat[data-tip]').forEach(chip => {
        if (fine) {
            chip.addEventListener('mouseenter', () => _heroTipShow(chip));
            chip.addEventListener('mouseleave', _heroTipHide);
        }
        chip.addEventListener('focus', () => _heroTipShow(chip));
        chip.addEventListener('blur', _heroTipHide);
        if (chip.dataset.metric) {
            const open = () => { _heroTipHide(); _heroStatModal(chip); };
            chip.addEventListener('click', open);
            chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        }
    });
    window.addEventListener('scroll', _heroTipHide, { passive: true });
}
const _HERO_METRIC_ICON = { users: 'fa-users', anons: 'fa-user-secret', visitors: 'fa-user-plus', active: 'fa-fire', follows: 'fa-heart', messages: 'fa-comments', sessions: 'fa-tower-broadcast', streamers: 'fa-satellite-dish', vods: 'fa-film', clips: 'fa-scissors', hours: 'fa-clock', hoursWatched: 'fa-couch', aiMoments: 'fa-brain', vibes: 'fa-hand-holding-dollar', supporters: 'fa-hand-holding-heart', vibesBought: 'fa-cart-shopping', subs: 'fa-star', points: 'fa-coins', pointsSpent: 'fa-gift', redemptions: 'fa-gift', emotes: 'fa-face-grin-squint' };
async function _heroStatModal(chip) {
    let tip; try { tip = JSON.parse(chip.dataset.tip || '{}'); } catch { tip = {}; }
    const metric = chip.dataset.metric;
    document.querySelector('.hero-chart-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'hero-chart-overlay';
    overlay.innerHTML = `<div class="hero-chart" role="dialog" aria-modal="true" aria-label="${esc(tip.label || metric)} over time">
        <div class="hero-chart-head"><h3><i class="fa-solid ${_HERO_METRIC_ICON[metric] || 'fa-chart-line'}"></i> ${esc(tip.label || metric)}</h3><button class="hero-chart-close" aria-label="Close">&times;</button></div>
        <p class="hero-chart-desc">${esc(tip.desc || tip.title || '')}</p>
        <div class="hero-chart-ranges"><button data-days="7">7 days</button><button data-days="30" class="active">30 days</button><button data-days="90">90 days</button></div>
        <div class="hero-chart-body"><div class="hero-chart-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div></div>
        <div class="hero-chart-foot"></div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('.hero-chart-close')) close(); });
    const unit = tip.recent?.unit || '';
    const load = async (days) => {
        const body = overlay.querySelector('.hero-chart-body'), foot = overlay.querySelector('.hero-chart-foot');
        body.innerHTML = '<div class="hero-chart-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        try {
            const d = await api(`/home/stats/series/${encodeURIComponent(metric)}?days=${days}`);
            body.innerHTML = _heroChartSvg(d.points, unit);
            const best = d.points.reduce((a, p) => (p.value > a.value ? p : a), { value: -1 });
            foot.innerHTML = `<span><b>${_fmtCount(d.total)}${unit}</b> in the last ${d.days} days</span><span>avg <b>${_fmtCount(d.total / d.days)}${unit}</b> / day</span>${best.value > 0 ? `<span>best day <b>${_fmtCount(best.value)}${unit}</b> · ${esc(_heroDay(best.day))}</span>` : ''}`;
        } catch { body.innerHTML = '<div class="hero-chart-loading">No data for this metric yet.</div>'; foot.innerHTML = ''; }
    };
    overlay.querySelectorAll('.hero-chart-ranges button').forEach(b => b.addEventListener('click', () => {
        overlay.querySelectorAll('.hero-chart-ranges button').forEach(x => x.classList.toggle('active', x === b));
        load(Number(b.dataset.days));
    }));
    load(30);
}
function _heroDay(iso) { try { return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch { return iso; } }
function _heroChartSvg(points, unit = '') {
    const W = 720, H = 220, padL = 40, padR = 10, padT = 12, padB = 26;
    const n = points.length;
    const max = Math.max(1, ...points.map(p => p.value));
    const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / n);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const bw = Math.max(2, ((W - padL - padR) / n) * (n > 40 ? 0.8 : 0.62));
    const bars = points.map((p, i) => `<rect class="bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y(p.value)).toFixed(1)}" rx="2" style="animation-delay:${(i * (0.35 / n)).toFixed(3)}s"><title>${esc(_heroDay(p.day))}: ${_fmtCount(p.value)}${unit}</title></rect>`).join('');
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const grid = [0, 0.5, 1].map(f => { const yy = y(max * f); return `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"></line><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${_fmtCount(max * f)}</text>`; }).join('');
    const labelEvery = n > 40 ? Math.ceil(n / 8) : n > 10 ? Math.ceil(n / 6) : 1;
    const labels = points.map((p, i) => (i % labelEvery === 0 || i === n - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(_heroDay(p.day))}</text>` : '').join('');
    return `<svg class="hero-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${grid}${bars}${n > 1 ? `<polyline class="line" points="${line}"></polyline>` : ''}${labels}</svg>`;
}

// ── Hero floating thumbnail collage ─────────────────────────────
const _HERO_BADGE = { live: 'LIVE', vod: 'VOD', clip: 'CLIP', paste: 'PASTE', moment: 'AI MOMENT' };
let _heroCollageTimer = null;
function _heroFloatContent(item) {
    const badge = `<span class="hero-float-badge">${_HERO_BADGE[item.kind] || ''}</span>`;
    if (item.thumbnail) {
        return `<img src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">`
            + `<span class="hero-float-body">${badge}<span class="hero-float-title">${esc(item.title || '')}</span></span>`;
    }
    const snippet = item.text ? esc(item.text) : '';
    return `<span class="hero-float-text">${badge}<span class="hero-float-title">${esc(item.title || 'Paste')}</span><span>${snippet}</span></span>`;
}
// The visual content lives in a PERSISTENT .hero-float-inner so swaps only change its contents
// (letting the inner shrink out / grow in) without recreating the element or fighting the drift.
function _heroFloatFill(el, item) {
    let inner = el.querySelector('.hero-float-inner');
    if (!inner) { inner = document.createElement('div'); inner.className = 'hero-float-inner'; el.appendChild(inner); }
    inner.innerHTML = _heroFloatContent(item);
    el.setAttribute('href', item.href || '#');
    el.onclick = (e) => handleLinkClick(e, item.href || '/');
    el.classList.remove('hero-float--live', 'hero-float--vod', 'hero-float--clip', 'hero-float--paste');
    el.classList.add('hero-float', 'hero-float--' + (item.kind || 'vod'));
}
function _heroCollagePositions(n) {
    const pos = [];
    let guard = 0;
    while (pos.length < n && guard++ < 500) {
        const left = Math.random() * 90 + 2;
        const top = Math.random() * 80 + 2;
        if (left > 25 && left < 75 && top > 20 && top < 78) continue; // keep the center clear for the copy
        if (pos.some(p => Math.hypot(p.left - left, (p.top - top) * 0.65) < 13)) continue;
        pos.push({ left, top });
    }
    while (pos.length < n) pos.push({ left: Math.random() * 88 + 3, top: Math.random() * 82 + 2 });
    return pos;
}
// One AI moment frame at a time as the full-bleed hero background, cross-fading (Ken Burns)
// through the day's ~5 frames. Prefers the AI "moment" frames; falls back to any thumbnail.
let _heroBgTimer = null;
let _heroBgActive = 0;
function renderHeroBackground(media, moments) {
    const wrap = document.getElementById('hero-bg');
    if (!wrap) return;
    const layers = wrap.querySelectorAll('.hero-bg-layer');
    if (layers.length < 2) return;
    // Prefer the full AI-moment frame set (not the shuffled/sliced collage media), so the
    // background cycles through all of the day's frames.
    let frames = (moments || []).filter(m => m && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.kind === 'moment' && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.thumbnail && m.kind !== 'paste').map(m => m.thumbnail);
    frames = [...new Set(frames)];
    if (_heroBgTimer) { clearInterval(_heroBgTimer); _heroBgTimer = null; }
    if (!frames.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    _heroBgActive = 0;
    layers[0].style.backgroundImage = `url("${frames[0]}")`;
    layers[1].classList.remove('active');
    // Re-trigger the Ken-Burns animation on first paint.
    layers[0].classList.remove('active'); void layers[0].offsetWidth; layers[0].classList.add('active');
    if (frames.length < 2 || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && frames.length < 2)) return;
    let idx = 0;
    _heroBgTimer = setInterval(() => {
        if (document.hidden) return;
        idx = (idx + 1) % frames.length;
        const next = (_heroBgActive + 1) % 2;
        const el = layers[next];
        const pre = new Image();
        pre.onload = () => {
            el.style.backgroundImage = `url("${frames[idx]}")`;
            el.classList.remove('active'); void el.offsetWidth; el.classList.add('active');
            layers[_heroBgActive].classList.remove('active');
            _heroBgActive = next;
        };
        pre.src = frames[idx];
    }, 9000);
}

function renderHeroCollage(media) {
    const wrap = document.getElementById('hero-collage');
    if (!wrap || !Array.isArray(media) || !media.length) return;
    if (_heroCollageTimer) { clearInterval(_heroCollageTimer); _heroCollageTimer = null; }
    wrap.innerHTML = '';
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const w = window.innerWidth || 1200;
    const count = Math.min(media.length, w < 640 ? 5 : w < 1024 ? 8 : 12);
    const positions = _heroCollagePositions(count);
    const cards = [];
    for (let i = 0; i < count; i++) {
        const el = document.createElement('a');
        // Depth: z in [-260, 120]. Far cards (negative z) are smaller, dimmer, softly blurred;
        // near cards are bigger, brighter, crisp — with mouse-parallax on the whole scene this
        // reads as real 3D depth.
        const z = Math.round(-260 + Math.random() * 380);
        const depth = (z + 260) / 380;                 // 0 = far, 1 = near
        const op = (0.32 + depth * 0.44).toFixed(2);
        const blur = (Math.max(0, -z) / 130 * 1.7).toFixed(2);
        const size = Math.round(84 + depth * 98);
        const rx = (Math.random() * 10 - 5).toFixed(1);
        const ry = (Math.random() * 14 - 7).toFixed(1);
        const rot = (Math.random() * 6 - 3).toFixed(1);
        el.style.cssText = `left:${positions[i].left}%;top:${positions[i].top}%;`
            + `--w:${size}px;--z:${z}px;--op:${op};--blur:${blur}px;--rx:${rx}deg;--ry:${ry}deg;--rot:${rot}deg;`
            + `--dur:${(11 + Math.random() * 9).toFixed(1)}s;--delay:${(Math.random() * -8).toFixed(1)}s;--in-delay:${(i * 0.05).toFixed(2)}s;`;
        _heroFloatFill(el, media[i % media.length]);
        wrap.appendChild(el);
        cards.push(el);
    }
    _heroParallaxInit();
    if (reduce || media.length <= count) return;
    let ptr = count;
    _heroCollageTimer = setInterval(() => {
        if (document.hidden) return;
        const card = cards[Math.floor(Math.random() * cards.length)];
        const item = media[ptr % media.length]; ptr++;
        card.classList.add('swapping');
        setTimeout(() => { _heroFloatFill(card, item); card.classList.remove('swapping'); }, 560);
    }, 5600);
}

// Mouse-parallax: gently tilt the whole 3D collage toward the cursor (desktop only).
let _heroParallaxBound = false;
function _heroParallaxInit() {
    if (_heroParallaxBound) return;
    const hero = document.querySelector('#page-home .hero');
    const collage = document.getElementById('hero-collage');
    if (!hero || !collage) return;
    if (window.matchMedia && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.matchMedia('(pointer: coarse)').matches)) return;
    _heroParallaxBound = true;
    let raf = 0, ry = 0, rx = 0;
    const apply = () => { raf = 0; collage.style.setProperty('--tilt-y', ry.toFixed(2) + 'deg'); collage.style.setProperty('--tilt-x', rx.toFixed(2) + 'deg'); };
    hero.addEventListener('pointermove', (e) => {
        const r = hero.getBoundingClientRect();
        ry = (((e.clientX - r.left) / r.width) * 2 - 1) * 7;
        rx = -(((e.clientY - r.top) / r.height) * 2 - 1) * 5;
        if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
    hero.addEventListener('pointerleave', () => { ry = 0; rx = 0; if (!raf) raf = requestAnimationFrame(apply); });
}

// ── Hero data: stats + collage + AI slogans (falls back gracefully) ──
function _cleanAudiences(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr
        .map(s => String(s == null ? '' : s)
            .replace(/^\s*(live\s+)?streaming\s+for\s+/i, '')  // strip a baked-in "live streaming for"
            .replace(/^\s*for\s+/i, '')
            .replace(/^["'‘’“”\-\s]+|["'‘’“”\s]+$/g, '')
            .replace(/[.!,;:]+$/, ''))
        .filter(s => s && s.length <= 60);
}
async function loadHeroData() {
    let data = null;
    try { data = await api('/home/hero'); } catch { /* static hero fallback below */ }
    startHeroRotation(_cleanAudiences(data && data.slogans && data.slogans.audiences));
    startHeroQuips(data && data.slogans && data.slogans.quips);
    startSloganCountdown(data && data.slogans && data.slogans.next_at);
    if (data && data.stats) renderHeroStats(data.stats);
    if (data && data.media) { renderHeroBackground(data.media, data.moments); renderHeroCollage(data.media); }
}

// Playful countdown to the next AI slogan/label batch (regenerates every 12h).
let _sloganCountdownTimer = null;
let _sloganRefreshTimer = null;
// After the countdown hits 0, poll the hero endpoint until the new batch lands, then swap the
// slogans in + restart the countdown — so it never gets stuck on "brewing…".
async function _refreshSlogansIfReady(prevNextAt) {
    try {
        const data = await api('/home/hero');
        const sl = data && data.slogans;
        if (sl && sl.next_at && (!prevNextAt || sl.next_at > prevNextAt)) {
            startHeroRotation(_cleanAudiences(sl.audiences));
            startHeroQuips(sl.quips);
            startSloganCountdown(sl.next_at);
            return true;
        }
    } catch { /* keep polling */ }
    return false;
}
function startSloganCountdown(nextAt) {
    const el = document.getElementById('hero-slogan-timer');
    if (!el) return;
    if (_sloganCountdownTimer) { clearInterval(_sloganCountdownTimer); _sloganCountdownTimer = null; }
    if (_sloganRefreshTimer) { clearInterval(_sloganRefreshTimer); _sloganRefreshTimer = null; }
    if (!nextAt) { el.hidden = true; return; }
    el.hidden = false;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
        let ms = nextAt - Date.now();
        if (ms <= 0) {
            el.innerHTML = `<i class="fa-solid fa-fire"></i> brewing fresh slogans…`;
            if (_sloganCountdownTimer) { clearInterval(_sloganCountdownTimer); _sloganCountdownTimer = null; }
            // Poll for the freshly-generated batch, then restart the countdown.
            if (!_sloganRefreshTimer) {
                _sloganRefreshTimer = setInterval(async () => {
                    if (await _refreshSlogansIfReady(nextAt)) {
                        clearInterval(_sloganRefreshTimer); _sloganRefreshTimer = null;
                    }
                }, 60000);
            }
            return;
        }
        const s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000);
        el.innerHTML = `<i class="fa-solid fa-fire"></i> next fresh batch of memes in <b>${pad(h)}:${pad(m)}:${pad(s)}</b>`;
    };
    tick();
    _sloganCountdownTimer = setInterval(tick, 1000);
}

// The "Streaming the way it should be" About block is collapsed by default — but expanded for
// a first-time visitor (within 30 min of their first visit) so they're more likely to read it.
function _homeAboutDefaultExpanded() {
    try {
        // Once they've scrolled past it (i.e. actually seen it), always collapse by default.
        if (localStorage.getItem('openvibe_about_seen') === '1') return false;
        const KEY = 'openvibe_first_visit';
        let first = parseInt(localStorage.getItem(KEY) || '0', 10);
        if (!first) { first = Date.now(); localStorage.setItem(KEY, String(first)); }
        return (Date.now() - first) < 30 * 60 * 1000;
    } catch { return false; }
}
let _homeAboutSeenObserver = null;
let _homeAboutInited = false;   // only auto-expand on the FIRST home view of the session
function _initHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    // Re-navigating back to Home should NOT re-expand it — only the first view of the session
    // uses the first-visit rule; after that it defaults collapsed.
    const expanded = _homeAboutInited ? false : _homeAboutDefaultExpanded();
    _homeAboutInited = true;
    banner.classList.toggle('about-collapsed', !expanded);
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // Mark it "seen" once the user scrolls all the way past the section, so the next visit
    // defaults to collapsed (they've already had their chance to read it).
    try {
        if (_homeAboutSeenObserver) { _homeAboutSeenObserver.disconnect(); _homeAboutSeenObserver = null; }
        if (localStorage.getItem('openvibe_about_seen') !== '1' && 'IntersectionObserver' in window) {
            _homeAboutSeenObserver = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    // Fully scrolled above the viewport → they've passed it.
                    if (!e.isIntersecting && e.boundingClientRect.bottom < 0) {
                        try { localStorage.setItem('openvibe_about_seen', '1'); } catch { /* */ }
                        if (_homeAboutSeenObserver) { _homeAboutSeenObserver.disconnect(); _homeAboutSeenObserver = null; }
                        break;
                    }
                }
            }, { threshold: 0 });
            _homeAboutSeenObserver.observe(banner);
        }
    } catch { /* observer optional */ }
}
function toggleHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    const collapsed = banner.classList.toggle('about-collapsed');
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}
function openHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    banner.classList.remove('about-collapsed');
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Daily AI easter egg ─────────────────────────────────────────────────────
let _egg = null, _eggBuf = [], _eggSolved = false, _eggSubmitTimer = null, _eggKeysWired = false;
const _EGG_ARROW = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
async function loadHeroEgg() {
    const el = document.getElementById('hero-egg');
    if (!el) return;
    let data; try { data = await api('/easter-egg/daily'); } catch { return; }
    const egg = data && data.egg;
    if (!egg) { el.style.display = 'none'; return; }
    _egg = egg; _eggSolved = !!egg.solved;
    el.style.display = '';
    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set('hero-egg-title', egg.title || 'The Daily Secret');
    const hints = document.getElementById('hero-egg-hints');
    if (hints) hints.innerHTML = (egg.hints || []).length ? egg.hints.map(h => `<li>${esc(h)}</li>`).join('') : '<li>No hints today — go on instinct.</li>';
    set('hero-egg-count', `${egg.foundCount || 0} cracked it today`);
    const reset = document.getElementById('hero-egg-reset');
    if (reset) reset.textContent = egg.nextResetAt ? ` · resets ${_eggResetLabel(egg.nextResetAt)}` : '';
    _renderEggStatus();
    _wireEggKeys();
}
function _eggResetLabel(ts) { const h = Math.round((ts - Date.now()) / 3600000); return h <= 1 ? 'soon' : `in ${h}h`; }
function _renderEggStatus() {
    const s = document.getElementById('hero-egg-status'); if (!s) return;
    s.textContent = _eggSolved ? '✓ Solved' : `${_egg ? _egg.codeLength : ''} keys`;
    s.className = 'hero-egg-status' + (_eggSolved ? ' solved' : '');
}
function toggleHeroEgg() { document.getElementById('hero-egg')?.classList.toggle('open'); }
function _wireEggKeys() {
    if (_eggKeysWired) return;
    _eggKeysWired = true;
    document.addEventListener('keydown', (e) => {
        if (_eggSolved || !_egg) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        let tok = _EGG_ARROW[e.key];
        if (!tok && /^[a-zA-Z]$/.test(e.key)) tok = e.key.toLowerCase();
        if (!tok) return;
        _eggBuf.push(tok);
        if (_eggBuf.length > _egg.codeLength) _eggBuf = _eggBuf.slice(-_egg.codeLength);
        if (_eggBuf.length === _egg.codeLength) { clearTimeout(_eggSubmitTimer); _eggSubmitTimer = setTimeout(_submitEgg, 220); }
    });
}
async function _submitEgg() {
    if (_eggSolved || !_egg || _eggBuf.length < _egg.codeLength) return;
    let res; try { res = await api('/easter-egg/solve', { method: 'POST', body: { sequence: _eggBuf.slice() } }); } catch { return; }
    if (res && res.solved) {
        _eggSolved = true; _renderEggStatus();
        const c = document.getElementById('hero-egg-count'); if (c && res.foundCount != null) c.textContent = `${res.foundCount} cracked it today`;
        _celebrateEgg(res.egg || {});
    }
}
function _celebrateEgg(egg) {
    try { toast(egg.reward || "You cracked today's secret! 🎉", 'success'); } catch { /* */ }
    const effect = egg.effect || 'confetti';
    try {
        if (effect === 'shake') { document.body.classList.add('egg-shake'); setTimeout(() => document.body.classList.remove('egg-shake'), 900); }
        if (effect === 'rainbow') { document.body.classList.add('egg-rainbow'); setTimeout(() => document.body.classList.remove('egg-rainbow'), 2600); }
        const N = effect === 'fireworks' ? 170 : effect === 'matrix' ? 90 : 130;
        const cont = document.createElement('div'); cont.className = 'egg-confetti';
        const colors = effect === 'matrix' ? ['#00ff41', '#0f0', '#00c030'] : ['#ff5a5f', '#ffd166', '#06d6a0', '#4d96ff', '#c77dff', '#fff'];
        for (let i = 0; i < N; i++) {
            const p = document.createElement('span');
            p.style.left = (Math.random() * 100) + 'vw';
            p.style.background = colors[i % colors.length];
            p.style.animationDelay = (Math.random() * 0.5) + 's';
            p.style.animationDuration = (1.5 + Math.random() * 1.6) + 's';
            if (effect === 'matrix') { p.style.width = '3px'; p.style.height = (12 + Math.random() * 20) + 'px'; }
            cont.appendChild(p);
        }
        document.body.appendChild(cont);
        setTimeout(() => cont.remove(), 3800);
    } catch { /* */ }
}

async function loadHome() {
    void loadHomeChangelog();
    _initHomeAbout();
    updateNavHeroTransparency();  // transparent nav over the hero at the top
    startHeroRotation();      // instant static rotation; loadHeroData upgrades it with AI slogans
    void loadHeroData();      // stats bar, floating-thumbnail collage, AI slogans
    void loadHeroEgg();       // daily AI easter egg widget

    // Reset homepage pagination on fresh load
    _homeRecentOnlinePage = 1;
    _homeRecentVodsPage = 1;
    _homeClipsPage = 1;
    _homePastesPage = 1;

    try {
        const liveData = await api('/streams');
        const streams = liveData.streams || [];
        document.getElementById('live-count').textContent = streams.length;
        const noLiveEl = document.getElementById('no-live-streams');
        if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';
        renderStreamGrid('stream-grid-live', streams, true);
    } catch (e) { console.error('Failed to load live streams', e); }

    loadHomeRecentOnline();
    void loadHomePulse();     // happening-now rail + weekly leaders + AI moments + latest update
    void loadHomeDigest();    // "while you were away" for returning logged-in users

    // Load recent VODs
    loadHomeRecentVods();
    // Load recent clips
    loadHomeClips();
    // Load recent pastes
    loadHomePastes();
    // Load Scraplandia leaderboards
    loadHomeLeaderboards();
    // Load Canvas preview
    loadHomeCanvas();

    startHomeRefresh(); // live grid + sections auto-update in real time
}

/* ── Community pulse: happening-now rail, weekly leaders, AI moments, latest ship ── */
async function loadHomePulse() {
    let p;
    try { p = await api('/home/pulse'); } catch { return; }
    if (!p) return;

    // Hero one-liner: the newest shipped commit.
    const latest = document.getElementById('hero-latest');
    if (latest && p.latestUpdate && p.latestUpdate.subject) {
        latest.innerHTML = `<i class="fa-solid fa-rocket"></i> shipped ${esc(timeAgo(p.latestUpdate.date))}: <b>${esc(p.latestUpdate.subject)}</b>`;
        latest.style.display = '';
    }

    const grid = document.getElementById('pulse-grid');
    const section = document.getElementById('home-pulse-section');
    if (!grid || !section) return;
    const cards = [];

    // Goal cards — nearest to completion, with progress bars.
    for (const g of (p.goals || [])) {
        const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
        const href = `/@${g.username}`;
        cards.push(`
            <a class="pulse-card pulse-goal" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                <div class="pulse-kicker"><i class="fa-solid fa-bullseye"></i> Goal · ${esc(g.display_name || g.username)}</div>
                <div class="pulse-title">${esc(g.title)}</div>
                <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
                <div class="pulse-sub">${Number(g.current_amount).toLocaleString()} / ${Number(g.target_amount).toLocaleString()} Vibes · <b>${pct}%</b></div>
            </a>`);
    }

    // Latest activity card (tip + follow together).
    const act = [];
    if (p.latestTip) act.push(`<div class="pulse-act"><i class="fa-solid fa-hand-holding-dollar"></i> <b>${esc(p.latestTip.from_display || p.latestTip.from_username || 'Someone')}</b> tipped <b>${Number(p.latestTip.amount).toLocaleString()}</b> Vibes to <b>${esc(p.latestTip.to_display || p.latestTip.to_username)}</b> <span class="muted">${esc(timeAgo(p.latestTip.created_at))}</span></div>`);
    if (p.newestFollow) act.push(`<div class="pulse-act"><i class="fa-solid fa-heart"></i> <b>${esc(p.newestFollow.follower_display || p.newestFollow.follower_username)}</b> followed <b>${esc(p.newestFollow.streamer_display || p.newestFollow.streamer_username)}</b> <span class="muted">${esc(timeAgo(p.newestFollow.created_at))}</span></div>`);
    if (act.length) cards.push(`<div class="pulse-card"><div class="pulse-kicker"><i class="fa-solid fa-wave-square"></i> Latest activity</div>${act.join('')}</div>`);

    // Weekly leader teasers.
    const board = (title, icon, rows, unit) => rows && rows.length ? `
        <div class="pulse-card">
            <div class="pulse-kicker"><i class="fa-solid ${icon}"></i> ${title}</div>
            ${rows.map((r, i) => `<div class="pulse-rank"><span class="pulse-medal">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span> <a href="/@${esc(r.username)}" onclick="return handleLinkClick(event, '/@${esc(r.username)}')">${esc(r.display_name || r.username)}</a> <b>${Number(r.total).toLocaleString()}</b> <span class="muted">${unit}</span></div>`).join('')}
        </div>` : '';
    const supporters = board('Top supporters this week', 'fa-trophy', p.topSupporters, 'Vibes');
    const earners = board('Top point earners this week', 'fa-coins', p.topEarners, 'pts');
    if (supporters) cards.push(supporters);
    if (earners) cards.push(earners);

    section.style.display = cards.length ? '' : 'none';
    grid.innerHTML = cards.join('');

    // AI Moments showcase row.
    const momentsRow = document.getElementById('home-moments-row');
    const momentsSection = document.getElementById('home-moments-section');
    if (momentsRow && momentsSection) {
        const ms = (p.moments || []).filter(m => m.thumbnail);
        momentsSection.style.display = ms.length ? '' : 'none';
        momentsRow.innerHTML = ms.map(m => `
            <a class="moment-card" href="${esc(m.href)}" onclick="return handleLinkClick(event, '${esc(m.href)}')">
                <img src="${esc(m.thumbnail)}" alt="" loading="lazy">
                <div class="moment-overlay">
                    <div class="moment-title">${esc(m.title)}</div>
                    ${m.username ? `<div class="moment-user">@${esc(m.username)}</div>` : ''}
                </div>
            </a>`).join('');
    }
}

/* ── "While you were away" digest (logged-in returning users) ── */
async function loadHomeDigest() {
    const box = document.getElementById('home-digest');
    if (!box || !currentUser) return;
    const KEY = 'openvibe_last_visit';
    let since = null;
    try { since = localStorage.getItem(KEY); } catch { /* */ }
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch { /* */ }
    // First visit (nothing to compare against) → no banner, just start the clock.
    if (!since) return;
    let d;
    try { d = await api(`/home/digest?since=${encodeURIComponent(since)}`); } catch { return; }
    if (!d || (!d.liveNow?.length && !d.missed?.length)) return;
    const chip = (u, extra, live) => `
        <a class="digest-chip ${live ? 'digest-chip--live' : ''}" href="/@${esc(u.username)}" onclick="return handleLinkClick(event, '/@${esc(u.username)}')">
            ${_avatarSpan(u.avatar_url, u.username, u.profile_color)}
            <span class="digest-name">${esc(u.display_name || u.username)}</span>
            <span class="digest-extra">${extra}</span>
        </a>`;
    const parts = [];
    for (const u of (d.liveNow || [])) parts.push(chip(u, '<i class="fa-solid fa-circle live-dot"></i> LIVE now', true));
    for (const u of (d.missed || [])) parts.push(chip(u, `streamed ${u.sessions > 1 ? u.sessions + '× ' : ''}${esc(timeAgo(u.last_at))}`, false));
    box.innerHTML = `<div class="digest-head"><i class="fa-solid fa-clock-rotate-left"></i> While you were away</div><div class="digest-row">${parts.join('')}</div>`;
    box.style.display = '';
}

async function loadHomeRecentOnline(page) {
    if (page !== undefined) _homeRecentOnlinePage = page;
    const offset = (_homeRecentOnlinePage - 1) * HOME_RECENT_ONLINE_PAGE_SIZE;
    try {
        const recentData = await api(`/streams/recently-online?limit=${HOME_RECENT_ONLINE_PAGE_SIZE}&offset=${offset}`);
        renderRecentlyOnline('stream-grid-recent', recentData.streamers || []);
        renderHomePagination('stream-grid-recent-pagination', recentData.total || 0, _homeRecentOnlinePage, HOME_RECENT_ONLINE_PAGE_SIZE, 'loadHomeRecentOnline');
    } catch { /* silent */ }
}

function renderRecentlyOnline(containerId, streamers) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!streamers.length) {
        container.innerHTML = '<p class="muted">No recent streamers</p>';
        return;
    }
    container.innerHTML = streamers.map(s => {
        const msList = (s.managed_streams || []);
        const avatar = _avatarSpan(s.avatar_url, s.username, s.profile_color);
        const channelHref = `/@${s.username}`;
        const streamsHtml = msList.length ? msList.map(ms => {
            const href = channelPath(s.username, ms.slug || ms.managed_stream_id);
            const thumb = ms.vod_thumbnail
                ? `<img src="${esc(ms.vod_thumbnail)}" alt="" loading="lazy" class="streamer-group-stream-thumb-img">`
                : `<div class="streamer-group-stream-thumb-placeholder"><i class="fa-solid fa-video"></i></div>`;
            return `
                <a class="streamer-group-stream" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                    <div class="streamer-group-stream-thumb">${thumb}</div>
                    <div class="streamer-group-stream-info">
                        <div class="streamer-group-stream-title">${esc(ms.title || 'Stream')}</div>
                        <div class="streamer-group-stream-time muted"><i class="fa-solid fa-clock"></i> ${ms.last_live_at ? timeAgo(ms.last_live_at) : 'long ago'}</div>
                    </div>
                </a>`;
        }).join('') : `<a class="streamer-group-stream" href="${channelHref}" onclick="return handleLinkClick(event, '${channelHref}')">
                    <div class="streamer-group-stream-info"><div class="streamer-group-stream-title muted">No streams</div></div>
                </a>`;
        return `
            <div class="streamer-group-card">
                <div class="streamer-group-header">
                    <a class="streamer-group-identity" href="${channelHref}" onclick="return handleLinkClick(event, '${channelHref}')">
                        ${avatar}
                        <span class="streamer-group-name">${esc(s.display_name || s.username)}</span>
                        <span class="streamer-group-last-online muted"><i class="fa-solid fa-clock"></i> ${timeAgo(s.last_online_at)}</span>
                    </a>
                </div>
                ${_cardAiHTML(s.ai_overview_short, s.ai_overview)}
                ${s.top_goal ? (() => {
                    const pct = Math.min(100, Math.round((s.top_goal.current / s.top_goal.target) * 100));
                    return `<div class="streamer-group-goal" title="${esc(s.top_goal.title)}: ${Number(s.top_goal.current).toLocaleString()} / ${Number(s.top_goal.target).toLocaleString()} Vibes">
                        <span class="sgg-title"><i class="fa-solid fa-bullseye"></i> ${esc(s.top_goal.title)}</span>
                        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
                        <span class="sgg-pct">${pct}%</span>
                    </div>`;
                })() : ''}
                <div class="streamer-group-streams">${streamsHtml}</div>
            </div>
        `;
    }).join('');
}

async function loadHomeRecentVods(page) {
    if (page !== undefined) _homeRecentVodsPage = page;
    const offset = (_homeRecentVodsPage - 1) * HOME_RECENT_VODS_PAGE_SIZE;
    try {
        const data = await api(`/streams/recent-vods?limit=${HOME_RECENT_VODS_PAGE_SIZE}&offset=${offset}`);
        const vods = data.vods || [];
        const header = document.getElementById('home-recent-vods-header');
        const grid = document.getElementById('home-recent-vods-grid');
        if (!header || !grid) return;
        if (!vods.length && _homeRecentVodsPage === 1) { header.style.display = 'none'; grid.innerHTML = ''; return; }
        header.style.display = '';
        grid.innerHTML = vods.map(v => {
            const href = `/vod/${v.id}`;
            return `
                <a class="stream-card" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
                        ${v.duration_seconds ? `<span class="stream-card-duration">${formatDuration(v.duration_seconds)}</span>` : ''}
                        <span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${v.view_count || 0}</span>
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
                        <div class="stream-card-streamer">
                            ${_avatarSpan(v.avatar_url, v.username, v.profile_color)}
                            ${esc(v.display_name || v.username)}
                            <span class="muted" style="margin-left:auto;font-size:0.75rem">${timeAgo(v.created_at)}</span>
                        </div>
                        ${_cardAiHTML(v.ai_overview_short, v.ai_overview)}
                    </div>
                </a>
            `;
        }).join('');
        renderHomePagination('home-recent-vods-pagination', data.total || 0, _homeRecentVodsPage, HOME_RECENT_VODS_PAGE_SIZE, 'loadHomeRecentVods');
    } catch { /* silent */ }
}

async function loadHomeClips(page) {
    if (page !== undefined) _homeClipsPage = page;
    const offset = (_homeClipsPage - 1) * HOME_CLIPS_PAGE_SIZE;
    try {
        const data = await api(`/clips?limit=${HOME_CLIPS_PAGE_SIZE}&offset=${offset}`);
        const clips = data.clips || [];
        const header = document.getElementById('home-clips-header');
        const grid = document.getElementById('home-clips-grid');
        if (!clips.length && _homeClipsPage === 1) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';
        grid.innerHTML = clips.map(c => `
            <a class="stream-card" href="/clip/${c.id}" onclick="return handleLinkClick(event, '/clip/${c.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(c.thumbnail_url, 'fa-scissors', c.title, `/api/thumbnails/generate/clip/${c.id}`)}
                    <span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${c.view_count || 0}</span>
                    ${c.duration_seconds ? `<span class="stream-card-duration">${formatDuration(c.duration_seconds)}</span>` : ''}
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(c.title || 'Untitled Clip')}</div>
                    <div class="stream-card-streamer">
                        ${_avatarSpan(c.avatar_url, c.username, c.profile_color)}
                        ${esc(c.username || 'Anonymous')}
                        <span class="muted" style="margin-left:auto;font-size:0.75rem">${timeAgo(c.created_at)}</span>
                    </div>
                    ${_cardAiHTML(c.ai_overview_short, c.ai_overview)}
                </div>
            </a>
        `).join('');
        renderHomePagination('home-clips-pagination', data.total || 0, _homeClipsPage, HOME_CLIPS_PAGE_SIZE, 'loadHomeClips');
    } catch { /* silent */ }
}

async function loadHomePastes(page) {
    if (page !== undefined) _homePastesPage = page;
    const offset = (_homePastesPage - 1) * HOME_PASTES_PAGE_SIZE;
    try {
        const data = await api(`/pastes?limit=${HOME_PASTES_PAGE_SIZE}&offset=${offset}`);
        const pastes = data.pastes || [];
        const header = document.getElementById('home-pastes-header');
        const list = document.getElementById('home-pastes-list');
        if (!pastes.length && _homePastesPage === 1) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';
        list.innerHTML = pastes.map(p => {
            const icon = p.type === 'screenshot' ? 'fa-image' : (p.language && p.language !== 'plaintext' ? 'fa-code' : 'fa-file-lines');
            const preview = p.type === 'paste' ? esc((p.content || '').slice(0, 220)).replace(/\n{3,}/g, '\n\n') : '';
            const media = p.type === 'screenshot' && p.screenshot_url
                ? `<div class="home-paste-media"><img src="${esc(p.screenshot_url)}" alt="${esc(p.title || 'Screenshot paste')}" loading="lazy"><span class="home-paste-type">Image</span></div>`
                : `<div class="home-paste-media"><div class="home-paste-snippet">${preview || esc(p.title || 'Untitled paste')}</div><div class="home-paste-icon"><i class="fa-solid ${icon}"></i></div><span class="home-paste-type">${p.language && p.language !== 'plaintext' ? esc(p.language) : 'Text'}</span></div>`;
            return `
            <a class="home-paste-card" href="/p/${esc(p.slug)}" onclick="return handleLinkClick(event, '/p/${esc(p.slug)}')">
                ${media}
                <div class="home-paste-body">
                <div class="home-paste-info">
                    <div class="home-paste-title">${esc(p.title || 'Untitled')}</div>
                    <div class="home-paste-meta">
                        ${p.username ? esc(p.username) : 'Anonymous'}
                        ${p.language && p.language !== 'plaintext' ? ` · <span class="home-paste-lang">${esc(p.language)}</span>` : ''}
                        · ${timeAgo(p.created_at)}
                    </div>
                    ${_cardAiHTML(p.ai_summary)}
                </div>
                </div>
            </a>`;
        }).join('');
        renderHomePagination('home-pastes-pagination', data.total || 0, _homePastesPage, HOME_PASTES_PAGE_SIZE, 'loadHomePastes');
    } catch { /* silent */ }
}

async function loadHomeLeaderboards() {
    try {
        const boards = ['total_level', 'combat', 'mining', 'fishing'];
        const questUrl = getScraplandiaUrl();
        const results = await Promise.all(boards.map(b =>
            fetch(`${questUrl}/api/game/leaderboard/${b}`).then(r => r.json()).catch(() => ({ entries: [] }))
        ));
        const header = document.getElementById('home-quest-header');
        const container = document.getElementById('home-leaderboards');
        const hasData = results.some(r => r.entries && r.entries.length);
        if (!hasData) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const labels = { total_level: 'Total Level', combat: 'Combat', mining: 'Mining', fishing: 'Fishing' };
        const icons = { total_level: 'fa-star', combat: 'fa-sword', mining: 'fa-gem', fishing: 'fa-fish' };
        container.innerHTML = boards.map((board, i) => {
            const entries = (results[i].entries || []).slice(0, 5);
            if (!entries.length) return '';
            return `
            <div class="home-lb-card">
                <div class="home-lb-title"><i class="fa-solid ${icons[board] || 'fa-trophy'}"></i> ${labels[board]}</div>
                <div class="home-lb-entries">
                    ${entries.map((e, rank) => `
                        <div class="home-lb-row">
                            <span class="home-lb-rank">${rank + 1}</span>
                            <span class="home-lb-name">${esc(e.display_name || e.username || 'Unknown')}</span>
                            <span class="home-lb-score">${typeof e.score === 'number' ? e.score.toLocaleString() : e.score}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }).join('');
    } catch { /* silent */ }
}

async function loadHomeCanvas() {
    try {
        const data = await fetch(`${getScraplandiaUrl()}/api/game/canvas/state`).then(r => r.json());
        const header = document.getElementById('home-canvas-header');
        const container = document.getElementById('home-canvas-preview');
        if (!data || !data.board) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const tiles = data.tiles || [];
        const recentActions = data.recent_actions || [];
        const uniqueArtists = new Set(tiles.map(t => t.user_id).filter(Boolean)).size;
        const width = data.board.width || 64;
        const height = data.board.height || 64;
        const palette = data.board.palette || ['#000000'];

        // Render a mini canvas preview
        const scale = 4;
        container.innerHTML = `
            <div class="home-canvas-wrap">
                <canvas id="home-canvas-mini" width="${width * scale}" height="${height * scale}" style="image-rendering:pixelated;border-radius:var(--radius);border:1px solid var(--border);max-width:100%;"></canvas>
                <div class="home-canvas-stats">
                    <div class="home-canvas-stat"><strong>${tiles.length.toLocaleString()}</strong> <span>pixels placed</span></div>
                    <div class="home-canvas-stat"><strong>${uniqueArtists.toLocaleString()}</strong> <span>artists</span></div>
                    <div class="home-canvas-stat"><strong>${width}×${height}</strong> <span>board size</span></div>
                    <div class="home-canvas-stat"><strong>${recentActions.length}</strong> <span>recent actions</span></div>
                </div>
                <a href="${getScraplandiaUrl()}/canvas" class="btn btn-outline" style="margin-top:12px;">
                    <i class="fa-solid fa-palette"></i> Open Canvas
                </a>
            </div>
        `;

        // Draw tiles on the mini canvas
        const canvas = document.getElementById('home-canvas-mini');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = palette[0] || '#000';
            ctx.fillRect(0, 0, width * scale, height * scale);
            for (const tile of tiles) {
                const color = palette[tile.color_index] || '#fff';
                ctx.fillStyle = color;
                ctx.fillRect(tile.x * scale, tile.y * scale, scale, scale);
            }
        }
    } catch { /* silent */ }
}

// Markup for a single stream card (live or recent). Extracted so the home page
// can reconcile the live grid in place for real-time updates.
function streamCardHTML(s, isLive) {
    let navUrl;
    if (isLive && s.id) {
        const msRef = s.managed_stream_slug || s.managed_stream_id || null;
        navUrl = channelPath(s.username, msRef);
    } else if (!isLive && s.vod_id && s.vod_is_public) {
        navUrl = `/vod/${s.vod_id}`;
    } else {
        navUrl = channelPath(s.username);
    }
    const thumb = (!isLive && s.vod_thumbnail_url) ? s.vod_thumbnail_url : s.thumbnail_url;
    const duration = !isLive && s.vod_duration ? `<span class="stream-card-duration">${formatDuration(s.vod_duration)}</span>` : '';
    const endedAgo = !isLive && s.ended_at ? `<span class="stream-card-ago">${timeAgo(s.ended_at)}</span>` : '';
    return `
        <a class="stream-card" data-stream-id="${esc(String(s.id || ''))}" href="${esc(navUrl)}" onclick="return handleLinkClick(event, '${esc(navUrl)}')">
            <div class="stream-card-thumb${s.is_nsfw ? ' stream-card-nsfw-blur' : ''}">
                ${thumbImg(thumb, 'fa-circle-nodes', s.title, !isLive && s.vod_id ? `/api/thumbnails/generate/vod/${s.vod_id}` : null)}
                ${streamTypeBadge(s.browser_mode, s.streaming_method)}
                ${s.is_nsfw ? '<span class="stream-card-nsfw">18+</span>' : ''}
                ${duration}
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(s.title || 'Untitled Stream')}</div>
                <div class="stream-card-streamer">
                    ${_avatarSpan(s.avatar_url, s.username, s.profile_color)}
                    ${esc(s.username || 'Anonymous')}
                    ${endedAgo}
                </div>
                ${(isLive && s.description) ? `<div class="stream-card-desc" title="Click to expand" onclick="event.preventDefault();event.stopPropagation();this.classList.toggle('expanded')">${esc(s.description)}</div>` : ''}
                ${_cardAiHTML(s.ai_overview_short, s.ai_overview)}
                <div class="stream-card-meta">
                    ${s.category ? `<span class="stream-card-tag">${esc(_capTag(s.category))}</span>` : ''}
                    <span class="stream-card-metaright">
                        ${isLive && s.started_at ? `<span class="stream-card-uptime" data-since="${esc(s.started_at)}"><i class="fa-solid fa-clock"></i> ${formatUptime(s.started_at)}</span>` : ''}
                        ${isLive ? `<span class="stream-card-vcount"><i class="fa-solid fa-eye"></i> ${s.total_viewer_count || s.viewer_count || 0}</span>` : ''}
                    </span>
                </div>
            </div>
        </a>`;
}

function renderStreamGrid(containerId, streams, isLive) {
    const c = document.getElementById(containerId);
    if (!streams.length) {
        if (!isLive) c.innerHTML = '<div class="empty-state"><p class="muted">No recent streams</p></div>';
        return;
    }
    c.innerHTML = streams.map(s => streamCardHTML(s, isLive)).join('');
}

/* ── Real-time home updates ─────────────────────────────────── */
let _homeLiveTimer = null;
let _homeSectionsTimer = null;

function _homeIsActive() {
    const p = document.getElementById('page-home');
    return p && p.classList.contains('active');
}

// Cross-fade a card's thumbnail to a new frame (live thumbnails change per capture).
function _crossfadeThumb(imgEl, newSrc) {
    if (!imgEl || !newSrc || imgEl.getAttribute('src') === newSrc) return;
    const pre = new Image();
    pre.onload = () => {
        imgEl.style.transition = 'opacity 0.4s';
        imgEl.style.opacity = '0';
        setTimeout(() => { imgEl.src = newSrc; imgEl.style.opacity = '1'; }, 400);
    };
    pre.src = newSrc;
}

function _updateLiveCard(card, s) {
    const vc = card.querySelector('.stream-card-vcount');
    if (vc) vc.innerHTML = `<i class="fa-solid fa-eye"></i> ${s.total_viewer_count || s.viewer_count || 0}`;
    const up = card.querySelector('.stream-card-uptime');
    if (up && s.started_at) { up.innerHTML = `<i class="fa-solid fa-clock"></i> ${formatUptime(s.started_at)}`; up.dataset.since = s.started_at; }
    const t = card.querySelector('.stream-card-title');
    if (t && t.textContent !== (s.title || 'Untitled Stream')) t.textContent = s.title || 'Untitled Stream';
    // AI overview: the card renders WITHOUT an overview block when the stream first
    // goes live (none exists yet). Inject it the moment one becomes available, then
    // keep its text current — otherwise it never appears without a full reload.
    if (s.ai_overview) {
        const aiBox = card.querySelector('.card-ai-overview');
        if (aiBox) {
            const shortTxt = (s.ai_overview_short || s.ai_overview || '').trim();
            const longTxt = (s.ai_overview || '').trim();
            // Don't clobber the text while the viewer has it expanded.
            if (!aiBox.classList.contains('expanded')) {
                const ai = aiBox.querySelector('.card-ai-text');
                if (ai && shortTxt && ai.textContent !== shortTxt) ai.textContent = shortTxt;
            }
            if (longTxt && longTxt !== shortTxt) aiBox.dataset.full = longTxt; else delete aiBox.dataset.full;
        } else {
            const info = card.querySelector('.stream-card-info');
            if (info) {
                const tmp = document.createElement('div');
                tmp.innerHTML = _cardAiHTML(s.ai_overview_short, s.ai_overview);
                const el = tmp.firstElementChild;
                if (el) {
                    const meta = info.querySelector('.stream-card-meta');
                    meta ? info.insertBefore(el, meta) : info.appendChild(el);
                }
            }
        }
    }
    const desc = card.querySelector('.stream-card-desc');
    if (desc && s.description != null && desc.textContent !== s.description) desc.textContent = s.description;
    // Thumbnail: live cards render a placeholder icon (no <img>) until the first frame
    // is captured. Crossfade if an <img> exists, else swap the placeholder for one.
    if (s.thumbnail_url) {
        const thumbBox = card.querySelector('.stream-card-thumb');
        const img = thumbBox && thumbBox.querySelector('img');
        if (img) {
            _crossfadeThumb(img, s.thumbnail_url);
        } else if (thumbBox) {
            const placeholder = thumbBox.querySelector(':scope > i');
            const newImg = document.createElement('img');
            newImg.alt = s.title || '';
            newImg.loading = 'lazy';
            newImg.style.opacity = '0';
            newImg.style.transition = 'opacity 0.4s';
            newImg.onerror = function () { handleThumbnailError(this); };
            newImg.onload = function () { this.style.opacity = '1'; };
            newImg.src = s.thumbnail_url;
            thumbBox.insertBefore(newImg, thumbBox.firstChild);
            if (placeholder) placeholder.style.display = 'none';
        }
    }
}

// Live-counting uptime tooltip: hover an uptime chip to see H:MM:SS ticking.
let _uptimeTipEl = null, _uptimeTipTimer = null, _uptimeTipSince = 0;
function _fmtHMS(ms) {
    let sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function _initUptimeTooltip() {
    if (window.__uptimeTipInit) return; window.__uptimeTipInit = true;
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest && e.target.closest('.stream-card-uptime[data-since]');
        if (!el) return;
        const raw = el.dataset.since;
        const isUTC = raw.includes('Z') || raw.includes('+') || raw.includes('T');
        _uptimeTipSince = new Date(isUTC ? raw : raw.replace(' ', 'T') + 'Z').getTime();
        if (!_uptimeTipEl) {
            _uptimeTipEl = document.createElement('div');
            _uptimeTipEl.className = 'uptime-tooltip';
            document.body.appendChild(_uptimeTipEl);
        }
        const tick = () => {
            _uptimeTipEl.textContent = 'Live for ' + _fmtHMS(Date.now() - _uptimeTipSince);
        };
        tick();
        const r = el.getBoundingClientRect();
        _uptimeTipEl.style.left = Math.round(r.left) + 'px';
        _uptimeTipEl.style.top = Math.round(r.top - 30) + 'px';
        _uptimeTipEl.style.display = 'block';
        clearInterval(_uptimeTipTimer);
        _uptimeTipTimer = setInterval(tick, 1000);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest && e.target.closest('.stream-card-uptime[data-since]');
        if (!el) return;
        clearInterval(_uptimeTipTimer);
        if (_uptimeTipEl) _uptimeTipEl.style.display = 'none';
    });
}

// Reconcile the live grid in place: update existing cards, animate in new streams,
// animate out ended ones — no full re-render, no flashing.
async function refreshHomeLive() {
    if (!_homeIsActive()) return;
    let streams;
    try { const d = await api('/streams'); streams = d.streams || []; } catch { return; }
    const grid = document.getElementById('stream-grid-live');
    if (!grid) return;
    const countEl = document.getElementById('live-count');
    if (countEl) countEl.textContent = streams.length;
    const noLiveEl = document.getElementById('no-live-streams');
    if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';

    const existing = new Map();
    grid.querySelectorAll('.stream-card[data-stream-id]').forEach(el => existing.set(el.dataset.streamId, el));
    const seen = new Set();
    streams.forEach((s, idx) => {
        const id = String(s.id);
        seen.add(id);
        const card = existing.get(id);
        if (card) {
            _updateLiveCard(card, s);
        } else {
            const tmp = document.createElement('div');
            tmp.innerHTML = streamCardHTML(s, true).trim();
            const el = tmp.firstElementChild;
            if (el) {
                el.classList.add('stream-card-appear');
                grid.insertBefore(el, grid.children[idx] || null);
            }
        }
    });
    existing.forEach((el, id) => {
        if (!seen.has(id)) {
            el.classList.add('stream-card-leave');
            setTimeout(() => { try { el.remove(); } catch {} }, 420);
        }
    });
}

// Refresh the paginated home sections (only at page 1, only when visible — so we
// never disrupt someone paging through or reading below the fold).
function refreshHomeSections() {
    if (!_homeIsActive() || document.visibilityState !== 'visible') return;
    if (_homeRecentOnlinePage === 1 && typeof loadHomeRecentOnline === 'function') loadHomeRecentOnline();
    if (_homeRecentVodsPage === 1 && typeof loadHomeRecentVods === 'function') loadHomeRecentVods();
    if (_homeClipsPage === 1 && typeof loadHomeClips === 'function') loadHomeClips();
    if (_homePastesPage === 1 && typeof loadHomePastes === 'function') loadHomePastes();
    if (typeof loadHomeLeaderboards === 'function') loadHomeLeaderboards();
}

function startHomeRefresh() {
    stopHomeRefresh();
    _initUptimeTooltip();
    _homeLiveTimer = setInterval(refreshHomeLive, 12000);
    _homeSectionsTimer = setInterval(refreshHomeSections, 60000);
}
function stopHomeRefresh() {
    if (_homeLiveTimer) { clearInterval(_homeLiveTimer); _homeLiveTimer = null; }
    if (_homeSectionsTimer) { clearInterval(_homeSectionsTimer); _homeSectionsTimer = null; }
}

/* ── Channel Page (/:username) ────────────────────────────────── */
let currentChannelUsername = null;
let _activeChannelIsOwnerRank = false; // is the current channel's user owner-rank?
let _activeChannelUserId = null;       // streamer's user id — the stable chat room key
const VODS_PAGE_SIZE = 24;          // now = grouped SESSIONS (cards) per page
const VODS_FETCH_WINDOW = 600;      // raw VODs fetched up-front to group + paginate client-side
let _vodsGroupCache = { key: null, groups: [], totalVideos: 0, streamers: [], truncated: false };
const CHANNEL_VODS_PAGE_SIZE = 12;
const CLIPS_PAGE_SIZE = 24;
const CHANNEL_CLIPS_PAGE_SIZE = 12;
let currentVodsPage = 1;
let currentClipsPage = 1;
let currentVodsStreamerFilter = 'all';
let currentClipsStreamerFilter = 'all';
let currentVodsSort = 'newest';
let currentClipsSort = 'newest';
const channelVodsPageByUser = Object.create(null);
const channelClipsPageByUser = Object.create(null);
const channelClipsOfPageByUser = Object.create(null);
// Channel VOD filter/sort state
let currentChannelVodFilter = null;   // numeric managed stream id or null = all
let currentChannelVodOrder = 'newest'; // newest|oldest|views|peak_viewers
let currentChannelManagedStreams = []; // populated on channel load, used for filter bar
// Homepage pagination state
let _homeRecentOnlinePage = 1;
let _homeRecentVodsPage = 1;
let _homeClipsPage = 1;
let _homePastesPage = 1;
const HOME_RECENT_ONLINE_PAGE_SIZE = 12;
const HOME_RECENT_VODS_PAGE_SIZE = 12;
const HOME_CLIPS_PAGE_SIZE = 12;
const HOME_PASTES_PAGE_SIZE = 10;

// Small Newest/Oldest segmented control (shared markup). `setter` is a global fn name
// taking 'newest'|'oldest'.
function sortToggleHTML(sort, setter) {
    const cur = sort === 'oldest' ? 'oldest' : 'newest';
    return `<div class="sort-toggle" role="group" aria-label="Sort order">
        <span class="sort-toggle-label"><i class="fa-solid fa-arrow-down-short-wide"></i> Sort</span>
        <button type="button" class="sort-btn ${cur === 'newest' ? 'active' : ''}" onclick="${setter}('newest')">Newest</button>
        <button type="button" class="sort-btn ${cur === 'oldest' ? 'active' : ''}" onclick="${setter}('oldest')">Oldest</button>
    </div>`;
}

function renderVodsPagination(containerId, page, total, pageSize, setterName, itemLabel = 'videos', sortOpts = null) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const totalItems = Math.max(0, Number(total) || 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    // With a sort toggle we always render (so sorting stays available on a single page).
    if (totalPages <= 1 && !sortOpts) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const start = totalItems ? ((page - 1) * pageSize) + 1 : 0;
    const end = Math.min(page * pageSize, totalItems);

    const sortHtml = sortOpts ? sortToggleHTML(sortOpts.sort, sortOpts.setter) : '';
    const pageHtml = totalPages > 1 ? `
        <button class="btn btn-small btn-outline" ${page <= 1 ? 'disabled' : ''} onclick="${setterName}(${page - 1})">
            <i class="fa-solid fa-chevron-left"></i> Prev
        </button>
        <span class="pastes-page-info">Showing ${start}-${end} of ${totalItems} ${itemLabel} • Page ${page}/${totalPages}</span>
        <button class="btn btn-small btn-outline" ${page >= totalPages ? 'disabled' : ''} onclick="${setterName}(${page + 1})">
            Next <i class="fa-solid fa-chevron-right"></i>
        </button>` : (sortOpts && totalItems ? `<span class="pastes-page-info">${totalItems} ${itemLabel}</span>` : '');

    el.style.display = '';
    el.innerHTML = sortHtml + pageHtml;
}

// Thin wrapper for homepage section pagination — same visual style as renderVodsPagination.
function renderHomePagination(containerId, total, page, pageSize, setterName) {
    renderVodsPagination(containerId, page, total, pageSize, setterName, 'items');
}

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

// Prettify a category/tag for display: capitalize words, upper-case known acronyms.
// e.g. "desktop" -> "Desktop", "irl" -> "IRL", "just chatting" -> "Just Chatting".
const _TAG_ACRONYMS = { irl: 'IRL', asmr: 'ASMR', diy: 'DIY', pvp: 'PvP', tts: 'TTS', nsfw: 'NSFW', vr: 'VR', ai: 'AI', fps: 'FPS', mmo: 'MMO', rpg: 'RPG' };
function _capTag(s) {
    if (!s) return s;
    return String(s).trim().split(/\s+/).map(w => {
        const lw = w.toLowerCase();
        if (_TAG_ACRONYMS[lw]) return _TAG_ACRONYMS[lw];
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
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
                    <span class="stream-card-viewers"><i class="fa-solid fa-eye"></i> ${cl.view_count || 0}</span>
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

    if (total === 0) { grid.innerHTML = '<p class="muted">No clips yet</p>'; return; }

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

function setVodsPage(page) {
    const safePage = Math.max(1, page | 0);
    if (safePage === currentVodsPage) return;
    currentVodsPage = safePage;
    loadVodsPage();
    const top = document.getElementById('page-vods');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setClipsPage(page) {
    const safePage = Math.max(1, page | 0);
    if (safePage === currentClipsPage) return;
    currentClipsPage = safePage;
    loadClipsPage();
    const top = document.getElementById('page-clips');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setVodsSort(sort) {
    const s = sort === 'oldest' ? 'oldest' : 'newest';
    if (s === currentVodsSort) return;
    currentVodsSort = s;
    currentVodsPage = 1;
    loadVodsPage();
}

function setClipsSort(sort) {
    const s = sort === 'oldest' ? 'oldest' : 'newest';
    if (s === currentClipsSort) return;
    currentClipsSort = s;
    currentClipsPage = 1;
    loadClipsPage();
}

function renderMediaStreamerFilters({
    barId,
    streamers = [],
    activeFilter = 'all',
    onSelect = 'setVodsStreamerFilter',
    countKey = 'vod_count',
    allLabel = 'All streamers',
} = {}) {
    const bar = document.getElementById(barId);
    if (!bar) return;

    const normalizedActive = (activeFilter || 'all').toLowerCase();
    const unique = [];
    const seen = new Set();
    for (const streamer of (streamers || [])) {
        const username = String(streamer?.username || '').trim();
        if (!username) continue;
        const key = username.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(streamer);
    }

    if (!unique.length) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = `
        <button class="media-filter-chip ${normalizedActive === 'all' ? 'active' : ''}" onclick="${onSelect}('all')">
            <i class="fa-solid fa-layer-group"></i>
            <span>${esc(allLabel)}</span>
        </button>
        ${unique.map(streamer => {
            const username = String(streamer.username || '').trim();
            const label = streamer.display_name || username;
            const count = Number(streamer[countKey] || 0);
            return `
                <button class="media-filter-chip ${normalizedActive === username.toLowerCase() ? 'active' : ''}" onclick="${onSelect}('${esc(username)}')">
                    <span>${esc(label)}</span>
                    ${count > 0 ? `<span class="media-filter-chip-count">${count}</span>` : ''}
                </button>
            `;
        }).join('')}
    `;
}

function renderVodsStreamerFilters(streamers = [], activeFilter = 'all') {
    renderMediaStreamerFilters({
        barId: 'vods-streamer-filters',
        streamers,
        activeFilter,
        onSelect: 'setVodsStreamerFilter',
        countKey: 'vod_count',
        allLabel: 'All streamers',
    });
}

function renderClipsStreamerFilters(streamers = [], activeFilter = 'all') {
    renderMediaStreamerFilters({
        barId: 'clips-streamer-filters',
        streamers,
        activeFilter,
        onSelect: 'setClipsStreamerFilter',
        countKey: 'clip_count',
        allLabel: 'All streamers',
    });
}

function setVodsStreamerFilter(username = 'all') {
    const nextFilter = String(username || 'all').trim() || 'all';
    if (nextFilter === currentVodsStreamerFilter) return;
    currentVodsStreamerFilter = nextFilter;
    currentVodsPage = 1;
    loadVodsPage();
    const top = document.getElementById('page-vods');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setClipsStreamerFilter(username = 'all') {
    const nextFilter = String(username || 'all').trim() || 'all';
    if (nextFilter === currentClipsStreamerFilter) return;
    currentClipsStreamerFilter = nextFilter;
    currentClipsPage = 1;
    loadClipsPage();
    const top = document.getElementById('page-clips');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/* ── Global Chat Page ──────────────────────────────────────── */
function loadChatPage() {
    // Connect to global chat (no streamId)
    initChat(null);
    // Load global history
    loadGlobalChatHistory();
    // Global chat AI overview + timeline (refreshed periodically)
    loadGlobalChatAi();
    if (window._globalAiPollTimer) clearInterval(window._globalAiPollTimer);
    window._globalAiPollTimer = setInterval(loadGlobalChatAi, 90000);
}

// Turn a UTC SQL timestamp ("YYYY-MM-DD HH:MM:SS") or ISO string into "x ago".
function _aiTimeAgo(ts) {
    if (!ts) return '';
    let s = String(ts);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    try { return (typeof timeAgo === 'function') ? timeAgo(s) : new Date(s).toLocaleString(); }
    catch { return ''; }
}

async function loadGlobalChatAi() {
    const strip = document.getElementById('global-ai-strip');
    const panel = document.getElementById('global-ai-panel');
    if (!strip || !panel) return;
    let insight = null;
    try { insight = (await api('/chat-ai/global')).insight; } catch { /* silent */ }
    if (!insight || !insight.overview) {
        strip.style.display = 'none';
        // Keep the panel only if the user had already opened it.
        if (!panel.classList.contains('gai-user-opened')) panel.style.display = 'none';
        return;
    }
    // Header strip (compact)
    const stripText = document.getElementById('global-ai-strip-text');
    if (stripText) stripText.textContent = insight.overview;
    strip.style.display = 'flex';

    // Full panel
    const ov = document.getElementById('global-ai-overview');
    if (ov) ov.textContent = insight.overview;
    const meta = document.getElementById('global-ai-meta');
    if (meta) {
        const bits = [];
        if (insight.window_label) bits.push(insight.window_label);
        if (insight.updated_at) bits.push('updated ' + _aiTimeAgo(insight.updated_at));
        meta.textContent = bits.join(' · ');
    }
    // The timeline is now a browsable/searchable, infinite-scroll list (fed by /chat-ai/timeline).
    // Initialise once so polling doesn't clobber the user's scroll/search.
    if (document.getElementById('global-ai-timeline') && !_gaiTlInited) { _gaiTlInited = true; _gaiTlInit(); }
    const mem = document.getElementById('global-ai-memory');
    if (mem) mem.textContent = insight.memory || '';
    if (mem && !insight.memory) { mem.innerHTML = '<span class="gai-empty">Still building a picture of the community…</span>'; }
}

// ── Global chat AI timeline browser (search + period jump + infinite scroll) ─────────────
let _gaiTlInited = false;
let _gaiTl = { q: '', since: null, periodBefore: null, oldestTs: 0, loading: false, done: false, lastDay: null };
let _gaiTlSearchTimer = null;

function _gaiTlPeriodBounds(period) {
    const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    switch (period) {
        case 'today': return { since: startOfToday, before: null };
        case 'yesterday': return { since: startOfToday - 86400000, before: startOfToday };
        case 'week': return { since: startOfToday - 6 * 86400000, before: null };
        case 'month': return { since: startOfToday - 29 * 86400000, before: null };
        default: return { since: null, before: null };
    }
}
function _gaiTlPeriod(period, btn) {
    document.querySelectorAll('#gai-tl-periods .gai-tl-chip').forEach(b => b.classList.toggle('active', b === btn));
    const b = _gaiTlPeriodBounds(period);
    _gaiTl.since = b.since; _gaiTl.periodBefore = b.before;
    _gaiTlInit();
}
function _gaiTlSearchDebounced(v) {
    clearTimeout(_gaiTlSearchTimer);
    _gaiTlSearchTimer = setTimeout(() => { _gaiTl.q = (v || '').trim(); _gaiTlInit(); }, 300);
}
function _gaiTlOnScroll(el) {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 90) _gaiTlLoad(false);
}
async function _gaiTlInit() {
    _gaiTl.oldestTs = 0; _gaiTl.done = false; _gaiTl.loading = false; _gaiTl.lastDay = null;
    const el = document.getElementById('global-ai-timeline');
    if (el) { el.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>'; el.scrollTop = 0; }
    await _gaiTlLoad(true);
}
async function _gaiTlLoad(reset) {
    if (_gaiTl.loading || (_gaiTl.done && !reset)) return;
    _gaiTl.loading = true;
    const p = new URLSearchParams({ limit: '25' });
    if (_gaiTl.q) p.set('q', _gaiTl.q);
    if (_gaiTl.since) p.set('since', String(_gaiTl.since));
    if (reset && _gaiTl.periodBefore) p.set('before', String(_gaiTl.periodBefore));
    else if (!reset && _gaiTl.oldestTs) p.set('before', String(_gaiTl.oldestTs));
    let data;
    try { data = await api('/chat-ai/timeline?' + p.toString()); } catch { _gaiTl.loading = false; return; }
    const el = document.getElementById('global-ai-timeline');
    if (!el) { _gaiTl.loading = false; return; }
    const events = data.events || [];
    if (reset) { el.innerHTML = ''; _gaiTl.lastDay = null; }
    if (events.length) {
        el.insertAdjacentHTML('beforeend', _gaiTlRenderGroups(events));
        _gaiTl.oldestTs = new Date(String(events[events.length - 1].ts).replace(' ', 'T') + 'Z').getTime();
    } else if (reset) {
        el.innerHTML = `<div class="gai-empty">${_gaiTl.q ? 'No moments match your search.' : 'No standout moments logged yet.'}</div>`;
    }
    _gaiTl.done = !data.hasMore;
    _gaiTl.loading = false;
}
function _gaiTlDayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dd = new Date(d); dd.setHours(0, 0, 0, 0);
    const diff = Math.round((today - dd) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function _gaiTlRenderGroups(events) {
    let html = '';
    for (const e of events) {
        const d = new Date(String(e.ts).replace(' ', 'T') + 'Z');
        const dayKey = d.toDateString();
        if (dayKey !== _gaiTl.lastDay) { _gaiTl.lastDay = dayKey; html += `<div class="gai-tl-day">${esc(_gaiTlDayLabel(d))}</div>`; }
        html += `<div class="gai-tl-item">
            <div class="gai-tl-when">${esc(_aiTimeAgo(e.ts))}</div>
            <div class="gai-tl-label">${esc(e.label || '')}</div>
            ${e.detail ? `<div class="gai-tl-detail">${esc(e.detail)}</div>` : ''}
        </div>`;
    }
    return html;
}

function toggleGlobalAiPanel() {
    const panel = document.getElementById('global-ai-panel');
    const strip = document.getElementById('global-ai-strip');
    if (!panel) return;
    const showing = panel.style.display !== 'none' && panel.style.display !== '';
    if (showing) {
        panel.style.display = 'none';
        panel.classList.remove('gai-user-opened');
        if (strip) strip.classList.remove('open');
    } else {
        panel.style.display = 'block';
        panel.classList.add('gai-user-opened');
        if (strip) strip.classList.add('open');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// Per-user chat insight — "today vs all-time" read of a chatter. Opened from a
// username's context (chat, profile). Fetches on demand.
// Shared "today vs all-time" chat-insight modal. `opts`: { title, iconClass, subtitle,
// fetchUrl }. Used for both native users and bridged relay users.
async function _openChatInsightModal(opts) {
    document.getElementById('user-ai-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'user-ai-modal-overlay';
    overlay.className = 'user-ai-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="user-ai-modal">
            <div class="user-ai-modal-head">
                <h3><i class="fa-solid ${opts.iconClass || 'fa-user-tag'}"></i> ${esc(opts.title || 'User')}</h3>
                <span class="gai-badge"><i class="fa-solid fa-wand-magic-sparkles"></i> AI</span>
                <button class="uai-close" onclick="document.getElementById('user-ai-modal-overlay').remove()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div id="user-ai-modal-body"><div class="gai-empty">Loading insight…</div></div>
        </div>`;
    document.body.appendChild(overlay);

    let data = null;
    try { data = await api(opts.fetchUrl); } catch { /* */ }
    const body = document.getElementById('user-ai-modal-body');
    if (!body) return;
    const ins = data && data.insight;
    const st = data && data.streamer;
    const hasChat = !!(ins && (ins.overview_24h || ins.overview_alltime));
    const hasStreamer = !!(st && (st.overview || st.overview_short));
    if (!hasChat && !hasStreamer) {
        body.innerHTML = '<div class="gai-empty">No AI insight yet — this user hasn\'t chatted enough recently. The analysis builds up over time; check back soon.</div>';
        return;
    }

    let html = '';

    // Streamer section first — who they are as a streamer + recent on-stream context.
    // Styled to match the chat sections below. The timeline is truncated here and links out
    // to the streamer's full AI Timeline tab on their channel page.
    if (hasStreamer) {
        const uname = opts.username || opts.title || '';
        const MEM_PREVIEW = 3;
        const mems = (st.memories || []).slice(0, MEM_PREVIEW);
        const hasMore = (st.memories || []).length > MEM_PREVIEW || !!uname;
        const fullLink = uname
            ? `<a class="uai-tl-more" href="${channelPath(uname)}#ai-timeline" onclick="document.getElementById('user-ai-modal-overlay')?.remove(); return handleLinkClick(event, '${channelPath(uname)}#ai-timeline')"><i class="fa-solid fa-timeline"></i> View full AI timeline <i class="fa-solid fa-arrow-right" style="font-size:0.8em"></i></a>`
            : '';
        html += `<div class="uai-group-label"><i class="fa-solid fa-tower-broadcast"></i> As a streamer</div>`;
        html += `<p class="uai-sub uai-group-sub">Who they are as a streamer — from the AI analysis of their streams.</p>`;
        html += `
            ${_uaiCollapsible('Streamer overview', '<span class="uai-tag uai-tag-streamer">channel</span>', esc(st.overview || st.overview_short || ''), { icon: 'fa-wand-magic-sparkles' })}
            ${mems.length ? `<div class="uai-section">
                <h4><i class="fa-solid fa-timeline"></i> Recent stream moments</h4>
                <div class="gai-timeline">${mems.map(m => `
                    <div class="gai-tl-item">
                        <div class="gai-tl-when">${_aiTimeAgo(m.created_at)}</div>
                        <div class="gai-tl-detail">${esc(m.description || '')}</div>
                    </div>`).join('')}</div>
                ${hasMore ? fullLink : ''}
            </div>` : (fullLink ? `<div class="uai-section">${fullLink}</div>` : '')}`;
    }

    // Chat-behavior insight.
    if (hasChat) {
        const tl = (ins.timeline || []).slice().reverse();
        html += `<div class="uai-group-label"><i class="fa-solid fa-comments"></i> In chat</div>`;
        html += `<p class="uai-sub uai-group-sub">How they chat today vs. overall — from their public chat messages.</p>`;
        html += `
            ${_uaiCollapsible('Today', '<span class="uai-tag uai-tag-today">last 24h</span>', ins.has_24h ? esc(ins.overview_24h) : '<span class="gai-empty">' + esc(ins.overview_24h || 'Quiet in the last 24 hours.') + '</span>', { icon: 'fa-bolt' })}
            ${_uaiCollapsible('Overall', '<span class="uai-tag uai-tag-all">all-time</span>', esc(ins.overview_alltime || ''), { icon: 'fa-infinity' })}
            ${tl.length ? (() => {
                // Relay users have no channel page → expand the full timeline inline (lazy).
                // Everyone else links out to their channel's AI Timeline tab.
                const hasChannel = !!(opts.username || opts.title) && !opts.isRelay;
                const PREVIEW = opts.isRelay ? 5 : 3;
                const items = tl.map((t, i) => `
                    <div class="gai-tl-item${i >= PREVIEW ? ' uai-tl-item-hidden' : ''}">
                        <div class="gai-tl-when">${_aiTimeAgo(t.ts)}</div>
                        <div class="gai-tl-label">${esc(t.label || '')}</div>
                        ${t.detail ? `<div class="gai-tl-detail">${esc(t.detail)}</div>` : ''}
                    </div>`).join('');
                const footer = hasChannel
                    ? `<a class="uai-tl-more" href="${channelPath(opts.username || opts.title)}#ai-timeline" onclick="document.getElementById('user-ai-modal-overlay')?.remove(); return handleLinkClick(event, '${channelPath(opts.username || opts.title)}#ai-timeline')"><i class="fa-solid fa-timeline"></i> View full AI timeline <i class="fa-solid fa-arrow-right" style="font-size:0.8em"></i></a>`
                    : (tl.length > PREVIEW ? `<button type="button" class="uai-tl-more" onclick="_uaiRevealMore(this)"><i class="fa-solid fa-chevron-down"></i> Show ${tl.length - PREVIEW} more</button>` : '');
                return `<div class="uai-section">
                    <h4><i class="fa-solid fa-timeline"></i> Notable moments</h4>
                    <div class="gai-timeline">${items}</div>
                    ${footer}
                </div>`;
            })() : ''}
            <p class="uai-sub" style="margin:14px 0 0">${ins.updated_at ? 'Updated ' + _aiTimeAgo(ins.updated_at) : ''}${ins.message_count ? ' · ~' + ins.message_count + ' messages analyzed' : ''}</p>`;
    } else if (hasStreamer) {
        html += `<p class="uai-sub" style="margin:6px 0 0">No chat insight yet — this user hasn't chatted enough recently.</p>`;
    }

    body.innerHTML = html;
}

// Build a collapsible overview section (collapsed by default). The header toggles it open;
// a short preview of the text shows while collapsed so it's clear there's content to expand.
function _uaiCollapsible(title, tagHtml, bodyHtml, opts = {}) {
    const plain = String(bodyHtml || '').replace(/<[^>]*>/g, '').trim();
    const preview = plain.length > 90 ? plain.slice(0, 90).trimEnd() + '…' : plain;
    return `<div class="uai-section uai-collapsible">
        <h4 class="uai-collapse-toggle" onclick="_uaiToggleSection(this)" role="button" tabindex="0">
            <i class="fa-solid ${opts.icon || 'fa-wand-magic-sparkles'}"></i> ${title} ${tagHtml || ''}
            <i class="fa-solid fa-chevron-down uai-collapse-caret"></i>
        </h4>
        <div class="uai-collapse-preview">${esc(preview)}</div>
        <div class="uai-collapse-body"><div class="uai-body">${bodyHtml}</div></div>
    </div>`;
}
// Toggle a collapsible AI-insight section open/closed.
function _uaiToggleSection(h4) {
    const section = h4.closest('.uai-collapsible');
    if (section) section.classList.toggle('uai-open');
}
window._uaiToggleSection = _uaiToggleSection;

// Reveal the next batch of an inline (relay-user) timeline — lazy expansion in place.
function _uaiRevealMore(btn) {
    const section = btn.closest('.uai-section');
    const tl = section?.querySelector('.gai-timeline');
    if (!tl) return;
    let n = 0;
    for (const el of tl.querySelectorAll('.uai-tl-item-hidden')) { el.classList.remove('uai-tl-item-hidden'); if (++n >= 12) break; }
    const remaining = tl.querySelectorAll('.uai-tl-item-hidden').length;
    if (remaining > 0) btn.innerHTML = `<i class="fa-solid fa-chevron-down"></i> Show ${remaining} more`;
    else btn.remove();
}
window._uaiRevealMore = _uaiRevealMore;

async function openUserChatInsight(userId, username) {
    if (!userId) return;
    return _openChatInsightModal({ title: username || 'User', username: username || '', iconClass: 'fa-user-tag', fetchUrl: `/chat-ai/user/${userId}` });
}
window.openUserChatInsight = openUserChatInsight;

// Anonymous chatter insight — keyed by their stable anon_id ("anon<N>").
async function openAnonChatInsight(anonId) {
    if (!anonId) return;
    return _openChatInsightModal({
        title: anonId,
        iconClass: 'fa-user-secret',
        subtitle: 'Anonymous chatter — how they chat today vs. overall, from their public messages.',
        fetchUrl: `/chat-ai/anon/${encodeURIComponent(anonId)}`,
    });
}
window.openAnonChatInsight = openAnonChatInsight;

// Relay (external-platform) chatter insight.
async function openRelayUserChatInsight(platform, username, displayPlatform) {
    if (!platform || !username) return;
    const plat = (displayPlatform || platform);
    return _openChatInsightModal({
        title: `${username}`,
        iconClass: 'fa-link',
        isRelay: true, // no channel page → expand the timeline inline instead of linking out
        subtitle: `Bridged ${plat} chatter — how they chat today vs. overall, from their relayed messages.`,
        fetchUrl: `/chat-ai/relay/${encodeURIComponent(platform)}/${encodeURIComponent(username)}`,
    });
}
window.openRelayUserChatInsight = openRelayUserChatInsight;

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
            document.getElementById('ch-category-badge').textContent = _capTag((liveStreams[0] && liveStreams[0].category) || ch.ai_category || ch.category || 'Live');
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
            document.getElementById('ch-category-badge-offline').textContent = _capTag(ch.ai_category || ch.category || 'Offline');
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
function formatUptime(startedAt) {
    if (!startedAt) return '';
    const start = new Date(startedAt.replace ? startedAt.replace(' ', 'T') + 'Z' : startedAt).getTime();
    if (isNaN(start)) return '';
    const d = Date.now() - start;
    if (d < 0) return '';
    const h = Math.floor(d / 3600000);
    const m = Math.floor((d % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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

    // Auto-scroll active tab into view after render
    requestAnimationFrame(scrollActiveTabIntoView);

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

async function loadChannelWeather(username) {
    // Weather now lives at the top of the About tab.
    const widgets = [document.getElementById('ch-weather-widget-about')];
    widgets.forEach(w => { if (w) w.style.display = 'none'; });

    try {
        const data = await api(`/streams/channel/${username}/weather`);
        if (!data || !data.enabled || !data.current) return;

        _channelWeatherData = data;
        const html = renderWeatherWidget(data);
        widgets.forEach(w => {
            if (w) { w.innerHTML = html; w.style.display = ''; }
        });
    } catch { /* silent */ }
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
        html += `<span class="ch-restream-badge" style="color:var(--accent)" title="Watching live on OpenVibe.Live${streamCount > 1 ? ` (across ${streamCount} streams)` : ''}"><i class="fa-solid fa-circle-nodes"></i> OV <i class="fa-solid fa-eye" style="font-size:0.75em"></i> ${hsTotal}</span>`;
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
    if (stream.category) { const _cb = document.getElementById('ch-category-badge'); if (_cb) _cb.textContent = _capTag(stream.category); }
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

/* ── Stream Status Polling — auto-detect online/offline ──────── */
let _streamPollTimer = null;
const STREAM_POLL_INTERVAL = 15000; // 15 seconds
// After the player reports the stream ended (or we otherwise know the channel just
// flipped state), poll far more aggressively for a short window. A streamer who
// bounces offline→online in a couple of seconds would otherwise leave viewers
// parked on the "Stream has ended" card for up to 2 × STREAM_POLL_INTERVAL: one
// interval for the live poll to notice the stream died, another for the offline
// poll to notice it came back.
const STREAM_POLL_FAST_INTERVAL = 2000;  // 2 seconds
const STREAM_POLL_FAST_WINDOW = 90000;   // burst for 90s, then fall back
let _streamPollFastUntil = 0;
// Whether the currently-scheduled interval was armed at the fast cadence, so we
// only tear the timer down and rebuild it when the cadence actually needs to change.
let _streamPollFast = false;

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

/**
 * Open (or extend) the fast-poll burst window and re-arm the running poll at the
 * fast cadence right away, so the next check lands in ~2s instead of ~15s.
 */
function _accelerateStreamStatusPoll() {
    _streamPollFastUntil = Date.now() + STREAM_POLL_FAST_WINDOW;
    if (_streamPollTimer && !_streamPollFast && _streamPollRearm) {
        _streamPollRearm();
    }
}

// Set by whichever poll (live/offline) is currently armed; lets
// _accelerateStreamStatusPoll() rebuild the interval at the new cadence.
let _streamPollRearm = null;

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
function _fmtCount(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }

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
    setBadge('ch-tab-badge-clips', data.clipsOfTotal);
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
    if (_aboutBio) html += `<div class="ch-about-bio">${_linkify(esc(_aboutBio))}</div>`;
    html += '<div class="ch-about-panels">' + _aboutPanels.map((p, i) => _aboutPanelViewHTML(p, i)).join('') + '</div>';
    host.innerHTML = html;
    _fillWeatherPanels();
}

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

// ── Donation goal widget (top of chat, live + offline) ───────
let _goalWidget = { userId: null, goals: [], timer: null };
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
}
function renderGoalWidget() {
    const goals = _goalWidget.goals || [];
    document.querySelectorAll('#ch-goal-widget, #ch-goal-widget-offline').forEach(el => _renderGoalWidgetInto(el, goals));
}
// One goal → plain. Multiple goals → a short, auto-scrolling (marquee) viewport that
// stays compact, with a faded bottom + animated caret to expand the full list.
function _renderGoalWidgetInto(el, goals) {
    if (!el) return;
    if (!goals.length) { el.style.display = 'none'; el.innerHTML = ''; el.classList.remove('cgw-multi', 'cgw-expanded'); return; }
    el.style.display = '';
    const items = goals.map(_goalWidgetItemHTML).join('');
    if (goals.length <= 1) {
        el.classList.remove('cgw-multi', 'cgw-expanded');
        el.innerHTML = `<div class="cgw-track cgw-track-static">${items}</div>`;
        return;
    }
    el.classList.add('cgw-multi');
    el.dataset.goalCount = goals.length;
    if (el.classList.contains('cgw-expanded')) {
        el.innerHTML = `
            <div class="cgw-viewport cgw-viewport-expanded"><div class="cgw-track cgw-track-static">${items}</div></div>
            <button class="cgw-more expanded" onclick="toggleGoalWidgetExpand(this)" title="Collapse goals" aria-label="Collapse goals"><i class="fa-solid fa-chevron-up"></i></button>`;
    } else {
        // Collapsed: RESTS on the streamer's first goal. The full list scrolls past just
        // once every ~30 min (constant motion is distracting), then settles back on the
        // first goal — so a streamer can put their most-important goal first. Append a
        // clone of the first goal so the single scroll pass loops back to it seamlessly.
        const firstItem = _goalWidgetItemHTML(goals[0]);
        el.innerHTML = `
            <div class="cgw-viewport"><div class="cgw-track cgw-track-cycle">${items}${firstItem}</div></div>
            <button class="cgw-more" onclick="toggleGoalWidgetExpand(this)" title="Show all goals" aria-label="Show all goals"><i class="fa-solid fa-chevron-down"></i></button>`;
        _ensureGoalCycleScheduler();
    }
}

// A gentle scroll-through of all goals 3× per half hour (every 10 min), then rest on
// the first goal — enough to surface every goal without constant distracting motion.
const GOAL_CYCLE_INTERVAL_MS = 10 * 60 * 1000;
const GOAL_CYCLE_ROW_MS = 2600; // scroll time per goal during the once-per-30-min pass
let _goalCycleTimer = null;
function _ensureGoalCycleScheduler() {
    if (_goalCycleTimer) return;
    // A single 30-min ticker that re-queries the DOM each time — survives widget
    // re-renders (goal updates / periodic refresh) without resetting the schedule.
    _goalCycleTimer = setInterval(() => {
        document.querySelectorAll('.ch-goal-widget.cgw-multi:not(.cgw-expanded)').forEach(_playGoalCycle);
    }, GOAL_CYCLE_INTERVAL_MS);
}
function _playGoalCycle(el) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const track = el && el.querySelector('.cgw-track-cycle');
    if (!track || track.children.length < 2) return;
    const n = parseInt(el.dataset.goalCount || '0', 10);
    if (n < 2) return;
    const first = track.children[0];
    const stride = first.offsetHeight + 6; // row height + margin
    // Start from rest (first goal), scroll through all N to the appended first-clone.
    track.style.transition = 'none';
    track.style.transform = 'translateY(0)';
    void track.offsetHeight; // reflow so the next transition animates
    track.style.transition = `transform ${n * GOAL_CYCLE_ROW_MS}ms ease-in-out`;
    track.style.transform = `translateY(-${stride * n}px)`;
    const onEnd = () => {
        track.removeEventListener('transitionend', onEnd);
        track.style.transition = 'none';
        track.style.transform = 'translateY(0)'; // snap back to the real first goal
    };
    track.addEventListener('transitionend', onEnd);
}
function toggleGoalWidgetExpand(btn) {
    const el = btn && btn.closest('.ch-goal-widget');
    if (!el) return;
    el.classList.toggle('cgw-expanded');
    _renderGoalWidgetInto(el, _goalWidget.goals || []);
}
function _goalWidgetItemHTML(g) {
    const pct = g.target_amount ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
    const reached = (!g.is_active && g.reached_at) || pct >= 100;
    const hasImg = !!g.image_url;
    // Image/video fills the whole card (cover); a gradient keeps the text readable.
    const media = hasImg
        ? (g.media_type === 'video'
            ? `<video class="cgw-media" src="${esc(g.image_url)}" muted loop autoplay playsinline></video>`
            : `<div class="cgw-media" style="background-image:url('${esc(g.image_url)}')"></div>`)
        : '';
    return `<div class="cgw-goal ${reached ? 'reached' : ''} ${hasImg ? 'has-img' : ''}" data-goal-id="${g.id}" onclick="openGoalPopover(${g.id})" title="View goal">
            ${media}
            <div class="cgw-overlay"></div>
            <div class="cgw-body">
                <div class="cgw-top">
                    <span class="cgw-title">${reached ? '🎉 ' : ''}${esc(g.title)}</span>
                    <span class="cgw-amt">${Number(g.current_amount).toLocaleString()} / ${Number(g.target_amount).toLocaleString()} Vibes</span>
                    <span class="cgw-pct">${reached ? '✓' : pct + '%'}</span>
                </div>
            </div>
            <div class="cgw-bar"><div class="cgw-fill" style="width:${pct}%"></div></div>
        </div>`;
}

// Click a goal in the widget → popover with a bigger image + full progress detail.
let _goalPopEsc = null;
function openGoalPopover(id) {
    const g = (_goalWidget.goals || []).find(x => x.id === id);
    if (!g) return;
    closeGoalPopover();
    const pct = g.target_amount ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
    const reached = (!g.is_active && g.reached_at) || pct >= 100;
    const media = g.image_url
        ? (g.media_type === 'video'
            ? `<video class="cgw-pop-media" src="${esc(g.image_url)}" autoplay muted loop playsinline></video>`
            : `<img class="cgw-pop-media" src="${esc(g.image_url)}" alt="">`)
        : '';
    const ov = document.createElement('div');
    ov.className = 'cgw-pop-overlay';
    ov.id = 'cgw-pop-overlay';
    ov.onclick = (e) => { if (e.target === ov) closeGoalPopover(); };
    ov.innerHTML = `<div class="cgw-pop ${reached ? 'reached' : ''}">
            <button class="cgw-pop-close" onclick="closeGoalPopover()" aria-label="Close">&times;</button>
            ${media}
            <div class="cgw-pop-info">
                <div class="cgw-pop-title">${reached ? '🎉 ' : ''}${esc(g.title)}</div>
                <div class="cgw-bar cgw-pop-bar"><div class="cgw-fill" style="width:${pct}%"></div></div>
                <div class="cgw-pop-amt">${Number(g.current_amount).toLocaleString()} / ${Number(g.target_amount).toLocaleString()} Vibes · ${pct}%${reached ? ' · Goal reached!' : ''}</div>
                ${(!reached && typeof currentUser !== 'undefined' && currentUser) ? `<button class="btn btn-primary" onclick="_donateToGoal(${g.id})"><i class="fa-solid fa-gift"></i> Donate to this goal</button>` : ''}
            </div>
        </div>`;
    document.body.appendChild(ov);
    _goalPopEsc = (e) => { if (e.key === 'Escape') closeGoalPopover(); };
    document.addEventListener('keydown', _goalPopEsc);
}
function closeGoalPopover() {
    const ov = document.getElementById('cgw-pop-overlay');
    if (ov) ov.remove();
    if (_goalPopEsc) { document.removeEventListener('keydown', _goalPopEsc); _goalPopEsc = null; }
}
// Open the donate modal pre-targeted at this goal.
function _donateToGoal(id) {
    window._pendingDonateGoalId = id;
    closeGoalPopover();
    if (typeof showModal === 'function') showModal('donate');
}
// Live updates pushed over the chat websocket (goal-update / goal-reached).
function updateGoalInWidget(goal) {
    if (!goal) return;
    const i = _goalWidget.goals.findIndex(x => x.id === goal.id);
    if (i >= 0) _goalWidget.goals[i] = goal; else _goalWidget.goals.push(goal);
    renderGoalWidget();
}
function goalReachedInWidget(goal) {
    updateGoalInWidget(goal);
    // Briefly pulse the reached goal in the widget.
    setTimeout(() => {
        document.querySelectorAll(`.cgw-goal[data-goal-id="${goal && goal.id}"]`).forEach(el => {
            el.classList.add('cgw-pulse'); setTimeout(() => el.classList.remove('cgw-pulse'), 2000);
        });
    }, 60);
}

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

// Minimal, safe linkifier for already-HTML-escaped text.
function _linkify(escaped) {
    return String(escaped).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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
        const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;color:#eee;font-family:system-ui,sans-serif;overflow:auto}a{color:#e0a44a}${ch.offline_css || ''}</style></head><body>${ch.offline_html || ''}</body></html>`;
        const iframe = document.createElement('iframe');
        iframe.className = 'ch-offline-html';
        // Sandbox WITHOUT allow-same-origin → the custom page is fully isolated.
        iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms');
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
    if (!built.length) {
        host.innerHTML = '';
        // Nothing to show → don't leave an empty overlay (just an X) floating over the image.
        const ov = document.getElementById('ch-offline-overlay');
        const re = document.getElementById('ch-offline-reopen');
        if (ov) ov.style.display = 'none';
        if (re) re.classList.remove('show');
        return;
    }

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

// Start offline poll — detects when a channel comes online
// Fast-load: when a LIVE-NOW notification (SSE, via live-notify.js) names the channel
// the viewer is currently on and it's showing offline, reload immediately instead of
// waiting up to 15s for the offline poll. The poll stays as a fallback.
let _lastFastLiveLoad = 0;
window.addEventListener('openvibe:stream-live', (e) => {
    try {
        const d = e && e.detail;
        if (!d || !d.username || !currentChannelUsername) return;
        if (String(d.username).toLowerCase() !== String(currentChannelUsername).toLowerCase()) return;
        // ONLY act when the channel page is actually the active page — otherwise
        // (e.g. watching one of the streamer's VODs/clips) reloading the channel would
        // tear down the player the viewer is on. currentChannelUsername lingers after
        // navigating away, so the page check is essential.
        const page = document.getElementById('page-channel');
        if (!page || !page.classList.contains('active')) return;
        // Already showing the live area with a healthy player? nothing to do.
        // The player phase check matters: when a streamer bounces offline→online the
        // live area is still on screen (the poll hasn't swapped in the offline card
        // yet) but the player is parked on "Stream has ended". Bailing out here on
        // visibility alone is exactly what used to strand viewers on that card.
        const liveArea = document.getElementById('ch-live-area');
        const playerDead = typeof playerLoadState !== 'undefined'
            && (playerLoadState?.phase === 'ended' || playerLoadState?.severity === 'error');
        if (liveArea && liveArea.style.display !== 'none' && !playerDead) return;
        // Debounce against duplicate SSE + the poll firing together.
        const now = Date.now();
        if (now - _lastFastLiveLoad < 4000) return;
        _lastFastLiveLoad = now;
        stopStreamStatusPoll();
        loadChannelPage(currentChannelUsername, d.slug || d.managed_id || null);
        if (typeof toast === 'function') toast(`${d.display_name || d.username} is now live!`, 'success');
    } catch { /* non-critical accelerator */ }
});

// The player tells us the moment the stream dies (server 'stream-ended', or a
// broadcaster that never came back). Without this the page only learns the stream
// dropped on the next 15s poll tick, and only learns it returned on the tick after
// that — so a 1-second offline blip could strand a viewer for ~30s. React now:
// swap to the offline card immediately and burst-poll for the comeback.
let _lastEndedReload = 0;
window.addEventListener('openvibe:stream-ended', (e) => {
    try {
        const page = document.getElementById('page-channel');
        if (!page || !page.classList.contains('active') || !currentChannelUsername) return;
        // Only react to the stream the viewer is actually watching. Player teardown
        // during navigation can surface an "ended" signal for a stream we already
        // moved off of; reloading the channel then would be a spurious jump.
        const endedId = e && e.detail && e.detail.streamId;
        if (endedId && currentStreamId && endedId !== currentStreamId) return;
        // One drop can surface as several "ended" signals (server push + a protocol
        // teardown); collapse them so we reload the channel once.
        const now = Date.now();
        if (now - _lastEndedReload < 4000) return;
        _lastEndedReload = now;
        _accelerateStreamStatusPoll();
        // Re-resolve channel state right away instead of waiting for a tick. If the
        // streamer is already back this lands on the live player; if not, it renders
        // the offline card, which then burst-polls via startOfflineStatusPoll().
        loadChannelPage(currentChannelUsername);
    } catch { /* non-critical accelerator */ }
});

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

let uptimeInterval = null;
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

async function toggleFollow() {
    if (!currentUser) return showModal('login');
    try {
        const data = await api(`/streams/${currentStreamId}/follow`, { method: 'POST' });
        const btn = document.getElementById('btn-follow');
        btn.classList.toggle('following', data.following);
        btn.innerHTML = data.following
            ? '<i class="fa-solid fa-heart-crack"></i> Unfollow'
            : '<i class="fa-solid fa-heart"></i> Follow';
        toast(data.following ? 'Followed!' : 'Unfollowed', 'info');
    } catch (e) { toast(e.message, 'error'); }
}

/* ── VODs Page ────────────────────────────────────────────────── */
/* ── Unified bulk-select for VODs / clips / pastes (admin + owner) ──
   Works on the global VODs/Clips pages (admins) and on a channel page (the
   channel owner on their own content, or any admin). Actions: public | unlisted
   | private | delete. Selection state is keyed by content type; the id is a VOD/
   clip numeric id or a paste slug (stored as strings). */
window._sel = window._sel || { vod: new Set(), clip: new Set(), paste: new Set() };
window._selCtx = window._selCtx || { enabled: false, reload: null };

function _isContentAdmin() {
    return !!(currentUser && (currentUser.role === 'admin' || currentUser.capabilities?.moderate_global));
}

// Enable/disable selection for the current view + set the reload callback.
function _selSetContext(enabled, reload) {
    window._selCtx = { enabled: !!enabled, reload: reload || null };
    if (!enabled) { _sel.vod.clear(); _sel.clip.clear(); _sel.paste.clear(); }
    _selRenderBar();
    _selSyncAllBtns();
}

/** Wrap a VOD/clip/paste card with a select-checkbox (no-op when disabled). */
function _currentUserIsOwner() {
    return !!(currentUser && (currentUser.capabilities?.is_owner || currentUser.is_owner));
}
function _selWrap(type, id, cardHtml, ownerIsOwner) {
    if (!window._selCtx.enabled) return cardHtml;
    // Owner-rank users' content is off-limits to non-owner admins/mods — no checkbox.
    if (ownerIsOwner && !_currentUserIsOwner()) return cardHtml;
    const sid = String(id);
    const esid = sid.replace(/'/g, "\\'");
    const checked = window._sel[type].has(sid) ? 'checked' : '';
    return `<div class="sel-card-wrap" data-sel-type="${type}" data-sel-id="${esc(sid)}">
        <label class="sel-card-check" onclick="event.stopPropagation()" title="Select">
            <input type="checkbox" ${checked} onchange="_selToggle('${type}','${esid}',this.checked)">
        </label>${cardHtml}</div>`;
}
// Back-compat alias for the global VOD/clip page call sites.
function _adminCardWrap(type, id, cardHtml, ownerIsOwner) { return _selWrap(type, id, cardHtml, ownerIsOwner); }
function _updateAdminBulkBar() { _selRenderBar(); _selSyncAllBtns(); }

function _selCount() { return window._sel.vod.size + window._sel.clip.size + window._sel.paste.size; }

function _selToggle(type, id, checked) {
    const set = window._sel[type]; if (!set) return;
    if (checked) set.add(String(id)); else set.delete(String(id));
    _selRenderBar(); _selSyncAllBtns();
}

// Modifier-click anywhere on a selectable card (so you don't have to aim at the tiny
// checkbox). Capture phase so it beats the card's link nav.
//   • Shift+click     → select the contiguous RANGE from the last-clicked anchor to here.
//   • Ctrl/Cmd+click  → TOGGLE just this one card (build up a selection of scattered items).
let _selLastIdx = null, _selLastContainer = null;
function _selSetCard(wrap, checked) {
    const cb = wrap.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = checked;
    const type = wrap.dataset.selType, id = wrap.dataset.selId;
    if (type && id) _selToggle(type, id, checked);
}
document.addEventListener('click', (e) => {
    if (!window._selCtx || !window._selCtx.enabled) return;
    const isRange = e.shiftKey;
    const isToggle = e.ctrlKey || e.metaKey;
    if (!isRange && !isToggle) return;
    const wrap = e.target.closest && e.target.closest('.sel-card-wrap');
    if (!wrap) return;
    e.preventDefault(); e.stopPropagation();
    const container = wrap.parentElement;
    const cards = Array.from(container.children).filter(c => c.classList && c.classList.contains('sel-card-wrap'));
    const idx = cards.indexOf(wrap);
    // Range needs an anchor in the same container; otherwise (and for Ctrl/Cmd) toggle one.
    if (isRange && !isToggle && _selLastIdx != null && _selLastContainer === container && idx >= 0) {
        for (let i = Math.min(_selLastIdx, idx); i <= Math.max(_selLastIdx, idx); i++) _selSetCard(cards[i], true);
    } else {
        const cb = wrap.querySelector('input[type="checkbox"]');
        _selSetCard(wrap, !(cb && cb.checked));
    }
    // Both gestures update the anchor, so a Ctrl+click can seed the next Shift+click range.
    _selLastIdx = idx; _selLastContainer = container;
}, true);

function _selClear() {
    window._sel.vod.clear(); window._sel.clip.clear(); window._sel.paste.clear();
    document.querySelectorAll('.sel-card-check input:checked').forEach(cb => { cb.checked = false; });
    _selRenderBar(); _selSyncAllBtns();
}

// Select-all / deselect-all toggle scoped to one section's grid container.
function _selAllToggle(containerId) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const wraps = [...c.querySelectorAll('.sel-card-wrap[data-sel-type]')];
    if (!wraps.length) return;
    const allSel = wraps.every(w => window._sel[w.dataset.selType]?.has(w.dataset.selId));
    wraps.forEach(w => {
        const t = w.dataset.selType, id = w.dataset.selId;
        if (!window._sel[t]) return;
        if (allSel) window._sel[t].delete(id); else window._sel[t].add(id);
        const cb = w.querySelector('input'); if (cb) cb.checked = !allSel;
    });
    _selRenderBar(); _selSyncAllBtns();
}

// Keep each "Select all / Deselect all" button's label + visibility in sync.
function _selSyncAllBtns() {
    document.querySelectorAll('.sel-all-btn[data-sel-container]').forEach(btn => {
        const c = document.getElementById(btn.dataset.selContainer);
        const wraps = c ? [...c.querySelectorAll('.sel-card-wrap[data-sel-type]')] : [];
        btn.style.display = (window._selCtx.enabled && wraps.length) ? '' : 'none';
        const allSel = wraps.length && wraps.every(w => window._sel[w.dataset.selType]?.has(w.dataset.selId));
        const span = btn.querySelector('.sel-all-label');
        if (span) span.textContent = allSel ? 'Deselect all' : 'Select all';
        // Discoverability: surface both modifier gestures on hover.
        const mod = (navigator.platform || '').toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';
        btn.title = `Tip: Shift+click a card selects a range · ${mod}+click toggles one`;
    });
}

function _selRenderBar() {
    const n = _selCount();
    let bar = document.getElementById('sel-bulk-bar');
    if (!n) { if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; } return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'sel-bulk-bar'; document.body.appendChild(bar); }
    bar.style.display = 'flex';
    bar.innerHTML = `<span><i class="fa-solid fa-check-double"></i> <strong>${n}</strong> selected</span>
        <button class="btn btn-small btn-outline" onclick="_selClear()">Clear</button>
        <button class="btn btn-small btn-outline" onclick="_selBulk('public')" title="Make public"><i class="fa-solid fa-globe"></i></button>
        <button class="btn btn-small btn-outline" onclick="_selBulk('unlisted')" title="Unlist (link-only)"><i class="fa-solid fa-link"></i></button>
        <button class="btn btn-small btn-outline" onclick="_selBulk('private')" title="Make private"><i class="fa-solid fa-lock"></i></button>
        <button class="btn btn-small btn-danger" onclick="_selBulk('delete')"><i class="fa-solid fa-trash"></i> Delete</button>`;
}

// Apply a bulk action across every selected type (vods/clips/pastes) in one go.
async function _selBulk(action) {
    const total = _selCount();
    if (!total) return;
    if (action === 'delete' && !confirm(`Delete ${total} item${total === 1 ? '' : 's'}? This removes them from storage and cannot be undone.`)) return;
    const jobs = [];
    if (window._sel.vod.size) jobs.push(api('/vods/bulk', { method: 'POST', body: { ids: [...window._sel.vod], action } }));
    if (window._sel.clip.size) jobs.push(api('/clips/bulk', { method: 'POST', body: { ids: [...window._sel.clip], action } }));
    if (window._sel.paste.size) jobs.push(api('/pastes/bulk', { method: 'POST', body: { slugs: [...window._sel.paste], action } }));
    try {
        const results = await Promise.all(jobs);
        const done = results.reduce((s, r) => s + (r && r.done || 0), 0);
        toast(`${action === 'delete' ? 'Deleted' : 'Updated'} ${done} item${done === 1 ? '' : 's'}`, 'success');
        window._sel.vod.clear(); window._sel.clip.clear(); window._sel.paste.clear();
        _selRenderBar(); _selSyncAllBtns();
        if (window._selCtx.reload) window._selCtx.reload();
    } catch (e) {
        toast(e.message || 'Bulk action failed', 'error');
    }
}

// A single VOD card's inner anchor (shared by the flat list + expanded session groups).
function _vodCardInner(v, myId) {
    return `<a class="stream-card" href="/vod/${v.id}" onclick="return handleLinkClick(event, '/vod/${v.id}')">
        <div class="stream-card-thumb">
            ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
            ${!v.is_public && v.user_id === myId ? '<span class="stream-card-nsfw" style="background:var(--text-muted)">PRIVATE</span>' : ''}
            ${v.stream_protocol ? protocolBadge(v.stream_protocol) : ''}
            <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(v.duration_seconds || v.duration)}</span>
        </div>
        <div class="stream-card-info">
            <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
            <div class="stream-card-streamer">
                ${_avatarSpan(v.avatar_url, v.username, v.profile_color)}
                ${esc(v.username || 'Unknown')}
                <span class="stream-card-date">${timeAgo(v.created_at)}</span>
            </div>
            ${_cardAiHTML(v.ai_overview_short, v.ai_overview)}
        </div>
    </a>`;
}
function _vodDayKey(ts) {
    try { const d = new Date(String(ts).replace(' ', 'T') + (/[TZ]/.test(String(ts)) ? '' : 'Z')); return isNaN(d) ? String(ts).slice(0, 10) : d.toISOString().slice(0, 10); }
    catch { return String(ts).slice(0, 10); }
}
// Group CONSECUTIVE VODs from the same streamer with the same title on the same day — these are
// almost always one session split by stream restarts / server restarts, so we condense them.
function _groupVods(vods) {
    const groups = [];
    let cur = null;
    for (const v of vods) {
        const key = `${v.user_id}|${String(v.title || '').trim().toLowerCase()}|${_vodDayKey(v.created_at)}`;
        if (cur && cur.key === key) cur.items.push(v);
        else { cur = { key, items: [v] }; groups.push(cur); }
    }
    return groups;
}
// Renders an array of ALREADY-grouped VOD groups ({ items: [...] }). Pagination happens by
// group (session), so a 30-part session counts as one card instead of blanking the page.
function _renderVodGroups(groups, myId) {
    return groups.map((g, gi) => {
        if (g.items.length < 2) {
            const v = g.items[0];
            return _adminCardWrap('vod', v.id, _vodCardInner(v, myId), !!v.owner_is_owner);
        }
        const rep = g.items.reduce((a, b) => ((b.duration_seconds || 0) > (a.duration_seconds || 0) ? b : a), g.items[0]);
        const totalDur = g.items.reduce((s, v) => s + (v.duration_seconds || v.duration || 0), 0);
        const gid = 'vg' + gi;
        const n = g.items.length;
        const groupCard = `<div class="stream-card vod-group-card" id="group-${gid}" onclick="toggleVodGroup('${gid}')" title="${n} videos from this session — click to expand">
            <div class="stream-card-thumb">
                ${thumbImg(rep.thumbnail_url, 'fa-video', rep.title, `/api/thumbnails/generate/vod/${rep.id}`)}
                <span class="vod-group-count"><i class="fa-solid fa-layer-group"></i> ${n}</span>
                <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(totalDur)}</span>
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(rep.title || 'VOD')}</div>
                <div class="stream-card-streamer">
                    ${_avatarSpan(rep.avatar_url, rep.username, rep.profile_color)}
                    ${esc(rep.username || 'Unknown')}
                    <span class="stream-card-date">${timeAgo(rep.created_at)}</span>
                </div>
                <button class="vod-group-hint" type="button"><i class="fa-solid fa-chevron-down vod-group-chev"></i> <span>${n} parts — <b>expand</b></span></button>
            </div>
        </div>`;
        const parts = g.items.map(v => _adminCardWrap('vod', v.id, _vodCardInner(v, myId), !!v.owner_is_owner)).join('');
        return groupCard + `<div class="vod-group-parts" id="parts-${gid}" style="display:none">${parts}</div>`;
    }).join('');
}
function toggleVodGroup(gid) {
    const parts = document.getElementById('parts-' + gid);
    const card = document.getElementById('group-' + gid);
    if (!parts) return;
    const opening = parts.style.display === 'none';
    parts.style.display = opening ? 'grid' : 'none';
    if (card) card.classList.toggle('expanded', opening);
    if (typeof _selSyncAllBtns === 'function') _selSyncAllBtns();
}

async function loadVodsPage() {
    const grid = document.getElementById('vods-grid-page');
    const pager = document.getElementById('vods-pagination-page');
    const filterBar = document.getElementById('vods-streamer-filters');
    if (!grid) return console.error('[VODs] grid element #vods-grid-page not found');
    grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading videos...</p></div>';
    if (pager) { pager.style.display = 'none'; pager.innerHTML = ''; }
    if (filterBar) {
        filterBar.style.display = 'none';
        filterBar.innerHTML = '';
    }
    // Mutations (admin delete/bulk) refresh via this callback — bust the cache so they re-fetch;
    // plain pagination (setVodsPage) keeps the cache and is instant.
    _selSetContext(_isContentAdmin(), () => { _vodsGroupCache.key = null; return loadVodsPage(); });

    try {
        const perPage = VODS_PAGE_SIZE; // grouped sessions per page
        const key = `${currentVodsStreamerFilter || 'all'}|${currentVodsSort || 'newest'}`;
        // Fetch the whole window once per filter/sort, then paginate the GROUPED sessions in-memory
        // so a multi-part session counts as one card (raw-VOD paging showed near-empty pages).
        if (_vodsGroupCache.key !== key) {
            const params = new URLSearchParams({ limit: String(VODS_FETCH_WINDOW), offset: '0' });
            if (currentVodsStreamerFilter && currentVodsStreamerFilter !== 'all') params.set('username', currentVodsStreamerFilter);
            if (currentVodsSort === 'oldest') params.set('sort', 'oldest');
            const data = await api(`/vods?${params.toString()}`);
            const vods = data.vods || [];
            const totalVideos = data.total ?? vods.length;
            _vodsGroupCache = {
                key, groups: _groupVods(vods), totalVideos,
                streamers: data.streamers || [],
                truncated: totalVideos > vods.length,
            };
        }
        const { groups, streamers, truncated, totalVideos } = _vodsGroupCache;

        renderVodsStreamerFilters(streamers, currentVodsStreamerFilter);

        const totalGroups = groups.length;
        const totalPages = Math.max(1, Math.ceil(totalGroups / perPage));
        if (currentVodsPage > totalPages) currentVodsPage = totalPages;

        if (!totalGroups) {
            grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-video fa-3x"></i><p>No videos yet</p><p class="muted">Videos are recorded automatically when streamers go live</p></div>';
            return;
        }

        const startG = (currentVodsPage - 1) * perPage;
        const pageGroups = groups.slice(startG, startG + perPage);
        const myId = currentUser ? currentUser.id : null;
        grid.innerHTML = _renderVodGroups(pageGroups, myId)
            + (truncated && currentVodsPage === totalPages ? `<div class="vods-truncated-note muted">Showing the ${totalVideos > VODS_FETCH_WINDOW ? 'most recent ' + VODS_FETCH_WINDOW : totalVideos} videos.</div>` : '');
        _updateAdminBulkBar('vod');

        renderVodsPagination('vods-pagination-page', currentVodsPage, totalGroups, perPage, 'setVodsPage', 'sessions', { sort: currentVodsSort, setter: 'setVodsSort' });
    } catch (e) {
        console.error('Failed to load videos', e);
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation fa-3x"></i><p>Failed to load videos</p><p class="muted">' + esc(e.message || String(e)) + '</p></div>';
    }
}

/* ── Clips Page ───────────────────────────────────────────────── */
async function loadClipsPage() {
    const grid = document.getElementById('clips-grid-page');
    const pager = document.getElementById('clips-pagination-page');
    const filterBar = document.getElementById('clips-streamer-filters');
    if (!grid) return console.error('[Clips] grid element not found');
    grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p>Loading clips...</p></div>';
    if (pager) { pager.style.display = 'none'; pager.innerHTML = ''; }
    if (filterBar) {
        filterBar.style.display = 'none';
        filterBar.innerHTML = '';
    }
    _selSetContext(_isContentAdmin(), loadClipsPage);
    try {
        const limit = CLIPS_PAGE_SIZE;
        const offset = (currentClipsPage - 1) * limit;
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (currentClipsStreamerFilter && currentClipsStreamerFilter !== 'all') {
            params.set('username', currentClipsStreamerFilter);
        }
        if (currentClipsSort === 'oldest') params.set('sort', 'oldest');
        const data = await api(`/clips?${params.toString()}`);
        const clips = data.clips || [];
        const total = data.total ?? clips.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));

        renderClipsStreamerFilters(data.streamers || [], currentClipsStreamerFilter);

        if (currentClipsPage > totalPages) {
            currentClipsPage = totalPages;
            return loadClipsPage();
        }

        if (!clips.length) {
            grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-scissors fa-3x"></i><p>No public clips yet</p><p class="muted">Viewers can create clips during live streams using the clip button</p></div>';
            return;
        }
        grid.innerHTML = clips.map(cl => _adminCardWrap('clip', cl.id, `
            <a class="stream-card" href="/clip/${cl.id}" onclick="return handleLinkClick(event, '/clip/${cl.id}')">
                <div class="stream-card-thumb">
                    ${thumbImg(cl.thumbnail_url, 'fa-scissors', cl.title, `/api/thumbnails/generate/clip/${cl.id}`)}
                    ${cl.stream_protocol ? protocolBadge(cl.stream_protocol) : ''}
                    <span class="stream-card-viewers"><i class="fa-solid fa-clock"></i> ${formatDuration(cl.duration_seconds)}</span>
                </div>
                <div class="stream-card-info">
                    <div class="stream-card-title">${esc(cl.title || 'Clip')}</div>
                    <div class="stream-card-streamer">
                        ${_avatarSpan(cl.avatar_url, cl.username, cl.profile_color)}
                        Clipped by ${esc(cl.display_name || cl.username || 'Unknown')}
                        <span class="stream-card-date">${timeAgo(cl.created_at)}</span>
                    </div>
                    ${_cardAiHTML(cl.ai_overview_short, cl.ai_overview)}
                </div>
            </a>
        `, !!(cl.owner_is_owner || cl.streamer_is_owner))).join('');
        _updateAdminBulkBar('clip');

        renderVodsPagination('clips-pagination-page', currentClipsPage, total, limit, 'setClipsPage', 'clips', { sort: currentClipsSort, setter: 'setClipsSort' });
    } catch (e) {
        console.error('Failed to load clips', e);
        grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation fa-3x"></i><p>Failed to load clips</p><p class="muted">' + esc(e.message || String(e)) + '</p></div>';
    }
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
                    <p style="font-size:1.05rem;font-weight:600">This clip failed to render</p>
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

        // Show "Clipped by" info
        const clippedByEl = document.getElementById('clp-clipped-by');
        if (clippedByEl) {
            clippedByEl.innerHTML = `<i class="fa-solid fa-scissors"></i> Clipped by <strong>${esc(cl.display_name || cl.username || 'Unknown')}</strong>`;
        }

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

/* ── Profile (legacy, redirects to channel) ───────────────────── */
async function loadProfile(username) {
    username = username || (currentUser && currentUser.username);
    if (!username) return navigate('/');
    navigate(channelPath(username), true);
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

    // Show comment form if logged in
    if (formEl) formEl.style.display = currentUser ? '' : 'none';

    try {
        const data = await api(`/comments/${contentType}/${contentId}`);
        const comments = data.comments || [];
        const total = data.total || 0;

        if (countEl) countEl.textContent = total > 0 ? `(${total})` : '';

        if (!comments.length) {
            listEl.innerHTML = '<div class="comments-empty"><i class="fa-solid fa-comment-dots" style="font-size:1.5rem;margin-bottom:8px"></i><p>No comments yet. Be the first!</p></div>';
            return;
        }

        listEl.innerHTML = comments.map(c => renderComment(c, contentType, contentId)).join('');
    } catch (e) {
        listEl.innerHTML = '<p class="muted">Failed to load comments</p>';
    }
}

function renderComment(c, contentType, contentId) {
    const initial = (c.username || '?')[0].toUpperCase();
    const color = c.profile_color || '#8b5cf6';
    const name = c.display_name || c.username || 'Unknown';
    const isOwn = currentUser && (c.user_id === currentUser.id);
    const isAdmin = currentUser && currentUser.capabilities?.moderate_global;
    const edited = c.updated_at && c.updated_at !== c.created_at;

    let actionsHtml = '';
    if (currentUser) {
        actionsHtml += `<button onclick="showReplyForm(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-reply"></i> Reply</button>`;
    }
    if (isOwn || isAdmin) {
        actionsHtml += `<button onclick="editComment(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-pen"></i> Edit</button>`;
        actionsHtml += `<button onclick="deleteCommentAction(${c.id}, '${contentType}', ${contentId})"><i class="fa-solid fa-trash"></i> Delete</button>`;
    }

    let repliesHtml = '';
    if (c.replies && c.replies.length) {
        repliesHtml = `<div class="comment-replies">${c.replies.map(r => renderComment(r, contentType, contentId)).join('')}</div>`;
    }

    return `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-avatar" style="background:${esc(color)}">${initial}</div>
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

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return date.toLocaleDateString();
}

/* ── Utility ──────────────────────────────────────────────────── */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML.replace(/'/g, '&#39;');
}

/**
 * Escape a string for safe interpolation inside a JS string literal
 * within an HTML attribute (e.g. onclick="fn('${escJs(val)}')" ).
 * Escapes backslash, single/double quotes, backticks, and angle brackets.
 */
function escJs(str) {
    return String(str ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")  
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/</g, '\\x3c')
        .replace(/>/g, '\\x3e');
}

/**
 * Universal thumbnail HTML helper.
 * Returns an <img> tag if a thumbnail URL exists, or a fallback icon.
 * @param {string|null} thumbnailUrl - the thumbnail_url from the DB record
 * @param {string} fallbackIcon - Font Awesome icon class (e.g. 'fa-video')
 * @param {string} [alt] - alt text for the image
 * @returns {string} HTML string
 */
async function handleThumbnailError(img) {
    if (!img) return;
    img.onerror = null;
    const fallback = img.nextElementSibling;
    const regenerateUrl = img.dataset.regenerateUrl;
    if (regenerateUrl && !img.dataset.regenerateTried) {
        img.dataset.regenerateTried = '1';
        try {
            const res = await fetch(regenerateUrl, { method: 'POST', credentials: 'include' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.thumbnail_url) {
                img.src = `${data.thumbnail_url}${data.thumbnail_url.includes('?') ? '&' : '?'}t=${Date.now()}`;
                img.style.display = '';
                if (fallback) fallback.style.display = 'none';
                return;
            }
        } catch {}
    }
    img.style.display = 'none';
    if (fallback) fallback.style.display = '';
}

function thumbImg(thumbnailUrl, fallbackIcon, alt, regenerateUrl = null) {
    if (thumbnailUrl) {
        return `<img src="${esc(thumbnailUrl)}" alt="${esc(alt || '')}" loading="lazy" data-regenerate-url="${esc(regenerateUrl || '')}" onerror="handleThumbnailError(this)">
                <i class="fa-solid ${fallbackIcon}" style="display:none"></i>`;
    }
    if (regenerateUrl) {
        // No thumbnail yet but we can try generating one — show icon and trigger generation
        return `<img src="" alt="${esc(alt || '')}" style="display:none" data-regenerate-url="${esc(regenerateUrl)}" data-regenerate-tried="" onerror="handleThumbnailError(this)">
                <i class="fa-solid ${fallbackIcon}"></i>`;
    }
    return `<i class="fa-solid ${fallbackIcon}"></i>`;
}

function formatDuration(secs) {
    if (!secs) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    let raw = dateStr;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const d = new Date(raw);
    if (isNaN(d)) return dateStr;
    const diff = Date.now() - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

function formatDateTime(dateStr) {
    if (!dateStr) return '';
    let raw = dateStr;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const d = new Date(raw);
    if (isNaN(d)) return dateStr;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function switchVodTab(tab) {
    document.querySelectorAll('#vod-section .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

/* ── Modal template stubs (filled by their modules) ──────────── */
function createManagedStreamModal() {
    const methods = [
        { id: 'browser', icon: 'globe', label: 'Browser', hint: 'Camera, mic, or screen from your browser' },
        { id: 'whip', icon: 'satellite-dish', label: 'WHIP', hint: 'OBS WHIP encoder / external WebRTC' },
        { id: 'rtmp', icon: 'server', label: 'RTMP', hint: 'OBS / Streamlabs / IRL Pro' },
        { id: 'cli', icon: 'terminal', label: 'CLI / FFmpeg', hint: 'FFmpeg, Pi, RTSP cameras' },
    ];
    const methodCards = methods.map(m => `
        <div class="bc-method-card-sm${m.id === 'browser' ? ' selected' : ''}" data-cmsmethod="${m.id}" onclick="_cmsSelectMethod('${m.id}')">
            <i class="fa-solid fa-${m.icon}"></i>
            <strong>${m.label}</strong>
            <span class="bc-card-sm-hint">${m.hint}</span>
        </div>`).join('');
    return `
        <h3><i class="fa-solid fa-plus"></i> Create Stream Slot</h3>
        <p class="muted" style="margin-bottom:16px">Each stream slot has its own stream key, settings, and history.</p>
        <div class="form-group">
            <label>Title</label>
            <input type="text" id="cms-title" class="form-input" placeholder="My Stream" maxlength="140">
        </div>
        <div class="form-group">
            <label>Category</label>
            <select id="cms-category" class="form-input">
                <option value="" selected>Auto — the AI decides from the stream</option>
                <option value="irl">IRL</option>
                <option value="outdoors">Outdoors</option>
                <option value="travel">Travel</option>
                <option value="building">Building/Craft</option>
                <option value="music">Music</option>
                <option value="gaming">Gaming</option>
                <option value="robot">Robot</option>
                <option value="desktop">Desktop</option>
                <option value="other">Other</option>
            </select>
        </div>
        <div class="form-group">
            <label>Streaming Method</label>
            <div class="bc-method-picker bc-method-picker-sm">${methodCards}</div>
            <input type="hidden" id="cms-method" value="browser">
            <input type="hidden" id="cms-protocol" value="webrtc">
        </div>
        <div class="form-group">
            <label>URL Slug <span class="muted">(optional)</span></label>
            <input type="text" id="cms-slug" class="form-input" placeholder="my-stream"
                maxlength="32" pattern="[a-z][a-z0-9_-]*"
                title="2-32 chars, start with a letter, alphanumeric/hyphens/underscores">
            <small class="muted">openvibe.live/@${currentUser?.username || 'username'}/<strong>slug</strong></small>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn btn-primary" onclick="_cmsCreate()" id="cms-create-btn" style="flex:1">
                <i class="fa-solid fa-plus"></i> Create
            </button>
            <button class="btn btn-outline" onclick="closeModal()" style="flex:1">Cancel</button>
        </div>
        <p id="cms-error" style="display:none;color:var(--danger);margin-top:8px;font-size:0.85rem"></p>`;
}

function _cmsSelectMethod(method) {
    const methodToProtocol = { browser: 'webrtc', whip: 'webrtc', cli: 'jsmpeg', rtmp: 'rtmp' };
    const methodEl = document.getElementById('cms-method');
    const protoEl = document.getElementById('cms-protocol');
    if (methodEl) methodEl.value = method;
    if (protoEl) protoEl.value = methodToProtocol[method] || 'webrtc';
    document.querySelectorAll('[data-cmsmethod]').forEach(el =>
        el.classList.toggle('selected', el.dataset.cmsmethod === method)
    );
}

async function _cmsCreate() {
    const btn = document.getElementById('cms-create-btn');
    const errEl = document.getElementById('cms-error');
    const title = (document.getElementById('cms-title')?.value || '').trim() || 'Untitled Stream';
    const category = document.getElementById('cms-category')?.value || '';
    const protocol = document.getElementById('cms-protocol')?.value || 'webrtc';
    const streamingMethod = document.getElementById('cms-method')?.value || 'browser';
    const slug = (document.getElementById('cms-slug')?.value || '').trim().toLowerCase() || undefined;
    if (btn) btn.disabled = true;
    if (errEl) errEl.style.display = 'none';
    try {
        const data = await api('/streams/managed', {
            method: 'POST',
            body: { title, category, protocol, streaming_method: streamingMethod, slug },
        });
        closeModal();
        if (typeof onManagedStreamCreated === 'function' && data.managed_stream) {
            await onManagedStreamCreated(data.managed_stream.id);
        }
        if (typeof toast === 'function') toast('Stream slot created!', 'success');
    } catch (err) {
        if (errEl) {
            errEl.textContent = err?.message || 'Failed to create stream slot';
            errEl.style.display = '';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function streamKeyModal() {
    return `
        <h3><i class="fa-solid fa-key"></i> Stream Key</h3>
        <p class="muted" style="margin-bottom:12px">Keep this secret! Anyone with your key can stream on your channel.</p>
        <div class="key-display">
            <input type="password" id="modal-key-val" readonly class="form-input" value="Loading...">
            <button class="btn btn-small" onclick="toggleModalKeyVis()"><i class="fa-solid fa-eye"></i></button>
            <button class="btn btn-small" onclick="copyModalKey()"><i class="fa-solid fa-copy"></i></button>
        </div>
        <button class="btn btn-outline" onclick="doRegenerateKey()" style="margin-top:12px">
            <i class="fa-solid fa-rotate"></i> Regenerate
        </button>`;
}
function createConfigModal() {
    return `
        <h3><i class="fa-solid fa-sliders"></i> New Control Profile</h3>
        <p class="muted" style="font-size:0.85rem;margin-bottom:12px">Create a reusable set of control buttons. You can set up different profiles for different robots, games, or setups.</p>
        <div class="form-group">
            <label>Profile Name</label>
            <input type="text" id="modal-config-name" class="form-input" placeholder="e.g. Cozmo Robot, RC Car, Camera Rig" maxlength="60">
        </div>
        <div class="form-group">
            <label>Description (optional)</label>
            <input type="text" id="modal-config-desc" class="form-input" placeholder="Brief description" maxlength="200">
        </div>
        <button class="btn btn-primary btn-lg" onclick="doCreateConfig()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-plus"></i> Create Profile
        </button>`;
}

function addConfigButtonModal() {
    return `
        <h3><i class="fa-solid fa-plus"></i> Add Control Button</h3>
        <div class="form-group">
            <label>Command</label>
            <input type="text" id="modal-cfgbtn-cmd" class="form-input" placeholder="e.g. forward" maxlength="100">
        </div>
        <div class="form-group">
            <label>Label</label>
            <input type="text" id="modal-cfgbtn-label" class="form-input" placeholder="e.g. Forward" maxlength="50">
        </div>
        <div class="form-group">
            <label>Icon (FontAwesome class)</label>
            <input type="text" id="modal-cfgbtn-icon" class="form-input" placeholder="e.g. fa-arrow-up" value="fa-gamepad">
        </div>
        <div class="form-group">
            <label>Type</label>
            <select id="modal-cfgbtn-type" class="form-input">
                <option value="button">Button (single click)</option>
                <option value="keyboard">Keyboard (hold to activate)</option>
                <option value="dpad">D-Pad</option>
                <option value="toggle">Toggle</option>
            </select>
        </div>
        <div class="form-group">
            <label>Key Binding (optional)</label>
            <input type="text" id="modal-cfgbtn-keybind" class="form-input" placeholder="e.g. w, a, s, d" maxlength="20">
            <span class="bc-field-hint">Keyboard shortcut for this button</span>
        </div>
        <div class="form-group">
            <label>Cooldown (seconds)</label>
            <input type="number" id="modal-cfgbtn-cooldown" class="form-input" value="0.5" min="0" max="30" step="0.1">
        </div>
        <details style="margin-top:8px">
            <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--text-secondary)"><i class="fa-solid fa-palette"></i> Custom Styling</summary>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.85rem">Text Color</label>
                    <input type="text" id="modal-cfgbtn-color" class="form-input form-input-sm" placeholder="#fff or red or var(--accent)">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.85rem">Background</label>
                    <input type="text" id="modal-cfgbtn-bg" class="form-input form-input-sm" placeholder="#333 or darkblue">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.85rem">Border Color</label>
                    <input type="text" id="modal-cfgbtn-border" class="form-input form-input-sm" placeholder="#8b5cf6 or var(--accent)">
                </div>
            </div>
        </details>
        <button class="btn btn-primary btn-lg" onclick="doAddConfigButton()" style="width:100%;margin-top:12px">
            <i class="fa-solid fa-plus"></i> Add Button
        </button>`;
}

function addCameraModal() {
    return `
        <h3><i class="fa-solid fa-video"></i> Add ONVIF Camera</h3>
        <p class="muted" style="font-size:0.85rem;">Connect to an ONVIF-compatible camera (Hikvision, Axis, Dahua, etc.)</p>
        <div class="form-group">
            <label>Camera Name</label>
            <input type="text" id="modal-cam-name" class="form-input" placeholder="e.g. Front Door">
        </div>
        <div class="form-group">
            <label>ONVIF URL</label>
            <input type="text" id="modal-cam-url" class="form-input" placeholder="http://192.168.1.100:8080">
        </div>
        <div class="form-group">
            <label>Username</label>
            <input type="text" id="modal-cam-username" class="form-input" placeholder="admin">
        </div>
        <div class="form-group">
            <label>Password</label>
            <input type="password" id="modal-cam-password" class="form-input">
        </div>
        <button class="btn btn-primary btn-lg" onclick="doAddCamera()" style="width:100%;margin-top:8px">
            <i class="fa-solid fa-plus"></i> Add Camera
        </button>`;
}

function discoverCamerasModal() {
    return `
        <h3><i class="fa-solid fa-magnifying-glass"></i> Discover Cameras</h3>
        <p class="muted" style="font-size:0.85rem;">Scan your network for ONVIF devices. This may take a few seconds.</p>
        <button class="btn btn-primary btn-lg" onclick="doDiscoverCameras()" style="width:100%;margin-bottom:12px">
            <i class="fa-solid fa-wifi"></i> Scan Network
        </button>
        <div id="discovery-status" style="min-height:100px;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-hover)">
            <p class="muted">Click "Scan Network" to discover devices...</p>
        </div>`;
}

// Working media state for the goal editor modal.
let _goalMediaUrl = '';
let _goalMediaType = '';
window._editingGoal = null;

function openAddGoal() { window._editingGoal = null; showModal('add-goal'); }
function editGoalModal(id) {
    const g = (window._dashGoals || []).find(x => x.id === id);
    window._editingGoal = g || null;
    showModal('add-goal');
}

function addGoalModal() {
    const g = window._editingGoal;
    _goalMediaUrl = g && g.image_url ? g.image_url : '';
    _goalMediaType = g && g.media_type ? g.media_type : '';
    return `
        <h3><i class="fa-solid fa-bullseye"></i> ${g ? 'Edit' : 'Add'} Donation Goal</h3>
        <div class="form-group">
            <label>Goal Title</label>
            <input type="text" id="modal-goal-title" class="form-input" placeholder="e.g. New tent!" value="${g ? esc(g.title) : ''}">
        </div>
        <div class="form-group">
            <label>Target (Vibes)</label>
            <input type="number" id="modal-goal-target" class="form-input" placeholder="500" min="1" value="${g ? g.target_amount : ''}">
        </div>
        ${g ? `
        <div class="form-group">
            <label>Current amount (Vibes)</label>
            <input type="number" id="modal-goal-current" class="form-input" min="0" value="${Number(g.current_amount) || 0}">
            <div class="muted" style="font-size:0.78rem;margin-top:4px">Manual correction — e.g. someone sent money outside the site. Setting it to the target completes the goal (without the celebration).</div>
        </div>` : ''}
        <div class="form-group">
            <label>Image / Video (optional)</label>
            <div id="goal-media-preview">${_goalMediaPreviewHTML()}</div>
            <input type="file" id="modal-goal-media" accept="image/*,video/*" onchange="uploadGoalMedia(this)" style="margin-top:6px">
            <div class="muted" style="font-size:0.78rem;margin-top:4px">Shown in the goal widget + celebrated in chat when reached. Videos/GIFs auto-convert to an optimized WebM.</div>
        </div>
        <button class="btn btn-primary btn-lg" onclick="saveGoal()" style="width:100%;margin-top:8px" id="goal-save-btn">
            <i class="fa-solid fa-floppy-disk"></i> ${g ? 'Save Goal' : 'Create Goal'}
        </button>`;
}
function _goalMediaPreviewHTML() {
    if (!_goalMediaUrl) return '<div class="muted" style="font-size:0.8rem">No media</div>';
    const media = _goalMediaType === 'video'
        ? `<video src="${esc(_goalMediaUrl)}" muted loop autoplay playsinline style="max-width:160px;max-height:100px;border-radius:8px"></video>`
        : `<img src="${esc(_goalMediaUrl)}" alt="" style="max-width:160px;max-height:100px;border-radius:8px">`;
    return `<div style="display:flex;align-items:center;gap:10px">${media}<button class="btn btn-xs btn-outline" onclick="removeGoalMediaSel()">Remove</button></div>`;
}
function removeGoalMediaSel() {
    _goalMediaUrl = ''; _goalMediaType = '';
    const p = document.getElementById('goal-media-preview'); if (p) p.innerHTML = _goalMediaPreviewHTML();
}
async function uploadGoalMedia(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const preview = document.getElementById('goal-media-preview');
    if (preview) preview.innerHTML = '<div class="muted" style="font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Uploading…</div>';
    try {
        const fd = new FormData(); fd.append('file', file);
        const token = localStorage.getItem('token');
        const res = await fetch(`${API}/api/streams/goal-media`, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        _goalMediaUrl = data.url; _goalMediaType = data.type;
        if (preview) preview.innerHTML = _goalMediaPreviewHTML();
    } catch (e) {
        toast(e.message || 'Media upload failed', 'error');
        if (preview) preview.innerHTML = _goalMediaPreviewHTML();
    }
    input.value = '';
}
async function saveGoal() {
    const title = (document.getElementById('modal-goal-title').value || '').trim();
    const target = parseInt(document.getElementById('modal-goal-target').value, 10);
    if (!title || !target) return toast('Fill in title and target', 'error');
    const body = { title, target_amount: target, image_url: _goalMediaUrl || null, media_type: _goalMediaType || null };
    // Edit mode only: send the manual progress correction when the streamer changed it.
    if (window._editingGoal) {
        const curEl = document.getElementById('modal-goal-current');
        if (curEl && curEl.value !== '') {
            const cur = parseInt(curEl.value, 10);
            if (Number.isFinite(cur) && cur >= 0 && cur !== Number(window._editingGoal.current_amount)) {
                body.current_amount = cur;
            }
        }
    }
    const btn = document.getElementById('goal-save-btn'); if (btn) btn.disabled = true;
    try {
        if (window._editingGoal) await api(`/funds/goals/${window._editingGoal.id}`, { method: 'PUT', body });
        else await api('/funds/goals', { method: 'POST', body });
        closeModal();
        if (typeof loadDashGoals === 'function') loadDashGoals();
        toast('Goal saved!', 'success');
    } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
}

/* Stream key modal helpers */
async function loadStreamKeyModal() {
    try {
        const data = await api('/auth/stream-key');
        const el = document.getElementById('modal-key-val');
        if (el) el.value = data.streamKey || data.stream_key || '';
    } catch { /* silent */ }
}
function toggleModalKeyVis() {
    const el = document.getElementById('modal-key-val');
    el.type = el.type === 'password' ? 'text' : 'password';
}
function copyModalKey() {
    const v = document.getElementById('modal-key-val').value;
    navigator.clipboard.writeText(v).then(() => toast('Copied!', 'success'));
}
async function doRegenerateKey() {
    try {
        const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
        document.getElementById('modal-key-val').value = data.streamKey || data.stream_key || '';
        toast('Key regenerated', 'success');
    } catch (e) { toast(e.message, 'error'); }
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

let _userLoaded = false;

/* ── Updates / Changelog Page ─────────────────────────────────── */
async function loadUpdatesPage() {
    const container = document.getElementById('updates-list');
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

    try {
        const data = await api('/updates?limit=50');
        if (!data.commits || data.commits.length === 0) {
            container.innerHTML = '<p style="opacity:0.6;text-align:center;padding:32px 0;">No updates found.</p>';
            return;
        }

        // Group commits by date
        const groups = {};
        for (const c of data.commits) {
            const day = new Date(c.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(c);
        }

        let html = '';
        for (const [day, commits] of Object.entries(groups)) {
            html += `<div class="updates-day">
                <h3 class="updates-day-header">${esc(day)}</h3>
                <div class="updates-day-commits">`;
            for (const c of commits) {
                const time = new Date(c.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                html += `<div class="update-entry">
                    <a class="update-hash" href="https://github.com/OpenVibers/OpenVibe.Live/commit/${c.hash}" target="_blank" title="View on GitHub">${esc(c.short)}</a>
                    <span class="update-subject">${esc(c.subject)}</span>
                    <span class="update-meta">${esc(c.author)} &middot; ${esc(time)}</span>
                </div>`;
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p style="color:var(--error);text-align:center;padding:32px 0;">Failed to load updates.</p>`;
    }
}

async function loadHomeChangelog(attempt = 0) {
    const container = document.getElementById('home-changelog');
    if (!container) return;

    try {
        const data = await api('/updates?limit=15');
        if (!data.commits || data.commits.length === 0) {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">No recent changes.</p>';
            return;
        }

        // Group commits by date (same pattern as updates page)
        const groups = {};
        for (const c of data.commits) {
            const day = new Date(c.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(c);
        }

        let html = '';
        for (const [day, commits] of Object.entries(groups)) {
            html += `<div class="updates-day">
                <h3 class="updates-day-header">${esc(day)}</h3>
                <div class="updates-day-commits">`;
            for (const c of commits) {
                const time = new Date(c.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                html += `<div class="update-entry">
                    <a class="update-hash" href="https://github.com/OpenVibers/OpenVibe.Live/commit/${c.hash}" target="_blank" title="View on GitHub">${esc(c.short)}</a>
                    <span class="update-subject">${esc(c.subject)}</span>
                    <span class="update-meta">${esc(c.author)} &middot; ${esc(time)}</span>
                </div>`;
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    } catch {
        // Retry up to 2 times with increasing delay (handles Cloudflare challenge timing)
        if (attempt < 2) {
            setTimeout(() => loadHomeChangelog(attempt + 1), (attempt + 1) * 3000);
        } else {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">Failed to load changelog.</p>';
        }
    }
}

/* Toggle collapsible changelog on homepage */
function toggleHomeChangelog() {
    const wrapper = document.getElementById('home-changelog-wrapper');
    const btn = document.getElementById('home-changelog-toggle');
    if (!wrapper || !btn) return;
    const expanded = wrapper.classList.toggle('expanded');
    wrapper.classList.toggle('collapsed', !expanded);
    btn.textContent = expanded ? 'Show Less' : 'Show All';
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadUser();
    _userLoaded = true;
    onAuthChange();

    // Start proactive token refresh timer
    startTokenRefreshTimer();

    // Theme is owned centrally by openvibe.network and applied by the shared OpenVibeThemeLoader
    // (which syncs from openvibe.network after paint). We no longer read OpenVibe.Live's local
    // theme store, so the theme chosen at openvibe.network/themes is authoritative here.

    // Route from current URL instead of always going home — but not in the popout
    // chat window, which drives its own chat UI and has no SPA pages to route to.
    // Covers /popout-chat.html AND the pretty /popout/<user>[/<id>] URLs.
    if (!location.pathname.startsWith('/popout')) {
        routeFromURL();
    }
});

// Handle browser back/forward — wait for auth to be resolved first
window.addEventListener('popstate', () => {
    if (location.pathname.startsWith('/popout')) return; // popout window: no SPA routing
    if (_userLoaded) {
        routeFromURL();
    }
    // If auth hasn't loaded yet, DOMContentLoaded handler will call routeFromURL()
});

// Intercept link clicks to use SPA navigation
document.addEventListener('click', (e) => {
    // Close user dropdown
    if (!e.target.closest('.nav-avatar-wrap') && !e.target.closest('.user-dropdown')) {
        document.getElementById('user-dropdown')?.classList.remove('show');
    }

    if (!e.target.closest('.nav-links') && !e.target.closest('.nav-hamburger')) {
        closeMobileNav();
    }
});

// ── Docs → clean Markdown ────────────────────────────────────────────────────
// Convert the docs HTML (headings, paragraphs, lists, code blocks, and the .doc-table
// endpoint tables) into proper Markdown so "Copy All"/"Copy Section" paste as real Markdown
// (GitHub-flavored tables, fenced code) instead of tab-separated innerText.
function _docsInlineMd(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const cls = node.className || '';
    if (tag === 'i' && /\bfa-/.test(cls)) return ''; // FontAwesome icon — no text
    const inner = Array.from(node.childNodes).map(_docsInlineMd).join('');
    switch (tag) {
        case 'code': return '`' + node.textContent + '`';
        case 'strong': case 'b': return '**' + inner.trim() + '**';
        case 'em': case 'i': return inner.trim() ? '*' + inner.trim() + '*' : '';
        case 'a': { const href = node.getAttribute('href') || ''; return href ? `[${inner.trim()}](${href})` : inner; }
        case 'br': return '\n';
        default: return inner;
    }
}
function _docsCell(c) { return _docsInlineMd(c).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim(); }
function _docsTableMd(table) {
    let header = Array.from(table.querySelectorAll('thead th')).map(_docsCell);
    let bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (!header.length) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows[0]) header = Array.from(rows[0].children).map(_docsCell);
        bodyRows = rows.slice(1);
    }
    const out = [];
    if (header.length) {
        out.push('| ' + header.join(' | ') + ' |');
        out.push('| ' + header.map(() => '---').join(' | ') + ' |');
    }
    for (const tr of bodyRows) {
        const cells = Array.from(tr.children).map(_docsCell);
        if (cells.length) out.push('| ' + cells.join(' | ') + ' |');
    }
    return out.join('\n');
}
function _docsToMarkdown(root) {
    const lines = [];
    const walk = (el) => {
        for (const node of el.childNodes) {
            if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) lines.push(t); continue; }
            if (node.nodeType !== 1) continue;
            const tag = node.tagName.toLowerCase();
            if (/^h[1-6]$/.test(tag)) {
                lines.push('', '#'.repeat(Number(tag[1])) + ' ' + _docsInlineMd(node).trim(), '');
            } else if (tag === 'p') {
                const t = _docsInlineMd(node).trim(); if (t) lines.push(t, '');
            } else if (tag === 'ul' || tag === 'ol') {
                Array.from(node.children).filter(li => li.tagName === 'LI').forEach((li, i) => {
                    lines.push((tag === 'ol' ? (i + 1) + '. ' : '- ') + _docsInlineMd(li).replace(/\s*\n\s*/g, ' ').trim());
                });
                lines.push('');
            } else if (tag === 'pre') {
                lines.push('```', (node.textContent || '').replace(/\n+$/, ''), '```', '');
            } else if (tag === 'table') {
                lines.push(_docsTableMd(node), '');
            } else if (tag === 'hr') {
                lines.push('', '---', '');
            } else {
                walk(node); // container — recurse
            }
        }
    };
    walk(root);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function copyDocsForAI() {
    const el = document.getElementById('docs-ai-content');
    if (!el) return;
    // Non-active tabs are display:none; reveal all so the converter sees every tab, then restore
    // (synchronous — no visible flash).
    const tabs = Array.from(el.querySelectorAll('.doc-tab-content'));
    const prevDisplay = tabs.map(t => t.style.display);
    tabs.forEach(t => { t.style.display = ''; });
    const text = _docsToMarkdown(el);
    tabs.forEach((t, i) => { t.style.display = prevDisplay[i]; });
    _docsCopy(text, 'docs-copy-btn', 'Copied all!');
}

function _docsCopy(text, btnId, label) {
    const flash = () => {
        const toast = document.getElementById('docs-copy-toast');
        const btn = document.getElementById(btnId);
        if (toast) { toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none'; }, 4000); }
        if (btn) { const orig = btn.innerHTML; btn.innerHTML = `<i class="fa-solid fa-check"></i> ${label}`; setTimeout(() => { btn.innerHTML = orig; }, 3000); }
    };
    navigator.clipboard.writeText(text).then(flash).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        flash();
    });
}

function showDocTab(tabName, btn) {
    document.querySelectorAll('.doc-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.docs-tab').forEach(el => el.classList.remove('active'));
    const target = document.querySelector(`.doc-tab-content[data-doc-tab="${tabName}"]`);
    if (target) target.style.display = '';
    if (btn) {
        btn.classList.add('active');
        // Keep the selected tab fully visible in the scrollable bar.
        try { btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch { /* */ }
    }
}

// Tab-bar overflow affordance: arrow buttons + edge fades when tabs overflow,
// plain mouse wheel scrolls the bar horizontally (no shift needed).
function initDocsTabScroller() {
    const wrap = document.getElementById('docs-tab-wrap');
    const bar = document.getElementById('docs-tab-bar');
    if (!wrap || !bar) return;
    const update = () => {
        wrap.classList.toggle('can-scroll-left', bar.scrollLeft > 4);
        wrap.classList.toggle('can-scroll-right', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4);
    };
    if (!wrap._scrollerInit) {
        wrap._scrollerInit = true;
        bar.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        const L = document.getElementById('docs-tab-arrow-left');
        const R = document.getElementById('docs-tab-arrow-right');
        if (L) L.onclick = () => bar.scrollBy({ left: -Math.max(200, bar.clientWidth * 0.6), behavior: 'smooth' });
        if (R) R.onclick = () => bar.scrollBy({ left: Math.max(200, bar.clientWidth * 0.6), behavior: 'smooth' });
        bar.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && bar.scrollWidth > bar.clientWidth) {
                bar.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    }
    // Widths are 0 until the page is actually displayed — measure on next frame.
    requestAnimationFrame(update);
}

function copyDocSection() {
    const active = document.querySelector('.doc-tab-content[style=""], .doc-tab-content:not([style*="display: none"]):not([style*="display:none"])');
    if (!active) return;
    _docsCopy(_docsToMarkdown(active), 'docs-copy-section-btn', 'Copied!');
}
