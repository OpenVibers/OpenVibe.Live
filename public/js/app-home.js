/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Home page: hero, live rails, digest, community pulse, Star of OpenVibe, changelog preview.

   Split out of app.js, which every page used to download and parse. This file loads with its
   route (public/features.json); it runs after app.js and relies on app.js globals.
   ═══════════════════════════════════════════════════════════════ */
/**
 * Stale-while-revalidate for public GET payloads.
 *
 * A returning visitor already has last visit's answer sitting in localStorage, and for a feed of
 * clips or a stat board that answer is almost always still right. Rendering it immediately and
 * then reconciling with the live response makes the page look finished on arrival instead of
 * assembling itself over several seconds — which is the whole point of the skeletons, done one
 * better: real content instead of grey bars.
 *
 * The render callback runs at most twice, and the second time only if the response actually
 * differs from what was already drawn, so a warm cache costs one paint rather than two.
 *
 * Only ever used for responses that are identical for every visitor. Anything per-user — the
 * digest, balances, unread counts, auth state — is deliberately not routed through here, and the
 * key includes the signed-in user id so a shared device can never show one account another's
 * cached page.
 */
const _SWR_PREFIX = 'ovswr:';
// Bump when a cached response's shape changes; older records are ignored instead of mis-rendered.
const _SWR_SCHEMA = 2;
/** A category the AI inferred (the server's category_inferred, or a stream row whose effective category is its ai_category) says so (roadmap 33.4). */
function _catInferred(s) { return s && s.category_inferred != null ? !!s.category_inferred : !!(s && s.ai_category && s.ai_category === s.category); }

function _swrKey(path) {
    let uid = 0;
    try { uid = (typeof currentUser !== 'undefined' && currentUser && currentUser.id) || 0; } catch { /* */ }
    return `${_SWR_PREFIX}${uid}:${path}`;
}
/** localStorage is small and shared; keep this to the most recent entries. */
function _swrTrim(max = 40) {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(_SWR_PREFIX)) keys.push(k);
        }
        if (keys.length <= max) return;
        const aged = keys.map(k => { let at = 0; try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch { /* */ } return { k, at }; })
            .sort((a, b) => a.at - b.at);
        for (const { k } of aged.slice(0, keys.length - max)) localStorage.removeItem(k);
    } catch { /* */ }
}
async function apiSWR(path, onData, { ttl = 120000 } = {}) {
    const key = _swrKey(path);
    let cached = null;
    try { const raw = localStorage.getItem(key); if (raw) cached = JSON.parse(raw); } catch { /* storage unavailable or corrupt */ }
    if (cached && (cached.v !== _SWR_SCHEMA || typeof cached.at !== 'number' || !cached.d)) cached = null;
    const fresh = cached && (Date.now() - (cached.at || 0)) < ttl;
    if (fresh) { try { onData(cached.d, true); } catch (e) { console.warn('[swr] cached render failed', path, e); } }
    try {
        const live = await api(path);
        const same = cached && JSON.stringify(cached.d) === JSON.stringify(live);
        try { localStorage.setItem(key, JSON.stringify({ v: _SWR_SCHEMA, at: Date.now(), d: live })); _swrTrim(); } catch { /* quota or private mode */ }
        if (!fresh || !same) onData(live, false);
        return live;
    } catch (err) {
        // Offline or the server is having a moment: whatever we already drew stands.
        if (fresh) return cached.d;
        throw err;
    }
}

/**
 * A username outside chat that behaves like a username inside chat.
 *
 * Names on the home page's activity and leaderboard cards were either plain bold text or a bare
 * link to the channel. In chat the same name opens a menu — message them, view the channel, mod
 * actions if you have them — and people reasonably expect that everywhere a name appears. This
 * emits the same data-* contract showChatContextMenu() reads, so one menu serves both.
 *
 * `u` may be an object ({username, display_name, user_id}) or a bare username string.
 */
function ovUserTag(u, label) {
    const core = typeof u === 'string' ? u : (u && (u.username || u.core_username)) || '';
    const name = label || (typeof u === 'string' ? u : (u && (u.display_name || u.username))) || core;
    if (!core) return esc(name || '');
    const id = (typeof u === 'object' && u && (u.user_id ?? u.id)) ?? '';
    return `<span class="ov-user" role="button" tabindex="0" title="${esc(name)} — open menu"`
        + ` data-username="${esc(name)}" data-core-username="${esc(core)}" data-user-id="${esc(String(id))}"`
        + ` onclick="ovUserMenu(event)" oncontextmenu="ovUserMenu(event)"`
        + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();ovUserMenu(event);}">${esc(name)}</span>`;
}

/**
 * Open the chat user menu.
 *
 * The chat UI is a lazy feature (public/features.json → chatUI) and this page has no chat of its
 * own, so the menu is not here yet: fetch the chat UI and open the same menu. If it cannot be
 * loaded, fall back to the channel — the name is a link to it.
 */
function ovUserMenu(event) {
    if (typeof showChatContextMenu === 'function') return showChatContextMenu(event);
    const el = event.currentTarget;
    const core = el && el.dataset && el.dataset.coreUsername;
    if (!core) return;
    event.preventDefault();
    if (window.ov && typeof window.ov.load === 'function') {
        window.ov.load('chatUI').then(() => {
            if (typeof showChatContextMenu === 'function') showChatContextMenu(event);
        }).catch(() => { navigate(`/@${core}`); });
        return;
    }
    navigate(`/@${core}`);
}

function ovPutCards(container, html, append) {
    if (!container) return;
    if (!append) { container.innerHTML = html; return; }
    const first = container.children.length;
    container.insertAdjacentHTML('beforeend', html);
    const added = Array.prototype.slice.call(container.children, first);

    // home-fx runs its own scroll-reveal over every .stream-card on the home page and parks each
    // one at opacity 0 until it is scrolled to. That is right for cards the reader is scrolling
    // toward and wrong for cards they just asked for by name. Worse, the two animations fight:
    // when .ov-enter is cleaned up below, a card that had not been revealed yet would drop back
    // to opacity 0 and disappear. Marking these as already revealed makes attachReveal() skip
    // them — it early-returns on .hfx-reveal — and leaves them opaque underneath, so .ov-enter is
    // the only thing animating.
    added.forEach(el => el.classList.add('hfx-reveal', 'is-in'));

    let reduce = false;
    try { reduce = (document.documentElement.getAttribute('data-ov-motion') === 'off'); } catch { /* */ }
    if (reduce) return;
    added.forEach((el, i) => {
        el.classList.add('ov-enter');
        el.style.setProperty('--ov-enter-i', String(Math.min(i, 11)));
    });
    setTimeout(() => added.forEach(el => {
        el.classList.remove('ov-enter');
        el.style.removeProperty('--ov-enter-i');
    }), 1400);
}

/* ── Home Page ────────────────────────────────────────────────── */
const HERO_ROTATE_WORDS = [
    'stealth campers', 'nomads', 'outdoor enthusiasts',
    'nerds', 'IRL streamers', 'desktop gamers', 'openvibes',
    'van dwellers', 'digital nomads', 'backpackers',
    'overlanders', 'thru-hikers', 'urban explorers',
    'tinkerers', 'makers', 'coders',
];
let _heroRotateIdx = 0;
let _heroRotateTimer = null;

function startHeroRotation(words) {
    const list = (Array.isArray(words) && words.length) ? words : HERO_ROTATE_WORDS;
    const el = document.getElementById('hero-rotate');
    if (!el) return;
    _heroRotateIdx = 0;
    el.textContent = list[0];
    el.classList.add('visible');
    if (_heroRotateTimer) clearInterval(_heroRotateTimer);
    _heroRotateTimer = setInterval(() => {
        el.classList.remove('visible');
        setTimeout(() => {
            _heroRotateIdx = (_heroRotateIdx + 1) % list.length;
            el.textContent = list[_heroRotateIdx];
            el.classList.add('visible');
        }, 400);
    }, 3000);
}

// ── Hero quip rotator (funny AI-generated slogans) ──────────────
const HERO_FALLBACK_QUIPS = [
    'No investors. No suits. Just vibes.',
    'Built by openvibes, for openvibes.',
    "Corporate streaming? We don't know her.",
    'Open source and proud of it.',
    'Low latency, high chaos.',
    'The internet campfire you forgot you wanted.',
];
let _heroQuipIdx = 0, _heroQuipTimer = null;
function startHeroQuips(quips) {
    const el = document.getElementById('hero-quip');
    if (!el) return;
    const list = (Array.isArray(quips) && quips.length) ? quips : HERO_FALLBACK_QUIPS;
    _heroQuipIdx = 0;
    el.textContent = list[0];
    el.classList.add('visible');
    if (_heroQuipTimer) clearInterval(_heroQuipTimer);
    _heroQuipTimer = setInterval(() => {
        el.classList.remove('visible');
        setTimeout(() => {
            _heroQuipIdx = (_heroQuipIdx + 1) % list.length;
            el.textContent = list[_heroQuipIdx];
            el.classList.add('visible');
        }, 400);
    }, 5000);
}

// ── Hero stats bar (animated count-up) ──────────────────────────
/**
 * Run a DOM change and animate the container from its old height to its new one.
 *
 * Expanding or collapsing a panel by toggling `hidden` makes everything below it jump by however
 * tall the panel is. Measuring before and after, pinning the old height and transitioning to the
 * new one turns that into a movement the eye can follow. The height is pinned only for the length
 * of the animation, so the panel can still grow freely afterwards.
 *
 * `entering` is the block being revealed; it fades up while the height changes, so the swap reads
 * as one movement rather than a resize plus a pop.
 */
function animateHeightChange(wrap, mutate, opts = {}) {
    const { duration = 420, entering = null } = opts;
    const reduced = window.matchMedia && (document.documentElement.getAttribute('data-ov-motion') === 'off');
    if (!wrap || reduced) { try { mutate(); } catch { /* */ } return; }
    const h0 = wrap.offsetHeight;
    try { mutate(); } catch { /* */ }
    const h1 = wrap.offsetHeight;
    if (h0 === h1) return;
    clearTimeout(wrap._ovHeightTimer);
    wrap.classList.add('is-swapping');
    wrap.style.height = `${h0}px`;
    if (entering) { entering.classList.remove('is-entering'); void entering.offsetWidth; entering.classList.add('is-entering'); }
    requestAnimationFrame(() => { wrap.style.height = `${h1}px`; });
    wrap._ovHeightTimer = setTimeout(() => {
        wrap.style.height = '';
        wrap.classList.remove('is-swapping');
        if (entering) entering.classList.remove('is-entering');
    }, duration + 40);
}

function _baselineDeltaHTML(now, avg, peak, window = '24h') {
    const n = Number(now) || 0;
    const a = Number(avg);
    const fmtAvg = (v) => (v < 10 ? String(Math.round(v * 10) / 10) : _fmtCount(Math.round(v)));
    if (!Number.isFinite(a) || a <= 0) {
        const tip = n > 0 ? `${_fmtCount(n)} right now — nothing recorded in the last ${window}`
            : `Nothing in the last ${window}`;
        return `<span class="hero-stat-delta ${n > 0 ? 'is-up' : 'is-flat'}" title="${esc(tip)}"><b>${n > 0 ? 'first today' : 'quiet'}</b></span>`;
    }
    // Nobody right now is not a crash: "-100%" in red read as broken on a quiet hour.
    if (n === 0) {
        return `<span class="hero-stat-delta is-flat" title="${esc(`Nobody right now · ${fmtAvg(a)} on average over the last ${window}`)}"><b>quiet now</b></span>`;
    }
    const pct = Math.round(((n - a) / a) * 100);
    const bits = [`${_fmtCount(n)} right now`, `${fmtAvg(a)} on average over the last ${window}`];
    if (Number.isFinite(Number(peak))) bits.push(`peak ${_fmtCount(Math.round(peak))}`);
    const cls = pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : 'is-flat';
    return `<span class="hero-stat-delta ${cls}" title="${esc(bits.join(' · '))}">`
        + `<b>${pct > 0 ? '+' : ''}${pct}%</b><em>vs ${window}</em></span>`;
}

/**
 * The change against the seven days before, as a small arrow and a percentage ('' when there is no previous week).
 * The triangle is drawn in CSS rather than set as an icon glyph, so it stays crisp and tiny at this size.
 */
function _heroTrendBits(w, pw) {
    if (!Number.isFinite(pw)) return '';
    if (pw === 0) return w > 0 ? '<span class="hero-stat-trend is-new">new</span>' : '';
    const pct = Math.round(((w - pw) / pw) * 100);
    if (pct === 0) return '<span class="hero-stat-trend is-flat"><i></i>flat</span>';
    return `<span class="hero-stat-trend ${pct > 0 ? 'is-up' : 'is-down'}"><i></i>${Math.abs(pct)}%</span>`;
}
/**
 * The pill of a number that already is a seven-day window (people who chatted this week): only how it compares with
 * the week before. "+66 7d" under a chip reading 66 said the same number twice.
 */
function _heroWindowDeltaHTML(w, pw) {
    w = Number(w); pw = Number(pw);
    if (!Number.isFinite(w) || !Number.isFinite(pw)) return '';
    const trend = _heroTrendBits(w, pw);
    if (!trend) return '';
    const cls = pw === 0 ? 'is-up' : w > pw ? 'is-up' : w < pw ? 'is-down' : 'is-flat';
    return `<span class="hero-stat-delta is-window ${cls}" title="${esc(`${_fmtCount(w)} in the last 7 days, against ${_fmtCount(pw)} the seven days before`)}"><em>7d</em>${trend}</span>`;
}

