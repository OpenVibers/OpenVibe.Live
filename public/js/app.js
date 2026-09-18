/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Core Application (SPA Router, Auth, API)
   URL-based routing with history.pushState
   ═══════════════════════════════════════════════════════════════ */

const API = '';   // same-origin
let currentUser = null;
let currentPage = 'home';
let currentStreamId = null;
let currentStreamData = null; // increments each stream switch; guards against fast-switch races
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
const RESERVED = new Set(['vods', 'clips', 'vod', 'clip', 'dashboard', 'settings', 'broadcast', 'admin', 'themes', 'game', 'canvas', 'chat', 'api', 'ws', 'media', 'pastes', 'p', 'updates', 'dmca', 'tos', 'terms', 'arena', 'recap']);
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
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--accent),#6d28d9);color:#fff;text-decoration:none;border:none;cursor:pointer">
                <i class="fa-solid fa-network-wired"></i> Sign in with OpenVibe
            </a>
            <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Don't have an account? One will be created when you sign in.</p>`,
        register: `
            <h3><i class="fa-solid fa-user-plus"></i> Sign Up</h3>
            <p style="color:var(--text-muted);margin-bottom:16px">Create your account on the OpenVibe.</p>
            <a href="/api/auth/sso/login" class="btn btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--accent),#6d28d9);color:#fff;text-decoration:none;border:none;cursor:pointer">
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

// Defined here once. dashboard.js used to carry a second, fuller copy that silently replaced this one
// because it loaded later — so the site's modals were closing through the dashboard's version.
function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('show');
    // The clone-preset modal toggles style.display rather than the .show class.
    const cloneModal = document.getElementById('clone-preset-config-modal');
    if (cloneModal) cloneModal.style.display = 'none';
}

// Escapes quotes as well as < > &. The previous version used the textContent/innerHTML trick,
// which leaves " and ' untouched — safe in text, but these helpers are also interpolated into
// attribute values, where an unescaped quote ends the attribute and starts a new one.
function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


/* ── Auth ──────────────────────────────────────────────────────── */
// Local login/register removed — all auth goes through OpenVibe SSO
function doLogin() { window.location.href = '/api/auth/sso/login'; }
function doRegister() { window.location.href = '/api/auth/sso/login'; }

// Session hint: 'account' after a successful sign-in (silent SSO may re-sign you in when the
// site token lapses), 'guest' after an explicit logout / "browse as guest" (never re-sign in).
function _setSsoHint(v) { try { localStorage.setItem('ov_sso_hint', v); } catch { /* */ } }
function _ssoHint() {
    // The cookie is set by the server on sign-in/sign-out (and by the network's sign-in-everywhere
    // chain, which never runs this page's JS); localStorage is the page-side copy.
    const m = document.cookie.match(/(?:^|;\s*)ov_sso_hint=([^;]*)/);
    if (m && m[1]) return m[1];
    try { return localStorage.getItem('ov_sso_hint') || ''; } catch { return ''; }
}

// ── Cross-site history (openvibe.network) ────────────────────
// What the signed-in account watches/opens here shows up in its network-wide History and the
// "Recently used" rows of the shared navbar on every other site. Recorded after the route
// rendered and its title settled; never for guests, and only for the pages worth remembering.
const _HISTORY_PAGES = { channel: 'stream', 'vod-player': 'vod', 'clip-player': 'clip', 'paste-viewer': 'paste', pastes: null, game: 'game', arena: 'page' };
let _historyTimer = null;
function _recordHistory(pageId) {
    const type = _HISTORY_PAGES[pageId];
    if (!type) return;
    clearTimeout(_historyTimer);
    _historyTimer = setTimeout(() => {
        const tok = (document.cookie.match(/(?:^|;\s*)ov_token=([^;]*)/) || [])[1] || localStorage.getItem('ov_token');
        if (!tok || !currentUser) return;
        const entry = { type, title: document.title.replace(/\s*[-–|]\s*OpenVibe\.Live\s*$/i, ''), url: location.href };
        const send = () => { try { window.OpenVibeHistory.record(entry, { token: decodeURIComponent(tok) }); } catch { /* */ } };
        if (window.OpenVibeHistory) return send();
        if (document.getElementById('ov-history-loader')) return;
        const sc = document.createElement('script'); sc.id = 'ov-history-loader'; sc.async = true; sc.src = '/shared/history.js'; sc.onload = send;
        document.head.appendChild(sc);
    }, 1800);
}
/** Try to sign back in through openvibe.network without a chooser — once per tab session. */
function _trySilentSso(force) {
    if (!force && _ssoHint() !== 'account') return false;
    try { if (sessionStorage.getItem('ov_silent_sso')) return false; sessionStorage.setItem('ov_silent_sso', '1'); } catch { return false; }
    if (location.pathname.startsWith('/banned') || location.pathname.startsWith('/api/')) return false;
    // Come back to this exact page once the network has answered.
    location.href = '/api/auth/sso/login?silent=1&next=' + encodeURIComponent(location.pathname + location.search);
    return true;
}
/**
 * A guest with no hint yet: ask openvibe.network in a hidden iframe whether this browser is
 * signed in there (GET /sso/check → one postMessage). Only a "yes" triggers the silent sign-in,
 * so first-time visitors never see a redirect. Once per tab per 10 minutes.
 */
let _ssoClientPromise = null;
function _loadSsoClient() {
    if (window.OpenVibeSSO) return Promise.resolve(window.OpenVibeSSO);
    if (_ssoClientPromise) return _ssoClientPromise;
    _ssoClientPromise = new Promise((resolve) => {
        const sc = document.createElement('script'); sc.async = true; sc.src = '/shared/sso-client.js';
        sc.onload = () => resolve(window.OpenVibeSSO || null); sc.onerror = () => resolve(null);
        document.head.appendChild(sc);
    });
    return _ssoClientPromise;
}
/** Signed in here: links to the other OpenVibe sites carry the session along (shared sso-client.js). */
function _enableHandoff() {
    _loadSsoClient().then((sso) => { try { sso && sso.handoffLinks({ signedIn: !!currentUser }); } catch { /* */ } });
}
function _checkNetworkSession() {
    if (_ssoHint() === 'guest' || /bot|crawl|spider|headless/i.test(navigator.userAgent)) return;
    try {
        const last = +sessionStorage.getItem('ov_sso_check_at') || 0;
        if (Date.now() - last < 10 * 60 * 1000) return;
        sessionStorage.setItem('ov_sso_check_at', String(Date.now()));
    } catch { return; }
    const base = (window.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/$/, '');
    let frame = null, timer = null;
    const done = () => { window.removeEventListener('message', onMsg); clearTimeout(timer); try { frame?.remove(); } catch { /* */ } };
    const onMsg = (e) => {
        if (e.origin !== base || !e.data || e.data.type !== 'ov-sso') return;
        done();
        if (currentUser) return;
        if (e.data.signedIn) { _trySilentSso(true); return; }
        // Not visible from an iframe (guest, or the browser keeps third-party cookies away):
        // let the browser itself ask the network — FedCM is a no-op for guests.
        _loadSsoClient().then(async (sso) => {
            if (!sso || !sso.fedcmAvailable() || currentUser) return;
            const r = await sso.fedcm({ apiBase: base, fedcmLogin: '/api/auth/fedcm', mediation: 'optional' });
            if (r && r.ok) { try { sessionStorage.removeItem('ov_silent_sso'); } catch { /* */ } _setSsoHint('account'); location.reload(); }
        });
    };
    window.addEventListener('message', onMsg);
    frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
    frame.src = `${base}/sso/check?origin=${encodeURIComponent(location.origin)}`;
    (document.body || document.documentElement).appendChild(frame);
    timer = setTimeout(done, 4000);
}
/** "Switch account": drop this site's session, keep openvibe.network's, open the account chooser. */
function switchAccount() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {}).finally(() => {
        localStorage.removeItem('token'); localStorage.removeItem('ov_token');
        document.cookie = 'token=;Max-Age=0;path=/'; document.cookie = 'ov_token=;Max-Age=0;path=/';
        _setSsoHint('account');
        location.href = '/api/auth/sso/login';
    });
}
/** "Browse as guest": signed out here only — openvibe.network still remembers you, so "Sign in" is one tap. */
function browseAsGuest() { logout(); try { toast('Browsing as a guest — Sign in brings you straight back.', 'info'); } catch { /* */ } }
function logout() {
    _setSsoHint('guest');
    try { window.OpenVibeSSO && window.OpenVibeSSO.preventSilent(); } catch { /* */ }
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
    /* destroyCanvasPage lived in js/canvas.js, which index.html has not loaded since canvas moved
       to OpenVibe.Games — so this guard has been permanently false. Removed rather than left as a
       line that looks like cleanup and never runs. */
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
        // No token in localStorage — try refreshing from the httpOnly cookie. A browser last seen as
        // a guest doesn't hold the page for that round trip (it answers 401 for nearly everyone):
        // the page routes now, and if a session does turn up the normal auth-change path signs in.
        if (_ssoHint() !== 'account') {
            tryRefreshToken().then(async (ok) => {
                if (!ok || !localStorage.getItem('token')) { _checkNetworkSession(); return; }
                await loadUser();
                if (currentUser) onAuthChange();
            }).catch(() => { _checkNetworkSession(); });
            return;
        }
        const refreshed = await tryRefreshToken();
        if (!refreshed) { _trySilentSso(); return; }
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
        _setSsoHint('account');
    } catch (err) {
        // Banned account: the server refuses with 403 — show the ban screen instead of the site.
        if (err && err.status === 403 && /banned/i.test(String(err.message || ''))) {
            if (!location.pathname.startsWith('/banned')) location.replace('/banned');
            return;
        }
        // If still 401 after auto-refresh attempt in api(), give up here — but let the network
        // sign us back in silently if it still has a session for this browser.
        localStorage.removeItem('token');
        localStorage.removeItem('ov_token');
        _trySilentSso();
    }
}
// Back from a silent sign-in that found no network session: stay a guest, tidy the URL.
try { if (new URLSearchParams(location.search).get('sso') === 'none') { _setSsoHint('guest'); history.replaceState(null, '', location.pathname); } } catch { /* */ }

function onAuthChange() {
    if (currentUser) _enableHandoff(); else if (window.OpenVibeSSO) { try { window.OpenVibeSSO.handoffLinks({ signedIn: false }); } catch { /* */ } }
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
            // The account menu opens with the same identity the navbar shows, so it does not need
            // a second source of truth — it is filled from here.
            const udAv = document.getElementById('ud-avatar');
            if (udAv) udAv.innerHTML = _avatarInner(currentUser.avatar_url, currentUser.username);
            const udName = document.getElementById('ud-name');
            if (udName) udName.textContent = currentUser.display_name || currentUser.username;
            const udHandle = document.getElementById('ud-handle');
            if (udHandle) udHandle.textContent = '@' + (currentUser.username || '');
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
        const udV = document.getElementById('ud-vibes');
        if (udV) udV.textContent = bal.toLocaleString();
    } catch { /* silent */ }
    // Navbar OpenCoins = the GLOBAL currency (game / cosmetics / media wallet).
    try {
        const coinData = await api('/coins/balance');
        const coins = coinData.balance || 0;
        const coinEl = document.getElementById('nav-coins-amount');
        if (coinEl) coinEl.textContent = coins.toLocaleString();
        const udC = document.getElementById('ud-coins');
        if (udC) udC.textContent = coins.toLocaleString();
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
    const dd = document.getElementById('user-dropdown');
    const open = dd.classList.toggle('show');
    if (open) { closeMobileNav(); dd.scrollTop = 0; }        // one panel at a time, always opened from the top
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
    if (navLinks.classList.contains('show')) { document.getElementById('user-dropdown')?.classList.remove('show'); navLinks.scrollTop = 0; }
}

function isModifiedLinkClick(event) {
    return !!(event && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey));
}

/**
 * Insert cards into a rail, and let appended ones arrive rather than appear.
 *
 * "Load more" used to splice eight cards into the DOM in one frame: the list jumped and there was
 * no visual link between pressing the button and the new rows. Only the new children are
 * staggered — re-animating what was already on screen would read as a full page repaint. The
 * class is stripped afterwards so it cannot affect a later re-render, and that cleanup runs on a
 * timer rather than on animationend, so an element whose animation never started (off-screen,
 * display:none) is still returned to normal.
 */
/**
 * Clear transient overlays that a route change has orphaned.
 *
 * Guides, spotlights and confirm sheets are all "this page, right now" UI. Each one is supposed to
 * clean up after itself, and each one has at least one exit that skips its own teardown — closing
 * a guide from a link inside it, navigating away from a spotlight, a confirm sheet whose caller
 * threw. The ones that matter are position:fixed with pointer-events:auto: they keep absorbing
 * taps over whatever they cover, which reads to the reader as "this button is dead". This is the
 * backstop, not the fix — the modules still clean up their own.
 */
function ovClearStrandedOverlays() {
    try { if (window.OVGuide && typeof OVGuide.closeSpotlight === 'function') OVGuide.closeSpotlight(); } catch { /* */ }
    try { if (window.OVGuide && OVGuide.state && OVGuide.state.open) OVGuide.close(false); } catch { /* */ }
    for (const sel of ['.ovg-spot', '.bc-ws-confirm-overlay', '.bg-guide']) {
        document.querySelectorAll(sel).forEach(el => { try { el.remove(); } catch { /* */ } });
    }
    // The scroll lock outliving its modal is the other way a page goes dead.
    try { if (!document.querySelector('.ovg.is-open')) document.body.classList.remove('ovg-lock'); } catch { /* */ }
}

/**
 * The view count on a thumbnail.
 *
 * Was a bare eye glyph and a raw integer on a flat black box. Now a frosted pill with tabular
 * figures and a compact count, so 12400 reads as 12.4K instead of widening the badge past the
 * corner of the card.
 */
function ovViewsBadge(n) {
    const v = Math.max(0, Number(n) || 0);
    // Thresholds are set just below the round number, not at it: 999,999 rounds to 1000 in the
    // K branch and would render "1000K".
    const label = v >= 999500 ? (v / 1000000).toFixed(v >= 9999500 ? 0 : 1).replace(/\.0$/, '') + 'M'
        : v >= 999.5 ? (v / 1000).toFixed(v >= 9999.5 ? 0 : 1).replace(/\.0$/, '') + 'K'
        : String(v);
    return `<span class="stream-card-viewers" title="${v.toLocaleString()} view${v === 1 ? '' : 's'}"><i class="fa-solid fa-eye"></i><b>${label}</b></span>`;
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
/**
 * Everything that must stop when we leave a route.
 *
 * This used to live inside navigate(), which meant the browser's Back and Forward buttons —
 * which go through popstate → routeFromURL() and never touch navigate() — left everything
 * running: the chat WebSocket still bound to the previous channel, the coin heartbeat still
 * crediting watch time on a page with nothing playing, the canvas socket and its timer, the
 * global AI poll, the arena and AI-viewer loops, and the broadcast desk's five polls. Every Back
 * press added another set. Now both paths go through here.
 */
function teardownRoute(nextPath) {
    // A new route generation: anything the previous route registered through ov.scope() is
    // released, and loaders still awaiting data for it see they are stale.
    if (window.ov) ov.nextRoute();
    ovClearStrandedOverlays();
    if (typeof destroyPlayer === 'function') destroyPlayer();
    if (typeof destroyChat === 'function') destroyChat();
    /* destroyCanvasPage lived in js/canvas.js, which index.html has not loaded since canvas moved
       to OpenVibe.Games — so this guard has been permanently false. Removed rather than left as a
       line that looks like cleanup and never runs. */
    if (typeof stopCoinHeartbeat === 'function') stopCoinHeartbeat();
    if (typeof updateChannelPointsNav === 'function') updateChannelPointsNav(null);
    if (typeof stopHomeRefresh === 'function') stopHomeRefresh();
    if (typeof stopStreamStatusPoll === 'function') stopStreamStatusPoll();
    clearInterval(uptimeInterval);

    if (window._liveVodPollTimer) {
        clearInterval(window._liveVodPollTimer);
        window._liveVodPollTimer = null;
        window._liveVodIsLive = false;
    }
    if (window._globalAiPollTimer) {
        clearInterval(window._globalAiPollTimer);
        window._globalAiPollTimer = null;
    }

    // Loops other modules own. Each is optional — a module that isn't loaded simply isn't stopped.
    const stop = (fn) => { try { if (typeof window[fn] === 'function') window[fn](); } catch { /* */ } };
    // Hardware controls: the socket and its reconnect loop outlived the channel, and the global
    // key handler kept sending bound keys to the last channel's device from any page.
    stop('destroyControlWs');
    try { currentStreamId = null; } catch { /* */ }
    // The VOD/clip chat replay re-arms itself every animation frame; nothing stopped it.
    if (window._chatReplayTimer) { cancelAnimationFrame(window._chatReplayTimer); window._chatReplayTimer = null; }
    window._vpChatReplay = null; window._clpChatReplay = null;
    // Channel strays that kept fetching or cycling off-route.
    stop('stopGoalWidget');
    stop('_stopOfflineCycler');
    stop('_stopCaptions');
    if (typeof _channelPastesTimer !== 'undefined' && _channelPastesTimer) { clearInterval(_channelPastesTimer); _channelPastesTimer = null; }
    if (typeof _goalCycleTimer !== 'undefined' && _goalCycleTimer) { clearInterval(_goalCycleTimer); _goalCycleTimer = null; }
    // A Back press with the clip creator open left its key handler, drag handlers and preview loop.
    try { const cm = document.getElementById('vp-clip-modal'); if (cm && cm.style.display && cm.style.display !== 'none') stop('closeClipCreator'); } catch { /* */ }
    stop('_aStopTimers');
    stop('stopAiViewerActivity');
    stop('stopPlayerStatsPoll');
    // The broadcast desk's polls only matter while you are on it. Leaving them running elsewhere
    // costs roughly a request a second for the rest of the session.
    const goingToBroadcast = typeof nextPath === 'string' && nextPath.startsWith('/broadcast');
    if (!goingToBroadcast) {
        stop('stopRtmpStatusPoll');
        stop('stopRtmpPreview');
        stop('stopRestreamStatusPolling');
        stop('_stopMediaPipPoll');
    }
}

function navigate(urlPath, replace = false) {
    closeMobileNav();
    teardownRoute(urlPath);

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

/**
 * Run a route's renderer once the route's features (public/features.json) are loaded — and only if
 * the visitor is still on that route. Without the generation check, a slow first load of the
 * broadcast bundle could finish after the visitor had moved on and start the desk's polls and
 * preview on whatever page they were now reading.
 */
/**
 * One site-wide indicator for live connections that are recovering.
 *
 * A restart drops every WebSocket (socket activation only protects new HTTP connections), and until
 * now each module either said nothing or wrote its own lines. Modules report their state here; the
 * pill shows the worst current state, waits a moment before appearing so a quick reconnect never
 * flashes, and confirms recovery briefly.
 */
const _ovConn = { sources: new Map(), el: null, showTimer: 0, hideTimer: 0 };
function ovConnectionPill(state, source = 'app') {
    const rank = { offline: 3, updating: 2, reconnecting: 1, connected: 0 };
    if (state === 'connected') _ovConn.sources.delete(source); else _ovConn.sources.set(source, state);
    let worst = null;
    for (const st of _ovConn.sources.values()) if (!worst || rank[st] > rank[worst]) worst = st;
    if (!_ovConn.el) {
        _ovConn.el = document.createElement('div');
        _ovConn.el.className = 'ov-conn-pill';
        _ovConn.el.setAttribute('role', 'status');
        _ovConn.el.setAttribute('aria-live', 'polite');
        _ovConn.el.innerHTML = '<span class="ov-conn-dot" aria-hidden="true"></span><span class="ov-conn-text"></span>';
        document.body.appendChild(_ovConn.el);
    }
    const el = _ovConn.el, text = el.querySelector('.ov-conn-text');
    clearTimeout(_ovConn.showTimer); clearTimeout(_ovConn.hideTimer);
    if (worst) {
        const label = worst === 'offline' ? "You're offline" : worst === 'updating' ? 'OpenVibe is updating — back in a moment' : 'Reconnecting…';
        const show = () => { el.dataset.state = worst; text.textContent = label; el.classList.add('is-shown'); el.dataset.wasShown = '1'; };
        if (el.classList.contains('is-shown') || worst !== 'reconnecting') show();
        else _ovConn.showTimer = setTimeout(show, 1500);
    } else if (el.dataset.wasShown === '1') {
        el.dataset.state = 'connected'; text.textContent = 'Reconnected'; el.classList.add('is-shown');
        el.dataset.wasShown = '';
        _ovConn.hideTimer = setTimeout(() => el.classList.remove('is-shown'), 2200);
    } else {
        el.classList.remove('is-shown');
    }
}
window.ovConnectionPill = ovConnectionPill;

function whenRouteReady(pageId, render) {
    const gen = window.ov ? ov.gen() : 0;
    const path = location.pathname;
    const run = () => {
        if (window.ov && !ov.isCurrent(gen)) return;
        try { render(); _recordHistory(pageId); }
        catch (err) {
            console.error(`[route] ${path} failed to render:`, err);
            if (window.ov) ov.showRouteError(`page-${pageId}`, err, () => whenRouteReady(pageId, render));
        }
    };
    if (!window.ov) return run();
    ov.route(path).then(run, (err) => {
        if (!ov.isCurrent(gen)) return;
        ov.showRouteError(`page-${pageId}`, err, () => whenRouteReady(pageId, render));
    });
}

/** Pastes live on openvibe.community. A signed-in user goes through its silent sign-in so they arrive
 *  signed in; guests go straight to the page. */
function _pasteHandOver(target) {
    const base = document.querySelector('meta[name="ov-pastes-base"]').content;
    const signedIn = /(?:^|;\s*)ov_sso_hint=account(?:;|$)/.test(document.cookie) || !!(typeof currentUser !== 'undefined' && currentUser);
    location.replace(signedIn ? `${base}/auth/login?silent=1&next=${encodeURIComponent(target)}` : base + target);
}

function routeFromURL() {
    // Remove the server-rendered SEO prerender block once the SPA takes over (it's crawlable
    // content for no-JS scrapers; JS clients render the real interactive page instead).
    try { document.getElementById('seo-prerender')?.remove(); } catch { /* */ }
    setPageTitle(null); // reset to default; per-route loaders set it once content loads
    const path = window.location.pathname;
    const segments = path.split('/').filter(Boolean);

    // Full teardown, not just the player. navigate() has already run this for in-app links; on a
    // Back/Forward press this is the only place it happens, and running it twice is harmless
    // because every stopper is idempotent.
    teardownRoute(path);

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.nav-links')?.classList.remove('show');

    window.scrollTo(0, 0);

    // Route matching
    if (segments.length === 0) {
        // Home: /
        showPage('home');
        whenRouteReady('home', () => loadHome());
    } else if (segments[0] === 'vods') {
        showPage('vods');
        whenRouteReady('vods', () => loadVodsPage());
    } else if (segments[0] === 'clips') {
        showPage('clips');
        whenRouteReady('clips', () => loadClipsPage());
    } else if (segments[0] === 'vod' && segments[1]) {
        // VOD player: /vod/:id  (optional ?t=<seconds> to auto-seek, e.g. from a clip link)
        showPage('vod-player');
        const _t = parseFloat(new URLSearchParams(window.location.search).get('t'));
        whenRouteReady('vod-player', () => loadVodPlayer(segments[1], Number.isFinite(_t) && _t > 0 ? _t : null));
    } else if (segments[0] === 'clip' && segments[1]) {
        // Clip player: /clip/:id
        showPage('clip-player');
        whenRouteReady('clip-player', () => loadClipPlayer(segments[1]));
    } else if (segments[0] === 'dashboard') {
        showPage('dashboard');
        whenRouteReady('dashboard', () => { if (typeof loadDashboard === 'function') loadDashboard(); });
    } else if (segments[0] === 'settings') {
        // /settings was merged into the dashboard — redirect there.
        navigate('/dashboard', true);
        return;
    } else if (segments[0] === 'broadcast') {
        // Show the shell first so the route feels instant, then fill it once its bundle is in.
        showPage('broadcast');
        whenRouteReady('broadcast', () => { if (typeof loadBroadcastPage === 'function') loadBroadcastPage(); });
    } else if (segments[0] === 'admin') {
        window.location.href = `${getOpenVibeToolsUrl()}/admin`;
        return;
    } else if (segments[0] === 'themes') {
        // Theme management moved to the central openvibe.network account app.
        window.location.href = 'https://openvibe.network/themes';
        return;
    } else if (segments[0] === 'chat') {
        showPage('chat');
        whenRouteReady('chat', () => loadChatPage());
    } else if (segments[0] === 'game') {
        window.location.href = `${getScraplandiaUrl()}/game`;
        return;
    } else if (segments[0] === 'canvas') {
        window.location.href = `${getScraplandiaUrl()}/canvas`;
        return;
    } else if (segments[0] === 'pastes') {
        showPage('pastes');
        const editSlug = new URLSearchParams(window.location.search).get('edit');
        whenRouteReady('pastes', () => {
            if (typeof loadPastesPage === 'function') loadPastesPage();
        });
        // Handle ?edit=slug
        if (editSlug) {
            Promise.all([api(`/pastes/${editSlug}`), ov.load('pastes')]).then(([data]) => {
                if (data.paste && typeof openNewPasteModal === 'function') openNewPasteModal({
                    title: data.paste.title,
                    content: data.paste.content,
                    language: data.paste.language,
                    visibility: data.paste.visibility,
                    slug: editSlug,
                });
            }).catch(() => {});
        }
    } else if (segments[0] === 'recap' && segments[1]) {
        // After-show report: /recap/:streamId
        showPage('recap');
        whenRouteReady('recap', () => { if (typeof loadRecapPage === 'function') loadRecapPage(segments[1]); });
    } else if (segments[0] === 'arena') {
        showPage('arena');
        whenRouteReady('arena', () => { if (typeof loadArenaPage === 'function') loadArenaPage(segments); });
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
    } else if (segments[0] === 'pastes' && !segments[1] && document.querySelector('meta[name="ov-pastes-base"]')) {
        _pasteHandOver(`/pastes${location.search}`);
        return;
    } else if (segments[0] === 'p' && segments[1] && document.querySelector('meta[name="ov-pastes-base"]')) {
        // Pastes live on openvibe.community now — hand the browser over (same slug, same URL shape).
        _pasteHandOver(`/p/${encodeURIComponent(segments[1])}${location.search}`);
        return;
    } else if (segments[0] === 'p' && segments[1]) {
        showPage('paste-viewer');
        whenRouteReady('paste-viewer', () => { if (typeof loadPasteViewer === 'function') loadPasteViewer(segments[1]); });
    } else if (segments[0] === 'documentation') {
        showPage('documentation');
        whenRouteReady('documentation', () => initDocsTabScroller());
    } else if (segments[0] === 'stream' && segments[1]) {
        // Legacy stream URL: /stream/:id
        showPage('stream');
        whenRouteReady('stream', () => openStream(segments[1]));
    } else if (segments.length >= 1 && segments[0].startsWith('@')) {
        // Channel page: /@username or /@username/:managedStreamIdOrSlug
        // Backward compat: /@username?stream=sessionId
        const username = normalizeChannelUsername(segments[0]);
        if (CHANNEL_USERNAME_RE.test(username)) {
            showPage('channel');
            const managedStreamRef = segments[1] || null;
            const legacyStreamParam = new URLSearchParams(window.location.search).get('stream');
            whenRouteReady('channel', () => loadChannelPage(username, managedStreamRef, legacyStreamParam ? parseInt(legacyStreamParam, 10) : null));
        } else {
            showPage('home');
            ov.load('home').then(() => loadHome());
        }
    } else {
        // 404 fallback
        showPage('home');
        ov.load('home').then(() => loadHome());
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Route-change motion: the brand mark, and the page itself.
   ═══════════════════════════════════════════════════════════════════════════ */

/** How long the mark stays animated after a route change before settling. */
const BRAND_AWAKE_MS = 5000;
let _brandIdleTimer = 0, _brandSettleTimer = 0, _brandSpinTimer = 0, _brandEverWoken = false;

/**
 * Wake the OV mark for a moment, then let it go still.
 *
 * The mark ran six looping animations — a float, a glow pulse, a comet sweep, a dot pulse and two
 * SMIL orbit motions, plus a sweeping gradient — forever, on every page. That is a composited
 * repaint every frame for the entire time someone sits reading, which is most of the time they
 * are here. It now animates when there is a reason to: the route changed, so the mark spins once
 * and stays lively for five seconds, then settles with an overshoot and holds still until the
 * next change.
 *
 * CSS loops stop via animation-play-state, which freezes them on their 0% keyframe — every one of
 * those is a sensible rest pose. SMIL cannot be paused from CSS at all, so the SVG element's own
 * pauseAnimations()/unpauseAnimations() handles the orbit dots and the gradient sweep.
 */
function ovWakeBrandMark() {
    let marks;
    try { marks = document.querySelectorAll('.brand-mark'); } catch { return; }
    if (!marks || !marks.length) return;
    let reduce = false;
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    if (reduce) {
        // CSS stops the loops under reduced motion but cannot reach SMIL — the gradient sweep on the
        // V would otherwise run for the whole session. Hold everything still, once.
        if (!_brandEverWoken) marks.forEach(m => { try { const svg = m.querySelector('svg'); svg && svg.pauseAnimations && svg.pauseAnimations(); } catch { /* */ } });
        _brandEverWoken = true;
        return;
    }

    _brandEverWoken = true;
    clearTimeout(_brandIdleTimer); clearTimeout(_brandSettleTimer); clearTimeout(_brandSpinTimer);
    marks.forEach((m) => {
        m.classList.remove('is-settling', 'is-spin');
        m.classList.add('is-awake');
        void m.offsetWidth;                       // restart the spin on a repeat navigation
        m.classList.add('is-spin');
        const svg = m.querySelector('svg');
        try { svg && svg.unpauseAnimations && svg.unpauseAnimations(); } catch { /* no SMIL here */ }
    });

    // The spin owns the svg's animation slot while it runs, so the ambient float cannot start
    // until it is off. Hand over as soon as the spin finishes rather than at the end of the window.
    _brandSpinTimer = setTimeout(() => marks.forEach(m => m.classList.remove('is-spin')), 1080);

    _brandIdleTimer = setTimeout(() => {
        marks.forEach((m) => {
            m.classList.remove('is-awake', 'is-spin');
            m.classList.add('is-settling');
            const svg = m.querySelector('svg');
            // Pause in place rather than rewinding: a jump back to t=0 would throw the orbit dot
            // across the ring at the exact moment the mark is supposed to be coming to rest.
            try { svg && svg.pauseAnimations && svg.pauseAnimations(); } catch { /* */ }
        });
        _brandSettleTimer = setTimeout(() => marks.forEach(m => m.classList.remove('is-settling')), 720);
    }, BRAND_AWAKE_MS);
}

/**
 * A thin bar that runs across the top on a route change.
 *
 * Routes here are instant to swap and slow to fill — the shell is already up, the content arrives
 * over the network. Without a signal the page looks broken for that gap. The bar is one element,
 * transform-only, and removes itself.
 */
let _routeBarTimer = 0;
function ovRouteProgress() {
    let reduce = false;
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    if (reduce) return;
    let bar = document.getElementById('ov-routebar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ov-routebar';
        bar.setAttribute('aria-hidden', 'true');
        document.body.appendChild(bar);
    }
    clearTimeout(_routeBarTimer);
    bar.classList.remove('is-run', 'is-done');
    void bar.offsetWidth;
    bar.classList.add('is-run');
    _routeBarTimer = setTimeout(() => {
        bar.classList.remove('is-run');
        bar.classList.add('is-done');
        _routeBarTimer = setTimeout(() => bar.classList.remove('is-done'), 320);
    }, 620);
}

/**
 * The incoming page rises into place instead of appearing.
 *
 * Transform and opacity only, so it cannot shift layout, and the class is stripped on a timer —
 * an element whose animation never ran (a route swapped again mid-flight, a hidden ancestor) must
 * not be left holding opacity 0.
 */
let _pageEnterTimer = 0;
function ovAnimatePageEnter(el) {
    if (!el) return;
    let reduce = false;
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
    if (reduce) return;
    clearTimeout(_pageEnterTimer);
    document.querySelectorAll('.page.is-entering').forEach(p => p.classList.remove('is-entering'));
    el.classList.remove('is-entering');
    void el.offsetWidth;
    el.classList.add('is-entering');
    _pageEnterTimer = setTimeout(() => el.classList.remove('is-entering'), 700);
}

function showPage(page) {
    const changed = currentPage !== page;
    currentPage = page;
    const el = document.getElementById(`page-${page}`);
    if (el) el.classList.add('active');
    // The mark and the page transition are both "you moved" signals, so they fire on a real
    // change only — re-rendering the page you are already on should not restart either.
    if (changed) { ovWakeBrandMark(); ovRouteProgress(); ovAnimatePageEnter(el); }
    // A fresh page load is not a "change" — currentPage is already the page being shown — so the
    // mark would never take its first sleep and the SMIL orbits would loop for the whole session.
    // Wake it once on arrival; the same timer puts it to sleep five seconds later.
    else if (!_brandEverWoken) ovWakeBrandMark();
    // One event for modules that react to the visible page (voice mini bar, floating chat…), instead
    // of each attaching MutationObservers to every section's class attribute.
    try { document.dispatchEvent(new CustomEvent('ov:page', { detail: { page, changed } })); } catch { /* */ }

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
    closeMobileNav();
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
    if (getComputedStyle(menu).position !== 'fixed') { menu.style.top = menu.style.left = menu.style.maxHeight = ''; return; }   // inside the mobile drawer it flows inline
    const rect = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const width = menu.offsetWidth || 200, pad = 8;
    // Keep the whole menu on screen: slide left when it would cross the right edge, cap its height to the space below.
    menu.style.left = `${Math.max(pad, Math.min(rect.left, vw - width - pad))}px`;
    menu.style.top = `${rect.bottom}px`;
    menu.style.maxHeight = `${Math.max(120, vh - rect.bottom - pad)}px`;
}

/** Close every navbar panel (used when the viewport changes under an open menu). */
function closeNavPanels() {
    document.getElementById('user-dropdown')?.classList.remove('show');
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
}
// A rotated phone, a resized window or an opened keyboard invalidates a fixed menu's position: reposition
// what is open, and close panels on orientation change. Escape closes them too.
{
    let raf = 0;
    const reflow = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => document.querySelectorAll('.nav-dropdown.open, .nav-dropdown:hover').forEach(positionNavDropdownMenu)); };
    window.addEventListener('resize', reflow, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', reflow, { passive: true });
    window.addEventListener('orientationchange', closeNavPanels, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNavPanels(); });
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

/* ── Channel Page (/:username) ────────────────────────────────── */
let currentChannelUsername = null; // is the current channel's user owner-rank?
let _activeChannelUserId = null;
let currentVodsPage = 1;
let currentVodsStreamerFilter = 'all';

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

function setVodsStreamerFilter(username = 'all') {
    const nextFilter = String(username || 'all').trim() || 'all';
    if (nextFilter === currentVodsStreamerFilter) return;
    currentVodsStreamerFilter = nextFilter;
    currentVodsPage = 1;
    loadVodsPage();
    const top = document.getElementById('page-vods');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Turn a UTC SQL timestamp ("YYYY-MM-DD HH:MM:SS") or ISO string into "x ago".
function _aiTimeAgo(ts) {
    if (!ts) return '';
    let s = String(ts);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    try { return (typeof timeAgo === 'function') ? timeAgo(s) : new Date(s).toLocaleString(); }
    catch { return ''; }
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

/* ── Stream Status Polling — auto-detect online/offline ──────── */
let _streamPollTimer = null;  // 2 seconds
const STREAM_POLL_FAST_WINDOW = 90000;   // burst for 90s, then fall back
let _streamPollFastUntil = 0;
// Whether the currently-scheduled interval was armed at the fast cadence, so we
// only tear the timer down and rebuild it when the cadence actually needs to change.
let _streamPollFast = false;

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
function _fmtCount(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); }

// ── Donation goal widget (top of chat, live + offline) ───────
let _goalWidget = { userId: null, goals: [], timer: null };
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
const GOAL_CYCLE_ROW_MS = 2600;
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

// Minimal, safe linkifier for already-HTML-escaped text.
function _linkify(escaped) {
    return String(escaped).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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

let uptimeInterval = null;

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

/* ── Profile (legacy, redirects to channel) ───────────────────── */
async function loadProfile(username) {
    username = username || (currentUser && currentUser.username);
    if (!username) return navigate('/');
    navigate(channelPath(username), true);
}

/* ── Utility ──────────────────────────────────────────────────── */
/**
 * Escape a string for interpolation into HTML.
 *
 * The previous implementation round-tripped through `div.textContent` → `innerHTML`, which does
 * NOT escape a double quote — and this function is used inside double-quoted attributes all over
 * this file (thumbnail `src`, `title`, `alt`). It only ever behaved safely because chat.js
 * happened to define a stricter `esc` that loaded later and overwrote it. That is not a safety
 * property, it is a coincidence of script order, and it would have disappeared the moment chat.js
 * stopped loading on every route.
 *
 * `?? ''` rather than `|| ''` so that esc(0) is "0" and not "".
 */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    // The old brand glyph as a placeholder → the OV mark (static, muted).
    const iconHtml = (extra) => fallbackIcon === 'fa-circle-nodes'
        ? `<span class="ov-mark ov-mark--ph" data-size="44" data-static="1"${extra || ''}></span>`
        : `<i class="fa-solid ${fallbackIcon}"${extra || ''}></i>`;
    if (thumbnailUrl) {
        return `<img src="${esc(thumbnailUrl)}" alt="${esc(alt || '')}" loading="lazy" data-regenerate-url="${esc(regenerateUrl || '')}" onerror="handleThumbnailError(this)">
                ${iconHtml(' style="display:none"')}`;
    }
    if (regenerateUrl) {
        // No thumbnail yet but we can try generating one — show icon and trigger generation
        return `<img src="" alt="${esc(alt || '')}" style="display:none" data-regenerate-url="${esc(regenerateUrl)}" data-regenerate-tried="" onerror="handleThumbnailError(this)">
                ${iconHtml()}`;
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
                    <input type="text" id="modal-cfgbtn-border" class="form-input form-input-sm" placeholder="var(--accent) or var(--accent)">
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
