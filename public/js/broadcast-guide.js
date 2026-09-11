/**
 * broadcast-guide.js — guided setup on the Go Live page.
 *
 *   /broadcast?setup=restream   → walks a streamer through restreaming: create a slot if they
 *                                  have none, open Restream Destinations, add RobotStreamer with
 *                                  the one-click "log in & fetch robots" path, add more platforms,
 *                                  then Go Live. A spotlight + card overlay that follows the real
 *                                  controls on the page (nothing is faked or duplicated).
 *
 * Logged out: the intent is remembered in localStorage, the user is sent through SSO, and the
 * guide resumes on the Go Live page after login.
 */
(function () {
    'use strict';
    const PENDING_KEY = 'ov-guide-pending';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function waitFor(fn, { timeout = 20000, every = 200 } = {}) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch { /* */ } await sleep(every); } return null; }

    // ── Overlay ────────────────────────────────────────────────
    let ui = null, raf = 0;
    function ensureUi() {
        if (ui) return ui;
        const root = document.createElement('div');
        root.className = 'bg-guide';
        root.innerHTML = `<div class="bg-guide-hole"></div><div class="bg-guide-card" role="dialog" aria-live="polite"><div class="bg-guide-step"></div><h4 class="bg-guide-title"></h4><p class="bg-guide-text"></p><div class="bg-guide-actions"></div></div>`;
        document.body.appendChild(root);
        ui = { root, hole: root.querySelector('.bg-guide-hole'), card: root.querySelector('.bg-guide-card'), step: root.querySelector('.bg-guide-step'), title: root.querySelector('.bg-guide-title'), text: root.querySelector('.bg-guide-text'), actions: root.querySelector('.bg-guide-actions'), target: null };
        const track = () => { if (!ui) return; place(); raf = requestAnimationFrame(track); };
        raf = requestAnimationFrame(track);
        return ui;
    }
    function place() {
        if (!ui) return;
        const t = ui.target;
        if (!t || !t.isConnected) { ui.hole.style.opacity = '0'; ui.card.style.top = '50%'; ui.card.style.left = '50%'; ui.card.style.transform = 'translate(-50%, -50%)'; return; }
        const r = t.getBoundingClientRect();
        ui.hole.style.opacity = '1';
        ui.hole.style.left = `${r.left - 8}px`; ui.hole.style.top = `${r.top - 8}px`; ui.hole.style.width = `${r.width + 16}px`; ui.hole.style.height = `${r.height + 16}px`;
        const cw = Math.min(380, window.innerWidth - 24), ch = ui.card.offsetHeight || 180;
        let top = r.bottom + 16, left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12));
        if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 16);
        ui.card.style.transform = 'none'; ui.card.style.top = `${top}px`; ui.card.style.left = `${left}px`; ui.card.style.width = `${cw}px`;
    }
    function show({ target, step, total, title, text, actions }) {
        const u = ensureUi();
        u.target = target || null;
        if (target) { try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* */ } }
        u.step.textContent = `Step ${step} of ${total}`;
        u.title.textContent = title;
        u.text.innerHTML = text;
        u.actions.innerHTML = '';
        for (const a of actions) { const b = document.createElement('button'); b.type = 'button'; b.className = `btn ${a.primary ? 'btn-primary' : 'btn-outline'} btn-sm`; b.innerHTML = a.label; b.onclick = a.onClick; u.actions.appendChild(b); }
        u.root.classList.add('is-on');
        place();
    }
    function close() { if (!ui) return; cancelAnimationFrame(raf); ui.root.remove(); ui = null; }

    // ── The restream guide ─────────────────────────────────────
    async function runRestreamGuide() {
        if (!window.currentUser) { try { localStorage.setItem(PENDING_KEY, 'restream'); } catch { /* */ } window.location.href = '/api/auth/sso/login'; return; }
        const total = 5;
        const skip = { label: 'Skip', onClick: close };
        // Wait for the workspace to initialise.
        await waitFor(() => typeof _wsState !== 'undefined' && document.getElementById('bc-ws-list'));
        await sleep(400);

        // 1. A stream slot
        if (typeof _wsState !== 'undefined' && !(_wsState.managedStreams || []).length) {
            const btn = document.querySelector('#bc-ws-empty button') || document.getElementById('bc-ws-empty');
            show({ target: btn, step: 1, total, title: 'First, a stream slot', text: 'A slot is one stream you run — its own key, settings, VODs and restream destinations. Make one (name it anything), then we\'ll wire up the restreams.', actions: [{ label: '<i class="fa-solid fa-plus"></i> Create a slot', primary: true, onClick: () => { try { showCreateManagedStreamModal(); } catch { /* */ } } }, skip] });
            const ok = await waitFor(() => (_wsState.managedStreams || []).length > 0 && document.getElementById('bc-ws-restream-details'), { timeout: 10 * 60 * 1000, every: 400 });
            if (!ok || !ui) return;
        } else {
            await waitFor(() => document.getElementById('bc-ws-restream-details'));
        }
        if (!ui && !ensureUi()) return;

        // 2. Restream destinations
        const details = document.getElementById('bc-ws-restream-details');
        if (details) details.open = true;
        await new Promise(r => { show({ target: details, step: 2, total, title: 'Restream destinations', text: 'This is where one stream fans out. Everything you add here gets your OpenVibe stream mirrored to it — Twitch, YouTube, Kick, any RTMP server, and RobotStreamer over its own connection. Your chat, emotes, sound commands and controls stay here.', actions: [{ label: 'Next <i class="fa-solid fa-arrow-right"></i>', primary: true, onClick: r }, skip] }); });
        if (!ui) return;

        // 3. RobotStreamer, the easy way
        const addBtn = details ? details.querySelector('button') : null;
        await new Promise(r => { show({ target: addBtn, step: 3, total, title: 'Add RobotStreamer', text: 'Pick <b>RobotStreamer</b> as the platform, then use <b>Log in &amp; fetch robots</b>: your RobotStreamer username and password are used once to grab your token and your robot list — nothing is stored. Pick the robot, save. Done.', actions: [{ label: '<i class="fa-solid fa-robot"></i> Add RobotStreamer now', primary: true, onClick: async () => { try { _wsAddRestreamDest(); await sleep(150); const sel = document.getElementById('ws-rs-platform'); if (sel) { sel.value = 'robotstreamer'; _wsRestreamPlatformChanged(); } const u = await waitFor(() => document.getElementById('ws-rs-rs-username'), { timeout: 3000 }); if (u) { u.focus(); if (ui) { ui.target = u.closest('.form-group') || u; ui.title.textContent = 'Log in & fetch robots'; ui.text.innerHTML = 'Enter your RobotStreamer username and password, hit <b>Log in &amp; fetch robots</b>, pick your robot from the list, then <b>Save</b>. The guide continues when the dialog closes.'; ui.actions.innerHTML = ''; } } } catch (e) { console.warn('[Guide]', e.message); } r(); } }, { label: 'I\'ll do it later', onClick: r }, skip] }); });
        if (!ui) return;
        // Wait for the dialog (if opened) to close.
        await waitFor(() => !document.querySelector('.bc-ws-confirm-overlay'), { timeout: 15 * 60 * 1000, every: 300 });
        if (!ui) return;

        // 4. More platforms
        await new Promise(r => { show({ target: addBtn, step: 4, total, title: 'Twitch, YouTube, Kick, RTMP', text: 'Same button, different platform: paste the stream key from each service. Every destination has its own <b>Auto-start</b> switch and its own <b>→ PowerChat</b> switch, so you decide what starts with the stream and whose chat lands on your overlay.', actions: [{ label: 'Next <i class="fa-solid fa-arrow-right"></i>', primary: true, onClick: r }, skip] }); });
        if (!ui) return;

        // 5. Go live
        const golive = document.getElementById('bc-ws-golive-btn') || document.getElementById('bc-ws-golive-section');
        await new Promise(r => { show({ target: golive, step: 5, total, title: 'Go live', text: 'Hit Go Live from this slot. Destinations with Auto-start fire the moment you\'re up; the rest you toggle from the live controls. Your viewers on every platform see one stream, and every chat comes back here.', actions: [{ label: '<i class="fa-solid fa-check"></i> Got it', primary: true, onClick: r }] }); });
        close();
        try { localStorage.removeItem(PENDING_KEY); } catch { /* */ }
    }

    // ── Entry points ───────────────────────────────────────────
    function wanted() { try { return new URLSearchParams(location.search).get('setup'); } catch { return null; } }
    async function boot() {
        // Resume after SSO: the intent was saved before the redirect.
        let pending = null; try { pending = localStorage.getItem(PENDING_KEY); } catch { /* */ }
        if (pending === 'restream' && !wanted()) {
            const user = await waitFor(() => window.currentUser, { timeout: 8000, every: 250 });
            if (user) { try { localStorage.removeItem(PENDING_KEY); } catch { /* */ } if (typeof navigate === 'function') navigate('/broadcast?setup=restream'); else location.href = '/broadcast?setup=restream'; }
            return;
        }
        if (wanted() === 'restream') {
            await waitFor(() => window.currentUser !== undefined && document.getElementById('page-broadcast')?.classList.contains('active'), { timeout: 8000 });
            await waitFor(() => typeof window.currentUser !== 'undefined' || window._userLoaded, { timeout: 6000 });
            runRestreamGuide().catch(e => console.warn('[Guide]', e.message));
        }
    }
    // Also react to in-app navigation to /broadcast?setup=restream (SPA pushState).
    const _push = history.pushState;
    history.pushState = function () { const r = _push.apply(this, arguments); setTimeout(() => { if (wanted() === 'restream' && !ui) boot(); }, 50); return r; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    window.startRestreamGuide = () => { if (typeof navigate === 'function') navigate('/broadcast?setup=restream'); else location.href = '/broadcast?setup=restream'; };
})();