function _heroStatFmt(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    return n.toLocaleString();
}
function _heroCountUp(el, target) {
    const dur = 1100, start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = _heroStatFmt(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step); else el.textContent = _heroStatFmt(target);
    };
    requestAnimationFrame(step);
}
function renderHeroStats(stats) {
    try { _renderHeroStats(stats); }
    catch (err) {
        // A throw in here used to leave the hero showing a skeleton forever, with nothing in the
        // console anyone would notice. Surface it and clear the placeholder instead.
        console.error('[hero] stat board failed to render', err);
        const w = document.getElementById('hero-stats');
        if (w) w.innerHTML = '';
    }
}
function _renderHeroStats(stats) {
    const wrap = document.getElementById('hero-stats');
    if (!wrap || !stats) return;
    // One stat BOARD: every themed group is a full-width row (kicker on the left, chips
    // on a shared column grid), so rows line up edge to edge instead of floating as
    // differently-sized islands. Chips keep short uniform labels (full meaning in the
    // title tooltip) so a long label never dwarfs its number.
    const R = stats.recent || {};
    // Declared here, above every use: both the full board and the headline strip read it, and the
    // board is built first. A const declared between them is a temporal dead zone, which is how
    // this function came to render an empty board twice today.
    const CC = stats.concurrency || {};
    const groups = [];

    // ── Right now ────────────────────────────────────────────────
    // Every number appears once on the board. Visitors and "anons" were the same table (each new address is given an
    // anon name) shown twice, so they are one chip; the weekly figures say only how they compare with the week before.
    const now = [
        { key: 'liveNow', metric: 'liveNow', deltaHTML: _baselineDeltaHTML(stats.liveNow, CC.liveAvg24h, CC.livePeak24h), cls: stats.liveNow > 0 ? 'hero-stat--live' : '', icon: stats.liveNow > 0 ? 'fa-circle' : 'fa-circle-dot', num: stats.liveNow, label: 'Live', title: stats.liveNow > 0 ? 'Streams live right now' : 'Nobody is live right now — check Recently Online below' },
        { key: 'viewersNow', metric: 'viewersNow', deltaHTML: _baselineDeltaHTML(stats.viewersNow, CC.viewersAvg24h, CC.viewersPeak24h), cls: stats.viewersNow > 0 ? 'hero-stat--live' : '', icon: 'fa-eye', num: stats.viewersNow, label: 'Watching', title: 'Viewers watching right now' },
        { key: 'weeklyActive', icon: 'fa-fire', num: stats.weeklyActive, label: 'Chatted', title: 'People who chatted in the last 7 days', desc: 'Distinct chatters in the last 7 days: signed-in people, anonymous chatters and chatters relayed from Twitch, Kick and YouTube, each counted once.', metric: 'active', deltaHTML: _heroWindowDeltaHTML(stats.weeklyActive, stats.prevWeeklyActive) },
        ...(stats.streamedWeek != null ? [{ key: 'streamedWeek', icon: 'fa-tower-broadcast', num: stats.streamedWeek, label: 'Went live', title: 'People who went live in the last 7 days', deltaHTML: _heroWindowDeltaHTML(stats.streamedWeek, stats.prevStreamedWeek) }] : []),
    ];
    // Viewers over the last 24 hours (5-minute samples): trends read better than a snapshot. It opens the
    // Watching chart on its last 24 hours.
    const trend = Array.isArray(stats.viewerTrend) ? stats.viewerTrend : [];
    if (trend.length >= 2 && trend.some(t => (t.viewers || 0) > 0)) {
        const max = Math.max(...trend.map(t => t.viewers || 0), 1);
        const W = 220, H = 34;
        const xy = trend.map((t, i) => [(i / (trend.length - 1) * W).toFixed(1), (H - 2 - ((t.viewers || 0) / max) * (H - 6)).toFixed(1)]);
        const line = xy.map(p => p.join(',')).join(' ');
        const area = `M0,${H} L${xy.map(p => p.join(',')).join(' L')} L${W},${H} Z`;
        const tip = { label: 'Viewers, last 24 hours', title: `People watching over the last 24 hours, sampled every 5 minutes · peak ${max}`, metric: 'viewersNow' };
        now.push({
            spark: true,
            html: `<div class="hero-stat hero-stat--spark hero-stat--clickable" data-metric="viewersNow" data-days="1" data-tip="${esc(JSON.stringify(tip))}" role="button" tabindex="0" aria-label="Viewers over the last 24 hours, peak ${max} — show over time">
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                    <path d="${area}" class="hero-spark-area"/>
                    <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                </svg><span class="hero-stat-label">Viewers · 24h · peak ${max}</span></div>`,
        });
    }
    groups.push({ kicker: 'Right now', icon: 'fa-bolt', rows: now });

    // ── Community ────────────────────────────────────────────────
    groups.push({
        kicker: 'Community', icon: 'fa-people-group', rows: [
            { key: 'anons', icon: 'fa-user-plus', num: stats.anons, label: 'Visitors', metric: 'visitors', title: 'Addresses that have visited Live', desc: 'Each new address that visits Live is given an anonymous name (anon1234), so this counts visits from new addresses: no account, no tracking. A phone that changes networks counts again, so it is more than the number of people.', recent: R.anons },
            { key: 'users', icon: 'fa-users', num: stats.users, label: 'Accounts', metric: 'users', title: 'People with an account on OpenVibe.Live', recent: R.users },
            { key: 'streamers', recent: R.streamers, icon: 'fa-satellite-dish', num: stats.streamers, label: 'Streamers', metric: 'streamers', title: 'People who have gone live here', desc: `People who have gone live here. "+" is new streamers: people whose first stream was in that window.${stats.streamedWeek != null ? ` ${_fmtCount(stats.streamedWeek)} went live in the last 7 days.` : ''}` },
            { icon: 'fa-heart', num: stats.follows, label: 'Follows', metric: 'follows', title: 'Channel follows', recent: R.follows },
            { key: 'chatMessages', icon: 'fa-comments', num: stats.chatMessages, label: 'Messages', metric: 'messages', title: 'Chat messages sent', recent: R.messages },
            { key: 'hoursWatched', recent: R.hoursWatched, unit: 'h', icon: 'fa-couch', num: stats.hoursWatched, label: 'Hours watched', metric: 'hoursWatched', title: 'Hours people have spent watching streams here' },
        ],
    });

    // ── Economy ──────────────────────────────────────────────────
    // The money four (tips, supporters, Vibes bought, subs) count from the Vibes relaunch. While all four are still
    // zero they are one chip that says so ("none yet since 17 Oct"), not four bare zeros that read as a dead site; the
    // first tip brings the four back. Every one of them is still said: nothing is hidden.
    const money = [
        { icon: 'fa-hand-holding-dollar', num: stats.vibesTipped, label: 'Vibes tipped', metric: 'vibes', title: 'Vibes tipped to streamers (100 Vibes = $1), on Live, PowerChat and OpenVibe.Tips', recent: R.vibes },
        { recent: R.supporters, icon: 'fa-hand-holding-heart', num: stats.supporters, label: 'Supporters', metric: 'supporters', title: 'People who have tipped a streamer' },
        { icon: 'fa-cart-shopping', num: stats.vibesBought, label: 'Vibes bought', metric: 'vibesBought', title: 'Vibes bought with real money (PowerChat, card, PayPal, crypto)', recent: R.vibesBought },
        { icon: 'fa-star', num: stats.activeSubs, label: 'Subs', metric: 'subs', title: 'Active channel subscriptions', recent: R.subs },
    ];
    const moneyFresh = money.every(r => r.num === 0);
    const since = stats.economySince && !isNaN(Date.parse(stats.economySince))
        ? new Date(stats.economySince + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const freshTip = { label: 'Tips and subs', title: `No tips, supporters, Vibes bought or subscriptions yet${since ? ` since the Vibes relaunch on ${since}` : ''}. Tip a streamer from their channel: the first one brings these four numbers back.`, desc: '', recent: null, metric: null };
    const fresh = {
        html: `<div class="hero-stat hero-stat--fresh" data-tip="${esc(JSON.stringify(freshTip))}"><i class="fa-solid fa-hand-holding-heart"></i><div class="hero-stat-meta"><span class="hero-stat-word">None yet</span><span class="hero-stat-label">Tips and subs${since ? ` · since ${esc(since)}` : ''}</span></div></div>`,
    };
    groups.push({
        kicker: 'Economy', icon: 'fa-coins', rows: [
            ...(moneyFresh ? [fresh] : money),
            // OpenCoins are network-wide; channel points below are per channel. Shown only when the wallet service
            // answered: zeroed chips would read as "nobody has any". (Coins held was coins earned less 50 spent: gone.)
            ...(stats.coinsEarned != null ? [
                { recent: R.coinsEarned, icon: 'fa-circle-dollar-to-slot', num: stats.coinsEarned, label: 'Coins earned', title: 'OpenCoins earned across the whole network — the site-wide currency you get for watching, chatting and using the tools', desc: `OpenCoins earned across the whole network: the site-wide currency you get for watching, chatting and using the tools.${stats.coinsCirculating != null ? ` ${_fmtCount(stats.coinsCirculating)} are in wallets right now.` : ''}` },
                { recent: R.coinsSpent, icon: 'fa-basket-shopping', num: stats.coinsSpent, label: 'Coins spent', title: 'OpenCoins spent on emotes, themes, cosmetics and sounds' },
                { recent: R.coinHolders, icon: 'fa-wallet', num: stats.coinHolders, label: 'Wallets', title: 'People holding OpenCoins' },
            ] : []),
            { icon: 'fa-coins', num: stats.pointsEarned, label: 'Points earned', metric: 'points', title: 'Channel points earned by viewers (watching, chatting, following) — per channel, unlike OpenCoins', recent: R.points },
            { icon: 'fa-gift', num: stats.pointsSpent, label: 'Points spent', metric: 'pointsSpent', title: `Channel points spent on rewards · ${_fmtCount(stats.redemptions || 0)} rewards redeemed`, recent: R.pointsSpent, sub: stats.redemptions ? `${_fmtCount(stats.redemptions)} rewards` : '' },
            { recent: R.goals, icon: 'fa-bullseye', num: stats.goalsActive, label: 'Goals', title: `Donation goals running now · ${stats.goalsReached || 0} reached so far`, sub: stats.goalsReached ? `${_fmtCount(stats.goalsReached)} reached` : '' },
        ],
    });

    // ── Archive ──────────────────────────────────────────────────
    groups.push({
        kicker: 'Archive', icon: 'fa-box-archive', rows: [
            { key: 'liveSessions', icon: 'fa-tower-broadcast', num: stats.liveSessions, label: 'Streams', metric: 'sessions', title: 'Streams started here, all time', recent: R.sessions },
            { icon: 'fa-film', num: stats.vods, label: 'VODs', metric: 'vods', title: 'Recorded videos', recent: R.vods },
            { icon: 'fa-scissors', num: stats.clips, label: 'Clips', metric: 'clips', title: 'Clips created', recent: R.clips },
            { icon: 'fa-clock', num: stats.streamHours, label: 'Hours archived', metric: 'hours', title: 'Hours of video kept in the archive', recent: R.hours, unit: 'h' },
            { icon: 'fa-brain', num: stats.aiMemories, label: 'AI moments', metric: 'aiMoments', title: 'Moments the AI remembers across every stream', recent: R.aiMoments },
            // The emotes series is gone (OpenVibe.Chat owns the table; Live stopped reading it in T3
            // N+2), so the chip and its chart are skipped — `stats.emotes` is null, the same "no series"
            // signal the OpenCoins chips use. No other markup changes.
            ...(stats.emotes != null ? [
                { recent: R.emotes, icon: 'fa-face-grin-squint', num: stats.emotes, label: 'Emotes', metric: 'emotes', title: 'Custom channel emotes uploaded' },
            ] : []),
            { icon: 'fa-paste', num: stats.pastes, label: 'Pastes', metric: 'pastes', title: `${stats.pasteText || 0} text · ${stats.pasteImages || 0} image pastes`, sub: (stats.pasteText != null && stats.pasteImages != null) ? `${_fmtCount(stats.pasteText)} txt · ${_fmtCount(stats.pasteImages)} img` : '' },
        ],
    });

    // Rolling-window deltas: the small sub-line is "+N in 7d" (was the cryptic "+N wk"); the
    // custom tooltip (data-tip, see _heroTooltip) spells out 24h / 7d / 30d and what the
    // number means. Every chip with a series behind it is clickable → over-time chart.
    const recSub = (rec, u = '') => (rec && rec.w > 0) ? `+${_fmtCount(rec.w)}${u} in 7d` : '';
    /**
     * The seven-day picture on a chip: how much it moved, and whether that beat the week before.
     *
     * One number on its own says nothing — "+2 this week" could be a record or a collapse. So the
     * pill carries both: the gain over the last seven days, and next to it the change against the
     * seven days before that, as a percentage. The triangle is drawn in CSS rather than set as an
     * icon glyph, so it stays crisp and tiny at this size.
     *
     * `rec` is { w, pw }: this window and the one before it. Either may be absent, and the pill
     * degrades to whichever half it has rather than disappearing.
     */
    const trendBits = _heroTrendBits;
    /**
     * The two instantaneous readings — streams live and people watching — against what's normal.
     *
     * A seven-day total makes no sense for a reading, but "busier than usual" does, and the
     * five-minute sampler has a week of history to compare against. Averages ignore samples where
     * nothing was happening, so an empty night doesn't make every afternoon look like a record.
     */
    const recDelta = (rec, u = '') => {
        if (!rec) return '';
        const w = Number(rec.w), pw = Number(rec.pw);
        if (!Number.isFinite(w)) return '';
        if (w === 0 && !Number.isFinite(pw)) return '';
        const up = w > 0;
        const prevText = Number.isFinite(pw) ? `, against ${_fmtCount(pw)} the seven days before` : '';
        const tip = `${_fmtCount(Math.abs(w))} in the last 7 days${prevText}`;
        return `<span class="hero-stat-delta ${w === 0 ? 'is-flat' : up ? 'is-up' : 'is-down'}" title="${esc(tip)}">`
            + `<b>${w === 0 ? '0' : (up ? '+' : '-') + _fmtCount(Math.abs(w))}${u}</b><em>7d</em>`
            + trendBits(w, pw)
            + '</span>';
    };
    const chip = (r) => {
        if (r.html) return r.html; // pre-rendered chips (the sparkline)
        const sub = r.sub || recSub(r.recent, r.unit || '');
        const tip = {
            label: r.label, title: r.title || '', desc: r.desc || '',
            recent: r.recent ? { d: r.recent.d, w: r.recent.w, m: r.recent.m, unit: r.unit || '' } : null,
            metric: r.metric || null,
        };
        const clickable = !!r.metric;
        return `<div class="hero-stat ${r.cls || ''} ${clickable ? 'hero-stat--clickable' : ''}" ${r.key ? `data-stat="${r.key}"` : ''} data-tip="${esc(JSON.stringify(tip))}" ${clickable ? `data-metric="${r.metric}" role="button" tabindex="0" aria-label="${esc(r.label)} — show over time"` : ''}><i class="fa-solid ${r.icon}"></i><div class="hero-stat-meta"><span class="hero-stat-num" data-n="${r.num || 0}">0</span><span class="hero-stat-label">${r.label}${clickable ? ' <i class="fa-solid fa-chart-line hero-stat-chart-hint"></i>' : ''}</span>${sub && !r.recent ? `<span class="hero-stat-sub">${sub}</span>` : ''}</div>${r.deltaHTML || recDelta(r.recent, r.unit || '')}</div>`;
    };
    // The full board is four groups and two dozen chips. Shown by default it pushed every live
    // stream on the site below the fold, and because it only arrives once the stats request lands
    // it was also the single biggest source of layout shift on the page — the content underneath
    // jumped down by the height of the whole board, several seconds in.
    //
    // So: a fixed-height headline strip by default, the full board one tap away. The strip's
    // height is reserved in CSS, so filling it in moves nothing.
    // Seven live numbers, three to a row. These are the ones that move — every other number on
    // the board is an all-time total that changes once an hour at best, so it lives under the
    // toggle. Each is keyed so the poller below can roll it to a new value without a re-render.
    const HEADLINE = [
        { key: 'liveNow', metric: 'liveNow', icon: stats.liveNow > 0 ? 'fa-circle' : 'fa-circle-dot', cls: stats.liveNow > 0 ? 'hero-stat--live' : '', num: stats.liveNow, label: 'Live', title: 'Streams live right now', deltaHTML: _baselineDeltaHTML(stats.liveNow, CC.liveAvg24h, CC.livePeak24h) },
        { key: 'viewersNow', metric: 'viewersNow', icon: 'fa-eye', cls: stats.viewersNow > 0 ? 'hero-stat--live' : '', num: stats.viewersNow, label: 'Watching', title: 'Viewers watching right now', deltaHTML: _baselineDeltaHTML(stats.viewersNow, CC.viewersAvg24h, CC.viewersPeak24h) },
        { key: 'weeklyActive', metric: 'active', icon: 'fa-fire', num: stats.weeklyActive, label: 'Chatted', title: 'People who chatted in the last 7 days', deltaHTML: _heroWindowDeltaHTML(stats.weeklyActive, stats.prevWeeklyActive) },
        { key: 'anons', metric: 'visitors', icon: 'fa-user-plus', num: stats.anons, label: 'Visitors', title: 'Addresses that have visited Live (each is given an anon name)', recent: R.anons },
        { key: 'chatMessages', metric: 'messages', icon: 'fa-comments', num: stats.chatMessages, label: 'Messages', title: 'Chat messages sent, all time', recent: R.messages },
        { key: 'streamers', metric: 'streamers', icon: 'fa-satellite-dish', num: stats.streamers, label: 'Streamers', title: 'People who have gone live here ("+" is new streamers)', recent: R.streamers },
        { key: 'liveSessions', metric: 'sessions', icon: 'fa-tower-broadcast', num: stats.liveSessions, label: 'Streams', title: 'Streams started here, all time', recent: R.sessions },
        { key: 'users', metric: 'users', icon: 'fa-user-group', num: stats.users, label: 'Accounts', title: 'People with an account on OpenVibe.Live', recent: R.users },
        { key: 'hoursWatched', metric: 'hoursWatched', icon: 'fa-couch', num: stats.hoursWatched, label: 'Watch hrs', title: 'Hours people have spent watching streams here', recent: R.hoursWatched, unit: 'h' },
    ];
    // Always starts collapsed. Persisting "expanded" meant every reload rendered and counted up
    // two dozen extra chips before the page had finished loading, for a view the reader asked for
    // once, days ago. The toggle still holds for as long as they're on the page.
    const open = false;
    wrap.innerHTML = `
        <div class="hero-stat-strip">${HEADLINE.map(chip).join('')}</div>
        <button type="button" class="hero-stat-more" id="hero-stat-more" aria-expanded="${open}" aria-controls="hero-stat-full">
            <span class="hero-stat-more-icon" aria-hidden="true"><i class="fa-solid fa-chart-simple"></i></span><span class="hero-stat-more-text"></span><i class="fa-solid fa-chevron-down hero-stat-more-chev" aria-hidden="true"></i>
        </button>
        <div class="hero-stat-full" id="hero-stat-full" ${open ? '' : 'hidden'}>
            ${groups.filter(g => g.rows.length).map(g => `
            <div class="hero-stat-group">
                <span class="hero-stat-kicker"><i class="fa-solid ${g.icon}"></i>${g.kicker}</span>
                <div class="hero-stat-row">${g.rows.map(chip).join('')}</div>
            </div>`).join('')}
            <a class="hero-stat-all-sites" href="https://openvibe.network/stats"><i class="fa-solid fa-chart-column" aria-hidden="true"></i><span>Stats for every OpenVibe site</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>
        </div>`;

    const btn = wrap.querySelector('#hero-stat-more');
    const full = wrap.querySelector('#hero-stat-full');
    const strip = wrap.querySelector('.hero-stat-strip');
    const total = groups.reduce((n, g) => n + g.rows.filter(r => !r.spark).length, 0);
    const label = () => { btn.querySelector('.hero-stat-more-text').textContent = full.hidden ? `Show all ${total} stats` : 'Show fewer stats'; };
    const sync = () => { strip.hidden = !full.hidden; btn.classList.toggle('is-open', !full.hidden); label(); };
    sync();

    /**
     * Swap between the strip and the full board as one movement.
     *
     * Toggling `hidden` on both made them vanish and appear in the same frame, with everything
     * below snapping up or down by several hundred pixels. Instead: measure the height before and
     * after, pin the container to the old height, then let it transition to the new one while the
     * incoming block fades up. The container is only height-constrained during the animation, so
     * nothing is clipped once it settles and the board can still grow if a number gets longer.
     */
    let swapping = 0;
    const reduced = window.matchMedia && (document.documentElement.getAttribute('data-ov-motion') === 'off');
    const swap = () => {
        const toOpen = full.hidden;
        if (reduced) {
            full.hidden = !toOpen; sync();
            btn.setAttribute('aria-expanded', String(toOpen));
            return;
        }
        const h0 = wrap.offsetHeight;
        full.hidden = !toOpen;
        sync();
        btn.setAttribute('aria-expanded', String(toOpen));
        const h1 = wrap.offsetHeight;

        clearTimeout(swapping);
        wrap.classList.add('is-swapping');
        wrap.style.height = `${h0}px`;
        const entering = toOpen ? full : strip;
        entering.classList.remove('is-entering');
        void entering.offsetWidth;
        entering.classList.add('is-entering');
        requestAnimationFrame(() => { wrap.style.height = `${h1}px`; });
        swapping = setTimeout(() => {
            wrap.style.height = '';
            wrap.classList.remove('is-swapping');
            entering.classList.remove('is-entering');
        }, 460);
    };

    btn.addEventListener('click', () => {
        // The board's chips start showing "0" and count up, and a chip reading "70,172" is taller
        // than one reading "0" once its label wraps — so the height measured at click time was
        // several hundred pixels short of where the board actually settles, and the animation
        // finished with a jump. Write the final text first, measure, animate, then count up from
        // zero over the top of it.
        const pending = full.hidden ? [...full.querySelectorAll('.hero-stat-num:not([data-counted])')] : [];
        pending.forEach(el => { el.textContent = _heroStatFmt(parseInt(el.dataset.n, 10) || 0); });
        swap();
        pending.forEach(el => { el.setAttribute('data-counted', '1'); _heroCountUp(el, parseInt(el.dataset.n, 10) || 0); });
    });
    wrap.querySelectorAll('.hero-stat-strip .hero-stat-num').forEach(el => {
        el.setAttribute('data-counted', '1');
        if (window.OVNum) OVNum.mount(el, parseInt(el.dataset.n, 10) || 0);
        else _heroCountUp(el, parseInt(el.dataset.n, 10) || 0);
    });
    _startHeroStatsLive();
    if (open) full.querySelectorAll('.hero-stat-num').forEach(el => { el.setAttribute('data-counted', '1'); _heroCountUp(el, parseInt(el.dataset.n, 10) || 0); });
    _heroBindInteractions(wrap);
}

/**
 * Keep the hero numbers current without re-rendering anything.
 *
 * A number that changes by being replaced is a number nobody notices, and re-rendering the board
 * on a timer would throw away the expand state, the tooltips and any text the reader had
 * selected. So this touches only the digits: it asks for the seven live values, finds each chip
 * by its data-stat key and rolls it to the new value. Nothing is destroyed, nothing reflows, and
 * the element the reader is hovering stays exactly where it was.
 *
 * It only runs while the home page is the visible route and the tab is in the foreground, and it
 * backs off when a request fails so a server having a bad minute does not get hammered.
 */
let _heroStatsTimer = null, _heroStatsBackoff = 0;
function _startHeroStatsLive() {
    if (_heroStatsTimer) return;
    const BASE = 10000;
    const tick = async () => {
        const wrap = document.getElementById('hero-stats');
        const home = document.getElementById('page-home');
        // Nothing to update, or nobody looking at it: skip the request entirely.
        if (!wrap || !home || !home.classList.contains('active') || document.hidden) return schedule(BASE);
        try {
            const d = await api('/home/stats-live');
            _heroStatsBackoff = 0;
            // Deltas move too — refresh them in place rather than rebuilding the chip.
            const DELTA_FOR = {
                users: d.recent?.users, anons: d.recent?.anons,
                chatMessages: d.recent?.messages,
                streamers: d.recent?.streamers,
                liveSessions: d.recent?.sessions,
                hoursWatched: d.recent?.hoursWatched,
            };
            // A seven-day figure's pill is only its comparison with the week before: rebuilt whole when it changes.
            const WINDOWED = { weeklyActive: [d.weeklyActive, d.prevWeeklyActive] };
            for (const [key, [w, pw]] of Object.entries(WINDOWED)) {
                const html = _heroWindowDeltaHTML(w, pw);
                if (!html) continue;
                wrap.querySelectorAll(`[data-stat="${key}"] .hero-stat-delta`).forEach(el => { if (el.outerHTML !== html) el.outerHTML = html; });
            }
            // The two instantaneous readings are re-rendered whole: their pill is a percentage
            // against a moving baseline, not a running total, so patching one number isn't enough.
            const cc = d.concurrency || {};
            const reBase = [['liveNow', d.liveNow, cc.liveAvg24h, cc.livePeak24h], ['viewersNow', d.viewersNow, cc.viewersAvg24h, cc.viewersPeak24h]];
            for (const [key, now, avg, peak] of reBase) {
                wrap.querySelectorAll(`[data-stat="${key}"] .hero-stat-delta`).forEach(el => {
                    const html = _baselineDeltaHTML(now, avg, peak);
                    // Replacing the node every ten seconds whether or not it changed was a steady
                    // stream of mutations for every observer watching the board.
                    if (html && el.outerHTML !== html) el.outerHTML = html;
                });
            }
            for (const [key, rec] of Object.entries(DELTA_FOR)) {
                const w = rec && Number(rec.w);
                if (!Number.isFinite(w)) continue;
                wrap.querySelectorAll(`[data-stat="${key}"] .hero-stat-delta`).forEach(el => {
                    const b = el.querySelector('b');
                    const txt = w === 0 ? '0' : `${w > 0 ? '+' : '-'}${_fmtCount(Math.abs(w))}`;
                    if (b && b.textContent !== txt) b.textContent = txt;
                    el.classList.toggle('is-up', w > 0);
                    el.classList.toggle('is-down', w < 0);
                    el.classList.toggle('is-flat', w === 0);
                });
            }
            for (const [key, value] of Object.entries(d || {})) {
                if (key === 'recent') continue;
                wrap.querySelectorAll(`[data-stat="${key}"] .hero-stat-num`).forEach(el => {
                    if (Number(el.dataset.n) === Number(value)) return;
                    if (window.OVNum) OVNum.set(el, value); else el.textContent = _heroStatFmt(value);
                    el.dataset.n = String(value);
                });
            }
            // The "Live" chip glows when anyone is on air.
            wrap.querySelectorAll('[data-stat="liveNow"], [data-stat="viewersNow"]').forEach(chip => {
                const n = Number(chip.querySelector('.hero-stat-num')?.dataset.n || 0);
                chip.classList.toggle('hero-stat--live', n > 0);
            });
            schedule(BASE);
        } catch {
            _heroStatsBackoff = Math.min(6, _heroStatsBackoff + 1);
            schedule(BASE * (1 + _heroStatsBackoff));
        }
    };
    const schedule = (ms) => { clearTimeout(_heroStatsTimer); _heroStatsTimer = setTimeout(tick, ms); };
    schedule(BASE);
    // Coming back to the tab should show current numbers straight away, not in ten seconds.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(400); });
}

// ── Hero stat tooltips + click-through charts ───────────────────
let _heroTipEl = null;
function _heroTipShow(chip) {
    let tip; try { tip = JSON.parse(chip.dataset.tip || 'null'); } catch { tip = null; }
    if (!tip) return;
    if (!_heroTipEl) { _heroTipEl = document.createElement('div'); _heroTipEl.className = 'hero-tip'; document.body.appendChild(_heroTipEl); }
    const u = tip.recent?.unit || '';
    _heroTipEl.innerHTML = `<div class="hero-tip-title">${esc(tip.label)}</div>
        <div class="hero-tip-desc">${esc(tip.desc || tip.title)}</div>
        ${tip.recent ? `<div class="hero-tip-recent">
            <div><b>+${_fmtCount(tip.recent.d)}${u}</b><span>24 h</span></div>
            <div><b>+${_fmtCount(tip.recent.w)}${u}</b><span>7 days</span></div>
            <div><b>+${_fmtCount(tip.recent.m)}${u}</b><span>30 days</span></div>
        </div>` : ''}
        ${tip.metric ? '<div class="hero-tip-cta"><i class="fa-solid fa-chart-line"></i> Tap for the last 30 / 90 days</div>' : ''}`;
    const r = chip.getBoundingClientRect();
    _heroTipEl.style.left = '0px'; _heroTipEl.style.top = '0px';
    _heroTipEl.classList.add('is-visible');
    const w = _heroTipEl.offsetWidth, h = _heroTipEl.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.top - h - 10;
    if (top < 8) top = r.bottom + 10;
    _heroTipEl.style.left = `${left}px`; _heroTipEl.style.top = `${top}px`;
}
function _heroTipHide() { if (_heroTipEl) _heroTipEl.classList.remove('is-visible'); }
function _heroBindInteractions(wrap) {
    const fine = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    wrap.querySelectorAll('.hero-stat[data-tip]').forEach(chip => {
        if (fine) {
            chip.addEventListener('mouseenter', () => _heroTipShow(chip));
            chip.addEventListener('mouseleave', _heroTipHide);
        }
        // Keyboard focus gets the tip; a tap on a touch screen focuses too, but the tap already
        // opens the stats view, so the tip only got in the way there.
        chip.addEventListener('focus', () => { if (fine || chip.matches(':focus-visible')) _heroTipShow(chip); });
        chip.addEventListener('blur', _heroTipHide);
        chip.addEventListener('touchstart', _heroTipHide, { passive: true });
        if (chip.dataset.metric) {
            const open = () => { _heroTipHide(); if (typeof openStatsNerds === 'function') openStatsNerds(chip); };
            chip.addEventListener('click', open);
            // Start fetching the stats view on intent, so the dialog opens without a wait.
            chip.addEventListener('pointerenter', () => { try { window.ov?.prefetch?.('statsNerds'); } catch { /* */ } }, { once: true });
            chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        }
    });
    window.addEventListener('scroll', _heroTipHide, { passive: true });
}
// ── Hero floating thumbnail collage ─────────────────────────────
const _HERO_BADGE = { live: 'LIVE', vod: 'VOD', clip: 'CLIP', paste: 'PASTE', moment: 'AI MOMENT' };
let _heroCollageTimer = null;
function _heroFloatContent(item) {
    const badge = `<span class="hero-float-badge">${_HERO_BADGE[item.kind] || ''}</span>`;
    if (item.thumbnail) {
        return `<img src="${esc(ovImgW(item.thumbnail, 320))}" data-full="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="${OV_IMG_RETRY}this.remove()">`
            + `<span class="hero-float-body">${badge}<span class="hero-float-title">${esc(item.title || '')}</span></span>`;
    }
    const snippet = item.text ? esc(item.text) : '';
    return `<span class="hero-float-text">${badge}<span class="hero-float-title">${esc(item.title || 'Paste')}</span><span>${snippet}</span></span>`;
}
// The visual content lives in a PERSISTENT .hero-float-inner so swaps only change its contents
// (letting the inner shrink out / grow in) without recreating the element or fighting the drift.
function _heroFloatFill(el, item) {
    let inner = el.querySelector('.hero-float-inner');
    if (!inner) { inner = document.createElement('div'); inner.className = 'hero-float-inner'; el.appendChild(inner); }
    inner.innerHTML = _heroFloatContent(item);
    el.setAttribute('href', item.href || '#');
    el.onclick = (e) => handleLinkClick(e, item.href || '/');
    el.classList.remove('hero-float--live', 'hero-float--vod', 'hero-float--clip', 'hero-float--paste');
    el.classList.add('hero-float', 'hero-float--' + (item.kind || 'vod'));
}
function _heroCollagePositions(n) {
    const pos = [];
    let guard = 0;
    while (pos.length < n && guard++ < 500) {
        const left = Math.random() * 90 + 2;
        const top = Math.random() * 80 + 2;
        if (left > 25 && left < 75 && top > 20 && top < 78) continue; // keep the center clear for the copy
        if (pos.some(p => Math.hypot(p.left - left, (p.top - top) * 0.65) < 13)) continue;
        pos.push({ left, top });
    }
    while (pos.length < n) pos.push({ left: Math.random() * 88 + 3, top: Math.random() * 82 + 2 });
    return pos;
}
// One AI moment frame at a time as the full-bleed hero background, cross-fading (Ken Burns)
// through the day's ~5 frames. Prefers the AI "moment" frames; falls back to any thumbnail.
let _heroBgTimer = null;
let _heroBgActive = 0;
function renderHeroBackground(media, moments) {
    const wrap = document.getElementById('hero-bg');
    if (!wrap) return;
    const layers = wrap.querySelectorAll('.hero-bg-layer');
    if (layers.length < 2) return;
    let frames = (moments || []).filter(m => m && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.kind === 'moment' && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.thumbnail && m.kind !== 'paste').map(m => m.thumbnail);
    frames = [...new Set(frames)];
    if (_heroBgTimer) { clearInterval(_heroBgTimer); _heroBgTimer = null; }
    if (!frames.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    _heroBgActive = 0;
    // Unless the server painted this frame (seo/pages.js): set it and restart the Ken Burns drift.
    if (!(layers[0].style.backgroundImage || '').includes(frames[0])) {
        layers[0].style.backgroundImage = `linear-gradient(var(--hero-veil, rgba(0,0,0,0.5)), var(--hero-veil, rgba(0,0,0,0.5))), url("${frames[0]}")`;
        layers[0].classList.remove('active'); void layers[0].offsetWidth; layers[0].classList.add('active');
    } else layers[0].classList.add('active');
    layers[1].classList.remove('active');
    if (frames.length < 2 || (window.matchMedia && (document.documentElement.getAttribute('data-ov-motion') === 'off') && frames.length < 2)) return;
    let idx = 0;
    _heroBgTimer = setInterval(() => {
        if (document.hidden) return;
        idx = (idx + 1) % frames.length;
        const next = (_heroBgActive + 1) % 2;
        const el = layers[next];
        const pre = new Image();
        pre.onload = () => {
            // The veil is part of the frame's own background rather than a filter or an overlay element: either of those
            // becomes a second full-hero layer on top of an animating one. Its colour is the theme's (--hero-veil, style.css).
            el.style.backgroundImage = `linear-gradient(var(--hero-veil, rgba(0,0,0,0.5)), var(--hero-veil, rgba(0,0,0,0.5))), url("${frames[idx]}")`;
            el.classList.remove('active'); void el.offsetWidth; el.classList.add('active');
            layers[_heroBgActive].classList.remove('active');
            _heroBgActive = next;
        };
        pre.src = frames[idx];
    }, 9000);
}

function renderHeroCollage(media) {
    const wrap = document.getElementById('hero-collage');
    if (!wrap || !Array.isArray(media) || !media.length) return;
    if (_heroCollageTimer) { clearInterval(_heroCollageTimer); _heroCollageTimer = null; }
    wrap.innerHTML = '';
    const reduce = window.matchMedia && (document.documentElement.getAttribute('data-ov-motion') === 'off');
    const w = window.innerWidth || 1200;
    const count = Math.min(media.length, w < 640 ? 5 : w < 1024 ? 8 : 12);
    const positions = _heroCollagePositions(count);
    const cards = [];
    for (let i = 0; i < count; i++) {
        const el = document.createElement('a');
        el.tabIndex = -1;   // decorative (the collage is aria-hidden): the same items are reachable in the page
        // Depth: z in [-260, 120]. Far cards (negative z) are smaller, dimmer, softly blurred;
        // near cards are bigger, brighter, crisp — with mouse-parallax on the whole scene this
        // reads as real 3D depth.
        const z = Math.round(-260 + Math.random() * 380);
        const depth = (z + 260) / 380;                 // 0 = far, 1 = near
        const op = (0.32 + depth * 0.44).toFixed(2);
        const size = Math.round(84 + depth * 98);
        const rot = (Math.random() * 6 - 3).toFixed(1);
        el.style.cssText = `left:${positions[i].left}%;top:${positions[i].top}%;`
            + `--w:${size}px;--op:${op};--rot:${rot}deg;`
            + `--dur:${(11 + Math.random() * 9).toFixed(1)}s;--delay:${(Math.random() * -8).toFixed(1)}s;--in-delay:${(i * 0.05).toFixed(2)}s;`;
        _heroFloatFill(el, media[i % media.length]);
        wrap.appendChild(el);
        cards.push(el);
    }
    _heroParallaxInit();
    if (reduce || media.length <= count) return;
    let ptr = count;
    _heroCollageTimer = setInterval(() => {
        // A swap decodes an image and repaints a card. Nobody sees it while the hero is scrolled
        // away or the tab is in the background, so it waits.
        if (document.hidden) return;
        const heroEl = document.querySelector('#page-home .hero');
        if (heroEl && heroEl.hasAttribute('data-fx-viewport') && !heroEl.classList.contains('fx-live')) return;
        if (!document.getElementById('page-home')?.classList.contains('active')) return;
        const card = cards[Math.floor(Math.random() * cards.length)];
        const item = media[ptr % media.length]; ptr++;
        card.classList.add('swapping');
        setTimeout(() => { _heroFloatFill(card, item); card.classList.remove('swapping'); }, 560);
    }, 8000);
}

// Mouse-parallax: gently tilt the whole 3D collage toward the cursor (desktop only).
let _heroParallaxBound = false;
function _heroParallaxInit() {
    if (_heroParallaxBound) return;
    const hero = document.querySelector('#page-home .hero');
    const collage = document.getElementById('hero-collage');
    if (!hero || !collage) return;
    if (window.matchMedia && ((document.documentElement.getAttribute('data-ov-motion') === 'off') || window.matchMedia('(pointer: coarse)').matches)) return;
    _heroParallaxBound = true;
    // Parallax is a plain 2D shift of the whole collage, written straight to its transform. It used
    // to write --tilt-x/--tilt-y custom properties; custom properties inherit, so every pointer move
    // invalidated style for the collage and every card inside it, and the rotateX/rotateY they fed
    // kept the scene in 3D. The rect is read once per frame rather than once per pointer event.
    let raf = 0, nx = 0, ny = 0, lastE = null;
    const apply = () => {
        raf = 0;
        if (lastE) {
            const r = hero.getBoundingClientRect();
            nx = ((lastE.clientX - r.left) / r.width) * 2 - 1;
            ny = ((lastE.clientY - r.top) / r.height) * 2 - 1;
        }
        collage.style.transform = `translate3d(${(-nx * 14).toFixed(1)}px, ${(-ny * 9).toFixed(1)}px, 0)`;
    };
    hero.addEventListener('pointermove', (e) => { lastE = e; if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
    hero.addEventListener('pointerleave', () => { lastE = null; nx = 0; ny = 0; if (!raf) raf = requestAnimationFrame(apply); });
}

// ── Hero data: stats + collage + AI slogans (falls back gracefully) ──
function _cleanAudiences(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr
        .map(s => String(s == null ? '' : s)
            .replace(/^\s*(live\s*-?\s*)?streaming\s+for\s+/i, '')  // strip a baked-in "live streaming for"
            .replace(/^\s*for\s+/i, '')
            .replace(/[\s,.\-–—:]*(for\s+)?(live\s*-?\s*)?stream(ing|ers|s)?\s*$/i, '') // …or a trailing "live streaming"
            .replace(/^["'‘’“”\-\s]+|["'‘’“”\s]+$/g, '')
            .replace(/[.!,;:]+$/, ''))
        .filter(s => s && s.length <= 60 && !/\b(live\s*-?\s*)?stream(ing|s)?\b|\blivestream/i.test(s));
}
async function loadHeroData() {
    // Last visit's hero (stats, collage, slogans) paints at once; the fresh numbers then roll in
    // through the odometer instead of the board appearing empty and filling after the request.
    try {
        await apiSWR('/home/hero', (data) => _renderHeroData(data), { ttl: 15 * 60 * 1000 });
    } catch { _renderHeroData(null); }
}
function _renderHeroData(data) {
    startHeroRotation(_cleanAudiences(data && data.slogans && data.slogans.audiences));
    startHeroQuips(data && data.slogans && data.slogans.quips);
    startSloganCountdown(data && data.slogans && data.slogans.next_at);
    if (data && data.stats) renderHeroStats(data.stats);
    if (data && data.media) { renderHeroBackground(data.media, data.moments); renderHeroCollage(data.media); }
}

// Playful countdown to the next AI slogan/label batch (regenerates every 12h).
let _sloganCountdownTimer = null;
let _sloganRefreshTimer = null;
// After the countdown hits 0, poll the hero endpoint until the new batch lands, then swap the
// slogans in + restart the countdown — so it never gets stuck on "brewing…".
async function _refreshSlogansIfReady(prevNextAt) {
    try {
        const data = await api('/home/hero');
        const sl = data && data.slogans;
        if (sl && sl.next_at && (!prevNextAt || sl.next_at > prevNextAt)) {
            startHeroRotation(_cleanAudiences(sl.audiences));
            startHeroQuips(sl.quips);
            startSloganCountdown(sl.next_at);
            return true;
        }
    } catch { /* keep polling */ }
    return false;
}
function startSloganCountdown(nextAt) {
    const el = document.getElementById('hero-slogan-timer');
    if (!el) return;
    if (_sloganCountdownTimer) { clearInterval(_sloganCountdownTimer); _sloganCountdownTimer = null; }
    if (_sloganRefreshTimer) { clearInterval(_sloganRefreshTimer); _sloganRefreshTimer = null; }
    if (!nextAt) { el.hidden = true; return; }
    el.hidden = false;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
        let ms = nextAt - Date.now();
        if (ms <= 0) {
            el.innerHTML = `<i class="fa-solid fa-fire"></i> brewing fresh slogans…`;
            if (_sloganCountdownTimer) { clearInterval(_sloganCountdownTimer); _sloganCountdownTimer = null; }
            // Poll for the freshly-generated batch, then restart the countdown.
            if (!_sloganRefreshTimer) {
                _sloganRefreshTimer = setInterval(async () => {
                    if (await _refreshSlogansIfReady(nextAt)) {
                        clearInterval(_sloganRefreshTimer); _sloganRefreshTimer = null;
                    }
                }, 60000);
            }
            return;
        }
        const s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000);
        const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
        // Rebuild the line once, then only touch the clock's text. Replacing the whole innerHTML every
        // second re-created the icon element and was the largest remaining source of idle DOM churn
        // on the home page (20 of 82 mutations in a 20s idle sample).
        let b = el.querySelector('b[data-clock]');
        if (!b) { el.innerHTML = `<i class="fa-solid fa-fire"></i> next fresh batch of memes in <b data-clock></b>`; b = el.querySelector('b[data-clock]'); }
        if (b.firstChild && b.firstChild.nodeType === 3) { if (b.firstChild.data !== clock) b.firstChild.data = clock; }
        else b.textContent = clock;
    };
    tick();
    _sloganCountdownTimer = setInterval(tick, 1000);
}

// The "Streaming the way it should be" About block is collapsed by default — but expanded for
// a first-time visitor (within 30 min of their first visit) so they're more likely to read it.
function _homeAboutDefaultExpanded() {
    try {
        // Phones always start collapsed (2026-10-29): opened, the section is 2.7 screens of reading between the
        // go-live button and the network, and "See what makes it different" sits right under that button.
        if (window.matchMedia('(max-width: 759px)').matches) return false;
        // Once they've scrolled past it (i.e. actually seen it), always collapse by default.
        if (localStorage.getItem('openvibe_about_seen') === '1') return false;
        const KEY = 'openvibe_first_visit';
        let first = parseInt(localStorage.getItem(KEY) || '0', 10);
        if (!first) { first = Date.now(); localStorage.setItem(KEY, String(first)); }
        return (Date.now() - first) < 30 * 60 * 1000;
    } catch { return false; }
}
let _homeAboutSeenObserver = null;
let _homeAboutInited = false;   // only auto-expand on the FIRST home view of the session
function _initHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    // Re-navigating back to Home should NOT re-expand it — only the first view of the session
    // uses the first-visit rule; after that it defaults collapsed.
    const expanded = _homeAboutInited ? false : _homeAboutDefaultExpanded();
    _homeAboutInited = true;
    banner.classList.toggle('about-collapsed', !expanded);
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // Mark it "seen" once the user scrolls all the way past the section, so the next visit
    // defaults to collapsed (they've already had their chance to read it).
    try {
        if (_homeAboutSeenObserver) { _homeAboutSeenObserver.disconnect(); _homeAboutSeenObserver = null; }
        if (localStorage.getItem('openvibe_about_seen') !== '1' && 'IntersectionObserver' in window) {
            _homeAboutSeenObserver = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    // Fully scrolled above the viewport → they've passed it.
                    if (!e.isIntersecting && e.boundingClientRect.bottom < 0) {
                        try { localStorage.setItem('openvibe_about_seen', '1'); } catch { /* */ }
                        if (_homeAboutSeenObserver) { _homeAboutSeenObserver.disconnect(); _homeAboutSeenObserver = null; }
                        break;
                    }
                }
            }, { threshold: 0 });
            _homeAboutSeenObserver.observe(banner);
        }
    } catch { /* observer optional */ }
}
/**
 * Stagger the About cards in as the section opens.
 *
 * Each animated child gets an index so they arrive in reading order; the class comes off on a
 * timer so a card whose animation never ran is not left holding its from-state.
 */
