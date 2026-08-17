// ═══════════════════════════════════════════════════════════════
// OpenVibe — Account Switcher
// Google-style multi-account management with anonymous mode.
// Persists sessions in localStorage, coordinates with server
// for token swapping. Integrates with OpenVibeNavbar dropdown.
// Usage: OpenVibeAccountSwitcher.init({ apiBase, onSwitch })
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    const STORAGE_KEY = 'openvibe_accounts';
    const TOKEN_KEY = 'ov_token';
    const ACTIVE_KEY = 'openvibe_active_account';
    const ANON_KEY = 'openvibe_anon_token';
    const ANON_TOKENS_KEY = 'openvibe_anon_tokens'; // Map<anonId, sessionToken>
    const MAX_ACCOUNTS = 10;

    let _config = { apiBase: 'https://openvibe.network', onSwitch: null };
    let _panelEl = null;

    function isAnonId(id) {
        return String(id) === 'anon' || String(id).startsWith('anon_');
    }

    /** Store of session tokens per anon identity */
    function getAnonTokens() {
        try { return JSON.parse(localStorage.getItem(ANON_TOKENS_KEY) || '{}'); } catch { return {}; }
    }
    function saveAnonTokens(tokens) {
        localStorage.setItem(ANON_TOKENS_KEY, JSON.stringify(tokens));
    }
    function setAnonToken(anonId, token) {
        const tokens = getAnonTokens();
        tokens[anonId] = token;
        saveAnonTokens(tokens);
    }
    function getAnonToken(anonId) {
        return getAnonTokens()[anonId] || null;
    }
    function removeAnonToken(anonId) {
        const tokens = getAnonTokens();
        delete tokens[anonId];
        saveAnonTokens(tokens);
    }

    // Cookie policy (CONTRACTS.md): ov_token is host-only everywhere EXCEPT on
    // openvibe.tools + its subdomains, where a Domain=.openvibe.tools cookie is
    // shared across the tool satellites.
    function onToolsDomain() {
        const host = (typeof location !== 'undefined' && location.hostname) || '';
        return host === 'openvibe.tools' || host.endsWith('.openvibe.tools');
    }

    function clearAuthCookie() {
        document.cookie = 'ov_token=;path=/;max-age=0;SameSite=Lax';
        if (onToolsDomain()) {
            document.cookie = 'ov_token=;path=/;max-age=0;domain=.openvibe.tools;SameSite=Lax';
        }
    }

    function setAuthCookie(token) {
        const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? ';Secure' : '';
        if (onToolsDomain()) {
            document.cookie = `ov_token=${token};path=/;max-age=${60 * 60 * 24 * 30};domain=.openvibe.tools;SameSite=Lax;Secure`;
        } else {
            document.cookie = `ov_token=${token};path=/;max-age=${60 * 60 * 24 * 30};SameSite=Lax${secure}`;
        }
    }

    function normalizeAccount(user, token) {
        const isAnon = !!user?.is_anon || isAnonId(user?.id);
        const anonNum = user.anon_number || null;
        // Each anon gets a unique ID based on its anon_number
        const id = isAnon ? (anonNum ? `anon_${anonNum}` : 'anon') : user.id;
        return {
            id,
            username: user.username,
            display_name: user.display_name || user.username,
            avatar_url: user.avatar_url || null,
            email: user.email || null,
            is_anon: isAnon,
            anon_number: anonNum,
            token,
            added_at: Date.now(),
        };
    }

    function getAnonAccount(id) {
        if (id) return getAccounts().find(a => a && a.is_anon && String(a.id) === String(id)) || null;
        return getAccounts().find(a => a && a.is_anon) || null;
    }

    function getAnonAccounts() {
        return getAccounts().filter(a => a && a.is_anon);
    }

    // ─── Account Store ─────────────────────────────────────────
    function getAccounts() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
    }

    function saveAccounts(accounts) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
    }

    function getActiveId() {
        return localStorage.getItem(ACTIVE_KEY);
    }

    function setActiveId(id) {
        localStorage.setItem(ACTIVE_KEY, id);
    }

    function addAccount(user, token) {
        const accounts = getAccounts();
        const entry = normalizeAccount(user, token);
        const existing = accounts.findIndex(a => String(a.id) === String(entry.id));
        if (existing !== -1) {
            accounts[existing] = entry;
        } else {
            if (accounts.length >= MAX_ACCOUNTS) {
                accounts.shift(); // Remove oldest
            }
            accounts.push(entry);
        }
        saveAccounts(accounts);
        return accounts;
    }

    function removeAccount(id) {
        const targetId = String(id);
        const accounts = getAccounts().filter(a => String(a.id) !== targetId);
        saveAccounts(accounts);
        // Clean up anon token if removing an anon identity
        if (isAnonId(targetId)) removeAnonToken(targetId);
        if (getActiveId() === targetId) {
            const fallback = accounts.find(a => !a.is_anon) || accounts[0];
            if (fallback) switchTo(fallback.id);
            else logout();
        }
        return accounts;
    }

    /** Read ov_token from the cookie (host-only; Domain=.openvibe.tools on tools hosts) */
    function getCookieToken() {
        const m = document.cookie.match(/(?:^|; )ov_token=([^;]*)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // ─── API ───────────────────────────────────────────────────
    async function apiFetch(path, opts = {}) {
        const token = localStorage.getItem(TOKEN_KEY) || getCookieToken();
        const headers = { 'Content-Type': 'application/json', ...opts.headers };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${_config.apiBase}${path}`, { ...opts, headers, credentials: 'include' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
    }

    async function switchTo(accountId) {
        if (isAnonId(accountId)) return switchToAnon(accountId);

        const accounts = getAccounts();
        const target = accounts.find(a => String(a.id) === String(accountId));
        if (target?.is_anon) return switchToAnon(accountId);
        if (!target || !target.token) {
            // Token expired — need re-login
            window.location.href = `${_config.apiBase}/login?switch_to=${accountId}&return=${encodeURIComponent(window.location.href)}`;
            return;
        }

        // Validate token is still good
        try {
            const headers = { Authorization: `Bearer ${target.token}` };
            const res = await fetch(`${_config.apiBase}/api/auth/me`, { headers });
            if (!res.ok) throw new Error('Token invalid');
        } catch {
            // Token expired
            removeAccount(target.id);
            window.location.href = `${_config.apiBase}/login?switch_to=${accountId}&return=${encodeURIComponent(window.location.href)}`;
            return;
        }

        localStorage.setItem(TOKEN_KEY, target.token);
        setActiveId(target.id);
        setAuthCookie(target.token);

        if (_config.onSwitch) _config.onSwitch(target);
        else window.location.reload();
    }

    /**
     * Switch to an anonymous identity. If anonId is provided, switch to that
     * specific anon. Otherwise use the most recently active or create a new one.
     */
    async function switchToAnon(anonId) {
        async function fetchAnonUser(token) {
            const res = await fetch(`${_config.apiBase}/api/auth/anon/${encodeURIComponent(token)}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Anon session invalid');
            const data = await res.json();
            return data.user || null;
        }

        let anonToken = null;
        let anonUser = null;

        // If switching to a specific anon identity, look up its token
        if (anonId && anonId !== 'anon') {
            anonToken = getAnonToken(anonId);
        }

        // Fallback to legacy single-anon token
        if (!anonToken) {
            anonToken = localStorage.getItem(ANON_KEY);
        }

        // Try to validate the existing token
        if (anonToken) {
            try {
                anonUser = await fetchAnonUser(anonToken);
            } catch {
                // Token invalid — clear it
                if (anonId) removeAnonToken(anonId);
                localStorage.removeItem(ANON_KEY);
                anonToken = null;
            }
        }

        // Create new anon session if we don't have a valid one
        if (!anonToken) {
            try {
                const data = await fetch(`${_config.apiBase}/api/auth/anon-session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                    credentials: 'include',
                }).then(async (res) => {
                    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                    return res.json();
                });
                anonToken = data.token;
                anonUser = data.user || null;
            } catch (err) {
                console.error('[OpenVibeAccountSwitcher] Failed to create anon session:', err);
                return;
            }
        }

        if (!anonUser) {
            try {
                anonUser = await fetchAnonUser(anonToken);
            } catch (err) {
                console.error('[OpenVibeAccountSwitcher] Failed to load anon session:', err);
                return;
            }
        }

        // Store the anon account and its token
        if (anonUser) {
            const entry = addAccount(anonUser, anonToken);
            const realId = anonUser.anon_number ? `anon_${anonUser.anon_number}` : 'anon';
            setAnonToken(realId, anonToken);
            // Also keep legacy key for backward compat
            localStorage.setItem(ANON_KEY, anonToken);

            localStorage.removeItem(TOKEN_KEY);
            setActiveId(realId);
            clearAuthCookie();

            if (_config.onSwitch) _config.onSwitch(getAnonAccount(realId) || { id: realId, is_anon: true, anon_number: anonUser.anon_number || null });
            else window.location.reload();
        }
    }

    /**
     * Create a brand-new anonymous identity (even if one already exists).
     * Useful for the "New Anon Identity" button.
     */
    async function createNewAnon() {
        try {
            const data = await fetch(`${_config.apiBase}/api/auth/anon-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force_new: true }),
                credentials: 'include',
            }).then(async (res) => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                return res.json();
            });
            const anonToken = data.token;
            const anonUser = data.user;
            if (!anonUser) throw new Error('No user returned');

            const entry = addAccount(anonUser, anonToken);
            const realId = anonUser.anon_number ? `anon_${anonUser.anon_number}` : 'anon';
            setAnonToken(realId, anonToken);

            localStorage.removeItem(TOKEN_KEY);
            localStorage.setItem(ANON_KEY, anonToken);
            setActiveId(realId);
            clearAuthCookie();

            if (_config.onSwitch) _config.onSwitch(getAnonAccount(realId) || { id: realId, is_anon: true, anon_number: anonUser.anon_number });
            else window.location.reload();
        } catch (err) {
            console.error('[OpenVibeAccountSwitcher] Failed to create new anon:', err);
        }
    }

    function logout() {
        const activeId = getActiveId();
        if (activeId) removeAccount(activeId);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(ACTIVE_KEY);
        clearAuthCookie();
        if (_config.onSwitch) _config.onSwitch(null);
        else window.location.reload();
    }

    function logoutAll() {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(ACTIVE_KEY);
        localStorage.removeItem(ANON_KEY);
        localStorage.removeItem(ANON_TOKENS_KEY);
        clearAuthCookie();
        if (_config.onSwitch) _config.onSwitch(null);
        else window.location.reload();
    }

    // ─── Switcher Panel UI ─────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('openvibe-switcher-styles')) return;
        const s = document.createElement('style');
        s.id = 'openvibe-switcher-styles';
        s.textContent = `
            .openvibe-switcher-overlay {
                position: fixed; inset: 0; z-index: 20000;
                background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
                display: flex; align-items: center; justify-content: center;
                animation: openvibe-sw-fadein .2s ease;
            }
            @keyframes openvibe-sw-fadein { from { opacity: 0; } to { opacity: 1; } }

            .openvibe-switcher-panel {
                width: 380px; max-height: 520px;
                background: var(--bg-card, #22222c);
                border: 1px solid var(--border, #333340); border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.6);
                overflow: hidden; animation: openvibe-sw-pop .25s cubic-bezier(.34,1.56,.64,1);
            }
            @keyframes openvibe-sw-pop { from { transform: scale(.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }

            .openvibe-switcher-header {
                text-align: center; padding: 20px 16px 12px;
                border-bottom: 1px solid var(--border, #333340);
            }
            .openvibe-switcher-header h3 { margin: 0 0 4px; font-size: 16px; font-weight: 700; color: var(--text-primary, #e0e0e0); }
            .openvibe-switcher-header p { margin: 0; font-size: 12px; color: var(--text-muted, #707080); }

            .openvibe-switcher-list { padding: 8px; max-height: 300px; overflow-y: auto; }

            .openvibe-switcher-item {
                display: flex; align-items: center; gap: 12px; padding: 10px 12px;
                border-radius: 10px; cursor: pointer; transition: background .15s;
                position: relative;
            }
            .openvibe-switcher-item:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-switcher-item.active { background: rgba(192,150,92,0.08); }
            .openvibe-switcher-item.active::after {
                content: '✓'; position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
                color: var(--accent, #8b5cf6); font-weight: 700; font-size: 16px;
            }
            .openvibe-switcher-item img { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
            .openvibe-switcher-item .info { flex: 1; line-height: 1.3; }
            .openvibe-switcher-item .info .name { font-size: 14px; font-weight: 600; color: var(--text-primary, #e0e0e0); }
            .openvibe-switcher-item .info .sub { font-size: 11px; color: var(--text-muted, #707080); }
            .openvibe-switcher-item .remove {
                opacity: 0; font-size: 14px; color: var(--live-red, #e74c3c);
                cursor: pointer; padding: 4px 6px; border-radius: 4px;
                transition: opacity .15s, background .15s;
            }
            .openvibe-switcher-item:hover .remove { opacity: .6; }
            .openvibe-switcher-item .remove:hover { opacity: 1; background: rgba(231,76,60,0.1); }

            .openvibe-switcher-anon {
                display: flex; align-items: center; gap: 12px; padding: 10px 12px;
                margin: 0 8px 8px; border-radius: 10px; cursor: pointer;
                border: 1px dashed var(--border, #333340);
                transition: all .15s; color: var(--text-muted, #707080);
            }
            .openvibe-switcher-anon:hover { background: var(--bg-hover, #2f2f3d); border-color: var(--accent-dark, #a07840); }
            .openvibe-switcher-anon .anon-icon { font-size: 22px; width: 40px; text-align: center; }

            .openvibe-switcher-actions {
                padding: 8px 12px; border-top: 1px solid var(--border, #333340);
                display: flex; gap: 8px; justify-content: center;
            }
            .openvibe-switcher-actions button {
                flex: 1; padding: 8px; border: none; border-radius: 8px;
                font-size: 12px; font-weight: 600; cursor: pointer;
                transition: all .15s;
            }
            .openvibe-switcher-actions .btn-add {
                background: var(--accent, #8b5cf6); color: #fff;
            }
            .openvibe-switcher-actions .btn-add:hover { background: var(--accent-dark, #a07840); }
            .openvibe-switcher-actions .btn-signout {
                background: rgba(231,76,60,0.1); color: var(--live-red, #e74c3c);
            }
            .openvibe-switcher-actions .btn-signout:hover { background: rgba(231,76,60,0.2); }
        `;
        document.head.appendChild(s);
    }

    function showPanel() {
        if (_panelEl) return;
        injectStyles();

        const accounts = getAccounts();
        const activeId = getActiveId();
        const isAnonActive = isAnonId(activeId);
        const loggedAccounts = accounts.filter(a => !a.is_anon);
        const anonAccounts = accounts.filter(a => a.is_anon);

        const overlay = document.createElement('div');
        overlay.className = 'openvibe-switcher-overlay';
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closePanel();
        });

        const panel = document.createElement('div');
        panel.className = 'openvibe-switcher-panel';

        panel.innerHTML = `
            <div class="openvibe-switcher-header">
                <h3>\uD83D\uDD25 Switch Account</h3>
                <p>Choose an account or browse anonymously</p>
            </div>
            <div class="openvibe-switcher-list">
                ${loggedAccounts.map(a => `
                    <div class="openvibe-switcher-item ${String(a.id) === String(activeId) ? 'active' : ''}" data-id="${a.id}">
                        <img src="${a.avatar_url || '/data/avatars/default.png'}" alt="">
                        <div class="info">
                            <div class="name">${a.display_name || a.username}</div>
                            <div class="sub">${a.email || `@${a.username}`}</div>
                        </div>
                        ${String(a.id) !== String(activeId) ? `<span class="remove" data-remove-id="${a.id}" title="Remove account">\u2715</span>` : ''}
                    </div>
                `).join('')}

                ${anonAccounts.length > 0 ? `
                    <div style="padding:6px 12px 2px;font-size:11px;font-weight:600;color:var(--text-muted,#707080);text-transform:uppercase;letter-spacing:0.05em;">Anonymous Identities</div>
                    ${anonAccounts.map(a => `
                        <div class="openvibe-switcher-item ${String(a.id) === String(activeId) ? 'active' : ''}" data-id="${a.id}">
                            <span style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:20px;border-radius:50%;background:var(--bg-secondary,#1a1a26);flex-shrink:0;">\uD83E\uDEE5</span>
                            <div class="info">
                                <div class="name">Anonymous #${a.anon_number || '?'}</div>
                                <div class="sub">anon_${a.anon_number || '?'}</div>
                            </div>
                            ${String(a.id) !== String(activeId) ? `<span class="remove" data-remove-id="${a.id}" title="Remove identity">\u2715</span>` : ''}
                        </div>
                    `).join('')}
                ` : ''}
            </div>
            <div class="openvibe-switcher-anon" id="openvibe-sw-new-anon">
                <span class="anon-icon">+</span>
                <div class="info">
                    <div class="name" style="color:var(--text-primary,#e0e0e0)">${anonAccounts.length > 0 ? 'New Anon Identity' : 'Go Anonymous'}</div>
                    <div class="sub">${anonAccounts.length > 0 ? 'Create another anonymous identity' : 'Browse without an account \u00b7 Limited features'}</div>
                </div>
            </div>
            <div class="openvibe-switcher-actions">
                <button class="btn-add" id="openvibe-sw-add">+ Add Account</button>
                <button class="btn-signout" id="openvibe-sw-signout">Sign Out All</button>
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        _panelEl = overlay;

        // Wire events
        panel.querySelectorAll('.openvibe-switcher-item[data-id]').forEach(el => {
            el.addEventListener('click', e => {
                if (e.target.closest('.remove')) return;
                switchTo(el.dataset.id);
                closePanel();
            });
        });

        panel.querySelectorAll('[data-remove-id]').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                removeAccount(el.dataset.removeId);
                closePanel();
                showPanel(); // Re-render
            });
        });

        panel.querySelector('#openvibe-sw-new-anon').addEventListener('click', () => {
            if (anonAccounts.length > 0) {
                createNewAnon();
            } else {
                switchToAnon();
            }
            closePanel();
        });

        panel.querySelector('#openvibe-sw-add').addEventListener('click', () => {
            window.location.href = `${_config.apiBase}/login?add_account=1&return=${encodeURIComponent(window.location.href)}`;
        });

        panel.querySelector('#openvibe-sw-signout').addEventListener('click', () => {
            logoutAll();
            closePanel();
        });

        // Esc to close
        const escHandler = e => { if (e.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', escHandler);
        overlay._escHandler = escHandler;
    }

    function closePanel() {
        if (!_panelEl) return;
        document.removeEventListener('keydown', _panelEl._escHandler);
        _panelEl.remove();
        _panelEl = null;
    }

    // ─── Token Refresh ───────────────────────────────────────────
    // Decode JWT payload without verification (client-side can't verify RS256).
    // Used only to check `exp` claim for proactive refresh.
    function decodeJwtPayload(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(payload));
        } catch { return null; }
    }

    let _refreshTimer = null;
    let _refreshInProgress = false;

    /**
     * Silently refresh the JWT if it expires within the next 2 hours,
     * or if it has already expired (7-day grace period on the server).
     * Updates localStorage, cookie, and account list.
     */
    async function silentRefresh() {
        if (_refreshInProgress) return;
        const token = localStorage.getItem(TOKEN_KEY) || getCookieToken();
        if (!token) return;
        const payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) return;

        const expiresAt = payload.exp * 1000;
        const now = Date.now();
        const twoHours = 2 * 60 * 60 * 1000;

        // Only refresh if token expires within 2 hours or is already expired
        if (expiresAt - now > twoHours) return;

        _refreshInProgress = true;
        try {
            const res = await fetch(`${_config.apiBase}/api/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                credentials: 'include',
            });
            if (!res.ok) {
                // If refresh fails with 401, token is truly dead — don't retry
                if (res.status === 401) {
                    console.warn('[OpenVibeAuth] Token refresh failed — session expired');
                }
                return;
            }
            const data = await res.json();
            if (data.token) {
                // Update localStorage
                localStorage.setItem(TOKEN_KEY, data.token);
                // Update cookie
                setAuthCookie(data.token);
                // Update the stored account entry
                const activeId = getActiveId();
                if (activeId && !isAnonId(activeId)) {
                    const accounts = getAccounts();
                    const idx = accounts.findIndex(a => String(a.id) === String(activeId));
                    if (idx !== -1) {
                        accounts[idx].token = data.token;
                        saveAccounts(accounts);
                    }
                }
                console.log('[OpenVibeAuth] Token refreshed silently');
            }
        } catch (err) {
            console.warn('[OpenVibeAuth] Silent refresh error:', err.message);
        } finally {
            _refreshInProgress = false;
        }
    }

    /**
     * Start a periodic timer that checks token expiry and refreshes when needed.
     * Checks every 15 minutes. Also runs an immediate check.
     */
    function startRefreshTimer() {
        if (_refreshTimer) return;
        silentRefresh(); // Immediate check
        _refreshTimer = setInterval(silentRefresh, 15 * 60 * 1000); // Every 15 min
    }

    function stopRefreshTimer() {
        if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    }

    // ─── Listen for navbar events ──────────────────────────────
    document.addEventListener('openvibe-switch-account', e => {
        switchTo(e.detail.accountId);
    });

    // ─── Public API ────────────────────────────────────────────
    const OpenVibeAccountSwitcher = {
        init(opts = {}) {
            Object.assign(_config, opts);
            // Start silent token refresh for logged-in users
            const activeId = getActiveId();
            if (activeId && !isAnonId(activeId)) {
                startRefreshTimer();
            }
        },

        /** Call after login success to store this account. */
        addAccount,
        removeAccount,
        getAccounts,
        getActiveId,
        switchTo,
        switchToAnon,
        createNewAnon,
        getAnonAccounts,
        logout,
        logoutAll,
        silentRefresh,
        startRefreshTimer,
        stopRefreshTimer,

        /** Show the full-screen account switcher panel. */
        showPanel,
        closePanel,

        /** Quick check: is user on an anonymous session? */
        isAnonymous() {
            const id = getActiveId();
            return isAnonId(id);
        },

        /** Get the current active account object. */
        getActive() {
            const id = getActiveId();
            if (!id) return null;
            if (isAnonId(id)) return getAnonAccount(id) || getAnonAccount() || null;
            return getAccounts().find(a => String(a.id) === String(id)) || null;
        },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeAccountSwitcher;
    else root.OpenVibeAccountSwitcher = OpenVibeAccountSwitcher;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
