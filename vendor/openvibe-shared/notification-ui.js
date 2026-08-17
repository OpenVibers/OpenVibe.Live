// ═══════════════════════════════════════════════════════════════
// OpenVibe — Notification UI Client
// Drop-in vanilla JS library for toast notifications, bell badge,
// notification panel, sounds, and real-time polling.
// Usage: <script src="https://openvibe.network/shared/notification-ui.js"></script>
//        OpenVibeNotifications.init({ token, apiBase, onAction })
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    const POLL_INTERVAL = 15_000; // 15s for unread count
    const TOAST_DURATION = { low: 0, normal: 3800, high: 6000, critical: 0 }; // 0 = sticky
    const MAX_TOASTS = 3;
    const SOUNDS = { normal: 'notification.mp3', high: 'notification-high.mp3', critical: 'notification-alarm.mp3' };

    let _config = { token: null, apiBase: 'https://openvibe.network', soundBase: '/assets/sounds', onAction: null };
    let _pollTimer = null;
    let _lastCheck = null;
    let _unreadCount = 0;
    let _toastContainer = null;
    let _panelEl = null;
    let _bellEl = null;
    let _audioCache = {};
    let _preferences = { enabled: true, sound: true, toasts: true, muted_categories: [] };

    // ── Styles (injected once) ───────────────────────────────
    function injectStyles() {
        if (document.getElementById('openvibe-notif-styles')) return;
        const style = document.createElement('style');
        style.id = 'openvibe-notif-styles';
        style.textContent = `
            @keyframes openvibe-toast-in { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes openvibe-toast-out { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
            @keyframes openvibe-badge-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }
            @keyframes openvibe-bell-ring { 0%{ transform: rotate(0); } 10%{ transform: rotate(14deg); } 20%{ transform: rotate(-14deg); } 30%{ transform: rotate(10deg); } 40%{ transform: rotate(-6deg); } 50%{ transform: rotate(0); } }
            @keyframes openvibe-slide-down { from { transform: translateY(-10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            @keyframes openvibe-fade-in { from { opacity: 0; } to { opacity: 1; } }

            .openvibe-toast-container {
                position: fixed; top: 82px; right: 14px; z-index: 100000;
                display: flex; flex-direction: column; gap: 6px;
                pointer-events: none; max-width: 320px; width: 100%;
            }
            .openvibe-toast {
                pointer-events: all;
                background: color-mix(in srgb, var(--bg-card, #22222c) 92%, transparent);
                border: 1px solid color-mix(in srgb, var(--border, #333340) 82%, transparent);
                border-radius: 10px; padding: 11px 12px; display: flex; gap: 10px; align-items: flex-start;
                box-shadow: 0 10px 24px rgba(0,0,0,0.28);
                animation: openvibe-toast-in .24s cubic-bezier(.34,1.56,.64,1);
                cursor: pointer; position: relative; overflow: hidden;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                color: var(--text-primary, #e0e0e0);
                transition: border-color .2s;
            }
            .openvibe-toast:hover { border-color: var(--accent, #8b5cf6); }
            .openvibe-toast.removing { animation: openvibe-toast-out .3s ease forwards; }
            .openvibe-toast-icon { font-size: 18px; flex-shrink: 0; line-height: 1; margin-top: 1px; }
            .openvibe-toast-body { flex: 1; min-width: 0; }
            .openvibe-toast-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
            .openvibe-toast-title .service-badge { font-size: 9px; padding: 1px 6px; border-radius: 3px; background: rgba(192,150,92,0.15); color: var(--accent-light, #a78bfa); font-weight: 500; }
            .openvibe-toast-msg { font-size: 11px; color: var(--text-secondary, #b0b0b8); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
            .openvibe-toast-close { position: absolute; top: 8px; right: 10px; background: none; border: none; color: var(--text-muted, #707080); cursor: pointer; font-size: 14px; padding: 2px; line-height: 1; }
            .openvibe-toast-close:hover { color: var(--text-primary, #e0e0e0); }
            .openvibe-toast-progress { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--accent, #8b5cf6); border-radius: 0 0 0 10px; }
            .openvibe-toast.priority-high { border-left: 3px solid var(--warning, #f39c12); }
            .openvibe-toast.priority-critical { border-left: 3px solid var(--live-red, #e74c3c); background: rgba(231,76,60,0.06); }
            .openvibe-toast-actions { display: flex; gap: 6px; margin-top: 8px; }
            .openvibe-toast-actions button { padding: 5px 12px; border-radius: 5px; border: 1px solid var(--border, #333340); background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s; }
            .openvibe-toast-actions button:hover { background: var(--accent-dark, #a07840); color: #fff; border-color: var(--accent-dark, #a07840); }
            .openvibe-toast-actions button.primary { background: var(--accent, #8b5cf6); color: #fff; border-color: var(--accent, #8b5cf6); }
            .openvibe-toast-user { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
            .openvibe-toast-user img { width: 24px; height: 24px; border-radius: 50%; }
            .openvibe-toast-user .username { font-weight: 600; font-size: 12px; cursor: pointer; }

            /* ── Bell ─────────────────────────────────────── */
            .openvibe-bell { position: relative; cursor: pointer; padding: 6px; display: inline-flex; align-items: center; justify-content: center; }
            .openvibe-bell svg { width: 22px; height: 22px; fill: var(--text-secondary, #b0b0b8); transition: fill .2s; }
            .openvibe-bell:hover svg { fill: var(--accent-light, #a78bfa); }
            .openvibe-bell .badge {
                position: absolute; top: 0; right: 0;
                min-width: 16px; height: 16px; padding: 0 4px;
                background: var(--live-red, #e74c3c); color: #fff;
                border-radius: 8px; font-size: 10px; font-weight: 700;
                display: flex; align-items: center; justify-content: center;
                line-height: 1; pointer-events: none;
                animation: openvibe-badge-pulse .4s ease;
            }
            .openvibe-bell .badge.hidden { display: none; }
            .openvibe-bell.ringing svg { animation: openvibe-bell-ring .6s ease; }

            /* ── Panel ────────────────────────────────────── */
            .openvibe-notif-panel {
                position: fixed; top: 62px; right: 16px;
                width: 380px; max-height: calc(100vh - 86px);
                background: var(--bg-secondary, #252530);
                border: 1px solid var(--border, #333340);
                border-radius: 12px;
                box-shadow: var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.5));
                z-index: 99999; display: none; flex-direction: column;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                color: var(--text-primary, #e0e0e0);
                animation: openvibe-slide-down .2s ease;
            }
            .openvibe-notif-panel.open { display: flex; }
            .openvibe-notif-panel-header {
                padding: 14px 16px; border-bottom: 1px solid var(--border, #333340);
                display: flex; align-items: center; justify-content: space-between;
            }
            .openvibe-notif-panel-header h3 { font-size: 15px; font-weight: 600; margin: 0; }
            .openvibe-notif-panel-header .actions { display: flex; gap: 8px; }
            .openvibe-notif-panel-header .actions button { background: none; border: none; color: var(--text-muted, #707080); cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; transition: all .15s; }
            .openvibe-notif-panel-header .actions button:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }
            .openvibe-notif-panel-tabs { display: flex; border-bottom: 1px solid var(--border, #333340); }
            .openvibe-notif-panel-tabs button { flex: 1; padding: 10px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #707080); font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s; }
            .openvibe-notif-panel-tabs button.active { color: var(--accent-light, #a78bfa); border-bottom-color: var(--accent, #8b5cf6); }
            .openvibe-notif-panel-list { flex: 1; overflow-y: auto; padding: 4px 0; }
            .openvibe-notif-item {
                padding: 12px 16px; display: flex; gap: 10px; align-items: flex-start;
                cursor: pointer; transition: background .15s; border-left: 3px solid transparent;
            }
            .openvibe-notif-item:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-notif-item.unread { background: rgba(192,150,92,0.04); border-left-color: var(--accent, #8b5cf6); }
            .openvibe-notif-item .icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
            .openvibe-notif-item .content { flex: 1; min-width: 0; }
            .openvibe-notif-item .content .title { font-size: 13px; font-weight: 500; margin-bottom: 2px; }
            .openvibe-notif-item .content .msg { font-size: 12px; color: var(--text-secondary, #b0b0b8); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .openvibe-notif-item .content .meta { font-size: 10px; color: var(--text-muted, #707080); margin-top: 4px; display: flex; gap: 8px; }
            .openvibe-notif-item .content .meta .service-tag { padding: 1px 5px; border-radius: 3px; background: var(--bg-tertiary, #2a2a38); font-weight: 500; }
            .openvibe-notif-panel-empty { text-align: center; padding: 48px 24px; color: var(--text-muted, #707080); }
            .openvibe-notif-panel-empty .icon { font-size: 36px; margin-bottom: 8px; display: block; opacity: .5; }

            @media (max-width: 440px) {
                .openvibe-toast-container { right: 8px; left: 8px; max-width: none; }
                .openvibe-notif-panel { right: 8px; left: 8px; width: auto; }
            }
        `;
        document.head.appendChild(style);
    }

    // ── Sound ────────────────────────────────────────────────
    function playSound(priority) {
        if (!_preferences.sound) return;
        const file = SOUNDS[priority];
        if (!file) return;
        const url = `${_config.soundBase}/${file}`;
        try {
            if (!_audioCache[url]) _audioCache[url] = new Audio(url);
            const audio = _audioCache[url];
            audio.currentTime = 0;
            audio.volume = priority === 'critical' ? 0.8 : 0.5;
            audio.play().catch(() => {});
        } catch {}
    }

    // ── Toast Container ──────────────────────────────────────
    function ensureToastContainer() {
        if (_toastContainer) return;
        _toastContainer = document.createElement('div');
        _toastContainer.className = 'openvibe-toast-container';
        document.body.appendChild(_toastContainer);
    }

    function showToast(notification) {
        if (!_preferences.toasts) return;
        if (_preferences.muted_categories.includes(notification.category)) return;
        ensureToastContainer();

        // Limit visible toasts
        while (_toastContainer.children.length >= MAX_TOASTS) {
            const oldest = _toastContainer.firstChild;
            oldest.remove();
        }

        const toast = document.createElement('div');
        toast.className = `openvibe-toast priority-${notification.priority}`;
        toast.dataset.notifId = notification.id;

        const rich = notification.richContent || {};
        let userHtml = '';
        if (rich.user) {
            const u = rich.user;
            const nameStyle = u.profile_color ? `color:${u.profile_color}` : '';
            const nameClass = u.name_effect ? `openvibe-name-fx-${u.name_effect}` : '';
            userHtml = `<div class="openvibe-toast-user">
                ${u.avatar_url ? `<img src="${u.avatar_url}" alt="">` : ''}
                <span class="username ${nameClass}" style="${nameStyle}">${u.display_name || u.username}</span>
            </div>`;
        }

        let actionsHtml = '';
        if (rich.actions && rich.actions.length) {
            actionsHtml = '<div class="openvibe-toast-actions">' +
                rich.actions.filter(a => a.type !== 'input').map(a =>
                    `<button data-action="${a.id}" class="${a.style === 'primary' ? 'primary' : ''}">${a.label}</button>`
                ).join('') + '</div>';
        }

        const serviceLabel = notification.service && notification.service !== 'network'
            ? `<span class="service-badge">${notification.service}</span>` : '';

        toast.innerHTML = `
            <div class="openvibe-toast-icon">${notification.icon || '🔔'}</div>
            <div class="openvibe-toast-body">
                ${userHtml}
                <div class="openvibe-toast-title">${notification.title}${serviceLabel}</div>
                <div class="openvibe-toast-msg">${notification.message}</div>
                ${actionsHtml}
            </div>
            <button class="openvibe-toast-close">&times;</button>
        `;

        // Progress bar for auto-dismiss
        const duration = TOAST_DURATION[notification.priority] || 5000;
        if (duration > 0) {
            const bar = document.createElement('div');
            bar.className = 'openvibe-toast-progress';
            bar.style.width = '100%';
            bar.style.transition = `width ${duration}ms linear`;
            toast.appendChild(bar);
            requestAnimationFrame(() => { bar.style.width = '0%'; });
        }

        // Events
        toast.querySelector('.openvibe-toast-close').addEventListener('click', e => {
            e.stopPropagation();
            dismissToast(toast);
        });

        toast.addEventListener('click', () => {
            if (rich.url) window.open(rich.url, '_blank');
            markRead(notification.id);
            dismissToast(toast);
        });

        // Action buttons
        toast.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const actionId = btn.dataset.action;
                const action = rich.actions.find(a => a.id === actionId);
                if (action?.url) { window.open(action.url, '_blank'); return; }
                if (_config.onAction) _config.onAction(notification.id, actionId, notification);
                dismissToast(toast);
            });
        });

        _toastContainer.appendChild(toast);

        // Auto dismiss
        if (duration > 0) {
            setTimeout(() => dismissToast(toast), duration);
        }
    }

    function dismissToast(el) {
        if (!el || !el.parentNode) return;
        el.classList.add('removing');
        setTimeout(() => el.remove(), 300);
    }

    // ── Bell / Badge ─────────────────────────────────────────
    function createBell() {
        const bell = document.createElement('div');
        bell.className = 'openvibe-bell';
        bell.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
            <span class="badge hidden">0</span>
        `;
        bell.addEventListener('click', () => togglePanel());
        _bellEl = bell;
        return bell;
    }

    function updateBadge(count) {
        _unreadCount = count;
        if (!_bellEl) return;
        const badge = _bellEl.querySelector('.badge');
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.classList.remove('hidden');
            _bellEl.classList.add('ringing');
            setTimeout(() => _bellEl.classList.remove('ringing'), 600);
        } else {
            badge.classList.add('hidden');
        }
    }

    // ── Panel ────────────────────────────────────────────────
    function createPanel() {
        const panel = document.createElement('div');
        panel.className = 'openvibe-notif-panel';
        panel.innerHTML = `
            <div class="openvibe-notif-panel-header">
                <h3>Notifications</h3>
                <div class="actions">
                    <button data-action="mark-all-read">Mark all read</button>
                    <button data-action="settings">⚙️</button>
                </div>
            </div>
            <div class="openvibe-notif-panel-tabs">
                <button class="active" data-tab="all">All</button>
                <button data-tab="unread">Unread</button>
                <button data-tab="social">Social</button>
                <button data-tab="game">Game</button>
                <button data-tab="system">System</button>
            </div>
            <div class="openvibe-notif-panel-list"></div>
        `;

        panel.querySelector('[data-action="mark-all-read"]').addEventListener('click', markAllRead);
        panel.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                panel.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                loadNotifications(btn.dataset.tab);
            });
        });

        document.addEventListener('click', e => {
            if (_panelEl?.classList.contains('open') && !_panelEl.contains(e.target) && !_bellEl?.contains(e.target)) {
                _panelEl.classList.remove('open');
            }
        });

        _panelEl = panel;
        document.body.appendChild(panel);
        return panel;
    }

    function togglePanel() {
        if (!_panelEl) createPanel();
        const opening = !_panelEl.classList.contains('open');
        _panelEl.classList.toggle('open');
        if (opening) loadNotifications('all');
    }

    async function loadNotifications(tab = 'all') {
        if (!_panelEl) return;
        const list = _panelEl.querySelector('.openvibe-notif-panel-list');
        list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">Loading...</div>';

        try {
            const params = new URLSearchParams({ limit: '50' });
            if (tab === 'unread') params.set('unread', '1');
            else if (tab !== 'all') params.set('category', tab);

            const res = await apiFetch(`/api/notifications?${params}`);
            const data = await res.json();

            if (!data.notifications || data.notifications.length === 0) {
                list.innerHTML = `<div class="openvibe-notif-panel-empty"><span class="icon">🔔</span>No notifications yet</div>`;
                return;
            }

            list.innerHTML = data.notifications.map(n => {
                // Render each item in isolation — one malformed notification must
                // never blank the whole dropdown ("Failed to load").
                try {
                    const ago = timeAgo(n.created_at);
                    const serviceTag = n.service && n.service !== 'network'
                        ? `<span class="service-tag">${esc(n.service)}</span>` : '';
                    return `<div class="openvibe-notif-item ${n.read ? '' : 'unread'}" data-id="${esc(n.id)}">
                        <span class="icon">${esc(n.icon || '🔔')}</span>
                        <div class="content">
                            <div class="title">${esc(n.title)}</div>
                            <div class="msg">${esc(n.message)}</div>
                            <div class="meta"><span>${esc(ago)}</span>${serviceTag}</div>
                        </div>
                    </div>`;
                } catch { return ''; }
            }).join('');

            list.querySelectorAll('.openvibe-notif-item').forEach(item => {
                item.addEventListener('click', () => {
                    const id = item.dataset.id;
                    markRead(id);
                    item.classList.remove('unread');
                    const notif = data.notifications.find(n => String(n.id) === id);
                    const rich = richOf(notif);
                    if (rich.url) window.open(rich.url, '_blank');
                });
            });
        } catch {
            list.innerHTML = '<div class="openvibe-notif-panel-empty"><span class="icon">⚠️</span>Failed to load</div>';
        }
    }

    // ── API Helpers ──────────────────────────────────────────
    function isCrossOrigin() {
        try { return new URL(_config.apiBase).origin !== window.location.origin; } catch { return false; }
    }

    function apiFetch(path, opts = {}) {
        const headers = { ...opts.headers };
        if (_config.token) headers['Authorization'] = `Bearer ${_config.token}`;
        const crossOrigin = isCrossOrigin();
        return fetch(`${_config.apiBase}${path}`, {
            ...opts,
            headers,
            // Only send credentials for same-origin requests; cross-origin uses Authorization header
            credentials: crossOrigin ? 'omit' : 'include',
        });
    }

    async function markRead(id) {
        try { await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
        _unreadCount = Math.max(0, _unreadCount - 1);
        updateBadge(_unreadCount);
    }

    async function markAllRead() {
        try { await apiFetch('/api/notifications/read-all', { method: 'POST' }); } catch {}
        updateBadge(0);
        if (_panelEl?.classList.contains('open')) {
            _panelEl.querySelectorAll('.openvibe-notif-item.unread').forEach(el => el.classList.remove('unread'));
        }
    }

    async function pollUnread() {
        try {
            const res = await apiFetch('/api/notifications/unread-count');
            const data = await res.json();
            const prev = _unreadCount;
            updateBadge(data.count || 0);

            // If new notifications arrived, fetch and toast the latest
            if (data.count > prev && _preferences.toasts) {
                const newest = await apiFetch(`/api/notifications?unread=1&limit=${data.count - prev}&since=${_lastCheck || ''}`);
                const nd = await newest.json();
                if (nd.notifications) {
                    for (const n of nd.notifications.slice(0, 3)) {
                        const rich = n.rich_content ? JSON.parse(n.rich_content) : {};
                        showToast({ ...n, richContent: rich });
                        playSound(n.priority);
                    }
                }
            }
            _lastCheck = new Date().toISOString();
        } catch {}
    }

    // ── Helpers ──────────────────────────────────────────────
    // Escape untrusted text before inserting into innerHTML. Notification
    // titles/messages can be attacker-controlled (e.g. abusive broadcasts), so
    // they must never be treated as HTML.
    function esc(v) {
        if (v == null) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // rich_content arrives already parsed from the API, but tolerate a raw JSON
    // string too. Never throw — a bad value just yields {}.
    function richOf(n) {
        const rc = n && n.rich_content;
        if (!rc) return {};
        if (typeof rc === 'object') return rc;
        try { return JSON.parse(rc) || {}; } catch { return {}; }
    }

    // ── Time Formatting ──────────────────────────────────────
    function timeAgo(dateStr) {
        const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return new Date(dateStr).toLocaleDateString();
    }

    // ── Public API ───────────────────────────────────────────
    const OpenVibeNotifications = {
        init(opts = {}) {
            Object.assign(_config, opts);
            injectStyles();
            if (opts.preferences) Object.assign(_preferences, opts.preferences);
            _lastCheck = new Date().toISOString();

            // Start polling
            pollUnread();
            _pollTimer = setInterval(pollUnread, POLL_INTERVAL);
        },

        destroy() {
            clearInterval(_pollTimer);
            _toastContainer?.remove();
            _panelEl?.remove();
            _toastContainer = null;
            _panelEl = null;
        },

        /** Create and inject the bell icon. Returns the DOM element. */
        createBell(container) {
            const bell = createBell();
            if (container) container.appendChild(bell);
            pollUnread();
            return bell;
        },

        /** Programmatically push a toast (for real-time WebSocket events). */
        push(notification) {
            showToast(notification);
            playSound(notification.priority);
            _unreadCount++;
            updateBadge(_unreadCount);
        },

        /** Update preferences at runtime. */
        setPreferences(prefs) {
            Object.assign(_preferences, prefs);
        },

        /** Update auth token (e.g., after account switch). */
        setToken(token) {
            _config.token = token;
            if (token) {
                pollUnread();
                if (!_pollTimer) _pollTimer = setInterval(pollUnread, POLL_INTERVAL);
            } else {
                clearInterval(_pollTimer);
                _pollTimer = null;
                updateBadge(0);
            }
        },

        /** Open/close the notification panel. */
        togglePanel,

        /** Get current unread count. */
        get unreadCount() { return _unreadCount; },
    };

    // Export
    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeNotifications;
    else root.OpenVibeNotifications = OpenVibeNotifications;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