function _aboutPlayOpening(banner) {
    let reduce = false;
    try { reduce = (document.documentElement.getAttribute('data-ov-motion') === 'off'); } catch { /* */ }
    if (reduce) return;
    const items = banner.querySelectorAll('.home-about-body .cta-section-label, .home-about-body .cta-method, .home-about-body .home-cta-feature, .home-about-body .home-cta-buttons, .home-about-body .cta-money-lede');
    items.forEach((el, i) => el.style.setProperty('--about-i', String(Math.min(i, 16))));
    banner.classList.remove('about-opening'); void banner.offsetWidth;
    banner.classList.add('about-opening');
    clearTimeout(banner._aboutTimer);
    banner._aboutTimer = setTimeout(() => banner.classList.remove('about-opening'), 1400);
}
function toggleHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    const collapsed = banner.classList.toggle('about-collapsed');
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (!collapsed) _aboutPlayOpening(banner);
}
function openHomeAbout() {
    const banner = document.getElementById('home-cta-banner');
    if (!banner) return;
    const wasCollapsed = banner.classList.contains('about-collapsed');
    banner.classList.remove('about-collapsed');
    if (wasCollapsed) _aboutPlayOpening(banner);
    const toggle = banner.querySelector('.home-about-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Quest is read by Live's server with the person's Network token. No Quest cookie crosses sites.
async function loadDailyQuest() {
    const card = document.getElementById('home-daily-quest');
    if (!card) return;
    let zone = 'UTC';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone; } catch { /* UTC */ }
    let data;
    try { data = await api('/home/daily-quest?time_zone=' + encodeURIComponent(zone)); }
    catch { card.hidden = true; return; }
    const quest = data && data.quest;
    if (!quest || !Array.isArray(quest.steps) || quest.steps.length !== 3) { card.hidden = true; return; }
    const mine = !!data.signed_in;
    const progress = Math.max(0, Math.min(3, Number(quest.progress) || 0));
    const streak = Math.max(0, Number(quest.streak) || 0);
    card.dataset.progress = mine ? String(progress) : '0';   // the three-part bar under the title
    // The head: what today's quest is and how far you are. The title is the quest's own, in full.
    document.getElementById('home-daily-kicker').textContent = !mine ? "TODAY'S QUEST"
        : quest.completed ? "TODAY'S QUEST · DONE" : `TODAY'S QUEST · ${progress} OF 3`;
    document.getElementById('home-daily-title').textContent = String(quest.title || '');
    const chip = document.getElementById('home-daily-chip');
    chip.replaceChildren();
    chip.hidden = !(mine && streak > 0);
    if (!chip.hidden) {
        const fire = document.createElement('i');
        fire.className = 'fa-solid fa-fire';
        fire.setAttribute('aria-hidden', 'true');
        chip.append(fire, ` ${streak}`);
        chip.title = `${streak}-day streak`;
        chip.setAttribute('aria-label', chip.title);
    }
    document.getElementById('home-daily-story').textContent = String(quest.story || '');
    // Each step is a row that takes you where it is done; the next one for you is marked.
    const siteName = (host) => {
        const part = String(host || '').split('.')[1] || '';
        return part ? 'OpenVibe.' + part.charAt(0).toUpperCase() + part.slice(1) : '';
    };
    const next = mine && !quest.completed ? quest.steps.find(step => !step.done) : null;
    const list = document.getElementById('home-daily-steps');
    list.replaceChildren();
    for (const step of quest.steps) {
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.href = /^https:\/\//.test(step.href || '') ? step.href : 'https://openvibe.quest/';
        const icon = document.createElement('span');
        icon.className = 'ov-icon home-daily-site-icon';
        icon.dataset.icon = String(step.site || '').split('.')[1] || 'quest';
        icon.dataset.size = '32';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'home-daily-step';
        const sentence = document.createElement('span');
        sentence.textContent = String(step.sentence || '');
        const where = document.createElement('small');
        where.textContent = step === next ? 'Next · ' + siteName(step.site) : siteName(step.site);
        text.append(sentence, where);
        link.append(icon, text);
        if (mine && step.done) {
            row.classList.add('is-done');
            const done = document.createElement('span');
            done.className = 'home-daily-check';
            done.textContent = '✓';
            done.setAttribute('aria-label', 'Done');
            link.append(done);
        } else {
            const go = document.createElement('i');
            go.className = 'fa-solid fa-chevron-right home-daily-go';
            go.setAttribute('aria-hidden', 'true');
            link.append(go);
        }
        if (step === next) row.classList.add('is-next');
        row.append(link);
        list.append(row);
    }
    // The door to Quest: what else is there, in one line.
    const more = data.more || {};
    const own = more.mine || null;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const bits = [];
    if (own) {   // the streak is the chip in the head already
        if (own.badges) bits.push(plural(own.badges, 'badge', 'badges'));
        if (own.in_progress) bits.push(plural(own.in_progress, 'quest', 'quests') + ' going');
        const left = (Number(more.quests) || 0) - (Number(own.completed) || 0) - (Number(own.in_progress) || 0);
        if (left > 0) bits.push(`${left} more to try`);
    }
    if (!bits.length && more.quests) bits.push(`${more.quests} quests${more.sites ? ` on ${more.sites} sites` : ''}, each with a badge`);
    if (!bits.length) bits.push('Every quest, your badges and your streak');
    document.getElementById('home-daily-more-line').textContent = bits.join(' · ');
    const toggle = document.getElementById('home-daily-toggle');
    if (!toggle.dataset.wired) {
        toggle.dataset.wired = '1';
        toggle.addEventListener('click', () => {
            const body = document.getElementById('home-daily-body');
            body.hidden = !body.hidden;
            toggle.setAttribute('aria-expanded', String(!body.hidden));
            card.classList.toggle('open', !body.hidden);
        });
    }
    card.hidden = false;
}

/**
 * Demote the two explainer sections once someone has read them enough times.
 *
 * "One stream. Everywhere." and the about panel are the pitch: they exist to tell a first-time
 * visitor what this place is. By the twentieth visit they are furniture between the reader and
 * the streams, and the reader has long since stopped looking at them — but they still shouldn't
 * disappear, because someone may want to send the link to a friend or read the money section.
 *
 * So after 18 home page views they move to the bottom of the page instead, ahead of the
 * changelog and the legal row. Same content, out of the way. The count lives per-browser, and a
 * cleared cache simply means someone sees the pitch again, which is harmless.
 */
const HOME_INTRO_VIEWS_BEFORE_DEMOTING = 18;
const _INTRO_SEEN_KEY = 'ov_home_intro_seen';

/**
 * How many visits the reader has actually *seen* both introductions on.
 *
 * This used to count home page loads, which is not the same thing: someone who opens the home page
 * and goes straight to a stream never scrolled to either section, yet it still counted against
 * them. A sighting now needs both sections to have been on screen during the visit. The old
 * load count seeds the new one once, so people who were already past the threshold stay there.
 */
function _homeIntroSeenCount() {
    try {
        let raw = localStorage.getItem(_INTRO_SEEN_KEY);
        if (raw === null) {
            const legacy = parseInt(localStorage.getItem('ov_home_views') || '0', 10) || 0;
            raw = String(Math.min(legacy, HOME_INTRO_VIEWS_BEFORE_DEMOTING));
            localStorage.setItem(_INTRO_SEEN_KEY, raw);
        }
        return parseInt(raw, 10) || 0;
    } catch { return 0; }
}
let _introSightingArmed = false;
let _introCounted = false;
const _introSeen = new Set();
/**
 * One sighting of the introductions: the reader has seen both of them during this visit.
 *
 * The tour and the About banner are the two parts of the "New here?" block, one after the other on every screen
 * (2026-11-07: no tab row); each is seen when it scrolls past.
 */
function _introSeenNow(id) {
    if (_introCounted) return;
    _introSeen.add(id);
    if (_introSeen.size < 2) return;
    _introCounted = true;
    try { localStorage.setItem(_INTRO_SEEN_KEY, String(Math.min(_homeIntroSeenCount() + 1, 9999))); } catch { /* */ }
}
function _watchIntroSighting() {
    if (_introSightingArmed || !('IntersectionObserver' in window)) return;
    const tour = document.getElementById('home-tour-mount');
    const about = document.getElementById('home-cta-banner');
    if (!tour || !about) return;
    _introSightingArmed = true;
    const io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) _introSeenNow(en.target.id);
    }, { threshold: 0.25 });
    io.observe(tour); io.observe(about);
}

