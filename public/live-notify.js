/**
 * OpenVibe.Live cross-site "went live" notifier.
 * Drop <script src="https://openvibe.live/live-notify.js" async></script> on any
 * OpenVibe site (openvibe.live, openvibe.tools, openvibe.games, …). It subscribes to the
 * shared SSE feed and shows an on-screen toast with a link to watch — driving
 * viewers to openvibe.live. Self-contained: injects its own CSS, no deps.
 */
(function () {
    'use strict';
    if (window.__openvibeLiveNotify) return;
    window.__openvibeLiveNotify = true;

    var BASE = 'https://openvibe.live';
    var seen = {};              // slot key -> last shown ts (client-side dedupe)
    var DEDUPE_MS = 60 * 60 * 1000;
    var AUTO_DISMISS_MS = 13000;

    function injectCSS() {
        if (document.getElementById('openvibe-live-notify-css')) return;
        var s = document.createElement('style');
        s.id = 'openvibe-live-notify-css';
        s.textContent =
            '#openvibe-live-notify{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;max-width:340px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
            '.hln-card{display:flex;gap:11px;align-items:center;background:#17171d;color:#f0f0f2;border:1px solid #2a2a32;border-left:3px solid #e0245e;border-radius:12px;padding:11px 12px;box-shadow:0 10px 30px rgba(0,0,0,.45);text-decoration:none;transform:translateX(120%);opacity:0;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .45s;cursor:pointer;overflow:hidden}' +
            '.hln-card.hln-in{transform:none;opacity:1}' +
            '.hln-av{width:42px;height:42px;border-radius:50%;flex:0 0 auto;object-fit:cover;background:#8b5cf6;display:flex;align-items:center;justify-content:center;color:#111;font-weight:700;font-size:16px;overflow:hidden}' +
            '.hln-av img{width:100%;height:100%;object-fit:cover}' +
            '.hln-body{min-width:0;flex:1}' +
            '.hln-live{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:800;letter-spacing:.5px;color:#ff5b7f;text-transform:uppercase}' +
            '.hln-live .hln-dot{width:7px;height:7px;border-radius:50%;background:#e0245e;animation:hlnPulse 1.3s infinite}' +
            '.hln-name{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}' +
            '.hln-title{font-size:12px;color:#a8a8b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.hln-x{position:absolute;top:5px;right:7px;color:#7a7a86;font-size:14px;line-height:1;padding:2px;cursor:pointer;background:none;border:none}' +
            '.hln-x:hover{color:#fff}' +
            '@keyframes hlnPulse{0%,100%{opacity:1}50%{opacity:.3}}' +
            '@media (prefers-reduced-motion:reduce){.hln-card{transition:opacity .3s}}';
        (document.head || document.documentElement).appendChild(s);
    }

    function ensureContainer() {
        var c = document.getElementById('openvibe-live-notify');
        if (!c) {
            c = document.createElement('div');
            c.id = 'openvibe-live-notify';
            (document.body || document.documentElement).appendChild(c);
        }
        return c;
    }

    function esc(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function show(d) {
        injectCSS();
        var c = ensureContainer();
        var name = d.display_name || d.username || 'Someone';
        var href = BASE + '/@' + encodeURIComponent(d.username || '');
        var letter = (name[0] || '?').toUpperCase();
        var av = d.avatar_url
            ? '<span class="hln-av"><img src="' + esc(d.avatar_url) + '" alt=""></span>'
            : '<span class="hln-av">' + esc(letter) + '</span>';
        var card = document.createElement('a');
        card.className = 'hln-card';
        card.href = href;
        card.target = (location.host.indexOf('live') === -1) ? '_blank' : '_self';
        card.rel = 'noopener';
        card.innerHTML =
            av +
            '<span class="hln-body">' +
                '<span class="hln-live"><span class="hln-dot"></span> Live now</span>' +
                '<div class="hln-name">' + esc(name) + '</div>' +
                (d.title ? '<div class="hln-title">' + esc(d.title) + '</div>' : '') +
            '</span>' +
            '<button class="hln-x" aria-label="Dismiss">&times;</button>';
        card.querySelector('.hln-x').addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation(); dismiss(card);
        });
        c.appendChild(card);
        requestAnimationFrame(function () { card.classList.add('hln-in'); });
        setTimeout(function () { dismiss(card); }, AUTO_DISMISS_MS);
    }

    function dismiss(card) {
        if (!card || card.__gone) return;
        card.__gone = true;
        card.classList.remove('hln-in');
        setTimeout(function () { try { card.remove(); } catch (e) {} }, 500);
    }

    function connect() {
        if (typeof EventSource === 'undefined') return;
        var es;
        try { es = new EventSource(BASE + '/api/live-events'); } catch (e) { return; }
        es.addEventListener('stream-live', function (e) {
            var d; try { d = JSON.parse(e.data); } catch (_) { return; }
            if (!d || !d.username) return;
            var key = String(d.managed_id || d.stream_id);
            var now = Date.now();
            if (seen[key] && now - seen[key] < DEDUPE_MS) return;
            seen[key] = now;
            show(d);
            // Let the app (if loaded) fast-load the stream when the viewer is already
            // on this streamer's channel page — instead of waiting for the 15s poll.
            try { window.dispatchEvent(new CustomEvent('openvibe:stream-live', { detail: d })); } catch (_) {}
        });
        // EventSource auto-reconnects on error; nothing to do.
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', connect);
    } else {
        connect();
    }
})();
