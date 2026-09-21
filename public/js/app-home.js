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

/** Open the chat user menu; if chat has not loaded, fall back to the channel. */
function ovUserMenu(event) {
    if (typeof showChatContextMenu === 'function') return showChatContextMenu(event);
    const el = event.currentTarget;
    const core = el && el.dataset && el.dataset.coreUsername;
    if (!core) return;
    event.preventDefault();
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
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
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
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    const pct = Math.round(((n - a) / a) * 100);
    const bits = [`${_fmtCount(n)} right now`, `${fmtAvg(a)} on average over the last ${window}`];
    if (Number.isFinite(Number(peak))) bits.push(`peak ${_fmtCount(Math.round(peak))}`);
    const cls = pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : 'is-flat';
    return `<span class="hero-stat-delta ${cls}" title="${esc(bits.join(' · '))}">`
        + `<b>${pct > 0 ? '+' : ''}${pct}%</b><em>vs ${window}</em></span>`;
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
    const now = [
        { key: 'liveNow', metric: 'liveNow', deltaHTML: _baselineDeltaHTML(stats.liveNow, CC.liveAvg24h, CC.livePeak24h), cls: stats.liveNow > 0 ? 'hero-stat--live' : '', icon: stats.liveNow > 0 ? 'fa-circle' : 'fa-circle-dot', num: stats.liveNow, label: 'Live', title: stats.liveNow > 0 ? 'Streams live right now' : 'Nobody is live right now — check Recently Online below' },
        { key: 'viewersNow', metric: 'viewersNow', deltaHTML: _baselineDeltaHTML(stats.viewersNow, CC.viewersAvg24h, CC.viewersPeak24h), cls: stats.viewersNow > 0 ? 'hero-stat--live' : '', icon: 'fa-eye', num: stats.viewersNow, label: 'Watching', title: 'Viewers watching right now' },
        { key: 'weeklyActive', icon: 'fa-fire', num: stats.weeklyActive, label: 'Active', title: 'People who chatted in the last 7 days', desc: 'Distinct chatters in the last 7 days — signed-in users, anonymous chatters and relayed (Twitch/Kick/YouTube) chatters, each counted once.', metric: 'active' },
        { key: 'weeklyVisitors', icon: 'fa-user-plus', num: stats.weeklyVisitors, label: 'Visitors', title: 'First-time visitors in the last 7 days', desc: 'Browsers seen on the site for the first time in the last 7 days (a privacy-safe fingerprint, no account needed). A proxy for new people showing up, not just chatting.', metric: 'visitors' },
    ];
    // 24h viewer sparkline (5-minute samples) — trends read better than a snapshot.
    const trend = Array.isArray(stats.viewerTrend) ? stats.viewerTrend : [];
    if (trend.length >= 2 && trend.some(t => (t.viewers || 0) > 0)) {
        const max = Math.max(...trend.map(t => t.viewers || 0), 1);
        const W = 220, H = 30;
        const pts = trend.map((t, i) => `${(i / (trend.length - 1) * W).toFixed(1)},${(H - 2 - ((t.viewers || 0) / max) * (H - 4)).toFixed(1)}`).join(' ');
        now.push({
            html: `<div class="hero-stat hero-stat--spark" title="Viewers over the last 24h (peak ${max})">
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                </svg><span class="hero-stat-label">24h viewers · peak ${max}</span></div>`,
        });
    }
    groups.push({ kicker: 'Right now', icon: 'fa-bolt', rows: now });

    // ── Community ────────────────────────────────────────────────
    groups.push({
        kicker: 'Community', icon: 'fa-people-group', rows: [
            { key: 'streamers', recent: R.streamers, icon: 'fa-satellite-dish', num: stats.streamers, label: 'Streamers', metric: 'streamers', title: 'People who have gone live' },
            { key: 'users', icon: 'fa-users', num: stats.users, label: 'Users', metric: 'users', title: 'Registered users', recent: R.users },
            { key: 'anons', icon: 'fa-user-secret', num: stats.anons, label: 'Anons', metric: 'anons', title: 'Anonymous chatters ever seen', recent: R.anons },
            { icon: 'fa-heart', num: stats.follows, label: 'Follows', metric: 'follows', title: 'Channel follows', recent: R.follows },
            { key: 'chatMessages', icon: 'fa-comments', num: stats.chatMessages, label: 'Messages', metric: 'messages', title: 'Chat messages sent', recent: R.messages },
            { key: 'hoursWatched', recent: R.hours, unit: 'h', icon: 'fa-couch', num: stats.hoursWatched, label: 'Hrs Watched', metric: 'hoursWatched', title: 'Hours the community has spent watching streams', unit: 'h' },
        ],
    });

    // ── Economy ──────────────────────────────────────────────────
    groups.push({
        kicker: 'Economy', icon: 'fa-coins', rows: [
            { icon: 'fa-hand-holding-dollar', num: stats.vibesTipped, label: 'Vibes Tipped', metric: 'vibes', title: 'Vibes donated between people (100 Vibes = $1)', recent: R.vibes },
            { recent: R.supporters, icon: 'fa-hand-holding-heart', num: stats.supporters, label: 'Supporters', metric: 'supporters', title: 'People who have tipped Vibes to a streamer' },
            { icon: 'fa-cart-shopping', num: stats.vibesBought, label: 'Vibes Bought', metric: 'vibesBought', title: 'Vibes purchased with real money (PowerChat, card, PayPal, crypto)', recent: R.vibesBought },
            { icon: 'fa-star', num: stats.activeSubs, label: 'Subs', metric: 'subs', title: 'Active channel subscriptions', recent: R.subs },
            // OpenCoins are network-wide; channel points below are per channel. Shown only when
            // the wallet service answered — four zeroed chips would read as "nobody has any".
            ...(stats.coinsEarned != null ? [
                { recent: R.coinsEarned, icon: 'fa-circle-dollar-to-slot', num: stats.coinsEarned, label: 'Coins Earned', title: 'OpenCoins earned across the whole network — the site-wide currency you get for watching, chatting and using the tools' },
                { recent: R.coinsSpent, icon: 'fa-basket-shopping', num: stats.coinsSpent, label: 'Coins Spent', title: 'OpenCoins spent on emotes, themes, cosmetics and sounds' },
                { icon: 'fa-vault', num: stats.coinsCirculating, label: 'Coins Held', title: 'OpenCoins sitting in wallets right now, across every OpenVibe site' },
                { recent: R.coinHolders, icon: 'fa-wallet', num: stats.coinHolders, label: 'Wallets', title: 'People holding OpenCoins' },
            ] : []),
            { icon: 'fa-coins', num: stats.pointsEarned, label: 'Points Earned', metric: 'points', title: 'Channel points earned by viewers (watching, chatting, following) — per channel, unlike OpenCoins', recent: R.points },
            { icon: 'fa-gift', num: stats.pointsSpent, label: 'Points Spent', metric: 'pointsSpent', title: `Channel points spent on rewards · ${_fmtCount(stats.redemptions || 0)} rewards redeemed`, recent: R.pointsSpent, sub: stats.redemptions ? `${_fmtCount(stats.redemptions)} rewards` : '' },
            { recent: R.goals, icon: 'fa-bullseye', num: stats.goalsActive, label: 'Goals', title: `Donation goals running now · ${stats.goalsReached || 0} reached so far`, sub: stats.goalsReached ? `${_fmtCount(stats.goalsReached)} reached` : '' },
        ],
    });

    // ── Archive ──────────────────────────────────────────────────
    groups.push({
        kicker: 'Archive', icon: 'fa-box-archive', rows: [
            { icon: 'fa-tower-broadcast', num: stats.liveSessions, label: 'Sessions', metric: 'sessions', title: 'Total stream sessions', recent: R.sessions },
            { icon: 'fa-film', num: stats.vods, label: 'VODs', metric: 'vods', title: 'Recorded videos', recent: R.vods },
            { icon: 'fa-scissors', num: stats.clips, label: 'Clips', metric: 'clips', title: 'Clips created', recent: R.clips },
            { icon: 'fa-clock', num: stats.streamHours, label: 'Hours', metric: 'hours', title: 'Hours of video archived', recent: R.hours, unit: 'h' },
            { icon: 'fa-brain', num: stats.aiMemories, label: 'AI Moments', metric: 'aiMoments', title: 'Moments the AI remembers across every stream', recent: R.aiMoments },
            { recent: R.emotes, icon: 'fa-face-grin-squint', num: stats.emotes, label: 'Emotes', metric: 'emotes', title: 'Custom channel emotes uploaded' },
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
    const trendBits = (w, pw) => {
        if (!Number.isFinite(pw)) return '';
        if (pw === 0) return w > 0 ? '<span class="hero-stat-trend is-new">new</span>' : '';
        const pct = Math.round(((w - pw) / pw) * 100);
        if (pct === 0) return '<span class="hero-stat-trend is-flat"><i></i>flat</span>';
        const up = pct > 0;
        return `<span class="hero-stat-trend ${up ? 'is-up' : 'is-down'}"><i></i>${Math.abs(pct)}%</span>`;
    };
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
        if (r.html) return r.html; // pre-rendered chips (sparkline)
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
        { key: 'weeklyActive', metric: 'active', icon: 'fa-fire', num: stats.weeklyActive, label: 'Active', title: 'People who chatted in the last 7 days', recent: { w: stats.weeklyActive, pw: stats.prevWeeklyActive } },
        { key: 'users', metric: 'users', icon: 'fa-user-group', num: stats.users, label: 'Users', title: 'Accounts on OpenVibe.Live', recent: R.users },
        { key: 'weeklyVisitors', metric: 'visitors', icon: 'fa-user-plus', num: stats.weeklyVisitors, label: 'Visitors', title: 'First-time visitors in the last 7 days', recent: { w: stats.weeklyVisitors, pw: stats.prevWeeklyVisitors } },
        { key: 'anons', metric: 'anons', icon: 'fa-user-secret', num: stats.anons, label: 'Anons', title: 'Anonymous chatters who have been given a name', recent: R.anons },
        { key: 'chatMessages', metric: 'messages', icon: 'fa-comments', num: stats.chatMessages, label: 'Messages', title: 'Chat messages sent, all time', recent: R.messages },
        { key: 'streamers', metric: 'streamers', icon: 'fa-satellite-dish', num: stats.streamers, label: 'Streamers', title: 'People who have gone live here', recent: R.streamers },
        { key: 'hoursWatched', metric: 'hoursWatched', icon: 'fa-couch', num: stats.hoursWatched, label: 'Hours', title: 'Hours the community has spent watching', recent: R.hours },
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
        </div>`;

    const btn = wrap.querySelector('#hero-stat-more');
    const full = wrap.querySelector('#hero-stat-full');
    const strip = wrap.querySelector('.hero-stat-strip');
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
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
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
                // hoursWatched is deliberately absent: its 7-day figure comes from OpenVibe.Media
                // (that is where VODs live now), and this endpoint only knows the local number,
                // which is zero. Overwriting it here would wipe a correct value with a wrong one.
                weeklyActive: { w: d.weeklyActive, pw: d.prevWeeklyActive },
                weeklyVisitors: { w: d.weeklyVisitors, pw: d.prevWeeklyVisitors },
            };
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
        return `<img src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">`
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
    // Prefer the full AI-moment frame set (not the shuffled/sliced collage media), so the
    // background cycles through all of the day's frames.
    let frames = (moments || []).filter(m => m && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.kind === 'moment' && m.thumbnail).map(m => m.thumbnail);
    if (!frames.length) frames = (media || []).filter(m => m && m.thumbnail && m.kind !== 'paste').map(m => m.thumbnail);
    frames = [...new Set(frames)];
    if (_heroBgTimer) { clearInterval(_heroBgTimer); _heroBgTimer = null; }
    if (!frames.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    _heroBgActive = 0;
    layers[0].style.backgroundImage = `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url("${frames[0]}")`;
    layers[1].classList.remove('active');
    // Re-trigger the Ken-Burns animation on first paint.
    layers[0].classList.remove('active'); void layers[0].offsetWidth; layers[0].classList.add('active');
    if (frames.length < 2 || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && frames.length < 2)) return;
    let idx = 0;
    _heroBgTimer = setInterval(() => {
        if (document.hidden) return;
        idx = (idx + 1) % frames.length;
        const next = (_heroBgActive + 1) % 2;
        const el = layers[next];
        const pre = new Image();
        pre.onload = () => {
            // The darkening is part of the frame's own background rather than a filter or an overlay element:
            // either of those becomes a second full-hero layer on top of an animating one.
            el.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url("${frames[idx]}")`;
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
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const w = window.innerWidth || 1200;
    const count = Math.min(media.length, w < 640 ? 5 : w < 1024 ? 8 : 12);
    const positions = _heroCollagePositions(count);
    const cards = [];
    for (let i = 0; i < count; i++) {
        const el = document.createElement('a');
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
    if (window.matchMedia && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.matchMedia('(pointer: coarse)').matches)) return;
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
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ }
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

// ── Daily AI easter egg ─────────────────────────────────────────────────────
let _egg = null, _eggBuf = [], _eggSolved = false, _eggSubmitTimer = null, _eggKeysWired = false;
const _EGG_ARROW = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const _EGG_GLYPH = { up: '↑', down: '↓', left: '←', right: '→' };
let _eggRevealed = [];          // [{index, token}] revealed for this solver today
let _eggFails = 0, _eggBusy = false;
async function loadHeroEgg() {
    const el = document.getElementById('hero-egg');
    if (!el) return;
    let data; try { data = await api('/easter-egg/daily'); } catch { return; }
    const egg = data && data.egg;
    if (!egg) { el.style.display = 'none'; return; }
    _egg = egg; _eggSolved = !!egg.solved; _eggBuf = []; _eggRevealed = egg.revealed || []; _eggFails = egg.fails || 0;
    el.style.display = '';
    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set('hero-egg-title', egg.title || 'The Daily Secret');
    // Letter pad (built once)
    const letters = document.getElementById('hero-egg-letters');
    if (letters && !letters.childElementCount) letters.innerHTML = 'abcdefghijklmnopqrstuvwxyz'.split('').map(l => `<button type="button" class="egg-key egg-key--letter" data-tok="${l}">${l}</button>`).join('');
    const pad = document.getElementById('hero-egg-pad');
    if (pad && !pad.dataset.wired) {
        pad.dataset.wired = '1';
        pad.addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            if (b.dataset.act === 'back') { _eggBuf.pop(); _renderEggSlots(); return; }
            if (b.dataset.act === 'clear') { _eggBuf = []; _renderEggSlots(); return; }
            if (b.dataset.tok) _eggPush(b.dataset.tok);
        });
    }
    _renderEggClues();
    _renderEggSlots();
    _renderEggMeta();
    _renderEggStatus();
    _wireEggKeys();
}
function _eggResetLabel(ts) { const h = Math.round((ts - Date.now()) / 3600000); return h <= 1 ? 'soon' : `in ${h}h`; }
function _renderEggStatus() {
    const s = document.getElementById('hero-egg-status'); if (!s) return;
    s.textContent = _eggSolved ? '✓ Cracked' : `${_egg ? _egg.codeLength : ''} keys`;
    s.className = 'hero-egg-status' + (_eggSolved ? ' solved' : '');
}
function _renderEggMeta() {
    if (!_egg) return;
    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set('hero-egg-count', `${_egg.foundCount || 0} cracked it today`);
    set('hero-egg-first', (_egg.firstSolvers || []).length ? ` · first: ${_egg.firstSolvers.slice(0, 3).join(', ')}` : '');
    set('hero-egg-reset', _egg.nextResetAt ? ` · new secret ${_eggResetLabel(_egg.nextResetAt)}` : '');
    const rb = document.getElementById('hero-egg-reveal');
    if (rb) {
        const left = Math.max(0, (_egg.revealAfterFails || 2) - _eggFails);
        const done = _eggRevealed.length >= Math.max(0, _egg.codeLength - 1);
        rb.style.display = _eggSolved ? 'none' : '';
        rb.disabled = done || left > 0;
        rb.innerHTML = done ? '<i class="fa-solid fa-lightbulb"></i> The last key is yours'
            : left > 0 ? `<i class="fa-regular fa-lightbulb"></i> Stuck? ${left} more wrong tr${left === 1 ? 'y' : 'ies'} unlocks a reveal`
            : '<i class="fa-solid fa-lightbulb"></i> Stuck? Reveal the next key';
    }
}
function _renderEggClues() {
    const ol = document.getElementById('hero-egg-clues'); if (!ol || !_egg) return;
    const clues = _egg.clues || _egg.hints || [];
    const rev = new Map(_eggRevealed.map(r => [r.index, r.token]));
    ol.innerHTML = clues.map((c, i) => `<li class="${rev.has(i) ? 'is-revealed' : ''}"><span class="egg-clue-n">${i + 1}</span><span class="egg-clue-text">${esc(c)}</span>${rev.has(i) ? `<span class="egg-clue-key" title="Revealed">${esc(_EGG_GLYPH[rev.get(i)] || rev.get(i).toUpperCase())}</span>` : ''}</li>`).join('')
        || '<li><span class="egg-clue-text">No clues today — go on instinct.</span></li>';
}
function _renderEggSlots(state) {
    const host = document.getElementById('hero-egg-slots'); if (!host || !_egg) return;
    const n = _egg.codeLength || 0;
    let html = '';
    for (let i = 0; i < n; i++) {
        const t = _eggBuf[i];
        html += `<span class="egg-slot ${t ? 'is-filled' : ''} ${i === _eggBuf.length ? 'is-next' : ''}">${t ? esc(_EGG_GLYPH[t] || t.toUpperCase()) : ''}</span>`;
    }
    host.innerHTML = html;
    host.className = 'hero-egg-slots' + (state ? ` is-${state}` : '') + (_eggSolved ? ' is-solved' : '');
}
function _eggPush(tok) {
    if (_eggSolved || !_egg || _eggBusy) return;
    _eggBuf.push(tok);
    if (_eggBuf.length > _egg.codeLength) _eggBuf = _eggBuf.slice(-_egg.codeLength);
    _renderEggSlots();
    if (_eggBuf.length === _egg.codeLength) { clearTimeout(_eggSubmitTimer); _eggSubmitTimer = setTimeout(_submitEgg, 200); }
}
function toggleHeroEgg() { document.getElementById('hero-egg')?.classList.toggle('open'); }
function _wireEggKeys() {
    if (_eggKeysWired) return;
    _eggKeysWired = true;
    document.addEventListener('keydown', (e) => {
        if (_eggSolved || !_egg) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Backspace') { _eggBuf.pop(); _renderEggSlots(); return; }
        let tok = _EGG_ARROW[e.key];
        if (!tok && /^[a-zA-Z]$/.test(e.key)) tok = e.key.toLowerCase();
        if (!tok) return;
        if (_EGG_ARROW[e.key]) e.preventDefault();          // don't scroll the page on arrows
        _eggPush(tok);
        // Typing counts as engagement: pop the panel open so people see the keys land.
        const el = document.getElementById('hero-egg'); if (el && !el.classList.contains('open') && _eggBuf.length === 1) el.classList.add('open');
    });
}
async function _submitEgg() {
    if (_eggSolved || !_egg || _eggBuf.length < _egg.codeLength || _eggBusy) return;
    _eggBusy = true;
    let res; try { res = await api('/easter-egg/solve', { method: 'POST', body: { sequence: _eggBuf.slice() } }); } catch { _eggBusy = false; return; }
    _eggBusy = false;
    if (res && res.solved) {
        _eggSolved = true; _renderEggStatus(); _renderEggSlots('right');
        if (res.foundCount != null) _egg.foundCount = res.foundCount;
        _renderEggMeta();
        _celebrateEgg(res.egg || {});
        return;
    }
    _eggFails = (res && res.fails) || (_eggFails + 1);
    _renderEggSlots('wrong');
    _renderEggMeta();
    setTimeout(() => { _eggBuf = []; _renderEggSlots(); }, 750);
}
async function _eggReveal() {
    if (_eggSolved || !_egg) return;
    let out; try { out = await api('/easter-egg/reveal', { method: 'POST', body: {} }); } catch (e) { try { toast((e && e.message) || 'Not yet', 'info'); } catch { /* */ } return; }
    if (out && out.revealed) { _eggRevealed = out.revealed; _renderEggClues(); _renderEggMeta(); }
}
function _celebrateEgg(egg) {
    try { toast(egg.reward || "You cracked today's secret! 🎉", 'success'); } catch { /* */ }
    const effect = egg.effect || 'confetti';
    try {
        if (effect === 'shake') { document.body.classList.add('egg-shake'); setTimeout(() => document.body.classList.remove('egg-shake'), 900); }
        if (effect === 'rainbow') { document.body.classList.add('egg-rainbow'); setTimeout(() => document.body.classList.remove('egg-rainbow'), 2600); }
        const N = effect === 'fireworks' ? 170 : effect === 'matrix' ? 90 : 130;
        const cont = document.createElement('div'); cont.className = 'egg-confetti';
        const colors = effect === 'matrix' ? ['#00ff41', '#0f0', '#00c030'] : ['#ff5a5f', '#ffd166', '#06d6a0', '#4d96ff', '#c77dff', '#fff'];
        for (let i = 0; i < N; i++) {
            const p = document.createElement('span');
            p.style.left = (Math.random() * 100) + 'vw';
            p.style.background = colors[i % colors.length];
            p.style.animationDelay = (Math.random() * 0.5) + 's';
            p.style.animationDuration = (1.5 + Math.random() * 1.6) + 's';
            if (effect === 'matrix') { p.style.width = '3px'; p.style.height = (12 + Math.random() * 20) + 'px'; }
            cont.appendChild(p);
        }
        document.body.appendChild(cont);
        setTimeout(() => cont.remove(), 3800);
    } catch { /* */ }
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
function _watchIntroSighting() {
    if (_introSightingArmed || !('IntersectionObserver' in window)) return;
    const tour = document.getElementById('home-tour-mount');
    const about = document.getElementById('home-cta-banner');
    if (!tour || !about) return;
    _introSightingArmed = true;
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) seen.add(en.target.id);
        if (seen.size === 2) {
            io.disconnect();
            try { localStorage.setItem(_INTRO_SEEN_KEY, String(Math.min(_homeIntroSeenCount() + 1, 9999))); } catch { /* */ }
        }
    }, { threshold: 0.25 });
    io.observe(tour); io.observe(about);
}

/**
 * Once both introductions have been seen enough times, they go to the very end of the page.
 *
 * They move as a pair, in order, after the changelog. The old version appended to the *first*
 * .container on the home page — but the changelog lives in a later one, so "moved to the bottom"
 * actually landed them in the middle of the page, above Recently Online.
 */
function demoteHomeIntroSections() {
    _watchIntroSighting();
    if (_homeIntroSeenCount() < HOME_INTRO_VIEWS_BEFORE_DEMOTING) return;
    const containers = document.querySelectorAll('#page-home > .container, #page-home .container');
    const changelog = document.getElementById('home-changelog-wrapper');
    const last = (changelog && changelog.closest('.container')) || containers[containers.length - 1];
    if (!last) return;
    for (const id of ['home-tour-mount', 'home-cta-banner']) {
        const el = document.getElementById(id);
        if (!el || el.dataset.ovDemoted) continue;
        el.dataset.ovDemoted = '1';
        el.classList.add('home-intro-demoted');
        try { last.appendChild(el); } catch { /* */ }
    }
}

async function loadHome() {
    demoteHomeIntroSections();
    void loadHomeChangelog();
    _initHomeAbout();
    updateNavHeroTransparency();  // transparent nav over the hero at the top
    startHeroRotation();      // instant static rotation; loadHeroData upgrades it with AI slogans
    void loadHeroData();      // stats bar, floating-thumbnail collage, AI slogans
    void loadHeroEgg();       // daily AI easter egg widget

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
            const streams = liveData.streams || [];
            document.getElementById('live-count').textContent = streams.length;
            const noLiveEl = document.getElementById('no-live-streams');
            if (noLiveEl) noLiveEl.style.display = streams.length ? 'none' : '';
            renderStreamGrid('stream-grid-live', streams, true);
            _homeFeaturedSync(streams.length > 0);
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
    // Load Scraplandia leaderboards
    loadHomeLeaderboards();
    // Load Canvas preview
    loadHomeCanvas();

    startHomeRefresh(); // live grid + sections auto-update in real time
}

/* ── Community pulse: happening-now rail, weekly leaders, AI moments, latest ship ── */
async function loadHomePulse() {
    try { await apiSWR('/home/pulse', (p) => _renderHomePulse(p), { ttl: 10 * 60 * 1000 }); } catch { /* section stays as it was */ }
}
function _renderHomePulse(p) {
    if (!p) return;

    // Hero one-liner: the newest shipped commit.
    const latest = document.getElementById('hero-latest');
    if (latest && p.latestUpdate && p.latestUpdate.subject) {
        latest.innerHTML = `<i class="fa-solid fa-rocket"></i> shipped ${esc(timeAgo(p.latestUpdate.date))}: <b>${esc(p.latestUpdate.subject)}</b>`;
        latest.style.display = '';
    }

    const grid = document.getElementById('pulse-grid');
    const section = document.getElementById('home-pulse-section');
    if (!grid || !section) return;
    const cards = [];

    // Goal cards — nearest to completion, with progress bars.
    for (const g of (p.goals || [])) {
        const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
        const href = `/@${g.username}`;
        cards.push(`
            <a class="pulse-card pulse-goal" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                <div class="pulse-kicker"><i class="fa-solid fa-bullseye"></i> Goal · ${esc(g.display_name || g.username)}</div>
                <div class="pulse-title">${esc(g.title)}</div>
                <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
                <div class="pulse-sub">${Number(g.current_amount).toLocaleString()} / ${Number(g.target_amount).toLocaleString()} Vibes · <b>${pct}%</b></div>
            </a>`);
    }

    // Latest activity card (tip + follow together).
    const act = [];
    if (p.latestTip) act.push(`<div class="pulse-act"><i class="fa-solid fa-hand-holding-dollar"></i> ${ovUserTag({ username: p.latestTip.from_username, display_name: p.latestTip.from_display }, p.latestTip.from_display || p.latestTip.from_username || 'Someone')} tipped <b>${Number(p.latestTip.amount).toLocaleString()}</b> Vibes to ${ovUserTag({ username: p.latestTip.to_username, display_name: p.latestTip.to_display })} <span class="muted">${esc(timeAgo(p.latestTip.created_at))}</span></div>`);
    if (p.newestFollow) act.push(`<div class="pulse-act"><i class="fa-solid fa-heart"></i> ${ovUserTag({ username: p.newestFollow.follower_username, display_name: p.newestFollow.follower_display })} followed ${ovUserTag({ username: p.newestFollow.streamer_username, display_name: p.newestFollow.streamer_display })} <span class="muted">${esc(timeAgo(p.newestFollow.created_at))}</span></div>`);
    if (act.length) cards.push(`<div class="pulse-card"><div class="pulse-kicker"><i class="fa-solid fa-wave-square"></i> Latest activity</div>${act.join('')}</div>`);

    // Weekly leader teasers.
    const board = (title, icon, rows, unit) => rows && rows.length ? `
        <div class="pulse-card">
            <div class="pulse-kicker"><i class="fa-solid ${icon}"></i> ${title}</div>
            ${rows.map((r, i) => `<div class="pulse-rank"><span class="pulse-medal">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span> ${ovUserTag(r)} <b>${Number(r.total).toLocaleString()}</b> <span class="muted">${unit}</span></div>`).join('')}
        </div>` : '';
    const supporters = board('Top supporters this week', 'fa-trophy', p.topSupporters, 'Vibes');
    const earners = board('Top point earners this week', 'fa-coins', p.topEarners, 'pts');
    if (supporters) cards.push(supporters);
    if (earners) cards.push(earners);

    section.style.display = cards.length ? '' : 'none';
    grid.innerHTML = cards.join('');

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
    if (!d || (!d.liveNow?.length && !d.streamed?.length && !d.hot?.length)) { box.style.display = 'none'; return; }
    const away = !!(since && currentUser);
    const n = (v) => Number(v || 0).toLocaleString();
    const chip = (u, extra, mods) => `
        <a class="digest-chip ${mods}" href="/@${esc(u.username)}" onclick="return handleLinkClick(event, '/@${esc(u.username)}')" title="${esc(u.last_title || u.title || '')}">
            ${_avatarSpan(u.avatar_url, u.username, u.profile_color)}
            <span class="digest-name">${esc(u.display_name || u.username)}</span>
            <span class="digest-extra">${extra}</span>
            ${u.followed ? '<span class="digest-follow" title="You follow them"><i class="fa-solid fa-heart"></i></span>' : ''}
        </a>${u.recap_stream_id ? `<a class="digest-recap" href="/recap/${u.recap_stream_id}" onclick="return handleLinkClick(event, '/recap/${u.recap_stream_id}')" title="After-show report"><i class="fa-solid fa-clipboard-list"></i></a>` : ''}`;
    const parts = [];
    for (const u of (d.liveNow || [])) parts.push(chip(u, `<i class="fa-solid fa-circle live-dot"></i> LIVE${u.viewer_count ? ` · ${n(u.viewer_count)} watching` : ' now'}`, `digest-chip--live${u.followed ? ' digest-chip--followed' : ''}`));
    for (const u of (d.streamed || [])) parts.push(chip(u, `${u.sessions > 1 ? `${u.sessions}× · ` : ''}${u.hours >= 0.1 ? `${u.hours}h · ` : ''}${esc(timeAgo(u.last_at))}${u.peak_viewers > 1 ? ` · peak ${n(u.peak_viewers)}` : ''}`, u.followed ? 'digest-chip--followed' : ''));
    const st = d.stats || {};
    const stats = [
        st.streams ? `<span class="digest-stat"><i class="fa-solid fa-tower-broadcast"></i> <b>${n(st.streams)}</b> stream${st.streams === 1 ? '' : 's'}</span>` : '',
        st.hours >= 0.5 ? (() => { const hrs = Math.round(st.hours); return `<span class="digest-stat"><i class="fa-regular fa-clock"></i> <b>${n(hrs)}</b> ${hrs === 1 ? 'hour' : 'hours'} live</span>`; })() : '',
        st.chat_lines ? `<span class="digest-stat"><i class="fa-solid fa-comments"></i> <b>${n(st.chat_lines)}</b> chat lines</span>` : '',
        st.new_follows ? `<span class="digest-stat"><i class="fa-solid fa-heart"></i> <b>${n(st.new_follows)}</b> new follow${st.new_follows === 1 ? '' : 's'}</span>` : '',
        st.new_members ? `<span class="digest-stat"><i class="fa-solid fa-user-plus"></i> <b>${n(st.new_members)}</b> joined</span>` : '',
        st.mic_moments ? `<span class="digest-stat"><i class="fa-solid fa-microphone-lines"></i> <b>${n(st.mic_moments)}</b> Arena mic moment${st.mic_moments === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join('');
    const hot = (d.hot || []).map(h => `<div class="digest-hot-line"><i class="fa-solid fa-microphone-lines"></i> “${esc(String(h.text || '').slice(0, 140))}” <b>— ${esc(h.display_name || h.username)}</b>${h.aimed_at ? ` <span class="muted">at ${esc(h.aimed_at)}</span>` : ''}</div>`).join('');
    const sinceLabel = d.since ? (away ? `since your last visit · ${esc(timeAgo(d.since))}` : `last ${Math.max(1, Math.round((Date.now() - Date.parse(d.since)) / 3600000))}h`) : '';
    box.innerHTML = `
        <div class="digest-head">
            <span class="digest-title"><i class="fa-solid ${away ? 'fa-clock-rotate-left' : 'fa-bolt'}"></i> ${away ? 'While you were away' : 'Lately on OpenVibe'}</span>
            <span class="digest-since">${sinceLabel}</span>
        </div>
        ${stats ? `<div class="digest-stats">${stats}</div>` : ''}
        ${parts.length ? `<div class="digest-row">${parts.join('')}</div>` : ''}
        ${hot ? `<div class="digest-hot">${hot}</div>` : ''}`;
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

function renderRecentlyOnline(containerId, streamers, append) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!streamers.length) {
        if (!append) container.innerHTML = '<p class="muted">No recent streamers</p>';
        return;
    }
    const _put = (html) => ovPutCards(container, html, append);
    _put(streamers.map(s => {
        const msList = (s.managed_streams || []);
        const avatar = _avatarSpan(s.avatar_url, s.username, s.profile_color);
        const channelHref = `/@${s.username}`;
        const streamsHtml = msList.length ? msList.map(ms => {
            const href = channelPath(s.username, ms.slug || ms.managed_stream_id);
            const thumb = ms.vod_thumbnail
                ? `<img src="${esc(ms.vod_thumbnail)}" alt="" loading="lazy" class="streamer-group-stream-thumb-img">`
                : `<div class="streamer-group-stream-thumb-placeholder"><i class="fa-solid fa-video"></i></div>`;
            return `
                <a class="streamer-group-stream" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                    <div class="streamer-group-stream-thumb">${thumb}</div>
                    <div class="streamer-group-stream-info">
                        <div class="streamer-group-stream-title">${esc(ms.title || 'Stream')}</div>
                        <div class="streamer-group-stream-time muted"><i class="fa-solid fa-clock"></i> ${ms.last_live_at ? timeAgo(ms.last_live_at) : 'long ago'}</div>
                    </div>
                </a>`;
        }).join('') : `<a class="streamer-group-stream" href="${channelHref}" onclick="return handleLinkClick(event, '${channelHref}')">
                    <div class="streamer-group-stream-info"><div class="streamer-group-stream-title muted">No streams</div></div>
                </a>`;
        return `
            <div class="streamer-group-card">
                <div class="streamer-group-header">
                    <a class="streamer-group-identity" href="${channelHref}" onclick="return handleLinkClick(event, '${channelHref}')">
                        ${avatar}
                        <span class="streamer-group-name">${esc(s.display_name || s.username)}</span>
                        <span class="streamer-group-last-online muted"><i class="fa-solid fa-clock"></i> ${timeAgo(s.last_online_at)}</span>
                    </a>
                </div>
                ${_cardAiHTML(s.ai_overview_short, s.ai_overview)}
                ${s.top_goal ? (() => {
                    const pct = Math.min(100, Math.round((s.top_goal.current / s.top_goal.target) * 100));
                    return `<div class="streamer-group-goal" title="${esc(s.top_goal.title)}: ${Number(s.top_goal.current).toLocaleString()} / ${Number(s.top_goal.target).toLocaleString()} Vibes">
                        <span class="sgg-title"><i class="fa-solid fa-bullseye"></i> ${esc(s.top_goal.title)}</span>
                        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
                        <span class="sgg-pct">${pct}%</span>
                    </div>`;
                })() : ''}
                <div class="streamer-group-streams">${streamsHtml}</div>
            </div>
        `;
    }).join(''));
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
                const href = `/vod/${v.id}`;
                return `
                    <a class="stream-card" href="${href}" onclick="return handleLinkClick(event, '${href}')">
                        <div class="stream-card-thumb">
                            ${thumbImg(v.thumbnail_url, 'fa-video', v.title, `/api/thumbnails/generate/vod/${v.id}`)}
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
                <a class="stream-card" href="/clip/${c.id}" onclick="return handleLinkClick(event, '/clip/${c.id}')">
                    <div class="stream-card-thumb">
                        ${thumbImg(c.thumbnail_url, 'fa-scissors', c.title, `/api/thumbnails/generate/clip/${c.id}`)}
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
        await apiSWR(`/clips?limit=${limit}&offset=${offset}`, render, { ttl: 180000 });
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
                    ? `<div class="home-paste-media"><img src="${esc(p.screenshot_url)}" alt="${esc(p.title || 'Screenshot paste')}" loading="lazy"><span class="home-paste-type">Image</span></div>`
                    : `<div class="home-paste-media"><div class="home-paste-snippet">${preview || esc(p.title || 'Untitled paste')}</div><div class="home-paste-icon"><i class="fa-solid ${icon}"></i></div><span class="home-paste-type">${p.language && p.language !== 'plaintext' ? esc(p.language) : 'Text'}</span></div>`;
                return `
                <a class="home-paste-card" href="/p/${esc(p.slug)}" onclick="return handleLinkClick(event, '/p/${esc(p.slug)}')">
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
                    </div>
                    </div>
                </a>`;
            }).join(''));
            if (window.OVDensity) OVDensity.attach(list, { key: 'pastes', header: document.getElementById('home-pastes-header') });
            homeRailLoaded(rail, offset, pastes.length, data.total);
            renderHomePagination('home-pastes-pagination', rail);
        };
        await apiSWR(`/pastes?limit=${limit}&offset=${offset}`, render, { ttl: 180000 });
    } catch { rail.filling = false; }
}

async function loadHomeLeaderboards() {
    try {
        const boards = ['total_level', 'combat', 'mining', 'fishing'];
        const questUrl = getScraplandiaUrl();
        // One probe first: if the service is not answering, the other three would fail the same way.
        const first = await fetchServiceJson(`${questUrl}/api/game/leaderboard/${boards[0]}`);
        const rest = first ? await Promise.all(boards.slice(1).map(b => fetchServiceJson(`${questUrl}/api/game/leaderboard/${b}`))) : [];
        const results = [first, ...rest].map(r => r || { entries: [] });
        while (results.length < boards.length) results.push({ entries: [] });
        const header = document.getElementById('home-quest-header');
        const container = document.getElementById('home-leaderboards');
        const hasData = results.some(r => r.entries && r.entries.length);
        if (!hasData) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const labels = { total_level: 'Total Level', combat: 'Combat', mining: 'Mining', fishing: 'Fishing' };
        const icons = { total_level: 'fa-star', combat: 'fa-sword', mining: 'fa-gem', fishing: 'fa-fish' };
        container.innerHTML = boards.map((board, i) => {
            const entries = (results[i].entries || []).slice(0, 5);
            if (!entries.length) return '';
            return `
            <div class="home-lb-card">
                <div class="home-lb-title"><i class="fa-solid ${icons[board] || 'fa-trophy'}"></i> ${labels[board]}</div>
                <div class="home-lb-entries">
                    ${entries.map((e, rank) => `
                        <div class="home-lb-row">
                            <span class="home-lb-rank">${rank + 1}</span>
                            <span class="home-lb-name">${esc(e.display_name || e.username || 'Unknown')}</span>
                            <span class="home-lb-score">${typeof e.score === 'number' ? e.score.toLocaleString() : e.score}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }).join('');
    } catch { /* silent */ }
}

/**
 * Fetch JSON from another OpenVibe service, remembering when it is not there.
 *
 * The home page asks OpenVibe.Games for leaderboards and canvas state. Those endpoints currently
 * answer with the Games SPA's HTML and no CORS headers, so from openvibe.live all five requests
 * fail — on every single home page view. Failing is fine; failing five times per visit forever is
 * not. A miss is remembered for a few hours per browser, so the page stops asking a service that
 * is not answering and starts again on its own once the window lapses. A response that is not
 * JSON counts as a miss instead of throwing inside .json().
 */
const _XSVC_MISS_KEY = 'ov_xsvc_miss_v1';
const _XSVC_MISS_MS = 6 * 60 * 60 * 1000;
function _xsvcMisses() { try { return JSON.parse(localStorage.getItem(_XSVC_MISS_KEY) || '{}'); } catch { return {}; } }
async function fetchServiceJson(url) {
    // Keyed per URL, not per service prefix: one board that 404s must not switch off every other
    // endpoint on the same service for six hours.
    const misses = _xsvcMisses();
    if (misses[url] && Date.now() - misses[url] < _XSVC_MISS_MS) return null;
    const remember = () => { try { misses[url] = Date.now(); localStorage.setItem(_XSVC_MISS_KEY, JSON.stringify(misses)); } catch { /* */ } };
    let r;
    try { r = await fetch(url, { credentials: 'omit' }); }
    catch { remember(); return null; }                 // network / CORS: the service is not answering
    const type = r.headers.get('content-type') || '';
    if (!/json/i.test(type)) { remember(); return null; }   // an HTML page where an API should be
    // A JSON error means the service is there and answered — do not remember it as absent.
    if (!r.ok) return null;
    try { return await r.json(); } catch { return null; }
}

async function loadHomeCanvas() {
    try {
        const header = document.getElementById('home-canvas-header');
        const container = document.getElementById('home-canvas-preview');
        const data = await fetchServiceJson(`${getScraplandiaUrl()}/api/game/canvas/state`);
        if (!data || !data.board) { if (header) header.style.display = 'none'; return; }
        if (header) header.style.display = '';

        const tiles = data.tiles || [];
        const recentActions = data.recent_actions || [];
        const uniqueArtists = new Set(tiles.map(t => t.user_id).filter(Boolean)).size;
        const width = data.board.width || 64;
        const height = data.board.height || 64;
        const palette = data.board.palette || ['#000000'];

        // Render a mini canvas preview
        const scale = 4;
        container.innerHTML = `
            <div class="home-canvas-wrap">
                <canvas id="home-canvas-mini" width="${width * scale}" height="${height * scale}" style="image-rendering:pixelated;border-radius:var(--radius);border:1px solid var(--border);max-width:100%;"></canvas>
                <div class="home-canvas-stats">
                    <div class="home-canvas-stat"><strong>${tiles.length.toLocaleString()}</strong> <span>pixels placed</span></div>
                    <div class="home-canvas-stat"><strong>${uniqueArtists.toLocaleString()}</strong> <span>artists</span></div>
                    <div class="home-canvas-stat"><strong>${width}×${height}</strong> <span>board size</span></div>
                    <div class="home-canvas-stat"><strong>${recentActions.length}</strong> <span>recent actions</span></div>
                </div>
                <a href="${getScraplandiaUrl()}/canvas" class="btn btn-outline" style="margin-top:12px;">
                    <i class="fa-solid fa-palette"></i> Open Canvas
                </a>
            </div>
        `;

        // Draw tiles on the mini canvas
        const canvas = document.getElementById('home-canvas-mini');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = palette[0] || '#000';
            ctx.fillRect(0, 0, width * scale, height * scale);
            for (const tile of tiles) {
                const color = palette[tile.color_index] || '#fff';
                ctx.fillStyle = color;
                ctx.fillRect(tile.x * scale, tile.y * scale, scale, scale);
            }
        }
    } catch {
        const header = document.getElementById('home-canvas-header');
        if (header) header.style.display = 'none';
    }
}

// Markup for a single stream card (live or recent). Extracted so the home page
// can reconcile the live grid in place for real-time updates.
function streamCardHTML(s, isLive) {
    let navUrl;
    if (isLive && s.id) {
        const msRef = s.managed_stream_slug || s.managed_stream_id || null;
        navUrl = channelPath(s.username, msRef);
    } else if (!isLive && s.vod_id && s.vod_is_public) {
        navUrl = `/vod/${s.vod_id}`;
    } else {
        navUrl = channelPath(s.username);
    }
    const thumb = (!isLive && s.vod_thumbnail_url) ? s.vod_thumbnail_url : s.thumbnail_url;
    const duration = !isLive && s.vod_duration ? `<span class="stream-card-duration">${formatDuration(s.vod_duration)}</span>` : '';
    const endedAgo = !isLive && s.ended_at ? `<span class="stream-card-ago">${timeAgo(s.ended_at)}</span>` : '';
    return `
        <a class="stream-card" data-stream-id="${esc(String(s.id || ''))}" href="${esc(navUrl)}" onclick="return handleLinkClick(event, '${esc(navUrl)}')">
            <div class="stream-card-thumb${s.is_nsfw ? ' stream-card-nsfw-blur' : ''}">
                ${thumbImg(thumb, 'fa-circle-nodes', s.title, !isLive && s.vod_id ? `/api/thumbnails/generate/vod/${s.vod_id}` : null)}
                ${streamTypeBadge(s.browser_mode, s.streaming_method)}
                ${s.is_nsfw ? '<span class="stream-card-nsfw">18+</span>' : ''}
                ${duration}
            </div>
            <div class="stream-card-info">
                <div class="stream-card-title">${esc(s.title || 'Untitled Stream')}</div>
                <div class="stream-card-streamer">
                    ${_avatarSpan(s.avatar_url, s.username, s.profile_color)}
                    ${esc(s.username || 'Anonymous')}
                    ${endedAgo}
                </div>
                ${(isLive && s.description) ? `<div class="stream-card-desc" title="Click to expand" onclick="event.preventDefault();event.stopPropagation();this.classList.toggle('expanded')">${esc(s.description)}</div>` : ''}
                ${_cardAiHTML(s.ai_overview_short, s.ai_overview)}
                <div class="stream-card-meta">
                    ${s.category ? `<span class="stream-card-tag">${esc(_capTag(s.category))}</span>` : ''}
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
    let streams;
    try { const d = await api('/streams'); streams = d.streams || []; } catch { return; }
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
    if (typeof loadHomeLeaderboards === 'function') loadHomeLeaderboards();
}

function startHomeRefresh() {
    stopHomeRefresh();
    _initUptimeTooltip();
    _homeLiveTimer = setInterval(refreshHomeLive, 12000);
    _homeSectionsTimer = setInterval(refreshHomeSections, 60000);
}
function stopHomeRefresh() {
    if (_homeLiveTimer) { clearInterval(_homeLiveTimer); _homeLiveTimer = null; }
    if (_homeSectionsTimer) { clearInterval(_homeSectionsTimer); _homeSectionsTimer = null; }
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
    return { offset: 0, limit: Math.max(_narrow ? 2 : 4, cols * 2), append: false, rail };
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

async function loadHomeChangelog(attempt = 0) {
    const container = document.getElementById('home-changelog');
    if (!container) return;

    try {
        const data = await api('/updates?limit=15');
        if (!data.commits || data.commits.length === 0) {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">No recent changes.</p>';
            return;
        }

        // Group commits by date (same pattern as updates page)
        const groups = {};
        for (const c of data.commits) {
            const day = new Date(c.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(c);
        }

        let html = '';
        for (const [day, commits] of Object.entries(groups)) {
            html += `<div class="updates-day">
                <h3 class="updates-day-header">${esc(day)}</h3>
                <div class="updates-day-commits">`;
            for (const c of commits) {
                const time = new Date(c.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                html += `<div class="update-entry">
                    <a class="update-hash" href="https://github.com/OpenVibers/OpenVibe.Live/commit/${c.hash}" target="_blank" title="View on GitHub">${esc(c.short)}</a>
                    <span class="update-subject">${esc(c.subject)}</span>
                    <span class="update-meta">${esc(c.author)} &middot; ${esc(time)}</span>
                </div>`;
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    } catch {
        // Retry up to 2 times with increasing delay (handles Cloudflare challenge timing)
        if (attempt < 2) {
            setTimeout(() => loadHomeChangelog(attempt + 1), (attempt + 1) * 3000);
        } else {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:16px 0;">Failed to load changelog.</p>';
        }
    }
}

/* Toggle collapsible changelog on homepage */
function toggleHomeChangelog() {
    const wrapper = document.getElementById('home-changelog-wrapper');
    const btn = document.getElementById('home-changelog-toggle');
    if (!wrapper || !btn) return;
    const expanded = wrapper.classList.toggle('expanded');
    wrapper.classList.toggle('collapsed', !expanded);
    btn.textContent = expanded ? 'Show Less' : 'Show All';
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
        ? `<img src="${esc(s.avatar_url)}" alt="${name}" loading="lazy">`
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
    const why = pick && (pick.headline || pick.reason)
        ? `<div class="star-why">${pick.headline ? `<div class="star-why-head">${esc(pick.headline)}</div>` : ''}${pick.reason ? `<div class="star-why-body">${esc(pick.reason)}</div>` : ''}<div class="star-why-meta"><i class="fa-solid fa-wand-magic-sparkles"></i> ${pick.by === 'ai' ? 'Picked by OpenVibe\'s AI' : 'Picked on the numbers'}${pick.next_at ? ` · next star ${esc(_starCountdown(pick.next_at))}` : ''}</div></div>`
        : '';
    const chips = [
        foreign ? `<span class="star-chip pink">${esc(lang.flag)} Streams in ${esc(lang.name)}</span>` : '',
        foreign ? `<span class="star-chip"><i class="fa-solid fa-language"></i> Chat auto-translated both ways</span>` : '',
        s.category ? `<span class="star-chip">${esc(_capTag(s.category))}</span>` : '',
        (s.follower_count > 0) ? `<span class="star-chip gold"><i class="fa-solid fa-heart"></i> ${esc(String(s.follower_count))} follower${s.follower_count === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join('');
    const isLive = !!s.live;
    const offline = !isLive && s.last_live_at ? `<div class="star-offline"><i class="fa-regular fa-clock"></i> Last live ${esc(timeAgo(s.last_live_at))} — follow to get pinged next time.</div>` : '';
    const liveCard = isLive ? `<div class="star-live-card">${streamCardHTML(s.live, true)}</div>` : '';
    sec.innerHTML = `
        <div class="section-header">
            <h2><i class="fa-solid fa-star" style="color:#fbbf24"></i> Star of OpenVibe</h2>
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
                    <h3 class="star-name"><a href="${esc(path)}" onclick="return handleLinkClick(event, '${esc(path)}')">${name}</a>${foreign && lang.code === 'ja' ? '<span class="star-jp">OpenVibeの看板配信者 — ようこそ！</span>' : ''}</h3>
                    <div class="star-chips">${chips}</div>
                </div>
                <div class="star-more" id="star-more" hidden>
                    ${why}
                    ${bioHtml}
                    ${overview}
                    ${offline}
                </div>
                <div class="star-actions">
                        <a class="btn btn-lg star-btn-watch" href="${esc(path)}" onclick="return handleLinkClick(event, '${esc(path)}')"><i class="fa-solid ${isLive ? 'fa-play' : 'fa-user'}"></i> ${isLive ? 'Watch now' : 'Visit channel'}</a>
                        <a class="btn btn-outline btn-lg" href="${esc(path)}#about" onclick="return handleLinkClick(event, '${esc(path)}#about')"><i class="fa-solid fa-comments"></i> Say hi${foreign ? ' — any language works' : ''}</a>
                        <button type="button" class="star-expand" id="star-expand" aria-expanded="false" aria-controls="star-more">
                            <i class="fa-solid fa-chevron-down"></i><span>More about ${name}</span>
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
        const label = () => {
            btn.querySelector('span').textContent = more.hidden ? `More about ${s.display_name || s.username}` : 'Show less';
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