/**
 * Once both introductions have been seen enough times, they go to the very end of the page.
 *
 * They are one block now — the tour, the About banner and the network hub behind one row of tabs — and
 * they move as that block, in order, after the changelog. The old version appended to the *first* .container on
 * the home page — but the changelog lives in a later one, so "moved to the bottom" actually landed them in the
 * middle of the page, above Recently Online.
 */
/**
 * The restream tour (public/js/home-tour.js, feature homeTour) sits below the fold: its code loads when the mount
 * nears the viewport. The mount is a panel of the "New here?" block now, so it can be hidden while another tab is
 * open — force=true loads it at once, which is what opening its tab does.
 */
let _homeTourArmed = false;
let _homeTourLoading = false;
function _loadHomeTour() {
    if (_homeTourLoading || !window.ov) return;
    _homeTourLoading = true;
    window.ov.load('homeTour').catch(() => { _homeTourLoading = false; _homeTourArmed = false; });
}
function _lazyHomeTour(force) {
    const el = document.getElementById('home-tour-mount');
    if (!el || !window.ov) return;
    if (force) { _loadHomeTour(); return; }
    if (_homeTourArmed) return;
    _homeTourArmed = true;
    if (!('IntersectionObserver' in window)) return _loadHomeTour();
    const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) { io.disconnect(); _loadHomeTour(); } }, { rootMargin: '800px 0px' });
    io.observe(el);
}

function demoteHomeIntroSections() {
    _lazyHomeTour();
    _watchIntroSighting();
    if (_homeIntroSeenCount() < HOME_INTRO_VIEWS_BEFORE_DEMOTING) return;
    const block = document.getElementById('home-intro');
    if (!block || block.dataset.ovDemoted) return;
    const containers = document.querySelectorAll('#page-home > .container, #page-home .container');
    const changelog = document.getElementById('home-changelog-wrapper');
    const last = (changelog && changelog.closest('.container')) || containers[containers.length - 1];
    if (!last) return;
    block.dataset.ovDemoted = '1';
    block.classList.add('home-intro-demoted');
    try { last.appendChild(block); } catch { /* */ }
}

