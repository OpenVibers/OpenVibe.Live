/*
   OpenVibe.Live — bind a robot to your channel's chat from openvibe.bot (feature "botBind").

   A robot approved on openvibe.bot/link (the one command on its computer, OpenVibe.Bot server/claims.js) offers
   "Use it in my OpenVibe.Live chat", which opens the owner's own channel with ?bind_robot=rob_…. There, and only on
   their own channel, they confirm and the channel is bound (PUT /api/streams/channel/:username/bot, owner only): its
   chat commands (!forward, !left, !say …) then drive that robot through Bot's own gate, and the robot's panel shows
   on the channel. app-channel.js loads this file only when the address carries a robot id.

     robotFrom(search)              → the rob_… id in ?bind_robot=, or null
     bindRequest(username, robotId) → { path, opts } for the api() call
     offer({ username, robotId, api, toast, onBound })  → shows the confirm bar above the channel's robot section

   Plain script for the browser (window.BotBind) and require() for the tests.
*/
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BotBind = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // The same shape the bind route accepts (server/bot/embed.js validRobotId).
    const ROBOT_ID = /^rob_[A-Za-z0-9_-]{4,60}$/;

    function robotFrom(search) {
        let id = null;
        try { id = new URLSearchParams(String(search || '')).get('bind_robot'); } catch { return null; }
        return id && ROBOT_ID.test(id) ? id : null;
    }

    function bindRequest(username, robotId) {
        return { path: `/streams/channel/${encodeURIComponent(username)}/bot`, opts: { method: 'PUT', body: { robot_id: robotId } } };
    }

    /** Drop ?bind_robot from the address bar, so a reload does not ask again. */
    function forget() {
        try {
            const u = new URL(location.href);
            u.searchParams.delete('bind_robot');
            history.replaceState(history.state, '', u.pathname + (u.search ? u.search : '') + u.hash);
        } catch { /* the address stays; asking again is harmless */ }
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function offer({ username, robotId, api, toast = () => {}, onBound = () => {} }) {
        const section = document.getElementById('ch-bot-section');
        if (!section || !section.parentNode || document.getElementById('ch-bot-bind')) return null;
        const bar = el('div', 'ch-bot-bind');
        bar.id = 'ch-bot-bind';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Drive a robot from your chat');
        const text = el('p', 'ch-bot-bind-text');
        text.append('Let your chat drive the robot you just added on OpenVibe.Bot? ', el('code', null, robotId));
        const note = el('p', 'ch-bot-bind-note',
            'Chat commands like !forward, !left and !say go to it, checked by its own rules on openvibe.bot (who may drive, limits, the e-stop). Its panel shows here. You can unbind it any time.');
        const actions = el('div', 'ch-bot-bind-actions');
        const yes = el('button', 'btn btn-sm btn-primary', 'Use it in my chat');
        yes.type = 'button';
        const no = el('button', 'btn btn-sm btn-ghost', 'Not now');
        no.type = 'button';
        actions.append(yes, no);
        bar.append(text, note, actions);
        section.parentNode.insertBefore(bar, section);
        const close = () => { bar.remove(); forget(); };
        no.addEventListener('click', close);
        yes.addEventListener('click', async () => {
            yes.disabled = true;
            no.disabled = true;
            const { path, opts } = bindRequest(username, robotId);
            try {
                const r = await api(path, opts);
                close();
                toast('Your chat drives the robot now. Try !forward in chat.', 'success');
                onBound(r && r.bot_embed);
            } catch (e) {
                yes.disabled = false;
                no.disabled = false;
                toast((e && e.message) || 'Could not bind the robot', 'error');
            }
        });
        return bar;
    }

    return { robotFrom, bindRequest, offer };
});
