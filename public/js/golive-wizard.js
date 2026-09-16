/**
 * golive-wizard.js — the Go Live setup wizard: first stream to first frame, step by step.
 *
 *   openGoLiveWizard({ step })   step: 'stream' | 'method' | 'restream' | 'golive'
 *
 * Four steps, every one driven by the real APIs (no fragile clicking around the workspace):
 *   1. Your stream    — pick an existing slot or create one (title, category)
 *   2. How you stream — Browser (cam / screen), OBS via RTMP, or OBS via WHIP; shows the
 *                       server + key with copy buttons and the exact OBS clicks
 *   3. Restream       — RobotStreamer (log in & pick the robot), Twitch / YouTube / Kick /
 *                       any RTMP with a stream key; optional
 *   4. Go live        — Browser: goes live from here. OBS: waits for your encoder and
 *                       celebrates when the stream shows up.
 *
 * Opens on its own the first time someone lands on Go Live with no slots (until dismissed),
 * from /broadcast?setup=new|restream, and from the home page's "Set up restreams" button.
 */
(function () {
    'use strict';
    const CATS = [['irl', 'IRL', 'fa-person-walking'], ['outdoors', 'Outdoors', 'fa-mountain-sun'], ['travel', 'Travel', 'fa-plane'], ['building', 'Building / Craft', 'fa-hammer'], ['music', 'Music', 'fa-music'], ['gaming', 'Gaming', 'fa-gamepad'], ['robot', 'Robot', 'fa-robot'], ['desktop', 'Desktop', 'fa-desktop'], ['other', 'Other', 'fa-sparkles']];
    const STEPS = [['stream', 'Your stream', 'fa-tower-broadcast'], ['method', 'How you stream', 'fa-sliders'], ['restream', 'Restream', 'fa-satellite-dish'], ['golive', 'Go live', 'fa-play']];
    const PLAT = { twitch: ['Twitch', 'fa-brands fa-twitch', '#a970ff'], youtube: ['YouTube', 'fa-brands fa-youtube', '#ff4b4b'], kick: ['Kick', 'fa-solid fa-bolt', '#53fc18'], custom: ['Any RTMP', 'fa-solid fa-tower-broadcast', '#e5e7eb'] };
    const S = { open: false, step: 'stream', slots: [], slot: null, method: null, mode: 'camera', key: null, rtmpUrl: null, whipBase: null, dests: [], rs: null, poll: null, dir: 1 };
    const $ = (sel, root) => (root || document).querySelector(sel);
    const h = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
    const say = (m, t) => { try { toast(m, t || 'info'); } catch { /* */ } };
    // app.js keeps the signed-in user in a top-level `let`, not on window — read it the right way.
    const me = () => { try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch { return null; } };

    // ── Shell ──────────────────────────────────────────────────
    function ensure() {
        let root = $('#glw');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'glw'; root.className = 'glw';
        root.innerHTML = `<div class="glw-scrim"></div>
            <div class="glw-card" role="dialog" aria-modal="true" aria-label="Go Live setup">
                <button type="button" class="glw-close" aria-label="Close" onclick="closeGoLiveWizard()"><i class="fa-solid fa-xmark"></i></button>
                <div class="glw-head"><span class="ov-mark" data-size="30"></span><div><div class="glw-kicker">Go Live setup</div><div class="glw-title" id="glw-title">Let's get you live</div></div></div>
                <ol class="glw-steps" id="glw-steps"></ol>
                <div class="glw-body"><div class="glw-panel" id="glw-panel"></div></div>
                <div class="glw-foot" id="glw-foot"></div>
            </div>`;
        document.body.appendChild(root);
        $('.glw-scrim', root).addEventListener('click', () => closeGoLiveWizard());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closeGoLiveWizard(); });
        if (typeof ovMarkMount === 'function') ovMarkMount(root);
        return root;
    }
    function renderSteps() {
        const idx = STEPS.findIndex(s => s[0] === S.step);
        $('#glw-steps').innerHTML = STEPS.map(([id, label, icon], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="glw-step-dot"><i class="fa-solid ${i < idx ? 'fa-check' : icon}"></i></span><span class="glw-step-label">${label}</span></li>`).join('');
        $('#glw-steps').style.setProperty('--p', `${(idx / (STEPS.length - 1)) * 100}%`);
    }
    function go(step, dir) {
        S.dir = dir || (STEPS.findIndex(s => s[0] === step) >= STEPS.findIndex(s => s[0] === S.step) ? 1 : -1);
        S.step = step;
        const panel = $('#glw-panel');
        panel.classList.remove('in-l', 'in-r'); void panel.offsetWidth;
        renderSteps();
        ({ stream: renderStream, method: renderMethod, restream: renderRestream, golive: renderGoLive })[step]();
        panel.classList.add(S.dir > 0 ? 'in-r' : 'in-l');
        try { if (typeof ovMarkMount === 'function') ovMarkMount(panel); } catch { /* */ }
        panel.scrollTop = 0;
    }
    function foot(html) { $('#glw-foot').innerHTML = html; }
    function title(t) { $('#glw-title').textContent = t; }

    // ── Data ───────────────────────────────────────────────────
    async function loadSlots() { try { const d = await api('/streams/managed'); S.slots = d.managed_streams || []; } catch { S.slots = []; } return S.slots; }
    async function loadEndpoint() {
        if (!S.slot) return;
        try { const d = await api(`/streams/managed/${S.slot.id}/profile`); S.key = d.stream_key || S.slot.stream_key || null; S.rtmpUrl = d.rtmp_url || 'rtmp://openvibe.live/live'; S.whipBase = (d.whip_url_base || location.origin).replace(/\/$/, ''); }
        catch { S.key = S.slot.stream_key || null; S.rtmpUrl = 'rtmp://openvibe.live/live'; S.whipBase = location.origin; }
    }
    async function loadDests() {
        if (!S.slot) return;
        try { const d = await api(`/restream/destinations?managed_stream_id=${S.slot.id}`); S.dests = (d.destinations || d || []).filter(x => !x.managed_stream_id || x.managed_stream_id === S.slot.id); } catch { S.dests = []; }
        try { const r = await api(`/robotstreamer/integration?managed_stream_id=${S.slot.id}`); S.rs = r && r.integration && (r.integration.robot_id || r.integration.stream_name) ? r.integration : null; } catch { S.rs = null; }
    }
    async function syncWorkspace() {
        try { if (typeof _wsLoadManagedStreams === 'function') await _wsLoadManagedStreams(); if (typeof _wsRenderSidebar === 'function') _wsRenderSidebar(); if (S.slot && typeof _wsSelectStream === 'function') await _wsSelectStream(S.slot.id); } catch { /* */ }
    }

    // ── Step 1: your stream ───────────────────────────────────
    function renderStream() {
        title(S.slots.length ? 'Which stream are we setting up?' : 'First, your stream');
        const cats = CATS.map(([v, l, i]) => `<button type="button" class="glw-chip" data-cat="${v}"><i class="fa-solid ${i}"></i> ${l}</button>`).join('');
        const existing = S.slots.length ? `<div class="glw-grid">${S.slots.map(s => `
            <button type="button" class="glw-pick ${S.slot && S.slot.id === s.id ? 'on' : ''}" data-slot="${s.id}">
                <span class="glw-pick-ico"><i class="fa-solid ${s.is_currently_live ? 'fa-circle live-dot' : 'fa-tower-broadcast'}"></i></span>
                <span class="glw-pick-body"><b>${h(s.title || 'Untitled')}</b><small>${h(s.streaming_method || s.protocol || 'browser')}${s.category ? ' · ' + h(s.category) : ''}${s.is_currently_live ? ' · <em>live now</em>' : ''}</small></span>
            </button>`).join('')}
            <button type="button" class="glw-pick glw-pick--new" data-slot="new"><span class="glw-pick-ico"><i class="fa-solid fa-plus"></i></span><span class="glw-pick-body"><b>New stream</b><small>another slot with its own key, settings and restreams</small></span></button>
        </div>` : '';
        $('#glw-panel').innerHTML = `
            <p class="glw-lead">${S.slots.length ? 'Each <b>stream slot</b> is one show you run — its own title, key, VODs and restream destinations. Pick one to set up, or make a new one.' : 'A <b>stream slot</b> is one show you run — it gets its own key, settings, VODs and restream destinations. Give it a name and a category; everything else can wait.'}</p>
            ${existing}
            <form class="glw-form ${S.slots.length ? 'is-hidden' : ''}" id="glw-new">
                <label>Stream title<input class="form-input" id="glw-title-in" maxlength="80" placeholder="e.g. Late night tinkering" autocomplete="off"></label>
                <label>Category</label><div class="glw-chips" id="glw-cats">${cats}</div>
                <label>One line about it <span class="muted">(optional)</span><input class="form-input" id="glw-desc-in" maxlength="200" placeholder="What people will see under the title"></label>
            </form>`;
        const form = $('#glw-new');
        $('#glw-panel').querySelectorAll('[data-slot]').forEach(b => b.addEventListener('click', () => {
            $('#glw-panel').querySelectorAll('[data-slot]').forEach(x => x.classList.remove('on')); b.classList.add('on');
            if (b.dataset.slot === 'new') { S.slot = null; form.classList.remove('is-hidden'); $('#glw-title-in').focus(); }
            else { S.slot = S.slots.find(s => String(s.id) === b.dataset.slot) || null; form.classList.add('is-hidden'); }
            renderStreamFoot();
        }));
        $('#glw-cats').addEventListener('click', (e) => { const c = e.target.closest('[data-cat]'); if (!c) return; $('#glw-cats').querySelectorAll('.glw-chip').forEach(x => x.classList.remove('on')); c.classList.add('on'); });
        renderStreamFoot();
    }
    function renderStreamFoot() {
        const formOpen = !$('#glw-new').classList.contains('is-hidden');
        const creating = !S.slot && formOpen;
        const undecided = !S.slot && !formOpen;              // slots exist, nothing picked yet
        foot(`<span class="glw-foot-note">Step 1 of 4</span><button type="button" class="btn btn-primary btn-lg" id="glw-next" ${undecided ? 'disabled' : ''}>${undecided ? 'Pick a stream above' : creating ? '<i class="fa-solid fa-wand-magic-sparkles"></i> Create my stream' : 'Next <i class="fa-solid fa-arrow-right"></i>'}</button>`);
        $('#glw-next').onclick = async () => {
            if (undecided) return;
            if (S.slot) { await loadEndpoint(); await loadDests(); return go('method'); }
            const t = ($('#glw-title-in') || {}).value || '';
            const cat = ($('#glw-cats .glw-chip.on') || {}).dataset ? $('#glw-cats .glw-chip.on').dataset.cat : '';
            if (!t.trim()) { say('Give your stream a title first', 'error'); $('#glw-title-in').focus(); return; }
            const btn = $('#glw-next'); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Creating…';
            try {
                const d = await api('/streams/managed', { method: 'POST', body: { title: t.trim(), category: cat || null, description: (($('#glw-desc-in') || {}).value || '').trim(), streaming_method: 'browser', protocol: 'webrtc' } });
                S.slot = d.managed_stream; await loadSlots(); S.slot = S.slots.find(s => s.id === d.managed_stream.id) || d.managed_stream;
                await syncWorkspace(); await loadEndpoint(); await loadDests();
                say(`"${t.trim()}" is ready`, 'success'); go('method');
            } catch (e) { say((e && e.message) || 'Could not create the stream', 'error'); btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Create my stream'; }
        };
    }

    // ── Step 2: how you stream ────────────────────────────────
    function renderMethod() {
        title('How will you stream?');
        const m = S.method || S.slot.streaming_method || 'browser';
        S.method = m; S.mode = S.slot.browser_mode || S.mode || 'camera';
        const cards = [
            ['browser', 'fa-globe', 'Browser', 'Camera, mic or your screen — straight from this page. No software.', 'Easiest'],
            ['rtmp', 'fa-desktop', 'OBS / Streamlabs', 'Any RTMP encoder. Scenes, overlays, the works.', 'Most flexible'],
            ['whip', 'fa-bolt', 'OBS via WHIP', 'OBS 30+ over WebRTC. Sub-second latency.', 'Lowest latency'],
        ].map(([id, i, name, sub, tag]) => `<button type="button" class="glw-pick glw-pick--method ${m === id ? 'on' : ''}" data-method="${id}"><span class="glw-pick-ico"><i class="fa-solid ${i}"></i></span><span class="glw-pick-body"><b>${name} <em class="glw-tag">${tag}</em></b><small>${sub}</small></span></button>`).join('');
        $('#glw-panel').innerHTML = `<p class="glw-lead">Pick how the video gets here. You can change this any time from the Go Live page.</p><div class="glw-grid glw-grid--3">${cards}</div><div class="glw-detail" id="glw-detail"></div>`;
        $('#glw-panel').querySelectorAll('[data-method]').forEach(b => b.addEventListener('click', async () => {
            S.method = b.dataset.method; $('#glw-panel').querySelectorAll('[data-method]').forEach(x => x.classList.remove('on')); b.classList.add('on'); renderMethodDetail();
            try { await api(`/streams/managed/${S.slot.id}`, { method: 'PUT', body: { streaming_method: S.method, protocol: S.method === 'rtmp' ? 'rtmp' : 'webrtc' } }); S.slot.streaming_method = S.method; } catch (e) { say((e && e.message) || 'Could not save the method', 'error'); }
        }));
        renderMethodDetail();
        foot(`<button type="button" class="btn btn-outline" onclick="window.__glwBack()"><i class="fa-solid fa-arrow-left"></i> Back</button><span class="glw-foot-note">Step 2 of 4</span><button type="button" class="btn btn-primary btn-lg" onclick="window.__glwNext()">Next <i class="fa-solid fa-arrow-right"></i></button>`);
        window.__glwBack = () => go('stream', -1);
        window.__glwNext = () => go('restream', 1);
    }
    const copyBtn = (v, label) => `<button type="button" class="glw-copy" data-copy="${h(v)}" title="Copy"><i class="fa-regular fa-copy"></i> ${label || 'Copy'}</button>`;
    function renderMethodDetail() {
        const d = $('#glw-detail'); if (!d) return;
        const key = S.key || '(loading…)';
        if (S.method === 'browser') {
            d.innerHTML = `<div class="glw-box"><div class="glw-box-head"><i class="fa-solid fa-globe"></i> Browser streaming</div>
                <p>When you press <b>Go live</b> we'll ask for your camera and mic (or a screen to share). Nothing to install.</p>
                <div class="glw-seg"><button type="button" class="${S.mode === 'camera' ? 'on' : ''}" data-mode="camera"><i class="fa-solid fa-video"></i> Camera + mic</button><button type="button" class="${S.mode === 'screen' ? 'on' : ''}" data-mode="screen"><i class="fa-solid fa-display"></i> Share my screen</button></div>
                <ul class="glw-tips"><li>Phones work great — landscape looks best.</li><li>Good light beats a good camera.</li></ul></div>`;
            d.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => { S.mode = b.dataset.mode; d.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('on')); b.classList.add('on'); try { await api(`/streams/managed/${S.slot.id}`, { method: 'PUT', body: { browser_mode: S.mode } }); S.slot.browser_mode = S.mode; } catch { /* */ } }));
        } else if (S.method === 'rtmp') {
            d.innerHTML = `<div class="glw-box"><div class="glw-box-head"><i class="fa-solid fa-desktop"></i> Paste these into OBS</div>
                <div class="glw-kv"><span>Server</span><code>${h(S.rtmpUrl || 'rtmp://openvibe.live/live')}</code>${copyBtn(S.rtmpUrl || 'rtmp://openvibe.live/live')}</div>
                <div class="glw-kv"><span>Stream key</span><code class="glw-secret" data-secret="${h(key)}">••••••••••••••••</code>${copyBtn(key)}<button type="button" class="glw-copy" data-reveal="1"><i class="fa-regular fa-eye"></i> Show</button></div>
                <ol class="glw-obs"><li><b>Settings</b> → <b>Stream</b></li><li>Service: <b>Custom…</b></li><li>Paste the server and the key</li><li><b>OK</b>, then <b>Start Streaming</b></li></ol>
                <p class="muted glw-fine">Keep the key private — anyone with it can stream as you. You can regenerate it on the Go Live page.</p></div>`;
        } else {
            const whip = `${S.whipBase || location.origin}/whip/${S.slot.id}`;
            d.innerHTML = `<div class="glw-box"><div class="glw-box-head"><i class="fa-solid fa-bolt"></i> OBS 30+ over WHIP</div>
                <div class="glw-kv"><span>Server</span><code style="word-break:break-all">${h(whip)}</code>${copyBtn(whip)}</div>
                <div class="glw-kv"><span>Bearer token</span><code class="glw-secret" data-secret="${h(key)}">••••••••••••••••</code>${copyBtn(key)}<button type="button" class="glw-copy" data-reveal="1"><i class="fa-regular fa-eye"></i> Show</button></div>
                <ol class="glw-obs"><li><b>Settings</b> → <b>Stream</b></li><li>Service: <b>WHIP</b></li><li>Paste the server and the bearer token</li><li><b>OK</b>, then <b>Start Streaming</b></li></ol>
                <p class="muted glw-fine">WHIP is WebRTC: viewers see you with under a second of delay.</p></div>`;
        }
        wireCopy(d);
    }
    function wireCopy(root) {
        root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(() => { b.innerHTML = '<i class="fa-regular fa-copy"></i> Copy'; }, 1500); } catch { say('Copy failed — long-press to copy', 'error'); } }));
        root.querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => { const c = b.parentElement.querySelector('.glw-secret'); if (!c) return; const on = c.dataset.on === '1'; c.textContent = on ? '••••••••••••••••' : c.dataset.secret; c.dataset.on = on ? '' : '1'; b.innerHTML = on ? '<i class="fa-regular fa-eye"></i> Show' : '<i class="fa-regular fa-eye-slash"></i> Hide'; }));
    }

    // ── Step 3: restream ───────────────────────────────────────
    function renderRestream() {
        title('Mirror it everywhere (optional)');
        const added = [
            ...(S.rs ? [`<li class="on"><i class="fa-solid fa-robot" style="color:#4a9eff"></i> RobotStreamer · ${h(S.rs.stream_name || ('robot ' + S.rs.robot_id))}<i class="fa-solid fa-check glw-ok"></i></li>`] : []),
            ...S.dests.map(d => `<li class="on"><i class="${(PLAT[d.platform] || PLAT.custom)[1]}" style="color:${(PLAT[d.platform] || PLAT.custom)[2]}"></i> ${h(d.name || (PLAT[d.platform] || PLAT.custom)[0])}<i class="fa-solid fa-check glw-ok"></i></li>`),
        ];
        $('#glw-panel').innerHTML = `
            <p class="glw-lead">Go live here once and the same stream goes out to every platform you add — while your chat, emotes, sound commands and controls stay on OpenVibe. Add what you want, or skip.</p>
            ${added.length ? `<ul class="glw-added">${added.join('')}</ul>` : ''}
            <div class="glw-grid glw-grid--3" id="glw-plats">
                <button type="button" class="glw-pick glw-pick--plat" data-plat="robotstreamer" style="--c:#4a9eff"><span class="glw-pick-ico"><i class="fa-solid fa-robot"></i></span><span class="glw-pick-body"><b>RobotStreamer</b><small>log in once, pick your robot</small></span></button>
                ${Object.entries(PLAT).map(([id, [name, icon, color]]) => `<button type="button" class="glw-pick glw-pick--plat" data-plat="${id}" style="--c:${color}"><span class="glw-pick-ico"><i class="${icon}"></i></span><span class="glw-pick-body"><b>${name}</b><small>${id === 'custom' ? 'server URL + key' : 'paste your stream key'}</small></span></button>`).join('')}
            </div>
            <div class="glw-detail" id="glw-plat-form"></div>`;
        $('#glw-plats').querySelectorAll('[data-plat]').forEach(b => b.addEventListener('click', () => { $('#glw-plats').querySelectorAll('.glw-pick').forEach(x => x.classList.remove('on')); b.classList.add('on'); renderPlatForm(b.dataset.plat); }));
        foot(`<button type="button" class="btn btn-outline" onclick="window.__glwBack()"><i class="fa-solid fa-arrow-left"></i> Back</button><span class="glw-foot-note">Step 3 of 4</span><button type="button" class="btn btn-primary btn-lg" onclick="window.__glwNext()">${added.length ? 'Next' : 'Skip for now'} <i class="fa-solid fa-arrow-right"></i></button>`);
        window.__glwBack = () => go('method', -1);
        window.__glwNext = () => go('golive', 1);
    }
    function renderPlatForm(plat) {
        const f = $('#glw-plat-form'); if (!f) return;
        if (plat === 'robotstreamer') {
            f.innerHTML = `<div class="glw-box"><div class="glw-box-head"><i class="fa-solid fa-robot"></i> RobotStreamer</div>
                <p>Your RobotStreamer login is used once to fetch your token and robot list — the password is never stored.</p>
                <div class="glw-row"><input class="form-input" id="glw-rs-user" placeholder="RobotStreamer username" autocomplete="username"><input class="form-input" id="glw-rs-pass" type="password" placeholder="Password" autocomplete="current-password"></div>
                <div id="glw-rs-robots"></div>
                <div class="glw-row"><button type="button" class="btn btn-primary" id="glw-rs-go"><i class="fa-solid fa-right-to-bracket"></i> Log in &amp; fetch robots</button><span class="muted" id="glw-rs-status"></span></div></div>`;
            $('#glw-rs-go').onclick = async () => {
                const u = $('#glw-rs-user').value.trim(), p = $('#glw-rs-pass').value;
                if (!u || !p) return say('Enter your RobotStreamer username and password', 'error');
                const st = $('#glw-rs-status'); st.textContent = 'Logging in…';
                try {
                    const d = await api('/robotstreamer/integration/login', { method: 'POST', body: { user_name: u, password: p, managed_stream_id: S.slot.id } });
                    const robots = d.available_robots || [];
                    if (!robots.length) { st.textContent = 'Logged in, but no robots on that account yet.'; return; }
                    if (robots.length === 1) { S.rs = d.integration || { robot_id: robots[0].robot_id, stream_name: robots[0].stream_name || robots[0].name }; say(`RobotStreamer connected — ${S.rs.stream_name || 'robot ' + S.rs.robot_id}`, 'success'); return renderRestream(); }
                    $('#glw-rs-robots').innerHTML = `<div class="glw-chips">${robots.map(r => `<button type="button" class="glw-chip" data-robot="${h(r.robot_id)}"><i class="fa-solid fa-robot"></i> ${h(r.stream_name || r.name || r.robot_id)}</button>`).join('')}</div><p class="muted glw-fine">Pick the robot this stream drives.</p>`;
                    st.textContent = `Logged in as ${u}. Pick a robot.`;
                    $('#glw-rs-robots').querySelectorAll('[data-robot]').forEach(b => b.addEventListener('click', async () => {
                        try { const v = await api('/robotstreamer/integration/validate', { method: 'POST', body: { robot_input: b.dataset.robot, managed_stream_id: S.slot.id } }); S.rs = v.integration || { robot_id: b.dataset.robot }; say('RobotStreamer connected', 'success'); renderRestream(); }
                        catch (e) { say((e && e.message) || 'Could not select that robot', 'error'); }
                    }));
                } catch (e) { st.textContent = ''; say((e && e.message) || 'RobotStreamer login failed', 'error'); }
            };
            return;
        }
        const [name] = PLAT[plat] || PLAT.custom;
        const needsUrl = plat === 'custom' || plat === 'kick';
        f.innerHTML = `<div class="glw-box"><div class="glw-box-head"><i class="${(PLAT[plat] || PLAT.custom)[1]}"></i> ${name}</div>
            <p>${plat === 'twitch' ? 'Twitch → Creator Dashboard → Settings → Stream → copy the <b>Primary Stream key</b>.' : plat === 'youtube' ? 'YouTube Studio → Go live → copy the <b>Stream key</b>.' : plat === 'kick' ? 'Kick → Creator Dashboard → Settings → Stream key: copy the <b>URL</b> and the <b>key</b>.' : 'Paste the RTMP server URL and stream key from the service you want to mirror to.'}</p>
            ${needsUrl ? `<input class="form-input" id="glw-p-url" placeholder="rtmps://… server URL">` : ''}
            <input class="form-input" id="glw-p-key" type="password" placeholder="${name} stream key" autocomplete="off">
            <label class="glw-check"><input type="checkbox" id="glw-p-auto" checked> Start automatically whenever I go live</label>
            <div class="glw-row"><button type="button" class="btn btn-primary" id="glw-p-add"><i class="fa-solid fa-plus"></i> Add ${name}</button></div></div>`;
        $('#glw-p-add').onclick = async () => {
            const key = $('#glw-p-key').value.trim(); const url = needsUrl ? $('#glw-p-url').value.trim() : '';
            if (!key) return say('Paste the stream key first', 'error');
            if (needsUrl && !url) return say('The server URL is needed too', 'error');
            try {
                await api('/restream/destinations', { method: 'POST', body: { platform: plat, stream_key: key, server_url: url || undefined, managed_stream_id: S.slot.id, auto_start: $('#glw-p-auto').checked ? 1 : 0, name: name } });
                await loadDests(); say(`${name} added`, 'success'); renderRestream();
            } catch (e) { say((e && e.message) || `Could not add ${name}`, 'error'); }
        };
    }

    // ── Step 4: go live ────────────────────────────────────────
    function renderGoLive() {
        title("You're set. Let's go live.");
        const m = S.method || S.slot.streaming_method || 'browser';
        const mname = { browser: 'Browser', rtmp: 'OBS / RTMP', whip: 'OBS / WHIP' }[m] || m;
        const dests = [...(S.rs ? ['RobotStreamer'] : []), ...S.dests.map(d => d.name || (PLAT[d.platform] || PLAT.custom)[0])];
        $('#glw-panel').innerHTML = `
            <div class="glw-summary">
                <div class="glw-sum-row"><i class="fa-solid fa-tower-broadcast"></i><span><b>${h(S.slot.title)}</b><small>${h(S.slot.category || 'no category yet')} · openvibe.live/@${h((me() || {}).username || '')}${S.slot.slug ? '/' + h(S.slot.slug) : ''}</small></span></div>
                <div class="glw-sum-row"><i class="fa-solid fa-sliders"></i><span><b>${mname}</b><small>${m === 'browser' ? (S.mode === 'screen' ? 'sharing your screen' : 'camera + mic') : 'waiting for your encoder'}</small></span></div>
                <div class="glw-sum-row"><i class="fa-solid fa-satellite-dish"></i><span><b>${dests.length ? dests.join(', ') : 'No restreams'}</b><small>${dests.length ? 'they start with the stream' : 'add them any time from Settings → Restream'}</small></span></div>
            </div>
            <div class="glw-launch" id="glw-launch">${m === 'browser'
                ? `<button type="button" class="btn btn-primary btn-lg glw-big" id="glw-golive"><i class="fa-solid fa-play"></i> Go live now</button><p class="muted glw-fine">We'll ask for camera/mic permission, then you're on.</p>`
                : `<div class="glw-wait"><span class="glw-radar"><i></i><i></i><i></i></span><b>Press <em>Start Streaming</em> in OBS</b><small>Watching for your stream… this screen lights up the moment it arrives.</small></div>`}
            </div>`;
        foot(`<button type="button" class="btn btn-outline" onclick="window.__glwBack()"><i class="fa-solid fa-arrow-left"></i> Back</button><span class="glw-foot-note">Step 4 of 4</span><button type="button" class="btn btn-outline" onclick="closeGoLiveWizard(true)">Finish</button>`);
        window.__glwBack = () => go('restream', -1);
        if (m === 'browser') {
            $('#glw-golive').onclick = async () => {
                try { localStorage.setItem('ov_wizard_done', '1'); } catch { /* */ }
                closeGoLiveWizard(true);
                try { await syncWorkspace(); if (typeof goLiveFromWorkspace === 'function') await goLiveFromWorkspace(); else say('Press Go Live on this page to start', 'info'); } catch (e) { say((e && e.message) || 'Could not start — use the Go Live button on this page', 'error'); }
            };
        } else {
            clearInterval(S.poll);
            S.poll = setInterval(async () => {
                if (!S.open) return clearInterval(S.poll);
                await loadSlots(); const cur = S.slots.find(s => s.id === S.slot.id);
                if (cur && cur.is_currently_live) { clearInterval(S.poll); celebrate(cur); }
            }, 4000);
        }
    }
    function celebrate(slot) {
        try { localStorage.setItem('ov_wizard_done', '1'); } catch { /* */ }
        const path = `/@${(me() || {}).username || ''}${slot && slot.slug ? '/' + slot.slug : ''}`;
        $('#glw-panel').innerHTML = `<div class="glw-live"><div class="glw-live-badge">LIVE</div><h3>You're live!</h3><p>Your stream is on OpenVibe${S.dests.length || S.rs ? ' and heading out to your restreams' : ''}. Go say hi to chat.</p>
            <a class="btn btn-primary btn-lg" href="${path}" onclick="closeGoLiveWizard(true); return handleLinkClick(event, '${path}')"><i class="fa-solid fa-eye"></i> Open my channel</a></div>`;
        foot(`<span></span><button type="button" class="btn btn-outline" onclick="closeGoLiveWizard(true)">Done</button>`);
        try { $('#glw-steps').style.setProperty('--p', '100%'); $('#glw-steps').querySelectorAll('li').forEach(li => li.classList.add('done')); } catch { /* */ }
        confetti();
    }
    function confetti() {
        try {
            const c = document.createElement('div'); c.className = 'glw-confetti';
            const colors = ['#ff5a5f', '#ffd166', '#06d6a0', '#4d96ff', '#c77dff', '#fff'];
            for (let i = 0; i < 140; i++) { const p = document.createElement('span'); p.style.left = (Math.random() * 100) + 'vw'; p.style.background = colors[i % colors.length]; p.style.animationDelay = (Math.random() * 0.6) + 's'; p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's'; c.appendChild(p); }
            document.body.appendChild(c); setTimeout(() => c.remove(), 4000);
        } catch { /* */ }
    }

    // ── Open / close ───────────────────────────────────────────
    window.openGoLiveWizard = async function (opts = {}) {
        if (!me()) {
            // Give the page a moment to finish loading the session before deciding we're logged out.
            for (let i = 0; i < 24 && !me(); i++) await new Promise(r => setTimeout(r, 250));
            if (!me()) { try { localStorage.setItem('ov-guide-pending', opts.step || 'new'); } catch { /* */ } location.href = '/api/auth/sso/login'; return; }
        }
        const root = ensure();
        S.open = true; root.classList.add('is-open'); document.body.classList.add('glw-lock');
        $('#glw-panel').innerHTML = '<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        await loadSlots();
        const want = opts.step || 'stream';
        // A specific slot (the workspace's current one) when we're asked to skip ahead.
        if (want !== 'stream' && S.slots.length) {
            const cur = (typeof _wsState !== 'undefined' && _wsState.selectedId) ? S.slots.find(s => s.id === _wsState.selectedId) : null;
            S.slot = cur || S.slots[0]; await loadEndpoint(); await loadDests(); go(want, 1);
        } else { S.slot = null; go('stream', 1); }
    };
    window.closeGoLiveWizard = function (finished) {
        const root = $('#glw'); if (!root) return;
        S.open = false; clearInterval(S.poll); root.classList.remove('is-open'); document.body.classList.remove('glw-lock');
        try { localStorage.setItem('ov_wizard_dismissed', '1'); if (finished) localStorage.setItem('ov_wizard_done', '1'); } catch { /* */ }
        try { if (typeof _wsLoadManagedStreams === 'function') _wsLoadManagedStreams().then(() => { if (typeof _wsRenderSidebar === 'function') _wsRenderSidebar(); }); } catch { /* */ }
    };
    // Home page / anywhere: "Set up restreams (guided)".
    window.startRestreamGuide = function () {
        if (location.pathname.startsWith('/broadcast')) return openGoLiveWizard({ step: 'restream' });
        if (typeof navigate === 'function') navigate('/broadcast?setup=restream'); else location.href = '/broadcast?setup=restream';
    };
    window.startGoLiveWizard = function () { if (location.pathname.startsWith('/broadcast')) return openGoLiveWizard({ step: 'stream' }); if (typeof navigate === 'function') navigate('/broadcast?setup=new'); else location.href = '/broadcast?setup=new'; };

    // Auto-open: ?setup=…, a pending intent after SSO, or a first visit with no slots.
    async function maybeAuto() {
        if (!location.pathname.startsWith('/broadcast')) return;
        const q = new URLSearchParams(location.search).get('setup');
        let pending = null; try { pending = localStorage.getItem('ov-guide-pending'); } catch { /* */ }
        const waitUser = async () => { for (let i = 0; i < 40; i++) { if (me()) return true; await new Promise(r => setTimeout(r, 250)); } return !!me(); };
        if (q || pending) {
            if (!(await waitUser())) return;
            const step = (q === 'restream' || pending === 'restream') ? 'restream' : 'stream';
            try { localStorage.removeItem('ov-guide-pending'); } catch { /* */ }
            try { history.replaceState(null, '', location.pathname); } catch { /* */ }
            return openGoLiveWizard({ step });
        }
        if (!(await waitUser())) return;
        let dismissed = null; try { dismissed = localStorage.getItem('ov_wizard_dismissed'); } catch { /* */ }
        if (dismissed) return;
        await loadSlots();
        if (!S.slots.length) openGoLiveWizard({ step: 'stream' });
    }
    const _push = history.pushState;
    history.pushState = function () { const r = _push.apply(this, arguments); setTimeout(() => { if (!S.open) maybeAuto(); }, 60); return r; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(maybeAuto, 300)); else setTimeout(maybeAuto, 300);
})();