/* ── The OpenVibe network (2026-11-07 redesign) ──────────────────────────────────────────────────────────────
 * The section's tiles are in the page already (scripts/build-network-section.js, from OpenVibe.Network's frame), so
 * crawlers and a reader without scripts get every site. Here it comes alive:
 *   - the first time it nears the screen its tiles rise in, in order, and the count of sites counts up;
 *   - the ring icons are drawn by openvibe-shared's ov-icons (loaded then, not with the page);
 *   - the jump links glide to their group; the "OV mark" button opens the network's site switcher;
 *   - "Create your free account" is only for a reader who is not signed in;
 *   - the frame the navbar already holds is read again, and a site that opened since the page was built is added to
 *     its group (DOM nodes, https OpenVibe addresses only), so the section is never behind for long. */
const _OVNET_HOST = /(^|\.)(openvibe\.[a-z]+|open\.shoes|openre\.stream)$/i;
const _OVNET_NEVER = /(^|\.)(openvibe\.(fund|ai|recipes|page)|openvalve\.games|therecipelist\.com)$/i;
// app.js's currentUser is a script-level binding, not a window property: window.currentUser was always undefined, so the
// button showed to people who were signed in (the owner, 11-09). The event's user wins when there is one.
function _ovnetSignedIn(root, user) {
    const cta = root.querySelector('[data-ovnet-signin]');
    const me = user !== undefined ? user : (typeof currentUser !== 'undefined' ? currentUser : null); // eslint-disable-line no-undef
    if (cta) cta.hidden = !!me;
}
function _ovnetCount(root) {
    const el = root.querySelector('.ovnet-count');
    const n = Number(root.querySelector('.ovnet-groups')?.dataset.sites || el?.dataset.count || 0);
    if (!el || !n) return;
    el.dataset.count = String(n);
    if (document.documentElement.getAttribute('data-ov-motion') === 'off') { el.textContent = String(n); return; }
    const clock = window.performance || Date;
    const t0 = clock.now(), dur = 900;
    const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        el.textContent = String(Math.round(n * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function _ovnetIcons() {
    if (window.OpenVibeIcons) { try { window.OpenVibeIcons.mount(document.getElementById('home-network')); } catch { /* */ } return; }
    if (document.querySelector('script[data-ovnet-icons]')) return;
    const sc = document.createElement('script');
    sc.src = '/shared/ov-icons.js'; sc.defer = true; sc.dataset.ovnetIcons = '1';
    sc.onload = () => { try { window.OpenVibeIcons && window.OpenVibeIcons.mount(document.getElementById('home-network')); } catch { /* */ } };
    document.head.appendChild(sc);
}
/** A site the frame lists that the page does not have yet: added to its group, built from DOM nodes. */
function _ovnetAddMissing(root, frame) {
    const nav = frame && Array.isArray(frame.nav) ? frame.nav : [];
    const have = new Set([...root.querySelectorAll('.ovnet-site[data-site]')].map((a) => a.dataset.site));
    let added = 0;
    for (const s of nav) {
        if (!s || typeof s.url !== 'string' || typeof s.name !== 'string' || !s.id) continue;
        const id = String(s.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
        if (!id || have.has(id)) continue;
        let u; try { u = new URL(s.url); } catch { continue; }
        if (u.protocol !== 'https:' || !_OVNET_HOST.test(u.hostname) || _OVNET_NEVER.test(u.hostname)) continue;
        const gid = String(s.group || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        const group = (gid && root.querySelector(`.ovnet-group[data-group="${gid}"] .ovnet-sites`)) || root.querySelector('.ovnet-group:last-of-type .ovnet-sites');
        if (!group) continue;
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'ovnet-site'; a.href = u.href; a.dataset.site = id; a.style.setProperty('--i', String(have.size + added));
        const ic = document.createElement('span');
        ic.className = 'ov-icon'; ic.dataset.icon = String(s.icon || id).replace(/[^a-z0-9-]/gi, '').slice(0, 32); ic.dataset.size = '40'; ic.setAttribute('aria-hidden', 'true');
        const txt = document.createElement('span'); txt.className = 'ovnet-txt';
        const b = document.createElement('b'); b.textContent = String(s.name).slice(0, 40);
        const small = document.createElement('small'); small.textContent = u.hostname;
        txt.append(b, small);
        if (s.tagline) { const line = document.createElement('span'); line.textContent = String(s.tagline).slice(0, 90); txt.append(line); }
        a.append(ic, txt); li.append(a); group.append(li);
        added++;
    }
    if (!added) return;
    for (const g of root.querySelectorAll('.ovnet-group')) {
        const n = g.querySelectorAll('.ovnet-site').length;
        const badge = g.querySelector('.ovnet-n'); if (badge) badge.textContent = String(n);
        const jump = [...root.querySelectorAll('.ovnet-jump a')].find((x) => x.getAttribute('href') === `#${g.id}`); const jb = jump && jump.querySelector('b'); if (jb) jb.textContent = String(n);
    }
    const total = root.querySelectorAll('.ovnet-site').length;
    const groups = root.querySelector('.ovnet-groups'); if (groups) groups.dataset.sites = String(total);
    const count = root.querySelector('.ovnet-count'); if (count) { count.dataset.count = String(total); count.textContent = String(total); }
    if (window.OpenVibeIcons) { try { window.OpenVibeIcons.mount(root); } catch { /* */ } }
}
function initHomeNetwork() {
    const root = document.getElementById('home-network');
    if (!root || root._ovnet) return;
    root._ovnet = true;
    _ovnetSignedIn(root);
    window.addEventListener('openvibe-auth-changed', (e) => _ovnetSignedIn(root, e && e.detail ? e.detail.user : undefined));
    // Glide to a group; the address keeps the group, so the link can be shared.
    root.addEventListener('click', (e) => {
        const jump = e.target.closest('.ovnet-jump a[href^="#"]');
        if (jump) {
            const to = document.getElementById(jump.getAttribute('href').slice(1));
            if (to) { e.preventDefault(); to.scrollIntoView({ behavior: 'smooth', block: 'start' }); try { history.replaceState(history.state, '', jump.getAttribute('href')); } catch { /* */ } }
            return;
        }
        if (e.target.closest('[data-ovnet-switcher]')) {
            // The OpenVibe menu (the orb at the top right) holds every site.
            const visible = (el) => el && el.getBoundingClientRect().width > 0;
            const menu = [document.getElementById('openvibe-burger'), document.getElementById('openvibe-search-btn'), document.getElementById('openvibe-switch-btn')].find(visible);
            if (!menu) return;
            // Show where the button is, then press it: the next time, the person knows where to go.
            menu.classList.add('ovnet-point');
            setTimeout(() => { menu.classList.remove('ovnet-point'); }, 950);
            setTimeout(() => menu.click(), document.documentElement.dataset.ovMotion === 'off' ? 0 : 320);
        }
    });
    // The first time it nears the screen: tiles rise in, the count counts up, the ring icons load.
    const wake = () => {
        if (root._ovnetAwake) return;
        root._ovnetAwake = true;
        root.classList.add('is-in');
        _ovnetCount(root);
        _ovnetIcons();
    };
    if ('IntersectionObserver' in window && !(window.matchMedia && (document.documentElement.getAttribute('data-ov-motion') === 'off'))) {
        root.classList.add('is-armed');
        const io = new IntersectionObserver((entries) => {
            if (entries.some((en) => en.isIntersecting)) { io.disconnect(); requestAnimationFrame(wake); }
        }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
        io.observe(root);
        // Never left invisible: if the observer has not fired in a few seconds of the section being on screen, show it.
        setTimeout(() => { try { if (!root._ovnetAwake && root.getBoundingClientRect().top < window.innerHeight) wake(); } catch { wake(); } }, 4000);
    } else wake();
    // Sites that opened since the page was built.
    try {
        const F = window.OpenVibeFrame;
        if (F && typeof F.get === 'function') {
            const now = F.get((d) => _ovnetAddMissing(root, d));
            if (now) _ovnetAddMissing(root, now);
        }
    } catch { /* the built list stands */ }
}

async function loadHome() {
    initHomeNetwork();    // the OpenVibe network: every site, alive (no tabs: everything shows)
    demoteHomeIntroSections();
    void loadHomeChangelog();
    _initHomeAbout();
    updateNavHeroTransparency();  // transparent nav over the hero at the top
    startHeroRotation();      // instant static rotation; loadHeroData upgrades it with AI slogans
    void loadHeroData();      // stats bar, floating-thumbnail collage, AI slogans
    void loadDailyQuest();     // shared daily quest from OpenVibe.Quest

    // Claim the space every feed is about to fill. Without this the page arrives as a short
    // column that grows in jumps as each request lands, which reads as slow and shoves content
    // around under the reader's thumb. Placeholders are cleared by whoever renders real content,
    // with a backstop below so nothing shimmers forever after a failed request.
    if (window.OVSkeleton) {
        OVSkeleton.cards('stream-grid-live');
        OVSkeleton.block('home-digest', { rows: 3 });
        OVSkeleton.block('home-star-section', { rows: 4, height: 140 });
        setTimeout(() => OVSkeleton.clearAll(), 9000);
    }

    // Reset homepage rails on fresh load
    homeRailReset();

    // Deliberately NOT awaited. Every other section used to sit behind this one request, so a
    // slow /streams held up the clips, VODs, pastes, digest and star rails even though none of
    // them depend on it. They all start together now and each fills in as it arrives.
    void (async () => { try {
        // Paint last visit's grid immediately, then reconcile with what is live now. The cached
        // copy is at most 20 seconds old; anything older falls through to a normal load and the
        // placeholders cover the gap.
        await apiSWR('/streams', (liveData) => {
            // Newest first, never by crowd (market research, Live outcome: a channel that just went live is seen,
            // instead of the biggest staying on top). The server's own order stays for its other readers.
            const streams = (liveData.streams || []).slice().sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
            document.getElementById('live-count').textContent = streams.length;
            const noLiveEl = document.getElementById('no-live-streams');
            if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';
            renderStreamGrid('stream-grid-live', streams, true);
            _homeTopicsSync(streams);
            _homeFeaturedSync(streams.length > 0);
            if (window.homeFeatured && homeFeatured.markGrid) homeFeatured.markGrid();
        }, { ttl: 20000 });
    } catch (e) {
        console.error('Failed to load live streams', e);
        // Never leave placeholders shimmering over a failed request.
        if (window.OVSkeleton) OVSkeleton.clear('stream-grid-live');
        const noLiveEl = document.getElementById('no-live-streams');
        if (noLiveEl) noLiveEl.style.display = '';
    } })();

    loadHomeRecentOnline();
    void loadHomePulse();     // happening-now rail + weekly leaders + AI moments + latest update
    void loadHomeDigest();    // "while you were away" / "lately on OpenVibe" — everyone
    void loadHomeStar();      // "Star of OpenVibe" spotlight (star_streamer setting)

    // Load recent VODs
    loadHomeRecentVods();
    // Load recent clips
    loadHomeClips();
    // Load recent pastes
    loadHomePastes();

    startHomeRefresh(); // live grid + sections auto-update in real time
}

/* ── Community pulse: happening-now rail, weekly leaders, AI moments, latest ship ── */
async function loadHomePulse() {
    try { await apiSWR('/home/pulse', (p) => _renderHomePulse(p), { ttl: 10 * 60 * 1000 }); } catch { /* section stays as it was */ }
}
function _renderHomePulse(p) {
    if (!p) return;

    // The hero one-liner ("shipped 5m ago: …") is the network's shared view (openvibe-shared
    // shipped.js, data-ov-shipped="latest" on #hero-latest), mounted by loadShipped().

    const grid = document.getElementById('pulse-grid');
    const section = document.getElementById('home-pulse-section');
    if (!grid || !section) return;
    const cards = [];
    const add = (kicker, person, value, context, href) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) return;
        const card = document.createElement('a');
        card.className = 'pulse-card pulse-fact-card';
        card.href = href;
        const k = document.createElement('span');
        k.className = 'pulse-kicker';
        k.textContent = kicker;
        const identity = document.createElement('span');
        identity.className = 'pulse-fact-identity';
        const face = document.createElement('span');
        face.className = 'pulse-fact-face';
        const name = String(person.username ? '@' + person.username : (person.display_name || person.name || 'OpenVibe'));
        face.textContent = String(person.display_name || person.username || person.name || 'O').charAt(0).toUpperCase();
        if (person.avatar_url) {
            const img = document.createElement('img');
            img.src = person.avatar_url;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = () => img.remove();
            face.append(img);
        }
        const label = document.createElement('span');
        label.textContent = name;
        identity.append(face, label);
        const big = document.createElement('strong');
        big.className = 'pulse-fact-number';
        big.textContent = new Intl.NumberFormat().format(number);
        const sub = document.createElement('span');
        sub.className = 'pulse-fact-context';
        sub.textContent = context;
        card.append(k, identity, big, sub);
        cards.push(card);
    };
    if (p.liveNow) add('LIVE NOW', p.liveNow, p.liveNow.viewer_count, 'viewers watching', '/@' + encodeURIComponent(p.liveNow.username));
    if (p.topStreamer) add('TOP STREAMER THIS WEEK', p.topStreamer, p.topStreamer.hours, 'hours streamed · peak ' + Number(p.topStreamer.peak_viewers || 0) + ' viewers', '/@' + encodeURIComponent(p.topStreamer.username));
    if (p.busiestChat) add('BUSIEST CHAT', p.busiestChat, p.busiestChat.messages_per_minute, 'messages a minute · ' + p.busiestChat.window, '/@' + encodeURIComponent(p.busiestChat.username));
    if (p.topFan) add('TOP FANS THIS WEEK', p.topFan, p.topFan.points, 'channel points earned', '/@' + encodeURIComponent(p.topFan.username));
    if (p.openCoinsToday > 0) add('OPENCOINS TODAY', { name: 'OpenVibe' }, p.openCoinsToday, 'earned across the network', 'https://openvibe.network/');
    if (p.dailyFinished > 0) add("TODAY'S QUEST", { name: 'OpenVibe.Quest' }, p.dailyFinished, 'people finished today', 'https://openvibe.quest/');
    section.style.display = cards.length ? '' : 'none';
    grid.replaceChildren(...cards);

    // AI Moments showcase row.
    const momentsRow = document.getElementById('home-moments-row');
    const momentsSection = document.getElementById('home-moments-section');
    if (momentsRow && momentsSection) {
        const ms = (p.moments || []).filter(m => m.thumbnail);
        momentsSection.style.display = ms.length ? '' : 'none';
        momentsRow.innerHTML = ms.map(m => `
            <a class="moment-card" href="${esc(m.href)}" onclick="return handleLinkClick(event, '${esc(m.href)}')">
                <img src="${esc(m.thumbnail)}" alt="" loading="lazy">
                <div class="moment-overlay">
                    <div class="moment-title">${esc(m.title)}</div>
                    ${m.username ? `<div class="moment-user">@${esc(m.username)}</div>` : ''}
                </div>
            </a>`).join('');
        // Hidden scrollbar, snap, arrows, position bar (public/js/ov-rail.js). Idempotent.
        if (window.OVRail && ms.length) OVRail.attach(momentsRow, { label: 'AI Moments' });
    }
}

/* ── "While you were away" digest (logged-in returning users) ── */
async function loadHomeDigest() {
    const box = document.getElementById('home-digest');
    if (!box) return;
    const KEY = 'openvibe_last_visit';
    let since = null;
    try { since = localStorage.getItem(KEY); } catch { /* */ }
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch { /* */ }
    let d;
    try { d = await api(`/home/digest${since ? `?since=${encodeURIComponent(since)}` : ''}`); }
    catch { box.innerHTML = ''; box.style.display = 'none'; return; }
    if (!d || typeof d.html !== 'string') { box.style.display = 'none'; return; }
    box.innerHTML = d.html;
    box.style.display = '';
}

async function loadHomeRecentOnline(opts) {
    const { offset, limit, append, rail } = homeRailRange('recent', opts, 'stream-grid-recent', 'loadHomeRecentOnline');
    try {
        const recentData = await api(`/streams/recently-online?limit=${limit}&offset=${offset}`);
        renderRecentlyOnline('stream-grid-recent', recentData.streamers || [], append);
        if (window.OVDensity) {
            // Recently-online cards are wider than a thumbnail — avatar, name and last-seen line
            // all sit on one row — so they need more room before two columns stop being cramped.
            // 188px puts a small phone on one card per row and a large one on two.
            OVDensity.attach(document.getElementById('stream-grid-recent'),
                { key: 'recent', minCard: 188, header: document.getElementById('stream-grid-recent')?.previousElementSibling });
        }
        homeRailLoaded(rail, offset, (recentData.streamers || []).length, recentData.total);
        renderHomePagination('stream-grid-recent-pagination', rail);
    } catch { rail.filling = false; }
}

const _SG_THUMB_PLACEHOLDER = '<div class="streamer-group-stream-thumb-placeholder"><i class="fa-solid fa-video"></i></div>';
// openvibe.media thumbnails come sized (Media's /t/:id?w=&fmt=): a 320 px WebP is about a third of the JPEG.
function _sgThumbSrc(url) {
    if (!url) return null;
    return /^https:\/\/openvibe\.media\/t\/[^?#\s]+$/.test(url) ? `${url}?w=320&fmt=webp` : url;
}
// A thumbnail that does not load (a dropped request on a phone, a frame not written yet) becomes the placeholder.
function _sgThumbFail(img) {
    const box = img && img.parentNode;
    if (box) box.innerHTML = _SG_THUMB_PLACEHOLDER;
}

function renderRecentlyOnline(containerId, streamers, append) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!append) container.replaceChildren();
    if (!streamers.length) return;
    const el = (tag, cls, value) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (value != null) node.textContent = String(value);
        return node;
    };
    for (const s of streamers) {
        const facts = s.recent_facts || {};
        const channelHref = '/@' + encodeURIComponent(s.username || '');
        const card = el('article', 'streamer-group-card recent-streamer-card');
        const head = el('header', 'streamer-group-identity recent-streamer-head');
        // The picture opens the person's menu, as a name in chat does (ovUserMenu); the name is the way to the channel.
        const shown = s.display_name || s.username || '?';
        const face = el('span', 'recent-streamer-face' + (s.live ? ' is-live' : ''), shown.charAt(0).toUpperCase());
        face.setAttribute('role', 'button'); face.tabIndex = 0; face.title = shown + ': open menu';
        face.dataset.username = shown; face.dataset.coreUsername = s.username || ''; face.dataset.userId = String(s.user_id ?? s.id ?? '');
        face.addEventListener('click', (e) => ovUserMenu(e));
        face.addEventListener('contextmenu', (e) => ovUserMenu(e));
        face.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ovUserMenu(e); } });
        if (s.avatar_url) {
            const img = el('img'); img.src = s.avatar_url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
            img.onerror = () => img.remove(); face.append(img);
        }
        const who = el('span', 'recent-streamer-who');
        const name = el('a', 'streamer-group-name', s.username ? '@' + s.username : shown);
        name.href = channelHref;
        const when = el('span', 'streamer-group-last-online' + (s.live ? ' is-live' : ''), s.live ? 'Live now' : timeAgo(s.last_online_at));
        if (!s.live) when.title = 'Last live ' + timeAgo(s.last_online_at);
        const top = el('span', 'recent-streamer-top');
        top.append(name, when);
        who.append(top);
        if (facts.usual_time) who.append(el('span', 'recent-streamer-usual', facts.usual_time));
        head.append(face, who);
        card.append(head);
        // This week, as even tiles: a number and what it counts. One with nothing to say is not drawn; the rest share
        // the row, so a card with one number is not a card with two holes.
        const stats = el('div', 'recent-streamer-stats');
        const stat = (icon, value, unit, label) => {
            if (!value) return;
            const n = el('span', 'recent-streamer-stat');
            n.title = label;
            const i = el('i', 'fa-solid ' + icon); i.setAttribute('aria-hidden', 'true');
            n.append(i, el('b', null, value), el('small', null, unit));
            stats.append(n);
        };
        stat('fa-tower-broadcast', facts.streams_this_week || '', Number(facts.streams_this_week) === 1 ? 'stream' : 'streams', 'Streams this week');
        stat('fa-clock', facts.hours_this_week ? facts.hours_this_week + ' h' : '', 'live', 'Hours live this week');
        stat('fa-fire', facts.days_in_a_row >= 3 ? facts.days_in_a_row + ' d' : '', 'in a row', 'Days in a row');
        const week = stats.childElementCount > 0;
        if (!week && facts.last_stream_seconds) stat('fa-clock', formatDuration(facts.last_stream_seconds), 'last stream', 'Length of the last stream');
        if (week) card.append(el('p', 'recent-streamer-cap', 'This week'));
        if (stats.childElementCount) card.append(stats);
        const overview = String(s.ai_overview_short || s.ai_overview || '').trim();
        const about = el('div', 'recent-streamer-about');
        const summary = el('p', 'recent-streamer-summary', overview);
        about.append(summary);
        if (overview) {
            const more = el('button', 'recent-streamer-more', 'More');
            more.type = 'button'; more.setAttribute('aria-expanded', 'false'); more.hidden = true;
            more.addEventListener('click', () => {
                const open = about.classList.toggle('is-open');
                summary.classList.toggle('expanded', open);
                more.textContent = open ? 'Less' : 'More';
                more.setAttribute('aria-expanded', String(open));
            });
            about.append(more);
            // "More" only where the three lines cut something off; the text fades out there (.is-cut) and More is under it.
            requestAnimationFrame(() => { const cut = summary.scrollHeight > summary.clientHeight + 2; more.hidden = !cut; about.classList.toggle('is-cut', cut); });
        }
        card.append(about);
        const history = el('div', 'recent-streamer-history');
        for (const h of (facts.streams || []).slice(0, 2)) {
            const replay = !h.is_live && h.vod_id;
            const row = el('a', 'recent-stream-row' + (h.is_live ? ' is-live' : ''));
            row.href = replay ? videoHref('vod', h.vod_id) : channelHref;
            // A picture on every one: the replay's own, else the one Live can make from the recording, else a mark
            // that says what it is. Never an empty box.
            const thumb = el('span', 'recent-stream-thumb');
            const made = replay ? `/api/thumbnails/generate/vod/${encodeURIComponent(h.vod_id)}` : null;
            const src = _sgThumbSrc(h.thumbnail_url) || made;
            const blank = () => { thumb.querySelectorAll('img, i').forEach((n) => n.remove()); thumb.classList.add('is-blank'); const i = el('i', 'fa-solid ' + (h.is_live ? 'fa-tower-broadcast' : 'fa-play')); i.setAttribute('aria-hidden', 'true'); thumb.prepend(i); };
            if (src) {
                const img = el('img');
                img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
                img.onerror = () => { if (made && img.dataset.made !== '1') { img.dataset.made = '1'; img.src = made; } else blank(); };
                if (src === made) img.dataset.made = '1';
                img.src = src;
                thumb.append(img);
            } else blank();
            thumb.append(el('span', 'recent-stream-tag', (h.is_live ? 'Live' : 'Replay') + (h.length_seconds ? ' · ' + formatDuration(h.length_seconds) : '')));
            row.append(thumb, el('span', 'recent-stream-title', h.title || 'Stream'));
            history.append(row);
        }
        card.append(history);
        container.append(card);
    }
}

