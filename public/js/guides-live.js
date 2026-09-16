/**
 * guides-live.js — OpenVibe.Live's journeys for the shared guidance engine (ov-guide.js).
 *
 *   setup-hub   the streamer checklist: everything the site offers, what's done, what's next
 *   golive      stream slot → streaming method → restream → go live
 *   restream    just the restream step (home page button)
 *   profile     avatar + bio          | offline    offline screen        | emote   first custom emote
 *   sound       first sound command   | goal       donation goal         | powerchat  real tips
 *   panels      about panels          | share      first follower        | tour    what the site can do (viewers too)
 *
 * Entry points: openGoLiveWizard(), startGoLiveWizard(), startRestreamGuide(), openSetupHub(),
 * ?guide=<journey>[:step] on any page, and the home page's "next up" button (setupNextUp()).
 */
(function () {
    'use strict';
    if (!window.OVGuide) return;
    const G = window.OVGuide, ui = G.ui, esc = (s) => ui.esc(s);
    const api = (p, o) => G.cfg.api(p, o);
    const say = (m, t) => G.cfg.toast(m, t);
    const me = () => G.cfg.me();
    const CATS = [['irl', 'IRL', 'fa-person-walking'], ['outdoors', 'Outdoors', 'fa-mountain-sun'], ['travel', 'Travel', 'fa-plane'], ['building', 'Building / Craft', 'fa-hammer'], ['music', 'Music', 'fa-music'], ['gaming', 'Gaming', 'fa-gamepad'], ['robot', 'Robot', 'fa-robot'], ['desktop', 'Desktop', 'fa-desktop'], ['other', 'Other', 'fa-sparkles']];
    const PLAT = { twitch: ['Twitch', 'fa-brands fa-twitch', '#a970ff'], youtube: ['YouTube', 'fa-brands fa-youtube', '#ff4b4b'], kick: ['Kick', 'fa-solid fa-bolt', '#53fc18'], custom: ['Any RTMP', 'fa-solid fa-tower-broadcast', '#e5e7eb'] };
    const TASK_JOURNEY = { slot: ['golive', 'stream'], method: ['golive', 'method'], restream: ['golive', 'restream'], golive: ['golive', 'golive'], profile: ['profile'], offline: ['offline'], emote: ['emote'], sound: ['sound'], goal: ['goal'], powerchat: ['powerchat'], panels: ['panels'], share: ['share'] };
    const TASK_ICON = { slot: 'fa-tower-broadcast', method: 'fa-sliders', restream: 'fa-satellite-dish', golive: 'fa-play', profile: 'fa-user', offline: 'fa-image', emote: 'fa-face-grin-squint-tears', sound: 'fa-volume-high', goal: 'fa-bullseye', powerchat: 'fa-hand-holding-dollar', panels: 'fa-table-columns', share: 'fa-share-nodes' };

    // ── Shared stream state (slot / endpoint / restreams) ─────
    const D = { slots: [], slot: null, key: null, rtmpUrl: null, whipBase: null, dests: [], rs: null, method: null, mode: 'camera', poll: null };
    async function loadSlots() { try { const d = await api('/streams/managed'); D.slots = d.managed_streams || []; } catch { D.slots = []; } return D.slots; }
    async function loadEndpoint() { if (!D.slot) return; try { const d = await api(`/streams/managed/${D.slot.id}/profile`); D.key = d.stream_key || D.slot.stream_key || null; D.rtmpUrl = d.rtmp_url || 'rtmp://openvibe.live/live'; D.whipBase = (d.whip_url_base || location.origin).replace(/\/$/, ''); } catch { D.key = D.slot.stream_key || null; D.rtmpUrl = 'rtmp://openvibe.live/live'; D.whipBase = location.origin; } }
    async function loadDests() { if (!D.slot) return; try { const d = await api(`/restream/destinations?managed_stream_id=${D.slot.id}`); D.dests = (d.destinations || []).filter(x => !x.managed_stream_id || x.managed_stream_id === D.slot.id); } catch { D.dests = []; } try { const r = await api(`/robotstreamer/integration?managed_stream_id=${D.slot.id}`); D.rs = r && r.integration && (r.integration.robot_id || r.integration.stream_name) ? r.integration : null; } catch { D.rs = null; } }
    async function pickDefaultSlot() { await loadSlots(); const cur = (typeof _wsState !== 'undefined' && _wsState.selectedId) ? D.slots.find(s => s.id === _wsState.selectedId) : null; D.slot = cur || D.slots[0] || null; if (D.slot) { D.method = D.slot.streaming_method || 'browser'; D.mode = D.slot.browser_mode || 'camera'; await loadEndpoint(); await loadDests(); } }
    async function syncWorkspace() { try { if (typeof _wsLoadManagedStreams === 'function') await _wsLoadManagedStreams(); if (typeof _wsRenderSidebar === 'function') _wsRenderSidebar(); if (D.slot && typeof _wsSelectStream === 'function') await _wsSelectStream(D.slot.id); } catch { /* */ } }
    const onBroadcast = () => location.pathname.startsWith('/broadcast');
    /**
     * Send someone to a real control in the dashboard and point at it.
     * Targets a stable element id rather than matching heading text, opens whichever tab and
     * sub-panel actually contains it, and waits for it to be laid out before spotlighting —
     * a hidden element has a zero-size rect, which is how the spotlight used to land in the
     * top-left corner highlighting nothing.
     */
    async function dashboard(targetSel, label, hint) {
        G.close(false);
        if (!location.pathname.startsWith('/dashboard')) G.cfg.navigate('/dashboard');
        const deadline = Date.now() + 12000;
        let el = null;
        while (Date.now() < deadline) {
            el = document.querySelector(targetSel);
            if (el) {
                // Open the dashboard tab and sub-panel that own this element.
                try {
                    const panel = el.closest('.dash-tab-panel[id^="dash-panel-"]');
                    if (panel && !panel.classList.contains('active') && typeof switchDashTab === 'function') {
                        const tab = panel.id.replace('dash-panel-', '');
                        switchDashTab(tab, document.querySelector(`[data-dtab="${tab}"]`));
                        await new Promise(r => setTimeout(r, 400));
                    }
                    const sub = el.closest('.dash-subpanel');
                    if (sub && !sub.classList.contains('active')) {
                        const btn = document.querySelector(`[data-ctab="${sub.id.replace(/^dash-[a-z]+-/, '')}"]`);
                        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 400)); }
                    }
                } catch { /* */ }
                const r = el.getBoundingClientRect();
                if (r.height > 8 && el.offsetParent !== null) break;      // laid out and visible
            }
            await new Promise(r => setTimeout(r, 250));
            el = null;
        }
        if (!el) { say(`${label} is in your dashboard — scroll down to find it.`, 'info'); return; }
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* */ }
        await new Promise(r => setTimeout(r, 450));
        G.spotlight({ target: el, title: label, text: hint || 'Set it up right here — the guide is done, this is the real control.', actions: [{ label: 'Got it', primary: true }] });
    }

    // ── Journey: go live (stream → method → restream → go live) ─
    const streamStep = {
        id: 'stream', title: 'Your stream', icon: 'fa-tower-broadcast',
        heading: 'Your stream',
        render: async () => {
            await loadSlots();
            const cats = ui.chips(CATS, 'cat');
            const existing = D.slots.length ? ui.grid([
                ...D.slots.map(s => ui.pick({ id: String(s.id), icon: s.is_currently_live ? 'fa-solid fa-circle live-dot' : 'fa-solid fa-tower-broadcast', title: esc(s.title || 'Untitled'), sub: `${esc(s.streaming_method || s.protocol || 'browser')}${s.category ? ' · ' + esc(s.category) : ''}${s.is_currently_live ? ' · <em>live now</em>' : ''}`, on: D.slot && D.slot.id === s.id })),
                ui.pick({ id: 'new', icon: 'fa-solid fa-plus', title: 'New stream', sub: 'another slot with its own key, settings and restreams', attrs: 'data-new="1"' }),
            ]) : '';
            return `${ui.lead(D.slots.length ? 'Each <b>stream slot</b> is one show you run — its own title, key, VODs and restream destinations. Pick one to set up, or make a new one.' : 'A <b>stream slot</b> is one show you run — it gets its own key, settings, VODs and restream destinations. Give it a name and a category; everything else can wait.')}
                ${existing}
                <form class="ovg-form ${D.slots.length ? 'is-hidden' : ''}" id="ovg-new" onsubmit="return false">
                    ${ui.field('Stream title', '<input class="form-input" id="ovg-title-in" maxlength="80" placeholder="e.g. Late night tinkering" autocomplete="off">')}
                    <div class="ovg-field-label">Category</div>${cats}
                    ${ui.field('One line about it <span class="muted">(optional)</span>', '<input class="form-input" id="ovg-desc-in" maxlength="200" placeholder="What people will see under the title">')}
                </form>`;
        },
        mount: (el) => {
            ui.wire(el);
            const form = el.querySelector('#ovg-new');
            el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
                el.querySelectorAll('[data-pick]').forEach(x => x.classList.remove('on')); b.classList.add('on');
                if (b.dataset.pick === 'new') { D.slot = null; form.classList.remove('is-hidden'); el.querySelector('#ovg-title-in').focus(); }
                else { D.slot = D.slots.find(s => String(s.id) === b.dataset.pick) || null; form.classList.add('is-hidden'); }
                const n = document.querySelector('#ovg-foot [data-act="next"]'); if (n) n.innerHTML = D.slot ? 'Next <i class="fa-solid fa-arrow-right"></i>' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Create my stream';
            }));
            const n = document.querySelector('#ovg-foot [data-act="next"]'); if (n && !D.slot) n.innerHTML = D.slots.length ? 'Pick a stream above' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Create my stream';
        },
        validate: async () => {
            if (D.slot) { D.method = D.slot.streaming_method || 'browser'; D.mode = D.slot.browser_mode || 'camera'; await loadEndpoint(); await loadDests(); return true; }
            const form = document.querySelector('#ovg-new'); if (!form || form.classList.contains('is-hidden')) return 'Pick a stream above, or choose "New stream"';
            const t = (document.querySelector('#ovg-title-in') || {}).value || ''; if (!t.trim()) return 'Give your stream a title first';
            const cat = ui.picked(form.parentElement, 'cat');
            try {
                const d = await api('/streams/managed', { method: 'POST', body: { title: t.trim(), category: cat || null, description: ((document.querySelector('#ovg-desc-in') || {}).value || '').trim(), streaming_method: 'browser', protocol: 'webrtc' } });
                await loadSlots(); D.slot = D.slots.find(s => s.id === d.managed_stream.id) || d.managed_stream; D.method = 'browser'; D.mode = 'camera';
                await syncWorkspace(); await loadEndpoint(); await loadDests(); say(`"${t.trim()}" is ready`, 'success'); return true;
            } catch (e) { return (e && e.message) || 'Could not create the stream'; }
        },
    };
    const methodStep = {
        id: 'method', title: 'How you stream', icon: 'fa-sliders', heading: 'How will you stream?',
        render: async () => {
            if (!D.slot) await pickDefaultSlot(); if (!D.slot) return ui.lead('Create a stream first.');
            const m = D.method || D.slot.streaming_method || 'browser'; D.method = m;
            return `${ui.lead('Pick how the video gets here. You can change this any time from the Go Live page.')}
                ${ui.grid([
                    ui.pick({ id: 'browser', icon: 'fa-solid fa-globe', title: 'Browser', tag: 'Easiest', sub: 'Camera, mic or your screen — straight from this page. No software.', on: m === 'browser' }),
                    ui.pick({ id: 'rtmp', icon: 'fa-solid fa-desktop', title: 'OBS / Streamlabs', tag: 'Most flexible', sub: 'Any RTMP encoder. Scenes, overlays, the works.', on: m === 'rtmp' }),
                    ui.pick({ id: 'whip', icon: 'fa-solid fa-bolt', title: 'OBS via WHIP', tag: 'Lowest latency', sub: 'OBS 30+ over WebRTC. Sub-second latency.', on: m === 'whip' }),
                ], 3)}<div class="ovg-detail" id="ovg-method-detail"></div>`;
        },
        mount: (el) => {
            const detail = () => {
                const d = el.querySelector('#ovg-method-detail'); if (!d) return;
                const key = D.key || '(loading…)';
                if (D.method === 'browser') d.innerHTML = ui.box('Browser streaming', `<p>When you press <b>Go live</b> we'll ask for your camera and mic (or a screen to share). Nothing to install.</p><div class="ovg-seg"><button type="button" class="${D.mode === 'camera' ? 'on' : ''}" data-mode="camera"><i class="fa-solid fa-video"></i> Camera + mic</button><button type="button" class="${D.mode === 'screen' ? 'on' : ''}" data-mode="screen"><i class="fa-solid fa-display"></i> Share my screen</button></div><ul class="ovg-tips"><li>Phones work great — landscape looks best.</li><li>Good light beats a good camera.</li></ul>`, 'fa-globe');
                else if (D.method === 'rtmp') d.innerHTML = ui.box('Paste these into OBS', `${ui.kv('Server', D.rtmpUrl || 'rtmp://openvibe.live/live', true)}${ui.secret('Stream key', key)}${ui.steps(['<b>Settings</b> → <b>Stream</b>', 'Service: <b>Custom…</b>', 'Paste the server and the key', '<b>OK</b>, then <b>Start Streaming</b>'])}<p class="muted ovg-fine">Keep the key private — anyone with it can stream as you. You can regenerate it on the Go Live page.</p>`, 'fa-desktop');
                else d.innerHTML = ui.box('OBS 30+ over WHIP', `${ui.kv('Server', `${D.whipBase || location.origin}/whip/${D.slot.id}`, true)}${ui.secret('Bearer token', key)}${ui.steps(['<b>Settings</b> → <b>Stream</b>', 'Service: <b>WHIP</b>', 'Paste the server and the bearer token', '<b>OK</b>, then <b>Start Streaming</b>'])}<p class="muted ovg-fine">WHIP is WebRTC: viewers see you with under a second of delay.</p>`, 'fa-bolt');
                ui.wire(d);
                d.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => { D.mode = b.dataset.mode; d.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('on')); b.classList.add('on'); try { await api(`/streams/managed/${D.slot.id}`, { method: 'PUT', body: { browser_mode: D.mode } }); D.slot.browser_mode = D.mode; } catch { /* */ } }));
            };
            el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => { D.method = b.dataset.pick; el.querySelectorAll('[data-pick]').forEach(x => x.classList.remove('on')); b.classList.add('on'); detail(); try { await api(`/streams/managed/${D.slot.id}`, { method: 'PUT', body: { streaming_method: D.method, protocol: D.method === 'rtmp' ? 'rtmp' : 'webrtc' } }); D.slot.streaming_method = D.method; } catch (e) { say((e && e.message) || 'Could not save the method', 'error'); } }));
            detail();
        },
    };
    const restreamStep = {
        id: 'restream', title: 'Restream', icon: 'fa-satellite-dish', heading: 'Mirror it everywhere (optional)', optional: true, skipLabel: 'Skip for now',
        render: async () => {
            if (!D.slot) await pickDefaultSlot(); if (!D.slot) return ui.lead('Create a stream first.');
            const added = [...(D.rs ? [`<li class="on"><i class="fa-solid fa-robot" style="color:#4a9eff"></i> RobotStreamer · ${esc(D.rs.stream_name || ('robot ' + D.rs.robot_id))}<i class="fa-solid fa-check ovg-ok"></i></li>`] : []), ...D.dests.map(d => `<li class="on"><i class="${(PLAT[d.platform] || PLAT.custom)[1]}" style="color:${(PLAT[d.platform] || PLAT.custom)[2]}"></i> ${esc(d.name || (PLAT[d.platform] || PLAT.custom)[0])}<i class="fa-solid fa-check ovg-ok"></i></li>`)];
            return `${ui.lead(`Go live here once and the same stream goes out to every platform you add — while your chat, emotes, sound commands and controls stay on OpenVibe.${added.length ? ` <b>${added.length} already set up for "${esc(D.slot.title)}"</b> — add more, or move on.` : ' Add what you want, or skip.'}`)}
                ${added.length ? `<ul class="ovg-added">${added.join('')}</ul>` : ''}
                ${ui.grid([
                    ui.pick({ id: 'robotstreamer', icon: 'fa-solid fa-robot', title: 'RobotStreamer', sub: 'log in once, pick your robot', color: '#4a9eff' }),
                    ...Object.entries(PLAT).map(([id, [name, icon, color]]) => ui.pick({ id, icon, title: name, sub: id === 'custom' ? 'server URL + key' : 'paste your stream key', color })),
                ], 3)}<div class="ovg-detail" id="ovg-plat-form"></div>`;
        },
        mount: (el) => {
            el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { el.querySelectorAll('[data-pick]').forEach(x => x.classList.remove('on')); b.classList.add('on'); platForm(el, b.dataset.pick); }));
        },
    };
    function platForm(el, plat) {
        const f = el.querySelector('#ovg-plat-form'); if (!f) return;
        const rerender = () => G.goTo('restream', 1);
        if (plat === 'robotstreamer') {
            f.innerHTML = ui.box('RobotStreamer', `<p>Your RobotStreamer login is used once to fetch your token and robot list — the password is never stored.</p><div class="ovg-row"><input class="form-input" id="ovg-rs-user" placeholder="RobotStreamer username" autocomplete="username"><input class="form-input" id="ovg-rs-pass" type="password" placeholder="Password" autocomplete="current-password"></div><div id="ovg-rs-robots"></div><div class="ovg-row"><button type="button" class="btn btn-primary" id="ovg-rs-go"><i class="fa-solid fa-right-to-bracket"></i> Log in &amp; fetch robots</button><span class="muted" id="ovg-rs-status"></span></div>`, 'fa-robot');
            f.querySelector('#ovg-rs-go').onclick = async () => {
                const u = f.querySelector('#ovg-rs-user').value.trim(), p = f.querySelector('#ovg-rs-pass').value; if (!u || !p) return say('Enter your RobotStreamer username and password', 'error');
                const st = f.querySelector('#ovg-rs-status'); st.textContent = 'Logging in…';
                try {
                    const d = await api('/robotstreamer/integration/login', { method: 'POST', body: { user_name: u, password: p, managed_stream_id: D.slot.id } });
                    const robots = d.available_robots || [];
                    if (!robots.length) { st.textContent = 'Logged in, but no robots on that account yet.'; return; }
                    if (robots.length === 1) { D.rs = d.integration || { robot_id: robots[0].robot_id, stream_name: robots[0].stream_name || robots[0].name }; say(`RobotStreamer connected — ${D.rs.stream_name || 'robot ' + D.rs.robot_id}`, 'success'); return rerender(); }
                    f.querySelector('#ovg-rs-robots').innerHTML = `${ui.chips(robots.map(r => [String(r.robot_id), r.stream_name || r.name || r.robot_id, 'fa-robot']), 'robot')}<p class="muted ovg-fine">Pick the robot this stream drives.</p>`; ui.wire(f); st.textContent = `Logged in as ${u}. Pick a robot.`;
                    f.querySelectorAll('[data-chip]').forEach(b => b.addEventListener('click', async () => { try { const v = await api('/robotstreamer/integration/validate', { method: 'POST', body: { robot_input: b.dataset.chip, managed_stream_id: D.slot.id } }); D.rs = v.integration || { robot_id: b.dataset.chip }; say('RobotStreamer connected', 'success'); rerender(); } catch (e) { say((e && e.message) || 'Could not select that robot', 'error'); } }));
                } catch (e) { st.textContent = ''; say((e && e.message) || 'RobotStreamer login failed', 'error'); }
            };
            return;
        }
        const [name, icon] = PLAT[plat] || PLAT.custom; const needsUrl = plat === 'custom' || plat === 'kick';
        f.innerHTML = ui.box(name, `<p>${plat === 'twitch' ? 'Twitch → Creator Dashboard → Settings → Stream → copy the <b>Primary Stream key</b>.' : plat === 'youtube' ? 'YouTube Studio → Go live → copy the <b>Stream key</b>.' : plat === 'kick' ? 'Kick → Creator Dashboard → Settings → Stream key: copy the <b>URL</b> and the <b>key</b>.' : 'Paste the RTMP server URL and stream key from the service you want to mirror to.'}</p>${needsUrl ? '<input class="form-input" id="ovg-p-url" placeholder="rtmps://… server URL">' : ''}<input class="form-input" id="ovg-p-key" type="password" placeholder="${name} stream key" autocomplete="off"><label class="ovg-check"><input type="checkbox" id="ovg-p-auto" checked> Start automatically whenever I go live</label><div class="ovg-row"><button type="button" class="btn btn-primary" id="ovg-p-add"><i class="fa-solid fa-plus"></i> Add ${name}</button></div>`, icon.replace('fa-brands ', '').replace('fa-solid ', ''));
        f.querySelector('.ovg-box-head i').className = icon;
        f.querySelector('#ovg-p-add').onclick = async () => {
            const key = f.querySelector('#ovg-p-key').value.trim(); const url = needsUrl ? f.querySelector('#ovg-p-url').value.trim() : '';
            if (!key) return say('Paste the stream key first', 'error'); if (needsUrl && !url) return say('The server URL is needed too', 'error');
            try { await api('/restream/destinations', { method: 'POST', body: { platform: plat, stream_key: key, server_url: url || undefined, managed_stream_id: D.slot.id, auto_start: f.querySelector('#ovg-p-auto').checked ? 1 : 0, name } }); await loadDests(); say(`${name} added`, 'success'); rerender(); }
            catch (e) { say((e && e.message) || `Could not add ${name}`, 'error'); }
        };
    }
    const goLiveStep = {
        id: 'golive', title: 'Go live', icon: 'fa-play', heading: "You're set. Let's go live.",
        render: async () => {
            if (!D.slot) await pickDefaultSlot(); if (!D.slot) return ui.lead('Create a stream first.');
            const m = D.method || D.slot.streaming_method || 'browser'; const mname = { browser: 'Browser', rtmp: 'OBS / RTMP', whip: 'OBS / WHIP' }[m] || m;
            const dests = [...(D.rs ? ['RobotStreamer'] : []), ...D.dests.map(d => d.name || (PLAT[d.platform] || PLAT.custom)[0])];
            const u = me() || {};
            return `<div class="ovg-summary">
                <div class="ovg-sum-row"><i class="fa-solid fa-tower-broadcast"></i><span><b>${esc(D.slot.title)}</b><small>${esc(D.slot.category || 'no category yet')} · openvibe.live/@${esc(u.username || '')}${D.slot.slug ? '/' + esc(D.slot.slug) : ''}</small></span></div>
                <div class="ovg-sum-row"><i class="fa-solid fa-sliders"></i><span><b>${mname}</b><small>${m === 'browser' ? (D.mode === 'screen' ? 'sharing your screen' : 'camera + mic') : 'waiting for your encoder'}</small></span></div>
                <div class="ovg-sum-row"><i class="fa-solid fa-satellite-dish"></i><span><b>${dests.length ? esc(dests.join(', ')) : 'No restreams'}</b><small>${dests.length ? 'they start with the stream' : 'add them any time'}</small></span></div>
            </div>
            <div class="ovg-launch">${m === 'browser'
                ? `<button type="button" class="btn btn-primary btn-lg ovg-big" id="ovg-golive"><i class="fa-solid fa-play"></i> Go live now</button><p class="muted ovg-fine">We'll ask for camera/mic permission, then you're on.</p>`
                : `<div class="ovg-wait"><span class="ovg-radar"><i></i><i></i><i></i></span><b>Press <em>Start Streaming</em> in OBS</b><small>Watching for your stream — this lights up the moment it arrives.</small></div>`}</div>`;
        },
        mount: (el) => {
            const m = D.method || D.slot.streaming_method || 'browser';
            if (m === 'browser') { const b = el.querySelector('#ovg-golive'); if (b) b.onclick = async () => { G.close(true); if (!onBroadcast()) { G.cfg.navigate('/broadcast'); await new Promise(r => setTimeout(r, 1200)); } try { await syncWorkspace(); if (typeof goLiveFromWorkspace === 'function') await goLiveFromWorkspace(); else say('Press Go Live on this page to start', 'info'); } catch (e) { say((e && e.message) || 'Could not start — use the Go Live button on the page', 'error'); } }; }
            else { clearInterval(D.poll); D.poll = setInterval(async () => { if (!G.state.open) return clearInterval(D.poll); await loadSlots(); const cur = D.slots.find(s => s.id === D.slot.id); if (cur && cur.is_currently_live) { clearInterval(D.poll); celebrate(el, cur); } }, 4000); }
        },
        footer: () => `<button type="button" class="btn btn-outline" data-act="back"><i class="fa-solid fa-arrow-left"></i> Back</button><span class="ovg-foot-note">Step 4 of 4</span><button type="button" class="btn btn-outline" data-act="next">Finish</button>`,
        next: 'close',
    };
    function celebrate(el, slot) {
        const u = me() || {}; const path = `/@${u.username || ''}${slot && slot.slug ? '/' + slot.slug : ''}`;
        el.innerHTML = `<div class="ovg-live"><div class="ovg-live-badge">LIVE</div><h3>You're live!</h3><p>Your stream is on OpenVibe${D.dests.length || D.rs ? ' and heading out to your restreams' : ''}. Go say hi to chat.</p><a class="btn btn-primary btn-lg" href="${path}" onclick="OVGuide.close(true); return handleLinkClick(event, '${path}')"><i class="fa-solid fa-eye"></i> Open my channel</a></div>`;
        ui.confetti();
    }
    G.register('golive', { title: 'Go Live setup', kicker: 'Go Live setup', steps: [streamStep, methodStep, restreamStep, goLiveStep], onOpen: async (ctx, opts) => { D.slot = null; if (opts.step && opts.step !== 'stream') await pickDefaultSlot(); }, onClose: () => { clearInterval(D.poll); try { if (typeof _wsLoadManagedStreams === 'function') _wsLoadManagedStreams().then(() => { if (typeof _wsRenderSidebar === 'function') _wsRenderSidebar(); }); } catch { /* */ } } });
    G.register('restream', { title: 'Restream setup', kicker: 'Restream setup', steps: [{ ...restreamStep, optional: false, nextLabel: 'Done', next: 'close' }], onOpen: pickDefaultSlot });

    // ── Mini journeys (one screen each, all real forms) ───────
    const one = (id, title, icon, render, mount, validate, nextLabel) => G.register(id, { title, kicker: 'Streamer setup', noStepBar: true, steps: [{ id: 'main', title, icon, heading: title, render, mount, validate, nextLabel: nextLabel || 'Done', next: 'close' }] });
    one('profile', 'Avatar and bio', 'fa-user', async () => { const u = me() || {}; return `${ui.lead('The first thing people see on your channel and next to every chat message.')}<div class="ovg-profile"><label class="ovg-avatar-pick" for="ovg-avatar-file">${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="">` : `<span>${esc(String(u.display_name || u.username || '?').charAt(0).toUpperCase())}</span>`}<i class="fa-solid fa-camera"></i></label><input type="file" id="ovg-avatar-file" accept="image/*" hidden><div class="ovg-profile-body">${ui.field('Bio', `<textarea class="form-input" id="ovg-bio" rows="3" maxlength="500" placeholder="What you stream, when, and why people should stick around">${esc(u.bio || '')}</textarea>`)}<p class="muted ovg-fine">Tap the picture to change your avatar. Square images look best.</p></div></div>`; },
        (el) => { const f = el.querySelector('#ovg-avatar-file'); f.addEventListener('change', async () => { const file = f.files && f.files[0]; if (!file) return; try { const d = await ui.upload('/auth/avatar', {}, file, 'avatar'); const url = d.avatar_url || (d.user && d.user.avatar_url); if (url) { el.querySelector('.ovg-avatar-pick').innerHTML = `<img src="${esc(url)}" alt=""><i class="fa-solid fa-camera"></i>`; const u = me(); if (u) u.avatar_url = url; } say('Avatar updated', 'success'); } catch (e) { say((e && e.message) || 'Upload failed', 'error'); } }); },
        async () => { const bio = (document.querySelector('#ovg-bio') || {}).value || ''; try { await api('/auth/profile', { method: 'PUT', body: { bio: bio.trim() } }); const u = me(); if (u) u.bio = bio.trim(); say('Profile saved', 'success'); return true; } catch (e) { return (e && e.message) || 'Could not save'; } }, 'Save');
    one('goal', 'Set a donation goal', 'fa-bullseye', async () => `${ui.lead('A visible target on your channel turns tips into a team effort. Keep the first one small and specific.')}${ui.field('What are you saving for?', '<input class="form-input" id="ovg-goal-title" maxlength="80" placeholder="e.g. New capture card">')}${ui.field('Target (Vibes)', '<input class="form-input" id="ovg-goal-amount" type="number" min="1" step="1" placeholder="500">')}<p class="muted ovg-fine">Goals show on your channel page and in the stream overlay; progress updates live as tips come in.</p>`,
        null, async () => { const t = (document.querySelector('#ovg-goal-title') || {}).value || '', a = parseInt((document.querySelector('#ovg-goal-amount') || {}).value, 10); if (!t.trim()) return 'Name the goal'; if (!(a > 0)) return 'Set a target amount'; try { await api('/funds/goals', { method: 'POST', body: { title: t.trim(), target_amount: a } }); say('Goal created', 'success'); ui.confetti(); return true; } catch (e) { return (e && e.message) || 'Could not create the goal'; } }, 'Create goal');
    one('emote', 'Upload a custom emote', 'fa-face-grin-squint-tears', async () => `${ui.lead('Your chat, your inside jokes. Viewers type the code and the image shows in chat. PNG, GIF (animated) or WebP, square, 112px or larger looks crisp.')}${ui.field('Emote code', '<input class="form-input" id="ovg-emote-code" maxlength="32" placeholder="e.g. gooseHype" autocomplete="off">')}<label class="ovg-drop" for="ovg-emote-file" id="ovg-emote-drop"><i class="fa-solid fa-image"></i><span>Tap to choose the image</span></label><input type="file" id="ovg-emote-file" accept="image/png,image/gif,image/webp,image/jpeg" hidden>`,
        (el) => { const f = el.querySelector('#ovg-emote-file'), d = el.querySelector('#ovg-emote-drop'); f.addEventListener('change', () => { const file = f.files && f.files[0]; if (!file) return; const r = new FileReader(); r.onload = () => { d.innerHTML = `<img src="${r.result}" alt=""><span>${esc(file.name)}</span>`; }; r.readAsDataURL(file); }); },
        async () => { const code = ((document.querySelector('#ovg-emote-code') || {}).value || '').trim(); const f = document.querySelector('#ovg-emote-file'); const file = f && f.files && f.files[0]; if (!code) return 'Give the emote a code'; if (!file) return 'Choose an image'; try { await ui.upload('/emotes', { code }, file, 'image'); say(`Emote "${code}" is live in your chat`, 'success'); ui.confetti(); return true; } catch (e) { return (e && e.message) || 'Upload failed'; } }, 'Upload emote');
    one('sound', 'Add a sound command', 'fa-volume-high', async () => `${ui.lead('Viewers type <b>!boom</b> in chat and your stream plays it. Short clips hit hardest — under 5 seconds.')}${ui.field('Command', '<div class="ovg-prefix"><span>!</span><input class="form-input" id="ovg-sound-cmd" maxlength="24" placeholder="boom" autocomplete="off"></div>')}<label class="ovg-drop" for="ovg-sound-file" id="ovg-sound-drop"><i class="fa-solid fa-music"></i><span>Tap to choose the audio (mp3, ogg, wav)</span></label><input type="file" id="ovg-sound-file" accept="audio/*" hidden>`,
        (el) => { const f = el.querySelector('#ovg-sound-file'), d = el.querySelector('#ovg-sound-drop'); f.addEventListener('change', () => { const file = f.files && f.files[0]; if (file) d.innerHTML = `<i class="fa-solid fa-check"></i><span>${esc(file.name)}</span>`; }); },
        async () => { const cmd = ((document.querySelector('#ovg-sound-cmd') || {}).value || '').trim().replace(/^!+/, ''); const f = document.querySelector('#ovg-sound-file'); const file = f && f.files && f.files[0]; if (!cmd) return 'Name the command'; if (!file) return 'Choose an audio file'; try { await ui.upload('/sounds', { command: cmd }, file, 'sound'); say(`!${cmd} is ready`, 'success'); ui.confetti(); return true; } catch (e) { return (e && e.message) || 'Upload failed'; } }, 'Add sound');
    one('offline', 'Offline screen', 'fa-image', async () => `${ui.lead('What visitors see on your channel when you are not live: an image, a looping video, or your own HTML page. It sits above your top content and the discover board.')}${ui.grid([ui.pick({ id: 'image', icon: 'fa-solid fa-image', title: 'Image', sub: 'a banner or a still from your stream' }), ui.pick({ id: 'video', icon: 'fa-solid fa-film', title: 'Video loop', sub: 'a short muted clip' }), ui.pick({ id: 'html', icon: 'fa-solid fa-code', title: 'Custom HTML', sub: 'anything you can build' })], 3)}<p class="muted ovg-fine">The upload lives in your dashboard — the button below takes you straight to it and points at the right spot.</p>`,
        (el) => { el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { el.querySelectorAll('[data-pick]').forEach(x => x.classList.remove('on')); b.classList.add('on'); })); },
        async () => { dashboard('#dash-card-offline', 'Offline Screen', 'Pick an image, a looping video or your own HTML — this is what visitors see when you are not live.'); return true; }, 'Open the offline screen settings');
    one('panels', 'Your About panels', 'fa-table-columns', async () => `${ui.lead('Panels are the blocks under your player: schedule, links, rules, gear, whatever you want people to know. They live on your channel page and in the About tab.')}${ui.steps(['Open your channel page', 'Tap <b>About</b> → <b>Edit panels</b>', 'Add a title and text (links and images work)', 'Save — it shows up for everyone right away'])}`,
        null, async () => { const u = me(); G.close(false); G.cfg.navigate(`/@${(u && u.username) || ''}#about`); return true; }, 'Go to my channel');
    one('powerchat', 'Connect PowerChat', 'fa-hand-holding-dollar', async () => `${ui.lead('PowerChat handles real-money tips (card and crypto) for OpenVibe streamers, with alerts on your stream and a tip link you can share anywhere.')}${ui.steps(['Press <b>Connect PowerChat</b> — you sign in there once', 'Tips land as chat alerts with the amount and message', 'Your channel gets a <b>Tip</b> button and a shareable tip link'])}<p class="muted ovg-fine">Nothing to pay to set up; PowerChat takes its cut per tip.</p>`,
        null, async () => { G.close(false); location.href = '/api/powerchat/oauth/start'; return true; }, 'Connect PowerChat');
    one('share', 'Get your first follower', 'fa-share-nodes', async () => { const u = me() || {}; const link = `${location.origin}/@${u.username || ''}`; return `${ui.lead('Followers get pinged the moment you go live, and they show up on your channel. Share the link where your people already are.')}${ui.kv('Your channel', link, true)}<div class="ovg-row"><a class="btn btn-outline" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(`I'm streaming on OpenVibe.Live — follow me at ${link}`)}"><i class="fa-brands fa-x-twitter"></i> Post</a><a class="btn btn-outline" target="_blank" rel="noopener" href="https://discord.gg/M6MuRUaeJj"><i class="fa-brands fa-discord"></i> Say hi in the Discord</a></div><ul class="ovg-tips"><li>Restream to where you already have viewers and tell them the chat lives here.</li><li>Go live at a regular time — the after-show reports and the Star of the day reward showing up.</li></ul>`; },
        (el) => ui.wire(el), null, 'Done');

    // ── Journey: the setup hub (checklist) ────────────────────
    let PROG = null;
    async function loadProgress() { try { PROG = await api('/streams/setup-progress'); } catch { PROG = null; } return PROG; }
    G.register('setup-hub', {
        title: 'Streamer setup', kicker: 'Streamer setup', noStepBar: true, onOpen: loadProgress,
        steps: [{
            id: 'hub', title: 'Streamer setup', icon: 'fa-list-check',
            heading: 'Your streaming setup',
            render: async (ctx) => {
                const p = PROG || await loadProgress();
                if (!p) return ui.lead('Could not load your setup right now.');
                const pct = Math.round((p.done / p.total) * 100);
                const groups = {}; p.tasks.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t); });
                const next = p.next;
                return `<div class="ovg-hub-top"><div class="ovg-ring" style="--pct:${pct}"><span>${p.done}<small>/${p.total}</small></span></div><div><div class="ovg-hub-title">${pct === 100 ? 'Everything is set up. Go be great.' : next ? `Next up: ${esc(next.title)}` : 'Nice work'}</div><div class="ovg-hub-sub">${pct === 100 ? 'Come back any time something new ships.' : next ? esc(next.why) : ''}</div>${next ? `<button type="button" class="btn btn-primary" data-task="${esc(next.id)}"><i class="fa-solid ${TASK_ICON[next.id] || 'fa-arrow-right'}"></i> Do it now</button>` : ''}</div></div>
                ${Object.entries(groups).map(([g, tasks]) => `<div class="ovg-hub-group"><h4>${esc(g)}</h4><ul class="ovg-tasks">${tasks.map(t => `<li class="${t.done ? 'done' : ''} ${ctx.focus === t.id ? 'focus' : ''}"><span class="ovg-task-ico"><i class="fa-solid ${t.done ? 'fa-check' : (TASK_ICON[t.id] || 'fa-circle')}"></i></span><span class="ovg-task-body"><b>${esc(t.title)}${t.done && t.count > 1 ? ` <small>×${t.count}</small>` : ''}</b><small>${esc(t.why)}</small></span><button type="button" class="btn btn-sm ${t.done ? 'btn-outline' : 'btn-primary'}" data-task="${esc(t.id)}">${t.done ? 'Revisit' : 'Set up'}</button></li>`).join('')}</ul></div>`).join('')}`;
            },
            mount: (el) => { el.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => { const [j, step] = TASK_JOURNEY[b.dataset.task] || []; if (!j) return; const needsBroadcast = j === 'golive' && !onBroadcast(); if (needsBroadcast) { G.close(false); G.cfg.navigate(`/broadcast?guide=golive${step ? ':' + step : ''}`); } else G.open(j, { step }); })); },
            footer: () => `<span class="ovg-foot-note">Everything here is optional — do it in any order.</span><button type="button" class="btn btn-outline" data-act="next">Close</button>`,
            next: 'close',
        }],
    });

    // ── Journey: site tour (for anyone, logged in or not) ─────
    const tourStep = (id, icon, title, html) => ({ id, icon, title, heading: title, render: async () => html });
    G.register('tour', {
        title: 'What OpenVibe can do', kicker: 'Quick tour', requiresUser: false,
        steps: [
            tourStep('stream', 'fa-tower-broadcast', 'One stream, everywhere', `${ui.lead('Go live from your browser, OBS or a robot, and mirror the same stream to Twitch, YouTube, Kick, RobotStreamer or any RTMP server at once. Chat from every platform lands in one place.')}<ul class="ovg-tips"><li>Sub-second WebRTC latency for viewers here.</li><li>Every stream is recorded; clips and AI moments are cut for you.</li></ul>`),
            tourStep('chat', 'fa-comments', 'Chat is the show', `${ui.lead('7TV, BTTV, FFZ and custom emotes; sound commands like <b>!boom</b> that play on stream; server-rendered TTS with collectible voices; auto-translation both ways for non-English streamers.')}<ul class="ovg-tips"><li>Type <b>.</b> before a message to keep it out of TTS.</li><li>Viewers earn Vibes for watching and chatting.</li></ul>`),
            tourStep('arena', 'fa-microphone-lines', 'The Arena', `${ui.lead('Everything streamers say on mic is judged by AI: the best trash talk lands in the Arena, callouts open beefs, and levels rise with the mouth. Chat can <b>!hype</b> a fight but never write one.')}`),
            tourStep('after', 'fa-clipboard-list', 'After every stream', `${ui.lead('An after-show report with a grade, the viewer curve, the loudest chatters, mic moments and clips — plus a daily AI-picked Star of OpenVibe and a fresh daily secret to crack.')}`),
            tourStep('you', 'fa-user-astronaut', 'Your turn', `${ui.lead(me() ? 'You have an account — the streamer setup walks you through everything in a few minutes.' : 'One free account works across the whole OpenVibe network. Sign in and the setup walks you through your first stream.')}`),
        ],
        onClose: (ctx, finished) => { if (finished && me()) G.open('setup-hub'); },
    });

    // ── Entry points ───────────────────────────────────────────
    window.openGoLiveWizard = (o = {}) => { const step = o.step || 'stream'; if (onBroadcast()) return G.open('golive', { step }); G.cfg.navigate(`/broadcast?guide=golive:${step}`); };
    window.startGoLiveWizard = () => openGoLiveWizard({ step: 'stream' });
    window.startRestreamGuide = () => { if (onBroadcast()) return G.open('golive', { step: 'restream' }); G.cfg.navigate('/broadcast?guide=golive:restream'); };
    window.openSetupHub = (focus) => G.open('setup-hub', { ctx: { focus } });
    window.openSiteTour = () => G.open('tour');
    // ── The home page quest / join panel ──────────────────────
    //
    // One slot in the tour card, two audiences. A signed-in streamer sees how far through setup
    // they are as a tank of water that fills as they finish tasks — it names the next task, and
    // the level visibly rises the first time they come back after finishing one. Everyone else
    // sees what an account actually gets them, because "Sign in" on its own is not a reason.

    const PERKS = [
        ['fa-tower-broadcast', 'Go live for free', 'Browser, OBS or a robot. No approval queue, no invite, no waiting list.'],
        ['fa-satellite-dish', 'Restream everywhere at once', 'Twitch, YouTube, Kick, RobotStreamer and any RTMP server from one stream.'],
        ['fa-comments', 'One chat, every platform', '7TV, BTTV and FFZ emotes, sound commands and TTS, translated both ways.'],
        ['fa-coins', 'Earn Vibes just for watching', 'Spend them on emotes, themes, cosmetics and sounds that play on stream.'],
        ['fa-scissors', 'Clips and VODs cut for you', 'Every stream is recorded and the good bits are found automatically.'],
        ['fa-circle-nodes', 'One account, whole network', 'The same login works across every OpenVibe site and tool.'],
    ];

    /** Water colour by progress — cool at the start, gold once it is done. */
    function questTone(pct) {
        if (pct >= 100) return { c: '#fbbf24', ico: 'fa-trophy' };
        if (pct >= 66) return { c: '#4ade80', ico: 'fa-bolt' };
        if (pct >= 33) return { c: '#2dd4bf', ico: 'fa-droplet' };
        return { c: 'var(--accent)', ico: 'fa-droplet' };
    }

    const SEEN_KEY = 'ov_quest_seen_done';

    function renderQuest(el, p) {
        const pct = Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
        const tone = questTone(pct);
        const next = p.next;
        const icon = next ? (TASK_ICON[next.id] || 'fa-arrow-right') : 'fa-trophy';
        // Did they finish something since they last looked? Then let the water surge up to meet it.
        let prev = null;
        try { const v = localStorage.getItem(SEEN_KEY); if (v !== null) prev = parseInt(v, 10); } catch { /* */ }
        const gained = Number.isFinite(prev) && p.done > prev ? p.done - prev : 0;
        const startPct = gained ? Math.round((prev / p.total) * 100) : pct;

        el.innerHTML = `
            <button type="button" class="ovg-quest${pct >= 100 ? ' is-done' : ''}" style="--q:${tone.c};--pct:${startPct}"
                aria-label="${next ? `Streamer setup, ${p.done} of ${p.total} done. Next up: ${esc(next.title)}` : 'Streamer setup complete'}">
                <span class="ovg-quest-liquid" aria-hidden="true">
                    <span class="ovg-quest-wave"></span><span class="ovg-quest-wave ovg-quest-wave--b"></span>
                    ${[9, 27, 46, 63, 81].map((x, i) => `<span class="ovg-quest-bub" style="--x:${x}%;--i:${i}"></span>`).join('')}
                </span>
                <span class="ovg-quest-sheen" aria-hidden="true"></span>
                <span class="ovg-quest-ico"><i class="fa-solid ${icon}"></i></span>
                <span class="ovg-quest-text">
                    <b>${next ? `Next up: ${esc(next.title)}` : 'Streamer setup complete'}</b>
                    <small>${next ? esc(next.why) : 'Everything on the list is done. Come back when something new ships.'}</small>
                </span>
                <span class="ovg-quest-count"><b>${p.done}</b><i>/${p.total}</i></span>
                <span class="ovg-quest-go" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
                ${gained ? `<span class="ovg-quest-pop">+${gained}</span>` : ''}
            </button>`;

        const btn = el.firstElementChild;
        btn.addEventListener('click', () => openSetupHub(next ? next.id : null));
        if (gained) {
            // Fill from where they were to where they are, so the progress is something they watch happen.
            requestAnimationFrame(() => setTimeout(() => { btn.style.setProperty('--pct', pct); btn.classList.add('is-surging'); }, 550));
            setTimeout(() => btn.classList.remove('is-surging'), 3200);
        }
        try { localStorage.setItem(SEEN_KEY, String(p.done)); } catch { /* */ }
    }

    function renderJoin(el) {
        el.innerHTML = `
            <div class="ovg-join">
                <span class="ovg-join-glow" aria-hidden="true"></span>
                <div class="ovg-join-head">
                    <span class="ovg-join-mark" aria-hidden="true"><i class="fa-solid fa-circle-nodes"></i></span>
                    <div>
                        <h3>Make a free account and the whole thing opens up</h3>
                        <p>Free to make, works everywhere on the network, and takes about ten seconds.</p>
                    </div>
                </div>
                <ul class="ovg-join-perks">
                    ${PERKS.map(([ico, title, why], i) => `<li style="--i:${i}"><span class="ovg-join-ico"><i class="fa-solid ${ico}"></i></span><span><b>${title}</b><small>${why}</small></span></li>`).join('')}
                </ul>
                <div class="ovg-join-cta">
                    <a class="btn btn-primary btn-lg ovg-join-go" href="/api/auth/sso/login"><i class="fa-solid fa-user-plus"></i> Create your free account</a>
                    <a class="btn btn-outline ovg-join-in" href="/api/auth/sso/login"><i class="fa-solid fa-right-to-bracket"></i> I already have one</a>
                    <button type="button" class="ovg-join-tour"><i class="fa-solid fa-wand-magic-sparkles"></i> Just show me around first</button>
                </div>
            </div>`;
        el.querySelector('.ovg-join-tour').addEventListener('click', () => openSiteTour());
    }

    window.setupNextUp = async function (el) {
        // The home page slot: setup progress for signed-in streamers, the pitch for everyone else.
        if (!el) return;
        if (!me()) { if (!el.querySelector('.ovg-join')) renderJoin(el); return; }
        const p = await loadProgress();
        if (!p || !p.total) return;
        renderQuest(el, p);
    };
    // First visit to Go Live with no slots → the go-live journey opens itself (until dismissed once).
    (function autoFirstTime() {
        const tryIt = async () => {
            if (!onBroadcast() || G.state.open) return;
            if (new URLSearchParams(location.search).get('guide')) return;
            if (G.progress('golive').dismissed || G.progress('golive').finished) return;
            for (let i = 0; i < 40 && !me(); i++) await new Promise(r => setTimeout(r, 250)); if (!me()) return;
            await loadSlots(); if (!D.slots.length) G.open('golive', { step: 'stream' });
        };
        const _push = history.pushState; history.pushState = function () { const r = _push.apply(this, arguments); setTimeout(tryIt, 400); return r; };
        setTimeout(tryIt, 800);
    })();
})();
