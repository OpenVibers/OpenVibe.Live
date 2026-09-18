/**
 * openvibe-shared/history.js — cross-site history for a signed-in account.
 *
 *   OpenVibeHistory.record({ type, title, url, icon, service, meta }, { token, apiBase })
 *   OpenVibeHistory.recent({ limit, service, type, token, apiBase })   → [{...}]
 *   OpenVibeHistory.clear({ token })                                   → wipes it
 *
 * Every property records what the account touched — a tool used, a stream watched, a paste
 * opened, a game played — so "Recently used" in the shared navbar and the History tab on the
 * Network show one timeline across the whole network instead of one per site. Writes are
 * deduplicated server-side (same URL within ten minutes bumps the entry instead of adding one)
 * and the browser side throttles too, so a page cannot flood it. Nothing is recorded for
 * anonymous sessions, and the user can pause or clear the timeline from their account page.
 *
 * Loaded lazily by navbar.js from https://openvibe.network/shared/history.js; safe to include
 * directly. Token resolution matches the navbar: ov_token cookie → localStorage.ov_token.
 */
(function (root) {
    'use strict';
    if (root.OpenVibeHistory) return;

    const DEFAULT_API = 'https://openvibe.network';
    const SENT_KEY = 'ov_history_sent';       // sessionStorage: url → ts, to avoid re-posting on every re-render
    const THROTTLE_MS = 5 * 60 * 1000;

    function token(opts) {
        if (opts && opts.token) return opts.token;
        const m = (typeof document !== 'undefined' ? document.cookie : '').match(/(?:^|;\s*)ov_token=([^;]*)/);
        if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
        try { return localStorage.getItem('ov_token'); } catch { return null; }
    }

    function api(opts) { return (opts && opts.apiBase) || DEFAULT_API; }

    function sent() { try { return JSON.parse(sessionStorage.getItem(SENT_KEY) || '{}'); } catch { return {}; } }
    function markSent(url) {
        try {
            const m = sent(); m[url] = Date.now();
            const keys = Object.keys(m); if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete m[k];
            sessionStorage.setItem(SENT_KEY, JSON.stringify(m));
        } catch { /* storage unavailable */ }
    }

    /** Guess an icon and service label from the URL when the caller gives none. */
    function inferService(url) {
        let host = '';
        try { host = new URL(url, location.href).hostname; } catch { return { service: null }; }
        const m = host.match(/^(?:(.+)\.)?openvibe\.([a-z]+)$/) || host.match(/^(?:(.+)\.)?(openre)\.stream$/);
        if (!m) return { service: null };
        return { service: m[2], sub: m[1] || null };
    }

    const ICONS = { tool: 'fa-screwdriver-wrench', stream: 'fa-tower-broadcast', vod: 'fa-clapperboard', clip: 'fa-scissors', paste: 'fa-paste', game: 'fa-gamepad', page: 'fa-file-lines', post: 'fa-comments', account: 'fa-user', theme: 'fa-palette', download: 'fa-download', chat: 'fa-comment' };

    async function record(entry, opts) {
        const t = token(opts);
        if (!t || !entry) return false;
        const url = String(entry.url || (typeof location !== 'undefined' ? location.href : '')).slice(0, 2000);
        if (!url) return false;
        const last = sent()[url] || 0;
        if (!entry.force && Date.now() - last < THROTTLE_MS) return false;
        markSent(url);
        const inf = inferService(url);
        const body = {
            type: String(entry.type || 'page').slice(0, 32),
            title: String(entry.title || (typeof document !== 'undefined' ? document.title : '') || url).slice(0, 200),
            url,
            icon: entry.icon || ICONS[entry.type] || null,
            service: entry.service || inf.service || null,
            sub: entry.sub || inf.sub || null,
            meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null,
        };
        try {
            const res = await fetch(`${api(opts)}/api/history`, {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
                body: JSON.stringify(body),
            });
            return res.ok;
        } catch { return false; }
    }

    async function recent(opts) {
        const t = token(opts);
        if (!t) return [];
        const q = new URLSearchParams();
        if (opts && opts.limit) q.set('limit', String(opts.limit));
        if (opts && opts.service) q.set('service', opts.service);
        if (opts && opts.type) q.set('type', opts.type);
        try {
            const res = await fetch(`${api(opts)}/api/history?${q}`, { headers: { Authorization: `Bearer ${t}` } });
            if (!res.ok) return [];
            const data = await res.json();
            return (data && data.items) || [];
        } catch { return []; }
    }

    async function clear(opts) {
        const t = token(opts);
        if (!t) return false;
        try { const res = await fetch(`${api(opts)}/api/history`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }); return res.ok; } catch { return false; }
    }

    async function remove(id, opts) {
        const t = token(opts);
        if (!t) return false;
        try { const res = await fetch(`${api(opts)}/api/history/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }); return res.ok; } catch { return false; }
    }

    root.OpenVibeHistory = { record, recent, clear, remove, ICONS };
})(typeof window !== 'undefined' ? window : globalThis);