async function loadHomeRecentVods(opts) {
    const { offset, limit, append, rail } = homeRailRange('vods', opts, 'home-recent-vods-grid', 'loadHomeRecentVods');
    try {
        const render = (data) => {
            const vods = data.vods || [];
            const header = document.getElementById('home-recent-vods-header');
            const grid = document.getElementById('home-recent-vods-grid');
            if (!header || !grid) return;
            if (!vods.length && !append) { header.style.display = 'none'; grid.innerHTML = ''; return; }
            header.style.display = '';
            const _put = (html) => ovPutCards(grid, html, append);
            _put(vods.map(v => {
                const href = `${videoHref('vod', v.id)}`;
                return `
                    <a class="stream-card" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                        <div class="stream-card-thumb">
                            ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
                            ${audioChip(v)}
                            ${v.duration_seconds ? `<span class="stream-card-duration">${formatDuration(v.duration_seconds)}</span>` : ''}
                            ${ovViewsBadge(v.view_count)}
                        </div>
                        <div class="stream-card-info">
                            <div class="stream-card-title">${esc(v.title || 'VOD')}</div>
                            <div class="stream-card-streamer">
                                ${_avatarSpan(v.avatar_url, v.username, v.profile_color)}
                                ${esc(v.display_name || v.username)}
                                <span class="muted" style="margin-left:auto;font-size:0.75rem">${timeAgo(v.created_at)}</span>
                            </div>
                            ${_cardAiHTML(v.ai_overview_short, v.ai_overview)}
                        </div>
                    </a>
                `;
            }).join(''));
            if (window.OVDensity) OVDensity.attach(grid, { key: 'vods', header: header });
            homeRailLoaded(rail, offset, vods.length, data.total);
            renderHomePagination('home-recent-vods-pagination', rail);
        };
        await apiSWR(`/streams/recent-vods?limit=${limit}&offset=${offset}`, render, { ttl: 180000 });
    } catch { rail.filling = false; }
}

async function loadHomeClips(opts) {
    const { offset, limit, append, rail } = homeRailRange('clips', opts, 'home-clips-grid', 'loadHomeClips');
    try {
        const render = (data) => {
            const clips = data.clips || [];
            const header = document.getElementById('home-clips-header');
            const grid = document.getElementById('home-clips-grid');
            if (!clips.length && !append) { if (header) header.style.display = 'none'; return; }
            if (header) header.style.display = '';
            const _put = (html) => ovPutCards(grid, html, append);
            _put(clips.map(c => `
                <a class="stream-card" href="${videoHref('clip', c.id)}" onclick="return handleLinkClick(event, '${videoHref('clip', c.id)}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(c.thumbnail_url, 'fa-scissors', c.title, `/api/thumbnails/generate/clip/${c.id}`)}
                        ${audioChip(c)}
                        ${ovViewsBadge(c.view_count)}
                        ${c.duration_seconds ? `<span class="stream-card-duration">${formatDuration(c.duration_seconds)}</span>` : ''}
                    </div>
                    <div class="stream-card-info">
                        <div class="stream-card-title">${esc(c.title || 'Untitled Clip')}</div>
                        <div class="stream-card-streamer">
                            ${_avatarSpan(c.avatar_url, c.username, c.profile_color)}
                            ${esc(c.username || 'Anonymous')}
                            <span class="muted" style="margin-left:auto;font-size:0.75rem">${timeAgo(c.created_at)}</span>
                        </div>
                        ${_cardAiHTML(c.ai_overview_short, c.ai_overview)}
                    </div>
                </a>
            `).join(''));
            if (window.OVDensity) OVDensity.attach(grid, { key: 'clips', header: header });
            homeRailLoaded(rail, offset, clips.length, data.total);
            renderHomePagination('home-clips-pagination', rail);
        };
        // People's clips; the AI's auto-clips have their own place (/moments, the AI Moments rail).
        await apiSWR(`/clips?limit=${limit}&offset=${offset}&auto_generated=0`, render, { ttl: 180000 });
    } catch { rail.filling = false; }
}

async function loadHomePastes(opts) {
    const { offset, limit, append, rail } = homeRailRange('pastes', opts, 'home-pastes-list', 'loadHomePastes');
    try {
        const render = (data) => {
            const pastes = data.pastes || [];
            const header = document.getElementById('home-pastes-header');
            const list = document.getElementById('home-pastes-list');
            if (!pastes.length && !append) { if (header) header.style.display = 'none'; return; }
            if (header) header.style.display = '';
            const _put = (html) => ovPutCards(list, html, append);
            _put(pastes.map(p => {
                const icon = p.type === 'screenshot' ? 'fa-image' : (p.language && p.language !== 'plaintext' ? 'fa-code' : 'fa-file-lines');
                const preview = p.type === 'paste' ? esc((p.content || '').slice(0, 220)).replace(/\n{3,}/g, '\n\n') : '';
                const media = p.type === 'screenshot' && p.screenshot_url
                    ? `<div class="home-paste-media"><img src="${esc(ovImgW(p.screenshot_url, 480))}" data-full="${esc(p.screenshot_url)}" alt="${esc(p.title || 'Screenshot paste')}" loading="lazy" onerror="${OV_IMG_RETRY}"><span class="home-paste-type">Image</span></div>`
                    : `<div class="home-paste-media"><div class="home-paste-snippet">${preview || esc(p.title || 'Untitled paste')}</div><div class="home-paste-icon"><i class="fa-solid ${icon}"></i></div><span class="home-paste-type">${p.language && p.language !== 'plaintext' ? esc(p.language) : 'Text'}</span></div>`;
                return `
                <a class="home-paste-card" href="${esc(pasteHref(p.slug))}">
                    ${media}
                    <div class="home-paste-body">
                    <div class="home-paste-info">
                        <div class="home-paste-title">${esc(p.title || 'Untitled')}</div>
                        <div class="home-paste-meta">
                            ${p.username ? esc(p.username) : 'Anonymous'}
                            ${p.language && p.language !== 'plaintext' ? ` · <span class="home-paste-lang">${esc(p.language)}</span>` : ''}
                            · ${timeAgo(p.created_at)}
                        </div>
                        ${_cardAiHTML(p.ai_summary)}
                        ${p.more_like_it && p.ai_summary ? `<div class="home-paste-preview">and ${Number(p.more_like_it)} more like it</div>` : ''}
                    </div>
                    </div>
                </a>`;
            }).join(''));
            if (window.OVDensity) OVDensity.attach(list, { key: 'pastes', header: document.getElementById('home-pastes-header') });
            homeRailLoaded(rail, offset, data.raw_count || pastes.length, data.total);
            renderHomePagination('home-pastes-pagination', rail);
        };
        await apiSWR(`/pastes?limit=${limit}&offset=${offset}&origin=user&dedupe=consecutive`, render, { ttl: 180000 });
    } catch { rail.filling = false; }
}

// Markup for a single stream card (live or recent). Extracted so the home page
// can reconcile the live grid in place for real-time updates.
/**
 * The colour a card's picture sits on until it arrives (plan L52: "a fake thumbnail… so it is not jarring"): the
 * streamer's own profile colour, or one drawn from their name, so a grid fills in colour rather than grey boxes.
 */
function _thumbTint(s) {
    if (s && /^#[0-9a-f]{6}$/i.test(String(s.profile_color || ''))) return s.profile_color;
    const name = String((s && s.username) || '');
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return `hsl(${h} 45% 34%)`;
}

/* ── Topics: what the live streams are about, as filters over the Live Now grid ─────────────
   A stream's topics are its category, the tags its streamer set and the tags the AI read from the
   stream (streams.ai_tags), minus words that say nothing to a viewer here: every stream is live,
   streamed and on a camera or a screen. Live market outcome 2: a viewer picks a topic, the grid
   keeps the streams that have it; nothing else on the page changes. */
const _TOPIC_STOP = new Set(['live', 'live stream', 'livestream', 'stream', 'streaming', 'streamer', 'chat', 'livechat',
    'live chat', 'overlay', 'ui', 'setup', 'lobby', 'facecam', 'multicam', 'multiframe', 'webcam', 'camera', 'screen',
    'desktop', 'browser', 'obs', 'gameplay', 'commentary', 'surveillance', 'stream overlay', 'pc']);
function _streamTopics(s) {
    const out = [];
    const add = (t) => {
        const v = String(t || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (v && v.length <= 32 && !_TOPIC_STOP.has(v) && !out.includes(v)) out.push(v);
    };
    add(s && s.category);
    for (const field of [s && s.tags, s && s.ai_tags]) {
        let list = field;
        if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
        if (Array.isArray(list)) list.forEach(add);
    }
    return out;
}

// The chip a viewer picked comes back the next time it is live (market outcome 2: a default set), in this browser
// only; _homeTopic is what is applied now, which is All while the picked topic is off air.
const _TOPIC_KEY = 'ov_home_topic';
let _homeTopicPref = (() => { try { return (typeof localStorage !== 'undefined' && localStorage.getItem(_TOPIC_KEY)) || ''; } catch { return ''; } })();
let _homeTopic = '';
// Following (market outcome 3): the live channels the signed-in viewer follows, from GET /api/streams/following
// (private, never cached by the edge), read at most once a minute. A chip of its own, first after All.
const _FOLLOWING = '@following';
let _homeFollowing = { at: 0, ids: new Set(), busy: false };
let _homeLastStreams = [];
function _homeFollowingRefresh() {
    const me = typeof currentUser !== 'undefined' && currentUser;
    if (!me || typeof api !== 'function') { if (!me) _homeFollowing = { at: 0, ids: new Set(), busy: false }; return; }
    if (_homeFollowing.busy || Date.now() - _homeFollowing.at < 60000) return;
    _homeFollowing.busy = true;
    api('/streams/following').then((d) => {
        _homeFollowing = { at: Date.now(), ids: new Set(((d && d.user_ids) || []).map(Number)), busy: false };
        _homeTopicsSync(_homeLastStreams);
    }).catch(() => { _homeFollowing = { ..._homeFollowing, at: Date.now(), busy: false }; });
}
/** The chip row over the live grid: shown when at least two streams are live and they have two topics or more, or
 *  some of them are channels the viewer follows. */
function _homeTopicsSync(streams) {
    const row = document.getElementById('home-topics');
    if (!row) return;
    _homeLastStreams = streams;
    _homeFollowingRefresh();
    const counts = new Map();
    for (const s of streams) for (const t of _streamTopics(s)) counts.set(t, (counts.get(t) || 0) + 1);
    const followingN = streams.filter((s) => _homeFollowing.ids.has(Number(s.user_id))).length;
    const show = streams.length >= 2 && (counts.size >= 2 || followingN > 0);
    row.hidden = !show;
    if (!show) { _homeTopic = ''; _homeTopicsApply(); return; }
    const available = new Set(counts.keys());
    if (followingN) available.add(_FOLLOWING);
    _homeTopic = available.has(_homeTopicPref) ? _homeTopicPref : '';
    // Most streams first, then A to Z; the row scrolls sideways, so every topic stays reachable.
    const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const key = `${streams.length}|${followingN}|${list.map(([t, n]) => `${t}:${n}`).join(',')}`;
    if (row.dataset.key !== key) {
        row.dataset.key = key;
        const chip = (topic, label, n) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'home-topic';
            b.dataset.topic = topic;
            b.append(label);
            const c = document.createElement('span');
            c.className = 'home-topic-n';
            c.textContent = String(n);
            b.append(' ', c);
            return b;
        };
        const nodes = [chip('', 'All', streams.length)];
        if (followingN) nodes.push(chip(_FOLLOWING, 'Following', followingN));
        for (const [t, n] of list) nodes.push(chip(t, _capTag(t), n));
        row.replaceChildren(...nodes);
        if (!row._ovBound) {
            row._ovBound = true;
            row.addEventListener('click', (e) => {
                const b = e.target.closest('.home-topic');
                if (!b) return;
                const next = b.dataset.topic === _homeTopic ? '' : b.dataset.topic;
                _homeTopicPref = next;
                _homeTopic = next;
                try { if (next) localStorage.setItem(_TOPIC_KEY, next); else localStorage.removeItem(_TOPIC_KEY); } catch { /* private mode */ }
                _homeTopicsApply();
            });
        }
    }
    _homeTopicsApply();
}
function _homeTopicsApply() {
    const row = document.getElementById('home-topics');
    if (row) row.querySelectorAll('.home-topic').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.topic === _homeTopic)));
    const grid = document.getElementById('stream-grid-live');
    if (!grid) return;
    grid.querySelectorAll('.stream-card[data-stream-id]').forEach((card) => {
        const keep = !_homeTopic || (_homeTopic === _FOLLOWING
            ? _homeFollowing.ids.has(Number(card.dataset.user))
            : (card.dataset.topics || '').split('|').includes(_homeTopic));
        card.hidden = !keep;
    });
}

