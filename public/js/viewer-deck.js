'use strict';
/**
 * The Viewer Deck (Elements, stage 1): the streamer's active elements on their channel page.
 *
 *   - GET  /api/channels/:name/elements        the elements, their state and what this viewer may press
 *   - POST /api/channels/:name/elements/:id/press
 *   - /ws/chat                                  the channel's room for `element-state` frames (the overlay path)
 *
 * The server is the authority: every press re-checks the role, live state, cooldowns, daily caps and
 * channel points, and each product checks its own action again. This file only draws the states the
 * API answers (empty, ready, on cooldown, costs points, not allowed for you, offline, signed out) and
 * keeps the element's own state live. No HTML from the server or the element is inserted as markup.
 */
(function () {
    var containers = [];
    var state = {
        username: null,
        data: null,
        inflight: Object.create(null),
        cooldowns: Object.create(null),
        ws: null,
        wsTimer: null,
        syncTimer: null,
        staleTimer: null,
        lastLoad: 0,
    };

    function byId(id) { return document.getElementById(id); }
    function node(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }
    function active() {
        var page = byId('page-channel');
        return !!(page && page.classList.contains('active'));
    }
    function username() {
        return typeof currentChannelUsername === 'string' && currentChannelUsername ? currentChannelUsername : null;
    }
    function call(path, opts) {
        if (typeof api !== 'function') return Promise.reject(new Error('The page is not ready.'));
        return api(path, opts);
    }
    function points(n) {
        var v = Number(n) || 0;
        return v.toLocaleString() + (v === 1 ? ' point' : ' points');
    }
    function mmss(ms) {
        var s = Math.max(0, Math.ceil(ms / 1000));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }
    function stateText(values) {
        var parts = [];
        Object.keys(values || {}).sort().slice(0, 6).forEach(function (k) {
            var v = values[k];
            if (v === null || v === undefined) return;
            if (Array.isArray(v)) v = v.join(', ');
            parts.push(k.replace(/_/g, ' ') + ': ' + String(v));
        });
        return parts.join(' · ');
    }

    function push(container, title, deck) {
        container.replaceChildren();
        container.hidden = false;
        var h = node('h2', 'ch-deck-title', title);
        container.append(h);
        if (!deck.elements.length) return;
        var list = node('div', 'ch-deck-list');
        deck.elements.forEach(function (el) {
            var item = node('div', 'ch-deck-item');
            item.dataset.eid = el.id;
            var btn = node('button', 'ovk-btn ovk-btn--primary ch-deck-btn');
            btn.type = 'button';
            btn.dataset.eid = el.id;
            btn.append(node('span', 'ch-deck-label', el.look && el.look.label ? el.look.label : el.name));
            var meta = node('span', 'ch-deck-meta');
            btn.append(meta);
            var left = state.cooldowns[el.id] || 0;
            var cost = Number(el.cost_points) || 0;
            var bits = [];
            if (cost) bits.push(points(cost));
            if (deck.viewer && deck.viewer.signed_in && deck.viewer.points !== null && cost) bits.push('you have ' + points(deck.viewer.points));
            if (left > 0) bits.push('on cooldown ' + mmss(left));
            meta.textContent = bits.join(' · ');
            if (!deck.live) {
                btn.disabled = true;
                meta.textContent = 'While ' + (deck.channel.display_name || deck.channel.username) + ' is live';
            } else if (!el.can_press) {
                btn.disabled = true;
                if (!bits.length) meta.textContent = el.message || 'Not available';
            } else if (state.inflight[el.id]) {
                btn.disabled = true;
                meta.textContent = 'Pressing…';
            }
            btn.addEventListener('click', function () { press(el.id); });
            item.append(btn);
            if (el.message && !el.can_press && deck.live) item.append(node('p', 'ch-deck-note', el.message));
            var values = el.state && el.state.values ? el.state.values : {};
            var text = stateText(values);
            if (text) item.append(node('p', 'ch-deck-state', text));
            list.append(item);
        });
        container.append(list);
        if (!deck.enabled) {
            container.append(node('p', 'ch-deck-note', 'Elements are off for this channel.'));
        }
    }

    function render() {
        containers = [byId('ch-deck'), byId('ch-deck-offline')].filter(Boolean);
        if (!containers.length) return;
        var deck = state.data;
        if (!deck || !deck.enabled || !deck.elements.length) {
            containers.forEach(function (c) { c.hidden = true; c.replaceChildren(); });
            return;
        }
        var title = (deck.channel.display_name || deck.channel.username) + "'s deck";
        containers.forEach(function (c) { push(c, title, deck); });
    }

    function refreshLater(ms) {
        clearTimeout(state.staleTimer);
        state.staleTimer = setTimeout(function () { load(true); }, ms);
    }

    async function press(id) {
        var deck = state.data;
        if (!deck || !deck.live || state.inflight[id]) return;
        var el = deck.elements.filter(function (x) { return x.id === id; })[0];
        if (!el || !el.can_press) return;
        state.inflight[id] = true;
        render();
        try {
            var out = await call('/channels/' + encodeURIComponent(state.username) + '/elements/' + encodeURIComponent(id) + '/press', { method: 'POST', body: {} });
            if (out && out.state) { el.state = out.state; }
            if (out && out.balance !== undefined && deck.viewer) deck.viewer.points = out.balance;
            if (out && out.cooldown_ms) state.cooldowns[id] = Date.now() + Number(out.cooldown_ms);
            state.inflight[id] = false;
            render();
            refreshLater(1200);
        } catch (err) {
            var data = (err && err.data) || {};
            el.message = data.error || (err && err.message) || 'That did not work.';
            el.can_press = false;
            if (data.retry_after_ms) { state.cooldowns[id] = Date.now() + Number(data.retry_after_ms); el.can_press = false; }
            state.inflight[id] = false;
            render();
            refreshLater(data.retry_after_ms ? Math.min(Number(data.retry_after_ms), 15000) : 1500);
        }
    }

    function updateState(frame) {
        if (!state.data || !frame || !frame.element_id) return;
        if (frame.channel && frame.channel.username && frame.channel.username.toLowerCase() !== String(state.username).toLowerCase()) return;
        var el = state.data.elements.filter(function (x) { return x.id === frame.element_id; })[0];
        if (!el) return;
        var current = el.state && Number(el.state.revision) || 0;
        if (Number(frame.revision) < current) return;
        el.state = { revision: Number(frame.revision) || 0, values: frame.values || {} };
        containers = [byId('ch-deck'), byId('ch-deck-offline')].filter(Boolean);
        containers.forEach(function (c) {
            var item = c.querySelector('[data-eid="' + frame.element_id + '"]');
            if (!item) return;
            var line = item.querySelector('.ch-deck-state');
            var text = stateText(el.state.values);
            if (!line) { line = node('p', 'ch-deck-state'); item.append(line); }
            line.textContent = text;
        });
    }

    function closeSocket() {
        if (state.ws) { try { state.ws.close(); } catch (e) { /* already closed */ } state.ws = null; }
        clearTimeout(state.wsTimer);
    }

    function connect(deck) {
        closeSocket();
        if (!deck || !deck.live || !deck.stream_id || !deck.elements.length) return;
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        var ws;
        try { ws = new WebSocket(proto + '://' + location.host + '/ws/chat?stream=' + encodeURIComponent(deck.stream_id)); } catch (e) { return; }
        state.ws = ws;
        ws.onopen = function () {
            try { ws.send(JSON.stringify({ type: 'join', streamId: deck.stream_id, channel: state.username })); } catch (e) { /* the join retries with the socket */ }
        };
        ws.onmessage = function (e) {
            try { var m = JSON.parse(e.data); if (m && m.type === 'element-state') updateState(m); } catch (err) { /* not ours */ }
        };
        ws.onclose = function () {
            if (state.ws !== ws) return;
            state.ws = null;
            if (active() && state.username === username()) {
                state.wsTimer = setTimeout(function () { if (state.data) connect(state.data); }, 3000);
            }
        };
    }

    async function load(fresh) {
        var name = username();
        if (!name || !active()) return;
        if (!fresh && state.username === name && state.data && Date.now() - state.lastLoad < 4000) return;
        state.lastLoad = Date.now();
        try {
            var deck = await call('/channels/' + encodeURIComponent(name) + '/elements');
            if (username() !== name) return;   // the page moved to another channel while this was in flight
            state.username = name;
            // Keep a local cooldown the server has not seen yet (a press answered a moment ago).
            (deck.elements || []).forEach(function (el) {
                if (state.cooldowns[el.id] && state.cooldowns[el.id] > Date.now()) el.can_press = false;
            });
            state.data = deck;
            render();
            connect(deck);
        } catch (err) {
            if (err && err.status === 404) { state.data = null; render(); }
        }
    }

    function sync() {
        if (!active()) return;
        var name = username();
        if (!name) return;
        if (name !== state.username || !state.data) { load(false); return; }
        if (Date.now() - state.lastLoad > 30000) load(true);
    }

    function tick() {
        var now = Date.now();
        var expired = false;
        Object.keys(state.cooldowns).forEach(function (id) {
            if (state.cooldowns[id] && state.cooldowns[id] <= now) { delete state.cooldowns[id]; expired = true; }
        });
        if (!state.data) return;
        state.data.elements.forEach(function (el) {
            var left = state.cooldowns[el.id] || 0;
            containers = containers.length ? containers : [byId('ch-deck'), byId('ch-deck-offline')].filter(Boolean);
            containers.forEach(function (c) {
                var btn = c.querySelector('[data-eid="' + el.id + '"]');
                if (!btn) return;
                var meta = btn.querySelector('.ch-deck-meta');
                if (meta && left > 0) meta.textContent = 'On cooldown ' + mmss(left);
                if (btn.disabled && !left && state.data.live) {
                    var wasCooling = meta && /cooldown/i.test(meta.textContent || '');
                    if (wasCooling) { btn.disabled = false; meta.textContent = ''; }
                }
            });
        });
        if (expired) refreshLater(300);
    }

    function boot() {
        state.syncTimer = setInterval(sync, 1500);
        setInterval(tick, 1000);
        window.addEventListener('hashchange', sync);
        window.addEventListener('popstate', sync);
        window.addEventListener('openvibe-auth-changed', function () { state.data = null; state.username = null; load(true); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
        sync();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
