/* ═══════════════════════════════════════════════════════════════
   RS-PROMO — RobotStreamer switch bonus (Zelle / PayPal)
   ───────────────────────────────────────────────────────────────
   Every RobotStreamer user who moves to OpenVibe.Live gets a cash
   bonus, paid personally by the site owner. This module mounts the
   four promo surfaces and all of their effects:

     1. Ticker   — animated marquee under the navbar on every page
     2. Takeover — one-time full-screen splash (money rain, aurora,
                   synthwave grid, count-up amount)
     3. Hero card — 3D-tilt bounty card in the home hero
     4. Claim modal — Zelle/PayPal toggle, steps, copyable message,
                   sign-in / DM-the-owner / Discord actions + confetti

   Amount, owner username, Discord link and the on/off switch come
   from GET /api/promo/robotstreamer (env RS_PROMO_*), so the promo
   can be retuned or paused without a frontend deploy. Everything
   here is static copy + server-provided strings (escaped) — no user
   content is rendered.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const PROMO_VERSION = 'rs-exclusive-v3';       // bump to re-show the takeover to everyone
    const SEEN_KEY = 'ov_rs_promo_seen';
    const TICKER_KEY = 'ov_rs_ticker_hidden';       // sessionStorage — comes back next visit
    const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    const cfg = { enabled: true, amount: 50, amountMin: 25, referral: 10, github: 'https://github.com/OpenVibers/OpenVibe.Live', owner: 'admin', discord: 'https://discord.gg/M6MuRUaeJj' };
    const STREAM_ALERT_KEY = 'ov_rs_stream_alert_min'; // sessionStorage — collapsed (never hidden) state
    let modalEl = null, takeoverEl = null, tickerEl = null;
    let rainStop = null;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = () => (cfg.amountMin && cfg.amountMin < cfg.amount ? `$${cfg.amountMin}–$${cfg.amount}` : `$${cfg.amount}`);
    const moneyMax = () => `$${cfg.amount}`;
    const referral = () => `$${cfg.referral}`;
    const ghLink = (label) => cfg.github ? `<a href="${esc(cfg.github)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    const store = {
        get(k, ss) { try { return (ss ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
        set(k, v, ss) { try { (ss ? sessionStorage : localStorage).setItem(k, v); } catch { /* private mode */ } },
    };
    const isLoggedIn = () => !!(window.currentUser);
    const say = (msg, type) => { if (typeof window.toast === 'function') window.toast(msg, type || 'info'); };

    // Pages where a full-screen splash would be hostile (mid-broadcast, overlays, popouts).
    function takeoverAllowedHere() {
        const p = location.pathname;
        if (/^\/(popout|obs|whip|embed|kiosk)/.test(p)) return false;
        if (/^\/(broadcast|dashboard)/.test(p)) return false;
        return true;
    }
    function promoAllowedHere() {
        return !/^\/(popout|obs|whip|embed|kiosk)/.test(location.pathname);
    }

    /* ─────────────────────────────────────────────────────────────
       Shared fragments
       ───────────────────────────────────────────────────────────── */
    const chipsHtml = () => `
        <span class="rs-chip rs-chip-zelle"><span class="rs-zelle-mark">Z</span> Zelle</span>
        <span class="rs-chip rs-chip-paypal"><i class="fa-brands fa-paypal"></i> PayPal</span>
        <span class="rs-chip rs-chip-cash"><i class="fa-solid fa-money-bill-wave"></i> Real cash, no coins</span>
        <span class="rs-chip rs-chip-build"><i class="fa-solid fa-hammer"></i> Features built on request</span>
        <span class="rs-chip rs-chip-oss" title="Every line of this site is public — trust what you can read"><i class="fa-brands fa-github"></i> 100% open source</span>`;

    const coinHtml = () => `
        <div class="rs-coin-wrap" aria-hidden="true">
            <div class="rs-coin">
                <div class="rs-coin-face front">$</div>
                <div class="rs-coin-face back"><i class="fa-solid fa-robot"></i></div>
                <div class="rs-coin-edge"></div>
            </div>
        </div>`;

    /* ─────────────────────────────────────────────────────────────
       1. TICKER
       ───────────────────────────────────────────────────────────── */
    function mountTicker() {
        if (tickerEl || store.get(TICKER_KEY, true) === '1') return;
        const copy = `
            <span class="rs-ticker-item"><i class="fa-solid fa-robot"></i> RobotStreamer streamers: quit RS for good, stream ONLY on OpenVibe.Live, get <span class="rs-money">${money()}</span> <span class="rs-ticker-sep">•</span> Zelle or PayPal <span class="rs-ticker-sep">•</span> <span class="rs-ticker-cta">Claim yours</span></span>
            <span class="rs-ticker-item"><i class="fa-solid fa-heart" style="color:#f472b6"></i> Converters get catered to — tell me what you want built and I build it <span class="rs-ticker-sep">•</span> paid out of pocket by the one guy who runs this place</span>
            <span class="rs-ticker-item"><i class="fa-brands fa-github"></i> Open source beats closed source: every line of this site is on GitHub, theirs isn't <span class="rs-ticker-sep">•</span> trust what you can read</span>
            <span class="rs-ticker-item"><i class="fa-solid fa-people-arrows" style="color:#86efac"></i> Already here? Bring a RobotStreamer streamer over and you get <span class="rs-money">${referral()}</span> too <span class="rs-ticker-sep">•</span> <span class="rs-ticker-cta">How it works</span></span>`;
        tickerEl = document.createElement('div');
        tickerEl.className = 'rs-ticker';
        tickerEl.setAttribute('role', 'region');
        tickerEl.setAttribute('aria-label', `RobotStreamer switch bonus: ${money()} via Zelle or PayPal`);
        tickerEl.innerHTML = `
            <div class="rs-ticker-track">
                <span class="rs-ticker-copy" style="display:contents">${copy}</span>
                <span class="rs-ticker-copy" style="display:contents" aria-hidden="true">${copy}</span>
            </div>
            <button class="rs-ticker-close" type="button" title="Hide for this visit" aria-label="Hide promo bar"><i class="fa-solid fa-xmark"></i></button>`;
        tickerEl.addEventListener('click', (e) => {
            if (e.target.closest('.rs-ticker-close')) { hideTicker(); return; }
            openClaim();
        });
        document.body.appendChild(tickerEl);
        document.body.classList.add('rs-ticker-on');
    }
    function hideTicker() {
        if (!tickerEl) return;
        store.set(TICKER_KEY, '1', true);
        tickerEl.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
        tickerEl.style.transform = 'translateY(-100%)';
        tickerEl.style.opacity = '0';
        document.body.classList.remove('rs-ticker-on');
        setTimeout(() => { tickerEl?.remove(); tickerEl = null; }, 400);
    }

    /* ─────────────────────────────────────────────────────────────
       2. TAKEOVER (money rain canvas + count-up)
       ───────────────────────────────────────────────────────────── */
    function buildTakeover() {
        const titleWords = ['Leave', 'RobotStreamer', 'for', 'good.', 'Get', 'paid.'];
        const el = document.createElement('div');
        el.className = 'rs-takeover';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', `RobotStreamer switch bonus: ${money()}`);
        el.innerHTML = `
            <div class="rs-tk-aurora" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
            <div class="rs-tk-grid" aria-hidden="true"></div>
            <canvas class="rs-tk-canvas" aria-hidden="true"></canvas>
            <button class="rs-tk-close" type="button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            <div class="rs-tk-content">
                <div class="rs-tk-eyebrow"><i class="fa-solid fa-robot"></i> robotstreamer.com users</div>
                <h1 class="rs-tk-title">${titleWords.map((w, i) => `<span class="rs-w" style="animation-delay:${0.25 + i * 0.09}s">${esc(w)}</span>`).join(' ')}</h1>
                <div class="rs-tk-amount" aria-label="${money()}"><span class="rs-money" data-countup="${cfg.amount}">${cfg.amountMin < cfg.amount ? `$${cfg.amountMin}–$0` : '$0'}</span></div>
                <p class="rs-tk-sub">Never stream on RobotStreamer again. Stream <b>only</b> on <b>OpenVibe.Live</b>. I send you <b>${money()}</b> — Zelle or PayPal, your pick.<br>And I cater to converters: <b>ask for a feature, I build it.</b> Not a corporation — one guy who wants you here.</p>
                <p class="rs-tk-trust"><i class="fa-brands fa-github"></i> <b>Trust what you can read.</b> Every line of this site is ${ghLink('public on GitHub')}. Theirs is closed source — you'll never see what it does. An open alternative is the only kind worth trusting.<br><i class="fa-solid fa-people-arrows"></i> <b>Already one of us?</b> Bring a RobotStreamer streamer over and you get <b>${referral()}</b> too.</p>
                <div class="rs-chips">${chipsHtml()}</div>
                <div class="rs-flow" aria-hidden="true">
                    <span class="rs-flow-node rs-from"><i class="fa-solid fa-robot"></i> RobotStreamer</span>
                    <span class="rs-flow-arrow"><span class="rs-walker">🤖</span></span>
                    <span class="rs-flow-node rs-to"><i class="fa-solid fa-circle-nodes"></i> OpenVibe.Live</span>
                </div>
                <div class="rs-tk-actions">
                    <button class="rs-btn rs-btn-gold" type="button" data-act="claim"><i class="fa-solid fa-sack-dollar"></i> Go exclusive — claim ${money()}</button>
                    <button class="rs-btn rs-btn-ghost" type="button" data-act="later"><i class="fa-solid fa-compass"></i> Show me around first</button>
                </div>
                <p class="rs-tk-foot"><i class="fa-solid fa-star"></i> You'll only see this splash once — the bar at the top brings you back here anytime.</p>
            </div>`;
        el.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (e.target.closest('.rs-tk-close') || act === 'later') { closeTakeover(); return; }
            if (act === 'claim') { closeTakeover(); openClaim(); }
        });
        return el;
    }
    function showTakeover(force) {
        if (takeoverEl) return;
        if (!force && (store.get(SEEN_KEY) === PROMO_VERSION || !takeoverAllowedHere())) return;
        takeoverEl = buildTakeover();
        document.body.appendChild(takeoverEl);
        document.body.style.overflow = 'hidden';
        store.set(SEEN_KEY, PROMO_VERSION);
        if (!REDUCED) {
            rainStop = startMoneyRain(takeoverEl.querySelector('.rs-tk-canvas'));
            countUp(takeoverEl.querySelector('[data-countup]'), cfg.amount, 1500, 500);
        } else {
            takeoverEl.querySelector('[data-countup]').textContent = money();
        }
        document.addEventListener('keydown', onTakeoverKey);
        setTimeout(() => takeoverEl?.querySelector('[data-act="claim"]')?.focus({ preventScroll: true }), 900);
    }
    function onTakeoverKey(e) { if (e.key === 'Escape') closeTakeover(); }
    function closeTakeover() {
        if (!takeoverEl) return;
        const el = takeoverEl; takeoverEl = null;
        document.removeEventListener('keydown', onTakeoverKey);
        document.body.style.overflow = '';
        if (rainStop) { rainStop(); rainStop = null; }
        el.classList.add('leaving');
        setTimeout(() => el.remove(), REDUCED ? 0 : 480);
    }

    function countUp(el, target, duration, delay) {
        if (!el) return;
        const t0 = performance.now() + (delay || 0);
        const ease = (t) => 1 - Math.pow(2, -10 * t);   // easeOutExpo
        function frame(now) {
            const t = Math.min(1, Math.max(0, (now - t0) / duration));
            const fmt = (n) => (cfg.amountMin < cfg.amount ? `$${cfg.amountMin}–$${n}` : `$${n}`);
            el.textContent = fmt(Math.round(ease(t) * target));
            if (t < 1) requestAnimationFrame(frame);
            else { el.textContent = fmt(target); el.parentElement?.classList.add('pop'); }
        }
        requestAnimationFrame(frame);
    }

    // Emoji particle rain: bills, coins, robots, hearts. Cheap (fillText), DPR-aware, pauses when hidden.
    function startMoneyRain(canvas) {
        if (!canvas) return () => {};
        const ctx = canvas.getContext('2d');
        const GLYPHS = ['💸', '💵', '🪙', '🤖', '💜', '💰', '🤖', '💸'];
        let w = 0, h = 0, dpr = 1, raf = 0, running = true, last = 0;
        const parts = [];
        function resize() {
            dpr = Math.min(2, window.devicePixelRatio || 1);
            w = canvas.clientWidth; h = canvas.clientHeight;
            canvas.width = w * dpr; canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        function spawn(initial) {
            return {
                g: GLYPHS[(Math.random() * GLYPHS.length) | 0],
                x: Math.random() * w,
                y: initial ? Math.random() * h : -40,
                s: 18 + Math.random() * 26,
                vy: 40 + Math.random() * 90,
                vx: (Math.random() - 0.5) * 30,
                r: Math.random() * Math.PI * 2,
                vr: (Math.random() - 0.5) * 2.2,
                sw: Math.random() * Math.PI * 2,
                a: 0.55 + Math.random() * 0.45,
            };
        }
        resize();
        const N = Math.min(90, Math.max(35, Math.round((w * h) / 16000)));
        for (let i = 0; i < N; i++) parts.push(spawn(true));
        function tick(now) {
            if (!running) return;
            const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
            ctx.clearRect(0, 0, w, h);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                p.sw += dt * 1.6;
                p.x += (p.vx + Math.sin(p.sw) * 22) * dt;
                p.y += p.vy * dt;
                p.r += p.vr * dt;
                if (p.y > h + 50 || p.x < -60 || p.x > w + 60) parts[i] = spawn(false);
                ctx.save();
                ctx.globalAlpha = p.a;
                ctx.translate(p.x, p.y); ctx.rotate(p.r);
                ctx.font = `${p.s}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
                ctx.fillText(p.g, 0, 0);
                ctx.restore();
            }
            raf = requestAnimationFrame(tick);
        }
        const onVis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf); } else if (!running) { running = true; last = 0; raf = requestAnimationFrame(tick); } };
        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', onVis);
        raf = requestAnimationFrame(tick);
        return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVis); };
    }

    /* ─────────────────────────────────────────────────────────────
       3. HERO BOUNTY CARD (home page)
       ───────────────────────────────────────────────────────────── */
    function mountHeroCard() {
        const mount = document.getElementById('rs-hero-mount');
        if (!mount || mount.dataset.mounted) return;
        mount.dataset.mounted = '1';
        mount.innerHTML = `
            <div class="rs-bills" aria-hidden="true"><span>💸</span><span>🪙</span><span>💵</span><span>💸</span><span>🤖</span></div>
            <div class="rs-card-border">
                <div class="rs-hero-card" id="rs-hero-card">
                    <div class="rs-card-glare" aria-hidden="true"></div>
                    ${coinHtml()}
                    <div class="rs-card-body">
                        <div class="rs-card-kicker"><i class="fa-solid fa-robot"></i> RobotStreamer switch bonus</div>
                        <h3 class="rs-card-title">Coming from RobotStreamer? Go exclusive here and get <span class="rs-money">${money()}</span></h3>
                        <p class="rs-card-sub">Never stream on RobotStreamer again, stream only on OpenVibe.Live. Zelle or PayPal, paid personally by the guy who runs this place — and every converter gets catered to: ask for a feature, I build it. Every line of this site is ${ghLink('open source on GitHub')}; theirs is closed. Already here? Bring a RobotStreamer streamer over and you get <b>${referral()}</b>.</p>
                        <div class="rs-card-chips">${chipsHtml()}</div>
                    </div>
                    <div class="rs-card-action">
                        <button class="rs-btn rs-btn-gold" type="button" onclick="rsPromoOpenClaim()"><i class="fa-solid fa-sack-dollar"></i> Claim ${money()}</button>
                        <button class="rs-card-replay" type="button" onclick="rsPromoReplay()">replay the splash ✨</button>
                    </div>
                </div>
            </div>`;
        if (!REDUCED && !COARSE) attachTilt(mount.querySelector('.rs-card-border'), mount.querySelector('#rs-hero-card'));
    }
    function attachTilt(zone, card) {
        if (!zone || !card) return;
        let raf = 0;
        zone.addEventListener('pointermove', (e) => {
            const r = card.getBoundingClientRect();
            const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                card.style.setProperty('--rs-ry', `${((px - 0.5) * 14).toFixed(2)}deg`);
                card.style.setProperty('--rs-rx', `${((0.5 - py) * 10).toFixed(2)}deg`);
                card.style.setProperty('--rs-mx', `${(px * 100).toFixed(1)}%`);
                card.style.setProperty('--rs-my', `${(py * 100).toFixed(1)}%`);
                card.style.setProperty('--rs-glare', '1');
            });
        });
        zone.addEventListener('pointerleave', () => {
            cancelAnimationFrame(raf);
            card.style.transition = 'transform 0.5s cubic-bezier(.2,1.4,.3,1)';
            card.style.setProperty('--rs-rx', '0deg'); card.style.setProperty('--rs-ry', '0deg'); card.style.setProperty('--rs-glare', '0');
            setTimeout(() => { card.style.transition = ''; }, 500);
        });
    }

    /* ─────────────────────────────────────────────────────────────
       3b. STREAM-PAGE ALERT — on every channel page, under the player.
           Never hidden: it collapses to a slim bar (remembered per session).
       ───────────────────────────────────────────────────────────── */
    function mountStreamAlert() {
        // One mount inside the live layout, one inside the offline layout — whichever is showing.
        // The offline one is (re)created on demand in case the channel page rebuilt its offline area.
        const offHead = document.getElementById('ch-offline-header');
        if (offHead && !document.getElementById('rs-stream-alert-offline')) {
            const m = document.createElement('div'); m.className = 'rs-stream-alert-mount'; m.id = 'rs-stream-alert-offline';
            offHead.parentNode.insertBefore(m, offHead);
        }
        document.querySelectorAll('.rs-stream-alert-mount').forEach(mountStreamAlertInto);
    }
    // The SPA swaps pages without reloading — re-check the channel page each time it becomes active.
    function watchChannelPage() {
        const page = document.getElementById('page-channel');
        if (!page || !('MutationObserver' in window)) return;
        new MutationObserver(() => { if (page.classList.contains('active')) mountStreamAlert(); }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    function mountStreamAlertInto(mount) {
        if (!mount || mount.dataset.mounted) return;
        mount.dataset.mounted = '1';
        const minimized = store.get(STREAM_ALERT_KEY, true) === '1';
        mount.innerHTML = `
            <div class="rs-stream-alert${minimized ? ' minimized' : ''}" role="region" aria-label="RobotStreamer switch bonus">
                <div class="rs-sa-stripe" aria-hidden="true"></div>
                <div class="rs-sa-body">
                    <div class="rs-sa-siren" aria-hidden="true"><i class="fa-solid fa-robot"></i></div>
                    <div class="rs-sa-text">
                        <div class="rs-sa-head">🚨 RobotStreamer streamers: get <span class="rs-money">${money()}</span> to switch — for good</div>
                        <div class="rs-sa-sub">Never stream on RobotStreamer again, stream <b>only</b> on OpenVibe.Live, and I pay you <b>${money()}</b> by Zelle or PayPal. Converters get catered to: <b>ask for a feature and I build it.</b> Every line of this site is ${ghLink('open source')} — theirs is closed. Bring a RobotStreamer streamer over and <b>you</b> get ${referral()} too.</div>
                        <div class="rs-sa-chips">${chipsHtml()}</div>
                    </div>
                    <div class="rs-sa-actions">
                        <button class="rs-btn rs-btn-gold" type="button" onclick="rsPromoOpenClaim()"><i class="fa-solid fa-sack-dollar"></i> Claim ${money()}</button>
                        <button class="rs-btn rs-btn-ghost" type="button" onclick="rsPromoReplay()"><i class="fa-solid fa-circle-info"></i> How it works</button>
                    </div>
                </div>
                <div class="rs-sa-mini" onclick="rsPromoToggleStreamAlert()">
                    <i class="fa-solid fa-robot"></i> <span>RobotStreamer streamers: <span class="rs-money">${money()}</span> to switch for good — Zelle / PayPal + features built for you</span>
                    <span class="rs-ticker-cta" onclick="event.stopPropagation(); rsPromoOpenClaim()">Claim</span>
                </div>
                <button class="rs-sa-toggle" type="button" onclick="rsPromoToggleStreamAlert()" title="Collapse / expand" aria-label="Collapse or expand the offer"><i class="fa-solid fa-chevron-up"></i></button>
            </div>`;
    }
    function toggleStreamAlert() {
        const els = document.querySelectorAll('.rs-stream-alert-mount .rs-stream-alert');
        if (!els.length) return;
        const min = !els[0].classList.contains('minimized');
        els.forEach(el => el.classList.toggle('minimized', min));
        store.set(STREAM_ALERT_KEY, min ? '1' : '0', true);
    }

    /* ─────────────────────────────────────────────────────────────
       4. CLAIM MODAL
       ───────────────────────────────────────────────────────────── */
    function claimMessage(method) {
        const via = method === 'paypal' ? 'PayPal' : 'Zelle';
        return `Hey! I'm coming over from RobotStreamer (RS username: ______). I'm done streaming on RS for good — OpenVibe.Live only from now on. I'd like to claim the ${money()} switch bonus via ${via}. My ${via} is: ______ · Referred by (OpenVibe user, if any): ______ 🤖💸`;
    }
    function openClaim() {
        if (modalEl) return;
        const loggedIn = isLoggedIn();
        const owner = esc(cfg.owner);
        const discord = cfg.discord ? esc(cfg.discord) : '';
        modalEl = document.createElement('div');
        modalEl.className = 'rs-modal';
        modalEl.setAttribute('role', 'dialog');
        modalEl.setAttribute('aria-modal', 'true');
        modalEl.setAttribute('aria-label', `Claim your ${money()} RobotStreamer switch bonus`);
        modalEl.innerHTML = `
            <div class="rs-modal-card">
                <button class="rs-modal-close" type="button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                <div class="rs-modal-head">
                    ${coinHtml()}
                    <div>
                        <h3>Claim your <span class="rs-money">${money()}</span></h3>
                        <p>The deal: you never stream on RobotStreamer again and stream only here. I pay you personally — and I build what you ask for.</p>
                    </div>
                </div>
                <div class="rs-toggle" data-method="zelle" role="group" aria-label="How do you want to get paid?">
                    <div class="rs-toggle-thumb" aria-hidden="true"></div>
                    <button type="button" data-method="zelle" aria-pressed="true"><span class="rs-zelle-mark">Z</span> Zelle</button>
                    <button type="button" data-method="paypal" aria-pressed="false"><i class="fa-brands fa-paypal"></i> PayPal</button>
                </div>
                <ol class="rs-steps">
                    <li class="rs-step ${loggedIn ? 'done' : ''}"><span class="rs-step-num"></span><div><strong>Sign in — it's free</strong><span>One OpenVibe account works across the whole network. ${loggedIn ? 'You\'re already in. ✔' : 'Takes about ten seconds.'}</span></div></li>
                    <li class="rs-step"><span class="rs-step-num"></span><div><strong>Go exclusive — retire your RobotStreamer stream</strong><span>Set up here instead: browser (WebRTC), OBS/RTMP, or your robot's existing pipeline — <a href="/broadcast" onclick="return handleLinkClick(event, '/broadcast')">Go Live</a> walks you through it. From now on you stream on OpenVibe.Live only.</span></div></li>
                    <li class="rs-step"><span class="rs-step-num"></span><div><strong>Message me</strong><span>Send your RobotStreamer username plus your <b class="rs-method-word">Zelle</b> info — in-site DM to <b>@${owner}</b> or on Discord. Copy the message below to make it painless.</span></div></li>
                    <li class="rs-step"><span class="rs-step-num"></span><div><strong>Get paid — and get catered to</strong><span>I send the <b>${money()}</b> by hand. Then tell me what your stream needs: converters get features built on request.</span></div></li>
                </ol>
                <div class="rs-msg"><span class="rs-msg-text">${esc(claimMessage('zelle'))}</span><button class="rs-msg-copy" type="button" title="Copy message" aria-label="Copy message"><i class="fa-regular fa-copy"></i></button></div>
                <div class="rs-trust">
                    <div class="rs-trust-row"><i class="fa-brands fa-github"></i><div><b>Why trust this over RobotStreamer?</b> Because you can read it. Every line of OpenVibe.Live is ${ghLink('public on GitHub')} — what it does with your stream, your chat and your data is in the open. RobotStreamer is closed source; you are trusting a black box. An open alternative is the only kind that earns trust.</div></div>
                    <div class="rs-trust-row"><i class="fa-solid fa-people-arrows"></i><div><b>Already on OpenVibe?</b> Bring a RobotStreamer streamer over — when they claim, name you in the message and <b>you get ${referral()}</b> as well. Yes, I'm paying our own users to phase that site out.</div></div>
                </div>
                <div class="rs-modal-actions">
                    ${loggedIn
                        ? `<button class="rs-btn rs-btn-gold" type="button" data-act="dm"><i class="fa-solid fa-paper-plane"></i> DM @${owner} to claim</button>`
                        : `<a class="rs-btn rs-btn-gold" href="/api/auth/sso/login"><i class="fa-solid fa-network-wired"></i> Sign in &amp; claim</a>`}
                    <div class="rs-row">
                        ${discord ? `<a class="rs-btn rs-btn-ghost" href="${discord}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-discord"></i> Claim on Discord</a>` : ''}
                        <a class="rs-btn rs-btn-ghost" href="/broadcast" onclick="return handleLinkClick(event, '/broadcast')" data-act="golive"><i class="fa-solid fa-tower-broadcast"></i> Set up my stream</a>
                    </div>
                </div>
                <p class="rs-modal-fine">One bonus per RobotStreamer account · Zelle or PayPal only · the deal is exclusivity: no more streaming on RobotStreamer, ever. Built and paid for by one person trying to make this work — thanks for giving it a shot <i class="fa-solid fa-heart"></i></p>
            </div>`;
        modalEl.addEventListener('click', onModalClick);
        document.addEventListener('keydown', onModalKey);
        document.body.appendChild(modalEl);
        document.body.style.overflow = 'hidden';
        if (!REDUCED) confettiBurst();
        setTimeout(() => modalEl?.querySelector('.rs-modal-actions .rs-btn')?.focus({ preventScroll: true }), 400);
    }
    function onModalKey(e) { if (e.key === 'Escape') closeClaim(); }
    function onModalClick(e) {
        if (e.target === modalEl || e.target.closest('.rs-modal-close')) { closeClaim(); return; }
        const tb = e.target.closest('.rs-toggle button');
        if (tb) { setMethod(tb.dataset.method); return; }
        if (e.target.closest('.rs-msg-copy')) { copyMessage(e.target.closest('.rs-msg-copy')); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'dm') {
            closeClaim();
            if (typeof window.openMessengerDm === 'function') window.openMessengerDm(cfg.owner);
            else say(`DM @${cfg.owner} to claim your ${money()}`, 'info');
        } else if (act === 'golive') {
            closeClaim();
        }
    }
    function setMethod(method) {
        const tg = modalEl?.querySelector('.rs-toggle'); if (!tg) return;
        tg.dataset.method = method;
        tg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.method === method)));
        modalEl.querySelector('.rs-method-word').textContent = method === 'paypal' ? 'PayPal' : 'Zelle';
        modalEl.querySelector('.rs-msg-text').textContent = claimMessage(method);
        const copyBtn = modalEl.querySelector('.rs-msg-copy'); copyBtn.classList.remove('copied'); copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
    }
    async function copyMessage(btn) {
        const text = modalEl?.querySelector('.rs-msg-text')?.textContent || '';
        try { await navigator.clipboard.writeText(text); }
        catch {
            const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
        }
        btn.classList.add('copied', 'rs-wiggle'); btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => btn.classList.remove('rs-wiggle'), 450);
        say('Claim message copied — paste it in your DM', 'success');
    }
    function closeClaim() {
        if (!modalEl) return;
        const el = modalEl; modalEl = null;
        document.removeEventListener('keydown', onModalKey);
        if (!takeoverEl) document.body.style.overflow = '';
        el.classList.add('leaving');
        setTimeout(() => el.remove(), REDUCED ? 0 : 260);
    }

    // Confetti burst from the bottom corners — gold, violet, RS blue, green.
    function confettiBurst() {
        const canvas = document.createElement('canvas');
        canvas.className = 'rs-confetti';
        (modalEl || document.body).appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = window.innerWidth, h = window.innerHeight;
        canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const COLORS = ['#fbbf24', '#fde68a', '#8b5cf6', '#a78bfa', '#7dd3fc', '#22c55e', '#f472b6', '#ffffff'];
        const parts = [];
        const emit = (x, y, dir) => {
            for (let i = 0; i < 90; i++) {
                const ang = dir + (Math.random() - 0.5) * 1.1, sp = 520 + Math.random() * 520;
                parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, g: 900, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
                    w: 6 + Math.random() * 8, hgt: 4 + Math.random() * 6, c: COLORS[(Math.random() * COLORS.length) | 0], life: 1.6 + Math.random() * 0.8, t: 0, round: Math.random() < 0.3 });
            }
        };
        emit(0, h, -Math.PI / 3.2); emit(w, h, -Math.PI + Math.PI / 3.2);
        let last = 0, raf = 0;
        function tick(now) {
            const dt = Math.min(0.04, (now - (last || now)) / 1000); last = now;
            ctx.clearRect(0, 0, w, h);
            let alive = 0;
            for (const p of parts) {
                p.t += dt; if (p.t > p.life) continue; alive++;
                p.vy += p.g * dt; p.vx *= 0.985; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
                ctx.save(); ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
                if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.hgt / 1.5, 0, Math.PI * 2); ctx.fill(); }
                else ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
                ctx.restore();
            }
            if (alive) raf = requestAnimationFrame(tick); else canvas.remove();
        }
        raf = requestAnimationFrame(tick);
        setTimeout(() => { cancelAnimationFrame(raf); canvas.remove(); }, 3200);
    }

    /* ─────────────────────────────────────────────────────────────
       Boot
       ───────────────────────────────────────────────────────────── */
    async function loadConfig() {
        try {
            const r = await fetch('/api/promo/robotstreamer', { credentials: 'same-origin' });
            if (!r.ok) return;
            const j = await r.json();
            if (typeof j.enabled === 'boolean') cfg.enabled = j.enabled;
            if (Number.isFinite(j.amount) && j.amount > 0) cfg.amount = j.amount;
            if (Number.isFinite(j.amount_min) && j.amount_min > 0) cfg.amountMin = j.amount_min;
            if (Number.isFinite(j.referral) && j.referral > 0) cfg.referral = j.referral;
            if (j.github !== undefined) cfg.github = j.github || '';
            if (j.owner) cfg.owner = String(j.owner);
            if (j.discord !== undefined) cfg.discord = j.discord || '';
        } catch { /* offline / dev without the route — defaults stand */ }
    }
    async function boot() {
        if (!promoAllowedHere()) return;
        await loadConfig();
        if (!cfg.enabled) return;
        mountTicker();
        mountHeroCard();
        mountStreamAlert();
        watchChannelPage();
        // Let the page settle (fonts, hero paint) before the splash slams in.
        setTimeout(() => showTakeover(false), 700);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // Public hooks (hero card buttons, console, other modules)
    window.rsPromoOpenClaim = openClaim;
    window.rsPromoReplay = () => showTakeover(true);
    window.rsPromoHideTicker = hideTicker;
    window.rsPromoToggleStreamAlert = toggleStreamAlert;
})();