function streamCardHTML(s, isLive) {
    let navUrl;
    if (isLive && s.id) {
        const msRef = s.managed_stream_slug || s.managed_stream_id || null;
        navUrl = channelPath(s.username, msRef);
    } else if (!isLive && s.vod_id && s.vod_is_public) {
        navUrl = `${videoHref('vod', s.vod_id)}`;
    } else {
        navUrl = channelPath(s.username);
    }
    const thumb = (!isLive && s.vod_thumbnail_url) ? s.vod_thumbnail_url : s.thumbnail_url;
    const duration = !isLive && s.vod_duration ? `<span class="stream-card-duration">${formatDuration(s.vod_duration)}</span>` : '';
    const endedAgo = !isLive && s.ended_at ? `<span class="stream-card-ago">${timeAgo(s.ended_at)}</span>` : '';
    const topics = isLive ? _streamTopics(s) : [];
    const cat = String(s.category || '').replace(/[-_]+/g, ' ').trim().toLowerCase();
    const shown = topics.filter((t) => t !== cat).slice(0, 2);
    return `
        <a class="stream-card"${ovLabelsAttr(s)}${isLive ? ` data-topics="${esc(topics.join('|'))}" data-user="${esc(String(s.user_id || ''))}"` : ''} data-stream-id="${esc(String(s.id || ''))}" href="${esc(navUrl)}" onclick="return handleLinkClick(event, '${esc(navUrl)}')">
            <div class="stream-card-thumb${s.is_nsfw ? ' stream-card-nsfw-blur' : ''}" style="--thumb-tint:${esc(_thumbTint(s))}" data-ov-labels-media>
                ${thumbImg(thumb, 'fa-circle-nodes', s.title, !isLive && s.vod_id ? `/api/thumbnails/generate/vod/${s.vod_id}` : null)}
                ${streamTypeBadge(s.browser_mode, s.streaming_method)}
                ${s.is_nsfw ? '<span class="stream-card-nsfw">18+</span>' : ''}
                ${duration}
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(s.title || 'Untitled Stream')}</div>
                ${ovLabelChips(s)}
                <div class="stream-card-streamer">
                    ${_avatarSpan(s.avatar_url, s.username, s.profile_color)}
                    ${esc(s.username ? '@' + s.username : 'Anonymous')}
                    ${endedAgo}
                </div>
                ${(isLive && s.description) ? `<div class="stream-card-desc" title="Click to expand" onclick="event.preventDefault();event.stopPropagation();this.classList.toggle('expanded')">${esc(s.description)}</div>` : ''}
                ${_cardAiHTML(s.ai_overview_short, s.ai_overview)}
                <div class="stream-card-meta">
                    ${s.category ? `<span class="stream-card-tag"${_catInferred(s) ? ' title="Category inferred by OpenVibe&#39;s AI from the stream"' : ''}>${esc(_capTag(s.category))}${_catInferred(s) ? '<span class="cat-inferred"> · inferred</span>' : ''}</span>` : ''}
                    ${shown.length ? `<span class="stream-card-topics">${shown.map((t) => esc(_capTag(t))).join(' · ')}</span>` : ''}
                    <span class="stream-card-metaright">
                        ${isLive && s.started_at ? `<span class="stream-card-uptime" data-since="${esc(s.started_at)}"><i class="fa-solid fa-clock"></i> ${formatUptime(s.started_at)}</span>` : ''}
                        ${isLive ? `<span class="stream-card-vcount"><i class="fa-solid fa-eye"></i> ${s.total_viewer_count || s.viewer_count || 0}</span>` : ''}
                    </span>
                </div>
            </div>
        </a>`;
}

/**
 * The featured stream box lives in its own lazily loaded feature; it is only fetched the first time
 * someone is live, and it stays out of the page entirely if the reader switched it off.
 */
let _homeFeaturedLoading = null;
function _homeFeaturedSync(hasLive) {
    const off = (() => { try { return localStorage.getItem('ov_home_featured_off') === '1'; } catch { return false; } })();
    const t = document.getElementById('home-featured-toggle');
    if (t) { t.hidden = !(off && hasLive); if (!t._ovBound) { t._ovBound = true; t.addEventListener('click', () => { if (window.homeFeatured) homeFeatured.setOff(false); else { try { localStorage.removeItem('ov_home_featured_off'); } catch { /* */ } _homeFeaturedSync(true); } }); } }
    if (!hasLive || off) { if (window.homeFeatured) homeFeatured.boot(hasLive); return; }
    if (window.homeFeatured) { homeFeatured.boot(true); return; }
    if (!_homeFeaturedLoading && window.ov && ov.load) {
        _homeFeaturedLoading = ov.load('featured').then(() => { if (_homeIsActive() && window.homeFeatured) homeFeatured.boot(true); }).catch(() => { _homeFeaturedLoading = null; });
    }
}

function renderStreamGrid(containerId, streams, isLive) {
    const c = document.getElementById(containerId);
    if (!c) return;
    // Placeholders have done their job the moment real data lands. Remove them by class rather
    // than clearing the container, because the live grid keeps its empty-state child in there.
    c.querySelectorAll('.ovsk').forEach(n => { try { n.remove(); } catch { /* */ } });
    if (!streams.length) {
        if (!isLive) c.innerHTML = '<div class="empty-state"><p class="muted">No recent streams</p></div>';
        return;
    }
    // Keep the live grid's empty-state node across a re-render. Replacing innerHTML used to
    // delete it outright, so once anyone went live the "nobody is streaming" message could never
    // come back when they all stopped — the grid just sat there blank.
    const empty = c.querySelector('.empty-state');
    c.innerHTML = streams.map(s => streamCardHTML(s, isLive)).join('');
    if (empty) { empty.style.display = 'none'; c.appendChild(empty); }
}

/* ── Real-time home updates ─────────────────────────────────── */
let _homeLiveTimer = null;
let _homeSectionsTimer = null;

function _homeIsActive() {
    const p = document.getElementById('page-home');
    return p && p.classList.contains('active');
}

// Cross-fade a card's thumbnail to a new frame (live thumbnails change per capture).
function _crossfadeThumb(imgEl, newSrc) {
    if (!imgEl || !newSrc || imgEl.getAttribute('src') === newSrc) return;
    const pre = new Image();
    pre.onload = () => {
        imgEl.style.transition = 'opacity 0.4s';
        imgEl.style.opacity = '0';
        setTimeout(() => { imgEl.src = newSrc; imgEl.style.opacity = '1'; }, 400);
    };
    pre.src = newSrc;
}

function _updateLiveCard(card, s) {
    // The AI re-reads a stream as it goes, so its topics can change between refreshes.
    card.dataset.topics = _streamTopics(s).join('|');
    const vc = card.querySelector('.stream-card-vcount');
    if (vc) vc.innerHTML = `<i class="fa-solid fa-eye"></i> ${s.total_viewer_count || s.viewer_count || 0}`;
    const up = card.querySelector('.stream-card-uptime');
    if (up && s.started_at) { up.innerHTML = `<i class="fa-solid fa-clock"></i> ${formatUptime(s.started_at)}`; up.dataset.since = s.started_at; }
    const t = card.querySelector('.stream-card-title');
    if (t && t.textContent !== (s.title || 'Untitled Stream')) t.textContent = s.title || 'Untitled Stream';
    // AI overview: the card renders WITHOUT an overview block when the stream first
    // goes live (none exists yet). Inject it the moment one becomes available, then
    // keep its text current — otherwise it never appears without a full reload.
    if (s.ai_overview) {
        const aiBox = card.querySelector('.card-ai-overview');
        if (aiBox) {
            const shortTxt = (s.ai_overview_short || s.ai_overview || '').trim();
            const longTxt = (s.ai_overview || '').trim();
            // Don't clobber the text while the viewer has it expanded.
            if (!aiBox.classList.contains('expanded')) {
                const ai = aiBox.querySelector('.card-ai-text');
                if (ai && shortTxt && ai.textContent !== shortTxt) ai.textContent = shortTxt;
            }
            if (longTxt && longTxt !== shortTxt) aiBox.dataset.full = longTxt; else delete aiBox.dataset.full;
        } else {
            const info = card.querySelector('.stream-card-info');
            if (info) {
                const tmp = document.createElement('div');
                tmp.innerHTML = _cardAiHTML(s.ai_overview_short, s.ai_overview);
                const el = tmp.firstElementChild;
                if (el) {
                    const meta = info.querySelector('.stream-card-meta');
                    meta ? info.insertBefore(el, meta) : info.appendChild(el);
                }
            }
        }
    }
    const desc = card.querySelector('.stream-card-desc');
    if (desc && s.description != null && desc.textContent !== s.description) desc.textContent = s.description;
    // Thumbnail: live cards render a placeholder icon (no <img>) until the first frame
    // is captured. Crossfade if an <img> exists, else swap the placeholder for one.
    if (s.thumbnail_url) {
        const thumbBox = card.querySelector('.stream-card-thumb');
        const img = thumbBox && thumbBox.querySelector('img');
        if (img) {
            _crossfadeThumb(img, s.thumbnail_url);
        } else if (thumbBox) {
            const placeholder = thumbBox.querySelector(':scope > i');
            const newImg = document.createElement('img');
            newImg.alt = s.title || '';
            newImg.loading = 'lazy';
            newImg.style.opacity = '0';
            newImg.style.transition = 'opacity 0.4s';
            newImg.onerror = function () { handleThumbnailError(this); };
            newImg.onload = function () { this.style.opacity = '1'; };
            newImg.src = s.thumbnail_url;
            thumbBox.insertBefore(newImg, thumbBox.firstChild);
            if (placeholder) placeholder.style.display = 'none';
        }
    }
}

// Live-counting uptime tooltip: hover an uptime chip to see H:MM:SS ticking.
let _uptimeTipEl = null, _uptimeTipTimer = null, _uptimeTipSince = 0;
function _fmtHMS(ms) {
    let sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function _initUptimeTooltip() {
    if (window.__uptimeTipInit) return; window.__uptimeTipInit = true;
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest && e.target.closest('.stream-card-uptime[data-since]');
        if (!el) return;
        const raw = el.dataset.since;
        const isUTC = raw.includes('Z') || raw.includes('+') || raw.includes('T');
        _uptimeTipSince = new Date(isUTC ? raw : raw.replace(' ', 'T') + 'Z').getTime();
        if (!_uptimeTipEl) {
            _uptimeTipEl = document.createElement('div');
            _uptimeTipEl.className = 'uptime-tooltip';
            document.body.appendChild(_uptimeTipEl);
        }
        const tick = () => {
            _uptimeTipEl.textContent = 'Live for ' + _fmtHMS(Date.now() - _uptimeTipSince);
        };
        tick();
        const r = el.getBoundingClientRect();
        _uptimeTipEl.style.left = Math.round(r.left) + 'px';
        _uptimeTipEl.style.top = Math.round(r.top - 30) + 'px';
        _uptimeTipEl.style.display = 'block';
        clearInterval(_uptimeTipTimer);
        _uptimeTipTimer = setInterval(tick, 1000);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest && e.target.closest('.stream-card-uptime[data-since]');
        if (!el) return;
        clearInterval(_uptimeTipTimer);
        if (_uptimeTipEl) _uptimeTipEl.style.display = 'none';
    });
}

// Reconcile the live grid in place: update existing cards, animate in new streams,
// animate out ended ones — no full re-render, no flashing.
async function refreshHomeLive() {
    if (!_homeIsActive()) return;
    // A background tab has nobody to show a refreshed grid to. refreshHomeSections() already
    // skips in that case; this one polled /api/streams forever regardless.
    if (document.hidden) return;
    let streams, agents;
    try { const d = await api('/streams'); streams = d.streams || []; agents = d.agents || []; } catch { return; }
    renderHomeAgents(agents);
    const grid = document.getElementById('stream-grid-live');
    if (!grid) return;
    const countEl = document.getElementById('live-count');
    if (countEl) countEl.textContent = streams.length;
    const noLiveEl = document.getElementById('no-live-streams');
    if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';

    const existing = new Map();
    grid.querySelectorAll('.stream-card[data-stream-id]').forEach(el => existing.set(el.dataset.streamId, el));
    const seen = new Set();
    streams.forEach((s, idx) => {
        const id = String(s.id);
        seen.add(id);
        const card = existing.get(id);
        if (card) {
            _updateLiveCard(card, s);
        } else {
            const tmp = document.createElement('div');
            tmp.innerHTML = streamCardHTML(s, true).trim();
            const el = tmp.firstElementChild;
            if (el) {
                el.classList.add('stream-card-appear');
                grid.insertBefore(el, grid.children[idx] || null);
            }
        }
    });
    existing.forEach((el, id) => {
        if (!seen.has(id)) {
            el.classList.add('stream-card-leave');
            setTimeout(() => { try { el.remove(); } catch {} }, 420);
        }
    });
    _homeTopicsSync(streams);
}

/** The Agents live row: public AI agent streams in their own row after people's streams (S2). */
function renderHomeAgents(agents) {
    const section = document.getElementById('home-agents');
    const grid = document.getElementById('home-agents-grid');
    if (!section || !grid) return;
    const list = Array.isArray(agents) ? agents : [];
    if (!list.length) { section.hidden = true; grid.replaceChildren(); return; }
    grid.replaceChildren();
    for (const a of list.slice(0, 12)) {
        const card = document.createElement('a');
        card.className = 'agent-card';
        card.href = a.page_url || '#';
        const media = document.createElement('div');
        media.className = 'agent-card-media';
        if (a.last_frame_url) {
            const img = document.createElement('img');
            img.src = a.last_frame_url; img.alt = ''; img.loading = 'lazy';
            media.appendChild(img);
        }
        const label = document.createElement('span');
        label.className = 'agent-label'; label.textContent = 'AI agent';
        media.appendChild(label);
        if (a.state === 'live') {
            const live = document.createElement('span');
            live.className = 'agent-card-live'; live.textContent = a.viewers ? `live · ${a.viewers}` : 'live';
            media.appendChild(live);
        }
        card.appendChild(media);
        const body = document.createElement('div');
        body.className = 'agent-card-body';
        const title = document.createElement('h3');
        title.className = 'agent-card-title'; title.textContent = a.title || 'An AI agent';
        const meta = document.createElement('p');
        meta.className = 'agent-card-meta';
        meta.textContent = [a.state === 'live' ? `${a.viewers || 0} watching` : `worked ${Math.round((a.worked_seconds || 0) / 60)} min`, (a.task && a.task.title) || ''].filter(Boolean).join(' · ');
        body.append(title, meta); card.appendChild(body); grid.appendChild(card);
    }
    section.hidden = false;
}

// Refresh the paginated home sections (only at page 1, only when visible — so we
// never disrupt someone paging through or reading below the fold).
function refreshHomeSections() {
    if (!_homeIsActive() || document.visibilityState !== 'visible') return;
    // Only rails the reader has not expanded: a refresh must never fold a browsed rail back up.
    const untouched = (k) => { const r = _homeRails[k]; return !r || r.shown <= Math.max(_narrow ? 2 : 4, _homeRailCols(r.grid) * 2); };
    if (untouched('recent') && typeof loadHomeRecentOnline === 'function') loadHomeRecentOnline();
    if (untouched('vods') && typeof loadHomeRecentVods === 'function') loadHomeRecentVods();
    if (untouched('clips') && typeof loadHomeClips === 'function') loadHomeClips();
    if (untouched('pastes') && typeof loadHomePastes === 'function') loadHomePastes();
}

