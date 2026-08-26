/**
 * powerchat.js — dashboard panel to connect a PowerChat account for real tips.
 * Connect flow is a small state machine (idle → connecting → success | error | cancelled)
 * with live animation, auto-refresh, a COOP-safe close check, and a manual copy/paste link
 * fallback for when the popup is blocked.
 */
(function () {
    'use strict';
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function _swap(el, html) { if (!el) return; el.innerHTML = html; el.classList.remove('pc-fade-in'); void el.offsetWidth; el.classList.add('pc-fade-in'); }

    const START_URL = '/api/powerchat/oauth/start';
    function authUrl() { return window.location.origin + START_URL; }

    let _pcActive = null;   // in-flight connect session

    window.loadPowerchatStatus = async function loadPowerchatStatus() {
        const card = $('dash-powerchat-card');
        if (!card) return;
        if (_pcActive) return;   // don't clobber the live connecting animation
        let st;
        try { st = await api('/powerchat/status'); }
        catch { card.style.display = 'none'; return; }

        if (!st || !st.enabled) { card.style.display = 'none'; return; }
        if (card.style.display === 'none') { card.style.display = ''; card.classList.add('pc-card-in'); setTimeout(() => card.classList.remove('pc-card-in'), 500); }
        else card.style.display = '';

        const statusEl = $('pc-status'), actionsEl = $('pc-actions'), hintEl = $('pc-hint');
        if (statusEl) statusEl.classList.remove('pc-status-block');

        if (!st.configured) {
            _swap(statusEl, '<span class="pc-dot pc-dot-off"></span> PowerChat isn\'t fully set up by the site owner yet.');
            if (actionsEl) actionsEl.innerHTML = '';
            if (hintEl) hintEl.textContent = '';
            return;
        }

        if (st.connected) {
            const kindLabel = st.connection_kind === 'app'
                ? '<span class="pc-kind pc-kind-app" title="Full OAuth connection — events flow both ways">Connected via app</span>'
                : (st.connection_kind === 'testing'
                    ? '<span class="pc-kind pc-kind-test" title="Sandbox self-connect (no app tokens)">Enabled for testing</span>'
                    : '');
            _swap(statusEl, `<span class="pc-dot pc-dot-on"></span> Connected as <strong>${esc(st.username || 'your account')}</strong> ${kindLabel}`);
            if (actionsEl) actionsEl.innerHTML = `
                <div class="pc-action-group">
                    <span class="pc-action-label"><i class="fa-solid fa-flask"></i> Test your setup</span>
                    <div class="pc-btn-row">
                        <button class="btn btn-primary btn-small" onclick="powerchatTestTip(this)"><i class="fa-solid fa-gift"></i> Send test tip</button>
                        <div class="pc-test-menu-wrap">
                            <button class="btn btn-outline btn-small" onclick="powerchatToggleTestMenu(event)"><i class="fa-solid fa-bell"></i> Test on PowerChat <i class="fa-solid fa-caret-down pc-test-caret"></i></button>
                            <div class="pc-test-menu" hidden>
                                <div class="pc-test-menu-head">Fires a fake event on your PowerChat overlay</div>
                                <button onclick="powerchatTestKind('tip', this)"><i class="fa-solid fa-hand-holding-dollar"></i> Tip alert</button>
                                <button onclick="powerchatTestKind('subscribe', this)"><i class="fa-solid fa-star"></i> Subscription alert</button>
                                <button onclick="powerchatTestKind('follow', this)"><i class="fa-solid fa-user-plus"></i> Follow alert</button>
                                <button onclick="powerchatTestKind('channel_points', this)"><i class="fa-solid fa-coins"></i> Channel-points redeem</button>
                                <button onclick="powerchatTestKind('host', this)"><i class="fa-solid fa-tower-broadcast"></i> Host alert</button>
                                <button onclick="powerchatTestKind('chat', this)"><i class="fa-solid fa-comment"></i> Chat message</button>
                                <button onclick="powerchatTestKind('view-count', this)"><i class="fa-solid fa-eye"></i> Viewer-count chip</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="pc-action-group">
                    <span class="pc-action-label"><i class="fa-solid fa-gear"></i> Connection</span>
                    <div class="pc-btn-row">
                        ${st.tip_page_url ? `<a class="btn btn-outline btn-small" href="${esc(st.tip_page_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> My tip page</a>` : ''}
                        <button class="btn btn-outline btn-small pc-disconnect-btn" onclick="powerchatDisconnect(this)"><i class="fa-solid fa-link-slash"></i> Disconnect</button>
                    </div>
                </div>`;
            // A grant never gains scopes retroactively — if the app now asks for more than
            // this connection was minted with (e.g. viewer count / chat / tips were added
            // later), the streamer must re-consent. Without this, those features silently 403.
            const missing = Array.isArray(st.missing_scopes) ? st.missing_scopes : [];
            if (missing.length) {
                if (actionsEl) actionsEl.insertAdjacentHTML('afterbegin', `
                    <div class="pc-action-group">
                        <span class="pc-action-label pc-warn"><i class="fa-solid fa-triangle-exclamation"></i> New permissions available</span>
                        <div class="pc-btn-row">
                            <button class="btn btn-primary btn-small" onclick="powerchatConnect()"><i class="fa-solid fa-rotate"></i> Reconnect to enable</button>
                        </div>
                    </div>`);
                if (hintEl) hintEl.innerHTML = `<span class="pc-warn">Your connection is missing: ${esc(missing.join(', '))}. Reconnect (one click, same account) to enable viewer count, chat, and alerts on your PowerChat overlay.</span>`;
            } else if (hintEl) {
                const base = st.last_error ? ('Note: ' + st.last_error) : 'Tips confirmed on PowerChat now flow into your goals, alerts, and chat automatically.';
                // Relay routing lives on the Broadcast page — streamers rarely find it unprompted.
                hintEl.innerHTML = `${esc(base)}<br><span class="pc-tip"><i class="fa-solid fa-lightbulb"></i> Tip: chat from every stream slot and restream (Twitch, Kick, YouTube, RobotStreamer) is merged into your PowerChat overlay by default. To turn that off for a specific slot or platform, open <a href="/broadcast" onclick="event.preventDefault();navigate('/broadcast')">Broadcast</a> → a slot's <strong>PowerChat Overlay</strong> settings, or the <strong>→ PowerChat</strong> switches in each restream destination. The viewer count on your overlay is your total audience (OpenVibe + restream platforms + RobotStreamer) — the same switches let you leave a platform's viewers out.</span>`;
            }
        } else {
            _swap(statusEl, '<span class="pc-dot pc-dot-off"></span> Not connected.');
            if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Connect PowerChat</button>`;
            if (hintEl) hintEl.innerHTML = st.last_error ? `<span class="pc-warn">Reconnect needed: ${esc(st.last_error)}</span>` : '';
        }
    };

    // ── Connect flow ──────────────────────────────────────────────────────────
    function _renderConnecting() {
        const card = $('dash-powerchat-card'); if (card) card.classList.add('pc-busy');
        const s = $('pc-status');
        if (s) s.classList.add('pc-status-block');
        _swap(s, `
            <div class="pc-connecting-box">
                <div class="pc-connecting-head"><span class="pc-spinner"></span> Waiting for you to authorize in PowerChat<span class="pc-ellipsis"><span>.</span><span>.</span><span>.</span></span></div>
                <div class="pc-progress"><span class="pc-progress-bar"></span></div>
                <div class="pc-manual">
                    <span>Popup didn't open?</span>
                    <a href="${esc(authUrl())}" onclick="return powerchatOpenManual(event)">Open the login page</a>
                    <button type="button" class="pc-copy-btn" onclick="powerchatCopyAuthUrl(this)"><i class="fa-solid fa-copy"></i> Copy link</button>
                </div>
            </div>`);
        const a = $('pc-actions');
        if (a) a.innerHTML = `<button class="btn btn-small pc-cancel-btn" onclick="powerchatCancelConnect()"><i class="fa-solid fa-xmark"></i> Cancel</button>`;
        const h = $('pc-hint');
        if (h) h.textContent = 'This page updates automatically the moment you finish.';
    }
    function _renderSuccess(username) {
        const card = $('dash-powerchat-card');
        if (card) { card.classList.remove('pc-busy'); card.classList.add('pc-flash'); setTimeout(() => card.classList.remove('pc-flash'), 1000); }
        const s = $('pc-status'); if (s) s.classList.remove('pc-status-block');
        _swap(s, `<span class="pc-check-pop">✓</span> <span class="pc-success-text">Connected${username ? ' as <strong>' + esc(username) + '</strong>' : ''}!</span>`);
        const a = $('pc-actions'); if (a) a.innerHTML = '';
        const h = $('pc-hint'); if (h) h.textContent = 'Setting things up…';
    }
    function _renderCancelled() {
        const card = $('dash-powerchat-card'); if (card) card.classList.remove('pc-busy');
        const s = $('pc-status'); if (s) s.classList.remove('pc-status-block');
        _swap(s, '<span class="pc-dot pc-dot-off"></span> Connection cancelled.');
        const a = $('pc-actions'); if (a) a.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Try again</button>`;
        const h = $('pc-hint'); if (h) h.textContent = '';
    }
    function _renderError(msg) {
        const card = $('dash-powerchat-card'); if (card) card.classList.remove('pc-busy');
        const s = $('pc-status'); if (s) s.classList.remove('pc-status-block');
        _swap(s, '<span class="pc-dot pc-dot-off"></span> Couldn\'t connect.');
        const a = $('pc-actions'); if (a) a.innerHTML = `<button class="btn btn-primary btn-small pc-connect-btn" onclick="powerchatConnect()"><i class="fa-solid fa-plug"></i> Try again</button>`;
        const h = $('pc-hint'); if (h) h.innerHTML = `<span class="pc-warn">${esc(msg || 'Connection failed. Please try again.')}</span>`;
    }

    function _openPopup() {
        const w = 560, h = 720;
        const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
        const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
        return window.open(START_URL, 'powerchat_oauth', `width=${w},height=${h},left=${left},top=${top}`);
    }

    window.powerchatConnect = function powerchatConnect() {
        if (_pcActive) return;

        // Set up completion listeners BEFORE opening, so a manual/copy-link completion in any
        // window still updates the dashboard (BroadcastChannel + localStorage survive COOP).
        let settled = false;
        const finish = (result, msg, username) => {
            if (settled) return;
            settled = true;
            cleanup(); _pcActive = null;
            try { if (_pcActive && _pcActive.popup && !_pcActive.popup.closed) _pcActive.popup.close(); } catch { /* */ }
            if (result === 'ok') {
                _renderSuccess(username);
                toast('PowerChat connected ✓', 'success');
                setTimeout(() => window.loadPowerchatStatus(), 1100);
            } else if (result === 'error') {
                toast('PowerChat: ' + (msg || 'connection failed'), 'error');
                _renderError(msg);
            } else { _renderCancelled(); }
        };
        const done = (m) => { if (!m || m.type !== 'powerchat-oauth') return; finish(m.ok ? 'ok' : 'error', m.error, m.username); };
        const onMsg = (e) => { if (e.origin === window.location.origin) done(e.data); };
        let bc = null;
        try { bc = new BroadcastChannel('powerchat-oauth'); bc.onmessage = (e) => done(e.data); } catch { /* */ }
        const onStorage = (e) => { if (e.key === 'powerchat-oauth' && e.newValue) { try { done(JSON.parse(e.newValue)); } catch { /* */ } } };
        window.addEventListener('message', onMsg);
        window.addEventListener('storage', onStorage);

        _renderConnecting();
        const popup = _openPopup();
        if (!popup) toast('Popup blocked — use the “Open the login page” link below to connect.', 'warning');

        const openedAt = Date.now();
        const poll = setInterval(() => {
            const p = _pcActive && _pcActive.popup;
            if (!p) return;
            let closed = false; try { closed = p.closed; } catch { closed = false; }
            if (!closed) return;
            clearInterval(poll);
            // COOP severs the opener handle the instant the popup goes cross-origin, making
            // `closed` report true even though it's open — so only a LATE close is a real one.
            if (Date.now() - openedAt < 8000) return;
            setTimeout(() => finish('cancelled'), 1000);
        }, 500);
        const to = setTimeout(() => finish('cancelled'), 5 * 60 * 1000);

        function cleanup() {
            window.removeEventListener('message', onMsg);
            window.removeEventListener('storage', onStorage);
            try { bc && bc.close(); } catch { /* */ }
            clearInterval(poll); clearTimeout(to);
        }
        _pcActive = { finish, popup };
    };

    // Manual fallback: (re)open the login window on a user gesture (beats popup blockers).
    window.powerchatOpenManual = function powerchatOpenManual(e) {
        if (e) e.preventDefault();
        const p = _openPopup();
        if (p) { if (_pcActive) _pcActive.popup = p; }
        else { window.location.href = START_URL; }   // last resort: same-tab navigation
        return false;
    };
    window.powerchatCopyAuthUrl = async function powerchatCopyAuthUrl(btn) {
        const url = authUrl();
        try { await navigator.clipboard.writeText(url); }
        catch { try { const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); } catch { /* */ } }
        if (btn) { const o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(() => { btn.innerHTML = o; }, 1600); }
        toast('Login link copied — paste it into a new tab if the popup is blocked', 'success');
    };

    window.powerchatCancelConnect = function powerchatCancelConnect() {
        if (!_pcActive) return;
        try { if (_pcActive.popup && !_pcActive.popup.closed) _pcActive.popup.close(); } catch { /* */ }
        _pcActive.finish('cancelled');
    };

    window.powerchatDisconnect = async function powerchatDisconnect(btn) {
        if (!confirm('Disconnect PowerChat? Tips will stop flowing into OpenVibe.Live until you reconnect.')) return;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Disconnecting…'; }
        const card = $('dash-powerchat-card'); if (card) card.classList.add('pc-busy');
        try { await api('/powerchat/oauth/connection', { method: 'DELETE' }); toast('PowerChat disconnected', 'success'); }
        catch (e) { toast(e.message || 'Failed to disconnect', 'error'); }
        finally { if (card) card.classList.remove('pc-busy'); window.loadPowerchatStatus(); }
    };

    // Local pipeline test — verifies the streamer's alert sound + chat celebration.
    window.powerchatTestTip = async function powerchatTestTip(btn) {
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…'; }
        try {
            const r = await api('/powerchat/test-tip', { method: 'POST', body: { amount: 5 } });
            toast(r && r.powerchat
                ? 'Test tip sent — it should render on both OpenVibe.Live and PowerChat 🎉'
                : 'Test tip sent — shown here on OpenVibe.Live. (Connect the app for it to also fire on PowerChat.)', 'success');
        } catch (e) { toast('Test tip failed: ' + (e.message || 'error'), 'error'); }
        finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-gift"></i> Send test tip'; } }
    };

    // ── "Test on PowerChat" dropdown — fire a fake event of any kind ──────────
    function _closeTestMenus() {
        document.querySelectorAll('.pc-test-menu').forEach(m => { m.hidden = true; });
        document.querySelectorAll('.pc-test-menu-wrap.open').forEach(w => w.classList.remove('open'));
    }
    window.powerchatToggleTestMenu = function powerchatToggleTestMenu(ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        const wrap = ev && ev.currentTarget ? ev.currentTarget.closest('.pc-test-menu-wrap') : null;
        const menu = wrap && wrap.querySelector('.pc-test-menu');
        if (!menu) return;
        const wasHidden = menu.hidden;
        _closeTestMenus();
        if (wasHidden) { menu.hidden = false; wrap.classList.add('open'); }
    };
    document.addEventListener('click', (e) => {
        if (!e.target.closest || !e.target.closest('.pc-test-menu-wrap')) _closeTestMenus();
    });

    // Fire one fake event on the PowerChat overlay. Alert kinds are display-only test
    // alerts (never credit anything); chat/view-count go through the real intake so the
    // streamer sees exactly what the live relay produces.
    window.powerchatTestKind = async function powerchatTestKind(kind, btn) {
        const menu = btn && btn.closest('.pc-test-menu');
        const buttons = menu ? Array.from(menu.querySelectorAll('button')) : (btn ? [btn] : []);
        buttons.forEach(b => { b.disabled = true; });
        const orig = btn ? btn.innerHTML : '';
        if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
        try {
            const r = await api('/powerchat/test-alert', { method: 'POST', body: { kind } });
            toast((r && r.note) || 'Test sent to PowerChat ✓', 'success');
            _closeTestMenus();
        } catch (e) {
            // api() throws { message: <error code>, data: <body> } — the human-readable
            // text for scope failures is in data.message.
            const m = (e && e.data && e.data.message) || (e && e.message) || '';
            if (/reconnect/i.test(m)) toast(m, 'warning');
            else toast('Test failed: ' + (m || 'error'), 'error');
        } finally {
            if (btn) btn.innerHTML = orig;
            buttons.forEach(b => { b.disabled = false; });
        }
    };

    // Chain into the dashboard load.
    const _prev = window.loadDashboard;
    window.loadDashboard = async function powerchatLoadDashboard() {
        if (typeof _prev === 'function') await _prev();
        try { await window.loadPowerchatStatus(); } catch { /* */ }
    };
})();
