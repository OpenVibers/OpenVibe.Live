// ═══════════════════════════════════════════════════════════════
// OpenVibe — Notification UI Client (shared across every OpenVibe site)
//
// One store (openvibe.network) → one bell everywhere. This file renders the bell +
// dropdown panel, toasts, a full-page inbox, and handles Web Push subscription.
//
// Usage: <script src="https://openvibe.network/shared/notification-ui.js"></script>
//        OpenVibeNotifications.init({ token, apiBase, swPath, onAction })
//        OpenVibeNotifications.createBell(mountEl)
//        OpenVibeNotifications.renderInbox(containerEl)      // full-page inbox
//
// Reads: GET /api/notifications?limit&offset&unread_only&category&q&since
//        GET /api/notifications/unread-count
// Writes: POST /:id/read, /read-batch, /read-all, /:id/dismiss, /api/push/{subscribe,unsubscribe}
// ═══════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    const POLL_INTERVAL = 15_000;
    const PAGE_SIZE = 30;
    const TOAST_DURATION = { low: 0, normal: 4200, high: 6500, critical: 0 }; // 0 = sticky
    const MAX_TOASTS = 3;
    const SOUNDS = { normal: 'notification.mp3', high: 'notification-high.mp3', critical: 'notification-alarm.mp3' };
    const CATEGORY_LABELS = {
        social: 'Social', chat: 'Chat', game: 'Game', stream: 'Streams', economy: 'Economy',
        achievement: 'Achievements', moderation: 'Moderation', system: 'System', service: 'Services', admin: 'Announcements',
    };
    const SERVICE_LABELS = { live: 'Live', tools: 'Tools', games: 'Games', media: 'Media', network: 'Network' };

    let _config = { token: null, apiBase: 'https://openvibe.network', soundBase: '/assets/sounds', swPath: '/openvibe-sw.js', onAction: null, inboxUrl: null };
    let _pollTimer = null;
    let _lastSeenAt = null;       // newest created_at we have toasted / seen
    let _unreadCount = 0;
    let _toastContainer = null;
    let _panelEl = null;
    let _bellEl = null;
    let _audioCache = {};
    let _preferences = { enabled: true, sound: true, toasts: true, muted_categories: [] };
    let _channel = null;          // BroadcastChannel for same-origin tab sync
    const _views = new Map();     // container → view state (panel + inboxes)

    // ── Styles ──────────────────────────────────────────────
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
            @keyframes openvibe-spin { to { transform: rotate(360deg); } }

            .openvibe-toast-container { position: fixed; top: 82px; right: 14px; z-index: 100000; display: flex; flex-direction: column; gap: 6px; pointer-events: none; max-width: 340px; width: 100%; }
            .openvibe-toast { pointer-events: all; background: color-mix(in srgb, var(--bg-card, #22222c) 94%, transparent); border: 1px solid color-mix(in srgb, var(--border, #333340) 82%, transparent); border-radius: 10px; padding: 11px 12px; display: flex; gap: 10px; align-items: flex-start; box-shadow: 0 10px 24px rgba(0,0,0,0.28); animation: openvibe-toast-in .24s cubic-bezier(.34,1.56,.64,1); cursor: pointer; position: relative; overflow: hidden; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text-primary, #e0e0e0); transition: border-color .2s; }
            .openvibe-toast:hover { border-color: var(--accent, #8b5cf6); }
            .openvibe-toast.removing { animation: openvibe-toast-out .3s ease forwards; }
            .openvibe-toast-icon { font-size: 18px; flex-shrink: 0; line-height: 1; margin-top: 1px; }
            .openvibe-toast-icon img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: block; }
            .openvibe-toast-body { flex: 1; min-width: 0; }
            .openvibe-toast-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
            .openvibe-toast-title .service-badge { font-size: 9px; padding: 1px 6px; border-radius: 3px; background: color-mix(in srgb, var(--accent, #8b5cf6) 18%, transparent); color: var(--accent-light, #a78bfa); font-weight: 500; }
            .openvibe-toast-msg { font-size: 11px; color: var(--text-secondary, #b0b0b8); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
            .openvibe-toast-close { position: absolute; top: 8px; right: 10px; background: none; border: none; color: var(--text-muted, #707080); cursor: pointer; font-size: 14px; padding: 2px; line-height: 1; }
            .openvibe-toast-close:hover { color: var(--text-primary, #e0e0e0); }
            .openvibe-toast-progress { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--accent, #8b5cf6); }
            .openvibe-toast.priority-high { border-left: 3px solid var(--warning, #f39c12); }
            .openvibe-toast.priority-critical { border-left: 3px solid var(--live-red, #e74c3c); background: rgba(231,76,60,0.06); }
            .openvibe-toast-actions { display: flex; gap: 6px; margin-top: 8px; }
            .openvibe-toast-actions button { padding: 5px 12px; border-radius: 5px; border: 1px solid var(--border, #333340); background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); font-size: 11px; font-weight: 600; cursor: pointer; }
            .openvibe-toast-actions button.primary { background: var(--accent, #8b5cf6); color: #fff; border-color: var(--accent, #8b5cf6); }

            .openvibe-bell { position: relative; cursor: pointer; padding: 6px; display: inline-flex; align-items: center; justify-content: center; }
            .openvibe-bell svg { width: 22px; height: 22px; fill: var(--text-secondary, #b0b0b8); transition: fill .2s; }
            .openvibe-bell:hover svg, .openvibe-bell.open svg { fill: var(--accent-light, #a78bfa); }
            .openvibe-bell .badge { position: absolute; top: 0; right: 0; min-width: 16px; height: 16px; padding: 0 4px; background: var(--live-red, #e74c3c); color: #fff; border-radius: 8px; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1; pointer-events: none; animation: openvibe-badge-pulse .4s ease; }
            .openvibe-bell .badge.hidden { display: none; }
            .openvibe-bell.ringing svg { animation: openvibe-bell-ring .6s ease; }

            .openvibe-notif-panel { position: fixed; top: 62px; right: 16px; width: 400px; max-height: calc(100vh - 86px); background: var(--bg-secondary, #252530); border: 1px solid var(--border, #333340); border-radius: 12px; box-shadow: var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.5)); z-index: 99999; display: none; flex-direction: column; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text-primary, #e0e0e0); animation: openvibe-slide-down .2s ease; overflow: hidden; }
            .openvibe-notif-panel.open { display: flex; }
            .openvibe-notif-inbox { display: flex; flex-direction: column; background: var(--bg-secondary, #252530); border: 1px solid var(--border, #333340); border-radius: 12px; overflow: hidden; color: var(--text-primary, #e0e0e0); font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; min-height: 420px; max-height: 78vh; }

            .openvibe-nv-head { padding: 12px 14px; border-bottom: 1px solid var(--border, #333340); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .openvibe-nv-head h3 { font-size: 15px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
            .openvibe-nv-head h3 .count { font-size: 11px; font-weight: 600; background: var(--live-red, #e74c3c); color: #fff; border-radius: 9px; padding: 1px 7px; }
            .openvibe-nv-head h3 .count.zero { display: none; }
            .openvibe-nv-actions { display: flex; gap: 4px; align-items: center; }
            .openvibe-nv-actions button, .openvibe-nv-actions a { background: none; border: 1px solid transparent; color: var(--text-muted, #707080); cursor: pointer; font-size: 12px; padding: 5px 8px; border-radius: 6px; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; line-height: 1; }
            .openvibe-nv-actions button:hover, .openvibe-nv-actions a:hover { background: var(--bg-hover, #2f2f3d); color: var(--text-primary, #e0e0e0); }
            .openvibe-nv-actions button.on { color: var(--accent-light, #a78bfa); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 40%, transparent); }
            .openvibe-nv-actions button:disabled { opacity: .45; cursor: default; }
            .openvibe-nv-actions svg { width: 14px; height: 14px; fill: currentColor; }

            .openvibe-nv-tools { padding: 8px 12px; border-bottom: 1px solid var(--border, #333340); display: flex; flex-direction: column; gap: 8px; }
            .openvibe-nv-search { position: relative; }
            .openvibe-nv-search input { width: 100%; box-sizing: border-box; padding: 7px 28px 7px 30px; border-radius: 8px; border: 1px solid var(--border, #333340); background: var(--bg-input, var(--bg-tertiary, #1e1e28)); color: var(--text-primary, #e0e0e0); font-size: 12px; outline: none; }
            .openvibe-nv-search input:focus { border-color: var(--accent, #8b5cf6); }
            .openvibe-nv-search svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; fill: var(--text-muted, #707080); pointer-events: none; }
            .openvibe-nv-search .clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-muted, #707080); cursor: pointer; font-size: 14px; display: none; }
            .openvibe-nv-search.has-q .clear { display: block; }
            .openvibe-nv-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
            .openvibe-nv-chips button { border: 1px solid var(--border, #333340); background: transparent; color: var(--text-secondary, #b0b0b8); font-size: 11px; padding: 4px 10px; border-radius: 999px; cursor: pointer; line-height: 1.2; }
            .openvibe-nv-chips button:hover { border-color: var(--accent, #8b5cf6); color: var(--text-primary, #e0e0e0); }
            .openvibe-nv-chips button.active { background: color-mix(in srgb, var(--accent, #8b5cf6) 18%, transparent); border-color: var(--accent, #8b5cf6); color: var(--accent-light, #a78bfa); }
            .openvibe-nv-chips select { margin-left: auto; border: 1px solid var(--border, #333340); background: var(--bg-input, var(--bg-tertiary, #1e1e28)); color: var(--text-secondary, #b0b0b8); font-size: 11px; padding: 4px 8px; border-radius: 8px; cursor: pointer; }

            .openvibe-nv-list { flex: 1; overflow-y: auto; padding: 4px 0; overscroll-behavior: contain; }
            .openvibe-notif-item { padding: 10px 12px 10px 14px; display: flex; gap: 10px; align-items: flex-start; cursor: pointer; transition: background .15s; border-left: 3px solid transparent; position: relative; }
            .openvibe-notif-item:hover { background: var(--bg-hover, #2f2f3d); }
            .openvibe-notif-item.unread { background: color-mix(in srgb, var(--accent, #8b5cf6) 7%, transparent); border-left-color: var(--accent, #8b5cf6); }
            .openvibe-notif-item .icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; width: 32px; text-align: center; }
            .openvibe-notif-item .icon img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: block; }
            .openvibe-notif-item .content { flex: 1; min-width: 0; }
            .openvibe-notif-item .title { font-size: 13px; font-weight: 500; margin-bottom: 2px; padding-right: 18px; }
            .openvibe-notif-item.unread .title { font-weight: 650; }
            .openvibe-notif-item .msg { font-size: 12px; color: var(--text-secondary, #b0b0b8); line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
            .openvibe-notif-item .meta { font-size: 10px; color: var(--text-muted, #707080); margin-top: 4px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
            .openvibe-notif-item .meta .tag { padding: 1px 5px; border-radius: 3px; background: var(--bg-tertiary, #2a2a38); font-weight: 500; }
            .openvibe-notif-item .dismiss { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--text-muted, #707080); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity .15s; }
            .openvibe-notif-item:hover .dismiss { opacity: 1; }
            .openvibe-notif-item .dismiss:hover { color: var(--live-red, #e74c3c); background: var(--bg-tertiary, #2a2a38); }
            .openvibe-nv-empty { text-align: center; padding: 44px 24px; color: var(--text-muted, #707080); font-size: 13px; }
            .openvibe-nv-empty .icon { font-size: 34px; margin-bottom: 8px; display: block; opacity: .5; }
            .openvibe-nv-more { display: flex; justify-content: center; padding: 10px; }
            .openvibe-nv-more button { border: 1px solid var(--border, #333340); background: transparent; color: var(--text-secondary, #b0b0b8); font-size: 12px; padding: 6px 14px; border-radius: 8px; cursor: pointer; }
            .openvibe-nv-more .spinner { width: 16px; height: 16px; border: 2px solid var(--border, #333340); border-top-color: var(--accent, #8b5cf6); border-radius: 50%; animation: openvibe-spin .8s linear infinite; }
            .openvibe-nv-foot { padding: 8px 12px; border-top: 1px solid var(--border, #333340); font-size: 11px; color: var(--text-muted, #707080); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
            .openvibe-nv-foot a { color: var(--accent-light, #a78bfa); text-decoration: none; }
            .openvibe-nv-note { font-size: 11px; color: var(--text-muted, #707080); padding: 6px 12px; background: color-mix(in srgb, var(--warning, #f39c12) 10%, transparent); border-bottom: 1px solid var(--border, #333340); }

            @media (max-width: 460px) {
                .openvibe-toast-container { right: 8px; left: 8px; max-width: none; }
                .openvibe-notif-panel { right: 6px; left: 6px; width: auto; top: 56px; max-height: calc(100vh - 66px); }
            }
        `;
        document.head.appendChild(style);
    }

    // ── Helpers ─────────────────────────────────────────────
    function esc(v) {
        if (v == null) return '';
        return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function richOf(n) {
        const rc = n && (n.rich_content ?? n.richContent);
        if (!rc) return {};
        if (typeof rc === 'object') return rc;
        try { return JSON.parse(rc) || {}; } catch { return {}; }
    }
    function urlOf(n) { return (n && n.url) || richOf(n).url || null; }
    function isRead(n) { return !!(n && (n.is_read === 1 || n.is_read === true || n.read === true)); }
    function parseDate(v) {
        if (!v) return null;
        // SQLite "YYYY-MM-DD HH:MM:SS" is UTC without a zone marker.
        const s = String(v);
        const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
        return isNaN(d.getTime()) ? null : d;
    }
    function timeAgo(v) {
        const d = parseDate(v); if (!d) return '';
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 45) return 'just now';
        if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return d.toLocaleDateString();
    }
    function inboxUrl() {
        if (_config.inboxUrl) return _config.inboxUrl;
        try { return new URL('/notifications', _config.apiBase).toString(); } catch { return 'https://openvibe.network/notifications'; }
    }
    function iconHtml(n) {
        const rich = richOf(n);
        const img = n.sender_avatar || rich.thumbnail || (rich.user && rich.user.avatar_url);
        if (img && /^https?:\/\//.test(String(img))) return `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${esc(n.icon || '🔔')}'))">`;
        return esc(n.icon || '🔔');
    }
    function navigateTo(url) {
        if (!url) return;
        try {
            const u = new URL(url, window.location.href);
            window.location.href = u.toString();
        } catch { window.location.href = url; }
    }

    // ── API ─────────────────────────────────────────────────
    function isCrossOrigin() {
        try { return new URL(_config.apiBase).origin !== window.location.origin; } catch { return false; }
    }
    function apiFetch(path, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        if (_config.token) headers['Authorization'] = `Bearer ${_config.token}`;
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            opts = { ...opts, body: JSON.stringify(opts.body) };
        }
        return fetch(`${_config.apiBase}${path}`, { ...opts, headers, credentials: isCrossOrigin() ? 'omit' : 'include' });
    }
    async function apiJson(path, opts) {
        const res = await apiFetch(path, opts);
        let data = null; try { data = await res.json(); } catch { /* */ }
        if (!res.ok) { const e = new Error((data && data.error) || `HTTP ${res.status}`); e.status = res.status; e.body = data; throw e; }
        return data || {};
    }
    function hasSession() { return !!_config.token || !isCrossOrigin(); }

    // ── Cross-tab sync (same origin) ────────────────────────
    function channel() {
        if (_channel !== null) return _channel || null;
        try { _channel = new BroadcastChannel('openvibe-notifications'); _channel.onmessage = (e) => onSyncMessage(e.data || {}); }
        catch { _channel = false; }
        return _channel || null;
    }
    function broadcast(msg) { try { channel()?.postMessage(msg); } catch { /* */ } }
    function onSyncMessage(msg) {
        if (msg.type === 'unread') setBadge(msg.count, { quiet: true });
        else if (msg.type === 'read') { for (const v of _views.values()) applyReadLocally(v, msg.ids || [], msg.all); }
    }

    // ── Sound ───────────────────────────────────────────────
    function playSound(priority) {
        if (!_preferences.sound) return;
        const file = SOUNDS[priority]; if (!file) return;
        const url = `${_config.soundBase}/${file}`;
        try {
            if (!_audioCache[url]) _audioCache[url] = new Audio(url);
            const a = _audioCache[url]; a.currentTime = 0; a.volume = priority === 'critical' ? 0.8 : 0.5; a.play().catch(() => {});
        } catch { /* */ }
    }

    // ── Toasts ──────────────────────────────────────────────
    function ensureToastContainer() {
        if (_toastContainer) return;
        _toastContainer = document.createElement('div');
        _toastContainer.className = 'openvibe-toast-container';
        document.body.appendChild(_toastContainer);
    }
    function showToast(n) {
        if (!_preferences.toasts) return;
        if (_preferences.muted_categories.includes(n.category)) return;
        ensureToastContainer();
        while (_toastContainer.children.length >= MAX_TOASTS) _toastContainer.firstChild.remove();
        const rich = richOf(n);
        const toast = document.createElement('div');
        toast.className = `openvibe-toast priority-${esc(n.priority || 'normal')}`;
        toast.dataset.notifId = n.id || '';
        const serviceLabel = n.service && n.service !== 'network' ? `<span class="service-badge">${esc(SERVICE_LABELS[n.service] || n.service)}</span>` : '';
        const actions = Array.isArray(rich.actions) ? rich.actions.filter(a => a && a.type !== 'input') : [];
        toast.innerHTML = `
            <div class="openvibe-toast-icon">${iconHtml(n)}</div>
            <div class="openvibe-toast-body">
                <div class="openvibe-toast-title">${esc(n.title)}${serviceLabel}</div>
                <div class="openvibe-toast-msg">${esc(n.message || '')}</div>
                ${actions.length ? `<div class="openvibe-toast-actions">${actions.map(a => `<button data-action="${esc(a.id)}" class="${a.style === 'primary' ? 'primary' : ''}">${esc(a.label)}</button>`).join('')}</div>` : ''}
            </div>
            <button class="openvibe-toast-close" aria-label="Dismiss">&times;</button>`;
        const duration = TOAST_DURATION[n.priority] ?? 5000;
        if (duration > 0) {
            const bar = document.createElement('div');
            bar.className = 'openvibe-toast-progress'; bar.style.width = '100%'; bar.style.transition = `width ${duration}ms linear`;
            toast.appendChild(bar);
            requestAnimationFrame(() => { bar.style.width = '0%'; });
            setTimeout(() => dismissToast(toast), duration);
        }
        toast.querySelector('.openvibe-toast-close').addEventListener('click', (e) => { e.stopPropagation(); dismissToast(toast); });
        toast.addEventListener('click', () => {
            if (n.id) markRead([n.id]);
            dismissToast(toast);
            const u = urlOf(n); if (u) navigateTo(u);
        });
        toast.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = actions.find(x => String(x.id) === btn.dataset.action);
            if (a && a.url) { navigateTo(a.url); return; }
            if (_config.onAction) _config.onAction(n.id, btn.dataset.action, n);
            dismissToast(toast);
        }));
        _toastContainer.appendChild(toast);
    }
    function dismissToast(el) {
        if (!el || !el.parentNode) return;
        el.classList.add('removing');
        setTimeout(() => el.remove(), 300);
    }

    // ── Bell / badge ────────────────────────────────────────
    function createBellEl() {
        const bell = document.createElement('div');
        bell.className = 'openvibe-bell';
        bell.setAttribute('role', 'button'); bell.setAttribute('aria-label', 'Notifications'); bell.tabIndex = 0;
        bell.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg><span class="badge hidden">0</span>`;
        bell.addEventListener('click', () => togglePanel());
        bell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); } });
        _bellEl = bell;
        return bell;
    }
    function setBadge(count, { quiet = false } = {}) {
        const prev = _unreadCount;
        _unreadCount = Math.max(0, Number(count) || 0);
        if (_bellEl) {
            const badge = _bellEl.querySelector('.badge');
            if (_unreadCount > 0) {
                badge.textContent = _unreadCount > 99 ? '99+' : String(_unreadCount);
                badge.classList.remove('hidden');
                if (!quiet && _unreadCount > prev) { _bellEl.classList.add('ringing'); setTimeout(() => _bellEl.classList.remove('ringing'), 600); }
            } else badge.classList.add('hidden');
        }
        for (const v of _views.values()) {
            const c = v.root.querySelector('.openvibe-nv-head .count');
            if (c) { c.textContent = _unreadCount > 99 ? '99+' : String(_unreadCount); c.classList.toggle('zero', _unreadCount === 0); }
        }
        if (!quiet) broadcast({ type: 'unread', count: _unreadCount });
    }

    // ── List views (panel + inbox share this) ───────────────
    const SVG = {
        search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
        check: '<svg viewBox="0 0 24 24"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>',
        bellOn: '<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
        bellOff: '<svg viewBox="0 0 24 24"><path d="M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z"/></svg>',
        gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
        open: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
    };

    function buildView(root, { mode }) {
        const v = { root, mode, tab: 'all', category: '', q: '', items: [], offset: 0, hasMore: false, loading: false, seq: 0, ids: new Set() };
        root.innerHTML = `
            <div class="openvibe-nv-head">
                <h3>Notifications <span class="count zero">0</span></h3>
                <div class="openvibe-nv-actions">
                    <button type="button" data-act="read-all" title="Mark all as read">${SVG.check}<span>Mark all read</span></button>
                    <button type="button" data-act="push" title="Desktop / mobile push alerts on this device">${SVG.bellOff}</button>
                    ${mode === 'panel' ? `<a href="${esc(inboxUrl())}" data-act="inbox" title="Open inbox">${SVG.open}</a>` : `<a href="${esc(inboxUrl().replace(/\/notifications$/, '/notifications#prefs'))}" data-act="prefs" title="Notification preferences">${SVG.gear}</a>`}
                </div>
            </div>
            <div class="openvibe-nv-note" data-role="note" style="display:none"></div>
            <div class="openvibe-nv-tools">
                <div class="openvibe-nv-search">${SVG.search}<input type="search" placeholder="Search notifications…" autocomplete="off" spellcheck="false"><button type="button" class="clear" aria-label="Clear search">&times;</button></div>
                <div class="openvibe-nv-chips">
                    <button type="button" data-tab="all" class="active">All</button>
                    <button type="button" data-tab="unread">Unread</button>
                    <select data-role="category"><option value="">All categories</option>${Object.entries(CATEGORY_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
                </div>
            </div>
            <div class="openvibe-nv-list" data-role="list"></div>
            <div class="openvibe-nv-foot"><span data-role="status"></span>${mode === 'panel' ? `<a href="${esc(inboxUrl())}">Open full inbox →</a>` : ''}</div>`;
        const list = root.querySelector('[data-role="list"]');
        const input = root.querySelector('input[type="search"]');
        let qTimer = null;
        input.addEventListener('input', () => {
            root.querySelector('.openvibe-nv-search').classList.toggle('has-q', !!input.value);
            clearTimeout(qTimer); qTimer = setTimeout(() => { v.q = input.value.trim(); reload(v); }, 260);
        });
        root.querySelector('.openvibe-nv-search .clear').addEventListener('click', () => { input.value = ''; v.q = ''; root.querySelector('.openvibe-nv-search').classList.remove('has-q'); reload(v); });
        root.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
            root.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active')); btn.classList.add('active');
            v.tab = btn.dataset.tab; reload(v);
        }));
        root.querySelector('[data-role="category"]').addEventListener('change', (e) => { v.category = e.target.value; reload(v); });
        root.querySelector('[data-act="read-all"]').addEventListener('click', () => markAllRead());
        root.querySelector('[data-act="push"]').addEventListener('click', () => togglePush(v));
        // Infinite scroll: load the next page when the user nears the bottom.
        list.addEventListener('scroll', () => {
            if (v.loading || !v.hasMore) return;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) loadMore(v);
        });
        list.addEventListener('click', (e) => {
            const dismissBtn = e.target.closest('.dismiss');
            const item = e.target.closest('.openvibe-notif-item');
            if (!item) return;
            const id = item.dataset.id;
            if (dismissBtn) { e.stopPropagation(); dismiss(v, id); return; }
            const n = v.items.find(x => String(x.id) === id);
            if (n && !isRead(n)) markRead([id]);
            const u = urlOf(n);
            if (u) navigateTo(u);
        });
        refreshPushButton(v);
        _views.set(root, v);
        return v;
    }

    function renderItems(v, { append = false } = {}) {
        const list = v.root.querySelector('[data-role="list"]');
        const html = v.items.map(n => {
            try {
                const cat = CATEGORY_LABELS[n.category] || n.category || '';
                const service = n.service && n.service !== 'network' ? `<span class="tag">${esc(SERVICE_LABELS[n.service] || n.service)}</span>` : '';
                return `<div class="openvibe-notif-item ${isRead(n) ? '' : 'unread'}" data-id="${esc(n.id)}" title="${esc(urlOf(n) ? 'Open' : '')}">
                    <span class="icon">${iconHtml(n)}</span>
                    <div class="content">
                        <div class="title">${esc(n.title)}</div>
                        ${n.message ? `<div class="msg">${esc(n.message)}</div>` : ''}
                        <div class="meta"><span title="${esc(parseDate(n.created_at)?.toLocaleString() || '')}">${esc(timeAgo(n.created_at))}</span>${service}${cat ? `<span class="tag">${esc(cat)}</span>` : ''}</div>
                    </div>
                    <button type="button" class="dismiss" title="Dismiss" aria-label="Dismiss">&times;</button>
                </div>`;
            } catch { return ''; }
        }).join('');
        if (!append) list.innerHTML = '';
        if (!v.items.length) {
            list.innerHTML = `<div class="openvibe-nv-empty"><span class="icon">${v.q ? '🔎' : '🔔'}</span>${v.q ? 'Nothing matches that search' : (v.tab === 'unread' ? 'You\'re all caught up' : 'No notifications yet')}</div>`;
        } else {
            const old = list.querySelector('.openvibe-nv-more'); if (old) old.remove();
            list.insertAdjacentHTML('beforeend', html);
            if (v.hasMore) list.insertAdjacentHTML('beforeend', `<div class="openvibe-nv-more"><button type="button" data-act="more">Load more</button></div>`);
            const more = list.querySelector('[data-act="more"]'); if (more) more.addEventListener('click', () => loadMore(v));
        }
        const st = v.root.querySelector('[data-role="status"]');
        if (st) st.textContent = v.total != null ? `${v.items.length} of ${v.total}${v.tab === 'unread' ? ' unread' : ''}` : '';
    }

    async function fetchPage(v, offset) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (v.tab === 'unread') params.set('unread_only', '1');
        if (v.category) params.set('category', v.category);
        if (v.q) params.set('q', v.q);
        return apiJson(`/api/notifications?${params}`);
    }
    async function reload(v) {
        const seq = ++v.seq;
        v.loading = true; v.offset = 0; v.items = []; v.ids = new Set(); v.hasMore = false; v.total = null;
        const list = v.root.querySelector('[data-role="list"]');
        list.innerHTML = '<div class="openvibe-nv-more"><span class="spinner"></span></div>';
        try {
            const data = await fetchPage(v, 0);
            if (seq !== v.seq) return;
            v.items = data.notifications || []; v.items.forEach(n => v.ids.add(String(n.id)));
            v.hasMore = !!data.has_more; v.total = data.total ?? null; v.offset = v.items.length;
            renderItems(v);
        } catch (e) {
            if (seq !== v.seq) return;
            list.innerHTML = `<div class="openvibe-nv-empty"><span class="icon">⚠️</span>${e.status === 401 ? 'Sign in to see your notifications' : 'Could not load notifications'}</div>`;
        } finally { if (seq === v.seq) v.loading = false; }
    }
    async function loadMore(v) {
        if (v.loading || !v.hasMore) return;
        const seq = v.seq; v.loading = true;
        const more = v.root.querySelector('.openvibe-nv-more'); if (more) more.innerHTML = '<span class="spinner"></span>';
        try {
            const data = await fetchPage(v, v.offset);
            if (seq !== v.seq) return;
            const fresh = (data.notifications || []).filter(n => !v.ids.has(String(n.id)));
            fresh.forEach(n => v.ids.add(String(n.id)));
            v.items = v.items.concat(fresh); v.hasMore = !!data.has_more; v.offset += (data.notifications || []).length; v.total = data.total ?? v.total;
            // Re-render only the tail to keep the scroll position.
            const old = v.root.querySelector('.openvibe-nv-more'); if (old) old.remove();
            if (fresh.length) renderItems({ ...v, items: fresh }, { append: true });
            else if (v.hasMore) { const list = v.root.querySelector('[data-role="list"]'); list.insertAdjacentHTML('beforeend', '<div class="openvibe-nv-more"><button type="button" data-act="more">Load more</button></div>'); list.querySelector('[data-act="more"]').addEventListener('click', () => loadMore(v)); }
            const st = v.root.querySelector('[data-role="status"]');
            if (st) st.textContent = v.total != null ? `${v.items.length} of ${v.total}${v.tab === 'unread' ? ' unread' : ''}` : '';
        } catch { /* keep what we have */ }
        finally { v.loading = false; }
    }
    function applyReadLocally(v, ids, all) {
        const set = new Set((ids || []).map(String));
        for (const n of v.items) if (all || set.has(String(n.id))) n.is_read = 1;
        v.root.querySelectorAll('.openvibe-notif-item.unread').forEach(el => { if (all || set.has(el.dataset.id)) el.classList.remove('unread'); });
    }

    // ── Mutations ───────────────────────────────────────────
    async function markRead(ids) {
        ids = (ids || []).map(String).filter(Boolean);
        if (!ids.length) return;
        for (const v of _views.values()) applyReadLocally(v, ids, false);
        broadcast({ type: 'read', ids });
        try {
            const data = ids.length === 1
                ? await apiJson(`/api/notifications/${encodeURIComponent(ids[0])}/read`, { method: 'POST' })
                : await apiJson('/api/notifications/read-batch', { method: 'POST', body: { ids } });
            if (data && typeof data.unread === 'number') setBadge(data.unread, { quiet: true }), broadcast({ type: 'unread', count: data.unread });
            else pollUnread();
        } catch { pollUnread(); }
    }
    async function markAllRead() {
        for (const v of _views.values()) applyReadLocally(v, [], true);
        setBadge(0);
        broadcast({ type: 'read', all: true });
        try { await apiJson('/api/notifications/read-all', { method: 'POST', body: {} }); } catch { pollUnread(); }
    }
    async function dismiss(v, id) {
        const n = v.items.find(x => String(x.id) === String(id));
        v.items = v.items.filter(x => String(x.id) !== String(id));
        v.root.querySelector(`.openvibe-notif-item[data-id="${CSS.escape(String(id))}"]`)?.remove();
        if (v.total != null) v.total = Math.max(0, v.total - 1);
        if (!v.items.length) renderItems(v);
        try {
            await apiJson(`/api/notifications/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
            if (n && !isRead(n)) setBadge(Math.max(0, _unreadCount - 1), { quiet: true });
        } catch { /* */ }
    }

    // ── Polling / toasts ────────────────────────────────────
    let _polling = false;
    async function pollUnread() {
        if (_polling || !hasSession()) return;
        _polling = true;
        try {
            const data = await apiJson('/api/notifications/unread-count');
            const prev = _unreadCount;
            const count = Number(data.count) || 0;
            setBadge(count);
            if (count > prev && _lastSeenAt) {
                // Something new arrived: fetch what's newer than the last thing we saw.
                const params = new URLSearchParams({ unread_only: '1', limit: '5', since: _lastSeenAt });
                const nd = await apiJson(`/api/notifications?${params}`);
                const fresh = (nd.notifications || []).slice().reverse();
                for (const n of fresh) { showToast(n); playSound(n.priority); }
                // Any open list should reflect the new items too.
                for (const v of _views.values()) if (v.mode === 'inbox' || (_panelEl && _panelEl.classList.contains('open'))) reload(v);
            }
            const newest = await newestCreatedAt();
            if (newest) _lastSeenAt = newest;
        } catch { /* offline / signed out — try again next tick */ }
        finally { _polling = false; }
    }
    async function newestCreatedAt() {
        try { const d = await apiJson('/api/notifications/newest'); const c = d.notification && d.notification.created_at; return c ? String(c) : null; } catch { return null; }
    }
    function startPolling() {
        stopPolling();
        if (!hasSession()) return;
        newestCreatedAt().then(c => { _lastSeenAt = c || new Date().toISOString(); pollUnread(); });
        _pollTimer = setInterval(pollUnread, POLL_INTERVAL);
    }
    function stopPolling() { if (_pollTimer) clearInterval(_pollTimer); _pollTimer = null; }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollUnread(); });

    // ── Panel ───────────────────────────────────────────────
    function createPanel() {
        const panel = document.createElement('div');
        panel.className = 'openvibe-notif-panel';
        document.body.appendChild(panel);
        buildView(panel, { mode: 'panel' });
        document.addEventListener('click', (e) => {
            if (panel.classList.contains('open') && !panel.contains(e.target) && !(_bellEl && _bellEl.contains(e.target))) closePanel();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closePanel(); });
        _panelEl = panel;
        return panel;
    }
    function closePanel() { _panelEl?.classList.remove('open'); _bellEl?.classList.remove('open'); }
    function togglePanel() {
        if (!_panelEl) createPanel();
        const opening = !_panelEl.classList.contains('open');
        _panelEl.classList.toggle('open', opening);
        _bellEl?.classList.toggle('open', opening);
        if (opening) { reload(_views.get(_panelEl)); refreshPushButton(_views.get(_panelEl)); pollUnread(); }
    }

    // ── Web Push ────────────────────────────────────────────
    function pushSupported() { return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext; }
    function urlBase64ToUint8Array(b64) {
        const padding = '='.repeat((4 - (b64.length % 4)) % 4);
        const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(base64); const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    async function currentSubscription() {
        if (!pushSupported()) return null;
        try { const reg = await navigator.serviceWorker.getRegistration(_config.swPath); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
    }
    async function pushStatus() {
        const supported = pushSupported();
        const sub = supported ? await currentSubscription() : null;
        return { supported, permission: supported ? Notification.permission : 'unsupported', subscribed: !!sub };
    }
    async function enablePush() {
        if (!pushSupported()) throw new Error('This browser does not support push notifications');
        if (!hasSession()) throw new Error('Sign in first');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in your browser settings' : 'Permission not granted');
        const reg = await navigator.serviceWorker.register(_config.swPath, { scope: '/' });
        await navigator.serviceWorker.ready;
        const { publicKey } = await apiJson('/api/push/vapid-key');
        if (!publicKey) throw new Error('Push is not configured on the server');
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
        await apiJson('/api/push/subscribe', { method: 'POST', body: { subscription: { ...sub.toJSON(), userAgent: navigator.userAgent.slice(0, 200) } } });
        try { localStorage.setItem('ov_push_enabled', '1'); } catch { /* */ }
        return true;
    }
    async function disablePush() {
        const sub = await currentSubscription();
        if (sub) {
            try { await apiJson('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch { /* */ }
            try { await sub.unsubscribe(); } catch { /* */ }
        }
        try { localStorage.removeItem('ov_push_enabled'); } catch { /* */ }
        return true;
    }
    async function refreshPushButton(v) {
        const btn = v && v.root.querySelector('[data-act="push"]');
        if (!btn) return;
        const st = await pushStatus();
        if (!st.supported) { btn.style.display = 'none'; return; }
        btn.style.display = '';
        btn.classList.toggle('on', st.subscribed);
        btn.innerHTML = st.subscribed ? `${SVG.bellOn}<span>Push on</span>` : `${SVG.bellOff}<span>Enable push</span>`;
        btn.title = st.subscribed ? 'Push alerts are on for this device — click to turn off' : (st.permission === 'denied' ? 'Notifications are blocked in your browser settings' : 'Get desktop / mobile alerts on this device even when the tab is closed');
        btn.disabled = st.permission === 'denied' && !st.subscribed;
    }
    async function togglePush(v) {
        const note = v.root.querySelector('[data-role="note"]');
        const say = (msg, ms = 4000) => { if (!note) return; note.textContent = msg; note.style.display = ''; clearTimeout(note._t); note._t = setTimeout(() => { note.style.display = 'none'; }, ms); };
        try {
            const st = await pushStatus();
            if (st.subscribed) { await disablePush(); say('Push alerts turned off for this device.'); }
            else { await enablePush(); say('Push alerts enabled — you\'ll get alerts here even when this site is closed.'); }
        } catch (e) { say(e.message || 'Could not change push setting', 6000); }
        for (const view of _views.values()) refreshPushButton(view);
    }

    // ── Public API ──────────────────────────────────────────
    const OpenVibeNotifications = {
        init(opts = {}) {
            Object.assign(_config, opts);
            injectStyles();
            if (opts.preferences) Object.assign(_preferences, opts.preferences);
            channel();
            startPolling();
            // If the user enabled push on this device before, make sure the worker is registered.
            try { if (pushSupported() && localStorage.getItem('ov_push_enabled') === '1') navigator.serviceWorker.register(_config.swPath, { scope: '/' }).catch(() => {}); } catch { /* */ }
        },
        destroy() {
            stopPolling();
            _toastContainer?.remove(); _panelEl?.remove();
            _toastContainer = null; if (_panelEl) _views.delete(_panelEl); _panelEl = null;
        },
        /** Create and inject the bell icon. Returns the DOM element. */
        createBell(container) {
            injectStyles();
            const bell = createBellEl();
            if (container) container.appendChild(bell);
            pollUnread();
            return bell;
        },
        /** Full-page inbox (same list, filters, search, infinite scroll) rendered into a container. */
        renderInbox(container, opts = {}) {
            injectStyles();
            if (!container) return null;
            container.classList.add('openvibe-notif-inbox');
            const v = buildView(container, { mode: 'inbox' });
            if (opts.tab) { v.tab = opts.tab; container.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === opts.tab)); }
            reload(v);
            return v;
        },
        /** Programmatically show a toast (real-time events). Marks nothing on the server. */
        push(notification) {
            showToast(notification);
            playSound(notification.priority);
            if (!notification.id) return;
            setBadge(_unreadCount + 1);
        },
        /** Re-fetch the badge and any open lists (call after an in-page action). */
        refresh() { pollUnread(); for (const v of _views.values()) reload(v); },
        markRead(ids) { return markRead(Array.isArray(ids) ? ids : [ids]); },
        markAllRead,
        setPreferences(prefs) { Object.assign(_preferences, prefs); },
        setToken(token) {
            _config.token = token;
            if (token || !isCrossOrigin()) startPolling(); else { stopPolling(); setBadge(0, { quiet: true }); }
        },
        togglePanel, closePanel,
        enablePush, disablePush, pushStatus,
        get unreadCount() { return _unreadCount; },
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = OpenVibeNotifications;
    else root.OpenVibeNotifications = OpenVibeNotifications;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