// The live grid follows OpenVibe.Events realtime (public/js/ov-live-realtime.js): a stream that
// starts or ends refreshes it at once. The 12 s poll stays as the fallback, and while realtime is
// connected it only runs once a minute as a safety net.
let _homeRtOff = null, _homeRtDebounce = null, _homeLastLiveRefresh = 0;
function _homeRealtimeRefresh() {
    clearTimeout(_homeRtDebounce);
    _homeRtDebounce = setTimeout(() => { _homeLastLiveRefresh = Date.now(); refreshHomeLive(); }, 400);
}
function _homeLiveTick() {
    if (window.OVLiveRealtime && OVLiveRealtime.connected && Date.now() - _homeLastLiveRefresh < 60000) return;
    _homeLastLiveRefresh = Date.now();
    refreshHomeLive();
}
function startHomeRefresh() {
    stopHomeRefresh();
    _initUptimeTooltip();
    _homeLiveTimer = setInterval(_homeLiveTick, 12000);
    _homeSectionsTimer = setInterval(refreshHomeSections, 60000);
    if (window.OVLiveRealtime) _homeRtOff = OVLiveRealtime.on((kind) => { if (kind !== 'error') _homeRealtimeRefresh(); });
}
function stopHomeRefresh() {
    if (_homeLiveTimer) { clearInterval(_homeLiveTimer); _homeLiveTimer = null; }
    if (_homeSectionsTimer) { clearInterval(_homeSectionsTimer); _homeSectionsTimer = null; }
    if (_homeRtOff) { _homeRtOff(); _homeRtOff = null; }
    clearTimeout(_homeRtDebounce);
} // populated on channel load, used for filter bar
// Homepage pagination state
// The home page used to open with 46 cards across four list sections, which made it enormous and
// meant every visitor downloaded four full pages of thumbnails to scroll past them. One row's
// worth each is plenty for a front page; the pagination underneath still reaches the rest, and
// the dedicated /vods, /clips and /pastes pages are where you go to actually browse.
//
// Wide screens fit more per row, so the counts follow the viewport rather than being fixed — six
// cards is one tidy row at 1400px and two rows on a laptop, but four is the right number on a
// phone where each card is full width.
// matchMedia, not innerWidth: reading innerWidth while the page is still being styled forces a
// synchronous style and layout pass of the whole document.
const _narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 759px)').matches;
/**
 * Home rails are sized by the row, not by a page number.
 *
 * A rail's grid decides how many cards fit per row (ov-density.js); the rail then always shows
 * whole rows: the first load is two rows, "Load more" adds whole rows, and if the row count
 * changes (a rotated phone, a narrower window, the per-row control) the last row is filled in
 * with one small request. A rail of six cards in four-wide rows no longer ends with two cards
 * and a hole.
 */
const _homeRails = {}; // key → { shown, total, grid, loader, filling }
function homeRailReset() { for (const k of Object.keys(_homeRails)) delete _homeRails[k]; }
function _homeRailCols(grid) {
    try { return Math.max(1, (window.OVDensity && grid) ? OVDensity.columns(grid) : 1); } catch { return 1; }
}
/** offset/limit for a fresh load (two rows) or for `more` cards, plus the rail record to update after. */
function homeRailRange(key, opts, gridId, loaderName) {
    const rail = _homeRails[key] || (_homeRails[key] = { shown: 0, total: 0, filling: false });
    rail.grid = document.getElementById(gridId);
    rail.loader = loaderName;
    if (opts && opts.more) return { offset: rail.shown, limit: opts.more, append: true, rail };
    rail.shown = 0;
    const cols = _homeRailCols(rail.grid);
    return { offset: 0, limit: Math.max(4, cols * 2), append: false, rail };
}
/** Record what a load brought in, then fill the last row if it is short. */
function homeRailLoaded(rail, offset, count, total) {
    rail.shown = offset + count;
    rail.total = Number(total) || 0;
    rail.filling = false;
    if (rail.grid && !rail.grid._ovRailBound) {
        rail.grid._ovRailBound = true;
        rail.grid.addEventListener('ovd:columns', () => homeRailAutofill(rail));
    }
    homeRailAutofill(rail);
}
function homeRailAutofill(rail) {
    if (!rail || rail.filling || !rail.loader || !rail.grid) return;
    const cols = _homeRailCols(rail.grid);
    const left = Math.max(0, rail.total - rail.shown);
    const short = rail.shown % cols;
    if (!left || !short) return;
    const need = Math.min(left, cols - short);
    rail.filling = true;
    const fn = window[rail.loader];
    if (typeof fn === 'function') fn({ more: need, auto: true }); else rail.filling = false;
}

/** True when the grid is a row that scrolls sideways (features/home.css makes Catch up's grids one on a phone). */
function homeRailSideways(grid) {
    try { return !!grid && getComputedStyle(grid).overflowX === 'auto'; } catch { return false; }
}
/** Cards a sideways rail asks for at a time: a few swipes' worth. */
const HOME_RAIL_BATCH = 6;
/**
 * The end of a sideways rail. While cards are left: two placeholder cards, and when the reader swipes to within about
 * a card of them the next batch loads in their place (an IntersectionObserver on the rail itself, no scroll handler).
 * When none are left: one "View all" card to the section's own page. left < 0 removes the tail (a grid that wraps
 * keeps its button).
 */
function homeRailTail(rail, left) {
    const grid = rail && rail.grid;
    if (!grid) return;
    for (const old of grid.querySelectorAll(':scope > .home-rail-tail')) old.remove();
    if (rail.tailObserver) { rail.tailObserver.disconnect(); rail.tailObserver = null; }
    if (left < 0) return;
    if (left === 0) {
        const all = grid.previousElementSibling && grid.previousElementSibling.querySelector('a.section-action[href]');
        if (!all || !rail.shown) return;
        const href = all.getAttribute('href');
        const end = document.createElement('a');
        end.className = 'home-rail-tail home-rail-end';
        end.href = href;
        end.addEventListener('click', (e) => handleLinkClick(e, href));
        end.innerHTML = '<span class="home-rail-end-icon" aria-hidden="true"><i class="fa-solid fa-arrow-right"></i></span><span>View all</span>';
        grid.appendChild(end);
        return;
    }
    const skel = [];
    for (let i = 0; i < Math.min(2, left); i++) {
        const s = document.createElement('div');
        s.className = 'home-rail-tail home-rail-skel';
        s.setAttribute('aria-hidden', 'true');
        s.innerHTML = '<div class="home-rail-skel-thumb"></div><div class="home-rail-skel-line"></div><div class="home-rail-skel-line is-short"></div>';
        grid.appendChild(s);
        skel.push(s);
    }
    if (typeof IntersectionObserver !== 'function') return;
    const more = () => {
        if (rail.loading || !rail.loader) return;
        const fn = window[rail.loader];
        if (typeof fn !== 'function') return;
        rail.loading = true;
        Promise.resolve(fn({ more: Math.min(left, HOME_RAIL_BATCH) })).catch(() => {}).finally(() => { rail.loading = false; });
    };
    // rootMargin on the right: the batch starts loading about a card before the placeholders come into view.
    rail.tailObserver = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); },
        { root: grid, rootMargin: '0px 80% 0px 0px', threshold: 0 });
    rail.tailObserver.observe(skel[0]);
}

// Thin wrapper for homepage section pagination — same visual style as renderVodsPagination.
/**
 * Home rails get a "Load more" button, not a pager.
 *
 * Prev/Next with a page counter belongs on a browse page where someone is hunting for a specific
 * thing. On a front page rail nobody wants to operate a paginator — they want a bit more of what
 * they're looking at, or they want the dedicated page. So: one button that appends the next
 * batch, showing how many are left, and it disappears when there are none.
 */
function renderHomePagination(containerId, rail) {
    const el = document.getElementById(containerId);
    if (!el || !rail) return;
    const left = Math.max(0, rail.total - rail.shown);
    // A rail that scrolls sideways (Catch up on a phone) loads its next cards by itself as the reader swipes toward its
    // end: a button under the row added cards off screen, at the far end, two at a time (the owner, 2026-11-01).
    if (homeRailSideways(rail.grid)) { el.innerHTML = ''; el.style.display = 'none'; homeRailTail(rail, left); return; }
    homeRailTail(rail, -1);
    // These containers ship with an inline display:none — the old pager unhid them itself, and
    // this one has to as well or the button renders into a hidden box and nobody ever sees it.
    if (left <= 0) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = 'block';
    // Whole rows: whatever completes the current row, then two more rows (one on a phone, where a
    // row is a screen). "8 more" into a four-wide grid was two rows; into a three-wide grid it was
    // two rows and a stray pair.
    const cols = _homeRailCols(rail.grid);
    const short = rail.shown % cols;
    const next = Math.min(left, (short ? cols - short : 0) + cols * (_narrow ? 1 : 2));
    el.innerHTML = `<button type="button" class="home-load-more" onclick="${rail.loader}({ more: ${next} })">
        <i class="fa-solid fa-arrow-down"></i>
        <span>Load ${next} more</span>
        <small>${left.toLocaleString()} left</small>
    </button>`;
}

/** Home "Recent Changes": Live's deployed changes grouped by day, drawn by the shared view. */
async function loadHomeChangelog() {
    const container = document.getElementById('home-changelog');
    if (!container) return;
    const shipped = await loadShipped();
    if (!shipped) { container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">Recent changes are not available right now.</p>'; return; }
    shipped.scan(document);   // the hero one-liner
    try {
        const res = await fetch(`${shipped.API}?service=live&limit=15`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
        const data = res.ok ? await res.json() : null;
        const entries = data && Array.isArray(data.entries) ? data.entries : [];
        container.textContent = '';
        if (!entries.length) { container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">No recent changes.</p>'; return; }
        container.classList.add('ov-shipped-log');
        shipped.appendDays(container, entries, false);
    } catch {
        container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">Recent changes are not available right now.</p>';
    }
}

/* Toggle collapsible changelog on homepage */
function toggleHomeChangelog() {
    const wrapper = document.getElementById('home-changelog-wrapper');
    const btn = document.getElementById('home-changelog-toggle');
    if (!wrapper || !btn) return;
    const expanded = wrapper.classList.toggle('expanded');
    wrapper.classList.toggle('collapsed', !expanded);
    btn.setAttribute('aria-expanded', String(expanded));
    const label = btn.querySelector('span');
    if (label) label.textContent = expanded ? 'Show fewer changes' : 'Show all recent changes';
    else btn.textContent = expanded ? 'Show Less' : 'Show All';
}


/* ── Star of OpenVibe — home spotlight for the featured streamer ─────────────────────
   GET /api/home/star → { star: { username, display_name, avatar_url, bio, bio_en, language,
   live, ai_overview, follower_count, last_live_at } } (null when no star is configured). */
function _starCountdown(ts) {
    const ms = Number(ts) - Date.now();
    if (!(ms > 0)) return 'soon';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h >= 1 ? `in ${h}h${m ? ` ${m}m` : ''}` : `in ${Math.max(1, m)}m`;
}
async function loadHomeStar() {
    if (!document.getElementById('home-star-section')) return;
    try { await apiSWR('/home/star', (data) => _renderHomeStar(data), { ttl: 30 * 60 * 1000 }); }
    catch { _renderHomeStar(null); }
}
function _renderHomeStar(data) {
    const sec = document.getElementById('home-star-section');
    if (!sec) return;
    const s = data && data.star;
    if (!s) { sec.style.display = 'none'; sec.innerHTML = ''; return; }
    const lang = s.language || { code: 'en', name: 'English', flag: '' };
    const foreign = lang.code && lang.code !== 'en';
    const name = esc(s.display_name || s.username);
    const path = channelPath(s.username);
    const initial = esc(String(s.display_name || s.username || '?').charAt(0).toUpperCase());
    const avatar = s.avatar_url
        ? `<img src="${esc(ovImgW(s.avatar_url, 160))}" data-full="${esc(s.avatar_url)}" alt="${name}" loading="lazy" onerror="${OV_IMG_RETRY}">`
        : initial;
    const bioSrc = (s.bio || '').trim();
    const bioEn = (s.bio_en || '').trim();
    let bioHtml = '';
    if (foreign && bioEn) {
        bioHtml = `<div class="star-bio-label"><i class="fa-solid fa-language"></i> English · auto-translated</div><p class="star-bio">${_linkify(esc(bioEn))}</p>
                   <div class="star-bio-label">${esc(lang.flag)} ${esc(lang.name)} · original</div><p class="star-bio-src">${_linkify(esc(bioSrc))}</p>`;
    } else if (bioSrc) {
        bioHtml = `<p class="star-bio">${_linkify(esc(bioSrc))}</p>`;
    }
    const overview = s.ai_overview ? `<p class="star-overview"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(String(s.ai_overview).slice(0, 260))}${String(s.ai_overview).length > 260 ? '…' : ''}</p>` : '';
    const pick = s.pick || null;
    // Who picked them and when the next star lands are two separate facts, each kept on one line:
    // as one uppercase run the countdown broke in half ("NEXT STAR / IN 3H") on a phone.
    const why = pick && (pick.headline || pick.reason)
        ? `<div class="star-why">${pick.headline ? `<div class="star-why-head">${esc(pick.headline)}</div>` : ''}${pick.reason ? `<div class="star-why-body">${esc(pick.reason)}</div>` : ''}<div class="star-why-meta"><span><i class="fa-solid fa-wand-magic-sparkles"></i> ${pick.by === 'ai' ? 'Picked by OpenVibe\'s AI' : 'Picked on the numbers'}</span>${pick.next_at ? `<span class="star-why-next"><i class="fa-regular fa-clock"></i> Next star ${esc(_starCountdown(pick.next_at))}</span>` : ''}</div></div>`
        : '';
    const chips = [
        foreign ? `<span class="star-chip pink">${esc(lang.flag)} Streams in ${esc(lang.name)}</span>` : '',
        foreign ? `<span class="star-chip"><i class="fa-solid fa-language"></i> Chat auto-translated both ways</span>` : '',
        s.category ? `<span class="star-chip"${_catInferred(s) ? ' title="Category inferred by OpenVibe&#39;s AI from the stream"' : ''}>${esc(_capTag(s.category))}${_catInferred(s) ? '<span class="cat-inferred"> · inferred</span>' : ''}</span>` : '',
        (s.follower_count > 0) ? `<span class="star-chip gold"><i class="fa-solid fa-heart"></i> ${esc(String(s.follower_count))} follower${s.follower_count === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join('');
    const isLive = !!s.live;
    const offline = !isLive && s.last_live_at ? `<div class="star-offline"><i class="fa-regular fa-clock"></i><span>Last live ${esc(timeAgo(s.last_live_at))} — follow to get pinged next time.</span></div>` : '';
    const liveCard = isLive ? `<div class="star-live-card">${streamCardHTML(s.live, true)}</div>` : '';
    sec.innerHTML = `
        <div class="section-header">
            <h2><i class="fa-solid fa-star star-head-icon"></i> Star of OpenVibe</h2>
            <span class="muted" style="font-size:0.8rem">${s.rotates ? 'a new star every day — picked by the site\'s AI from who actually showed up' : 'the streamer we\'re rolling out the red carpet for'}</span>
        </div>
        <div class="star-card-border">
            <div class="star-card${isLive ? ' is-live' : ''}">
                <div class="star-petals" aria-hidden="true"><span>🌸</span><span>🌸</span><span>✨</span><span>🌸</span><span>✨</span><span>🌸</span></div>
                <div class="star-avatar-wrap">
                    <div class="star-avatar-glow" aria-hidden="true"></div>
                    <div class="star-avatar-ring" aria-hidden="true"></div>
                    <a class="star-avatar" href="${esc(path)}" onclick="return handleLinkClick(event, '${esc(path)}')" style="${s.profile_color ? `background:${esc(s.profile_color)}` : ''}">${avatar}</a>
                    ${isLive ? '<span class="star-live-pill">LIVE</span>' : ''}
                    <span class="star-badge">⭐ Star</span>
                </div>
                <div class="star-body">
                    <div class="star-kicker"><i class="fa-solid fa-star"></i> ${s.rotates ? 'Star of the day' : 'Featured streamer'}</div>
                    <h3 class="star-name"><a href="${esc(path)}" onclick="return handleLinkClick(event, '${esc(path)}')">${s.username ? esc('@' + s.username) : name}</a>${foreign && lang.code === 'ja' ? '<span class="star-jp">OpenVibeの看板配信者 — ようこそ！</span>' : ''}</h3>
                    <div class="star-chips">${chips}</div>
                </div>
                <div class="star-more" id="star-more" hidden>
                    ${why}
                    ${bioHtml}
                    ${overview}
                    ${offline}
                </div>
                <div class="star-actions">
                    <a class="star-act star-btn-watch" href="${esc(path)}" onclick="return handleLinkClick(event, '${esc(path)}')"><i class="fa-solid ${isLive ? 'fa-play' : 'fa-user'}" aria-hidden="true"></i><span>${isLive ? 'Watch now' : 'Visit channel'}</span></a>
                    <a class="star-act" href="${esc(path)}#about" onclick="return handleLinkClick(event, '${esc(path)}#about')"><i class="fa-solid fa-comments" aria-hidden="true"></i><span>Say hi${foreign ? '<span class="star-act-extra"> — any language works</span>' : ''}</span></a>
                    <button type="button" class="star-act star-expand" id="star-expand" aria-expanded="false" aria-controls="star-more" title="More about ${name}">
                        <i class="fa-solid fa-chevron-down" aria-hidden="true"></i><span class="star-expand-label">More about ${name}</span>
                    </button>
                </div>
            </div>
        </div>`;
    // The live stream card is the tallest piece of the section — it goes inside the disclosure.
    const more = sec.querySelector('#star-more');
    if (more && liveCard) more.insertAdjacentHTML('beforeend', liveCard);

    const card = sec.querySelector('.star-card');
    const btn = sec.querySelector('#star-expand');
    if (card && btn && more) {
        card.classList.add('is-compact');
        // On a phone the toggle is an icon button; the label stays in the DOM (visually hidden)
        // so it is still the button's accessible name, and the title is the tooltip.
        const label = () => {
            const text = more.hidden ? `More about ${s.display_name || s.username}` : 'Show less';
            btn.querySelector('.star-expand-label').textContent = text;
            btn.title = text;
            btn.classList.toggle('is-open', !more.hidden);
            btn.setAttribute('aria-expanded', String(!more.hidden));
        };
        label();
        btn.addEventListener('click', () => {
            animateHeightChange(card, () => {
                more.hidden = !more.hidden;
                card.classList.toggle('is-compact', more.hidden);
                label();
            }, { entering: more.hidden ? null : more });
        });
    }
    sec.style.display = '';
}
