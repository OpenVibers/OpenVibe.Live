/**
 * OpenVibe.Live — Arena tab (speech-driven beefs + the community shit-talking board)
 *
 * Routes (handled from app.js):
 *   /arena                     pulse · on the mic now · open beefs · the board · ladders
 *   /arena/beef/<id>           one beef: tug-of-war, clock, announcer feed, receipts, sides
 *   /arena/topic/<id>          one board event: angles, progress, best lines, sides/bounty/phrase
 *   /arena/live/<username>     the ears: what the listener hears from a live fighter (auto-refresh)
 *   /arena/<username>          fighter profile (stats drill down, voice + quotes, level, beefs, rivalries)
 *
 * Nothing here starts a fight. Beefs open when a streamer says another fighter's name on mic
 * while talking shit (server/arena/listener.js). Everything renders with escaped template
 * strings — persona/quote/headline text is AI-written or transcribed and is never trusted as HTML.
 */
'use strict';

const ARENA_STATS = ['hype', 'grind', 'chat', 'loyalty', 'clutch', 'vibe', 'mic'];
const ARENA_STAT_LABEL = { hype: 'Hype', grind: 'Grind', chat: 'Chat', loyalty: 'Loyalty', clutch: 'Clutch', vibe: 'Vibe', mic: 'Mic' };
const ARENA_KIND = {
    topic: { label: 'Topic', icon: 'fa-comment-dots' },
    debate: { label: 'Debate', icon: 'fa-scale-unbalanced' },
    phrase: { label: 'Say it', icon: 'fa-quote-left' },
    bounty: { label: 'Bounty', icon: 'fa-sack-dollar' },
};
let _arenaRoster = null;
let _arenaTimers = [];
let _arenaImagePoll = null;
let _arenaUtterance = null;

function _aEsc(s) { return typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _aNum(n) { n = Number(n) || 0; return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Number.isInteger(n) ? n : n.toFixed(1)); }
function _aInitial(u) { return (u.display_name || u.username || '?').trim().charAt(0).toUpperCase(); }
function _aStamp(sec) { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:` : '') + `${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`; }
function _aDate(d) { try { return new Date(String(d).replace(' ', 'T') + (String(d).endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return String(d || ''); } }
function _aAgo(d) {
    if (!d) return '';
    const ms = Date.now() - new Date(String(d).includes('T') ? d : String(d).replace(' ', 'T') + 'Z').getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); if (h < 48) return `${h}h ago`; return `${Math.round(h / 24)}d ago`;
}
function _aClock(sec) { sec = Math.max(0, Math.floor(sec || 0)); if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`; return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function _aToast(msg, type = 'info') { if (typeof toast === 'function') toast(msg, type); else console.log('[Arena]', msg); }
function _aMe() { return (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null; }
function _aSpinner(text) { return `<div class="arena-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>${_aEsc(text)}</span></div>`; }

function _aStopTimers() {
    for (const t of _arenaTimers) { clearInterval(t); clearTimeout(t); }
    _arenaTimers = [];
    if (_arenaImagePoll) { clearInterval(_arenaImagePoll); _arenaImagePoll = null; }
    _aStopSpeaking();
}
function _aEvery(ms, fn) { const t = setInterval(() => { if (typeof currentPage !== 'undefined' && currentPage !== 'arena') return _aStopTimers(); fn(); }, ms); _arenaTimers.push(t); return t; }

// ── Speech: hear the taunt / quotes read out (browser TTS, no server cost) ──
function _aStopSpeaking() {
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* */ }
    document.querySelectorAll('.is-speaking').forEach(el => el.classList.remove('is-speaking'));
    _arenaUtterance = null;
}
function _aSpeak(text, btn) {
    if (!window.speechSynthesis || !text) return;
    if (btn && btn.classList.contains('is-speaking')) { _aStopSpeaking(); return; }
    _aStopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 0.9;
    const voices = speechSynthesis.getVoices();
    const pick = voices.find(v => /en/i.test(v.lang) && /Google|Daniel|Samantha|Alex/i.test(v.name)) || voices.find(v => /en/i.test(v.lang));
    if (pick) u.voice = pick;
    u.onend = u.onerror = () => { if (btn) btn.classList.remove('is-speaking'); _arenaUtterance = null; };
    _arenaUtterance = u;
    if (btn) btn.classList.add('is-speaking');
    speechSynthesis.speak(u);
}
function _aSpeakBtn(text, cls = 'arena-speak') { return `<button type="button" class="${cls}" data-speak="${_aEsc(text)}" title="Hear it (browser voice)"><i class="fa-solid fa-volume-high"></i></button>`; }
function _aBindSpeak(root) {
    root.querySelectorAll('[data-speak]').forEach(btn => btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _aSpeak(btn.dataset.speak, btn); }));
}

/** Portrait: AI image when present, otherwise the avatar (or an initial) styled as a card. */
function _aPortrait(f, size = 'md') {
    const u = f.user || f;
    const color = u.profile_color || '#8b5cf6';
    if (f.image_url) return `<div class="arena-portrait arena-portrait-${size}" style="--fc:${_aEsc(color)}"><img src="${_aEsc(f.image_url)}" alt="" loading="lazy"></div>`;
    if (u.avatar_url) return `<div class="arena-portrait arena-portrait-${size} arena-portrait-avatar" style="--fc:${_aEsc(color)}"><img src="${_aEsc(u.avatar_url)}" alt="" loading="lazy"><span class="arena-portrait-glow"></span></div>`;
    return `<div class="arena-portrait arena-portrait-${size} arena-portrait-initial" style="--fc:${_aEsc(color)}"><span>${_aEsc(_aInitial(u))}</span></div>`;
}

/** Heptagon radar chart as inline SVG (no library). */
function _aRadar(r, color, size = 200) {
    const c = size / 2, R = size / 2 - 28;
    const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / ARENA_STATS.length;
    const pt = (i, v) => { const rr = R * (v / 99); return [c + rr * Math.cos(angle(i)), c + rr * Math.sin(angle(i))]; };
    const ring = (v) => ARENA_STATS.map((_, i) => pt(i, v).map(x => x.toFixed(1)).join(',')).join(' ');
    const poly = ARENA_STATS.map((k, i) => pt(i, r[k] || 0).map(x => x.toFixed(1)).join(',')).join(' ');
    const labels = ARENA_STATS.map((k, i) => {
        const rr = R + 16, x = c + rr * Math.cos(angle(i)), y = c + rr * Math.sin(angle(i));
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${_aEsc(ARENA_STAT_LABEL[k])}</text>`;
    }).join('');
    return `<svg class="arena-radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
        ${[33, 66, 99].map(v => `<polygon points="${ring(v)}" class="arena-radar-ring"></polygon>`).join('')}
        <polygon points="${poly}" class="arena-radar-fill" style="fill:${_aEsc(color)}33;stroke:${_aEsc(color)}"></polygon>
        ${labels}
    </svg>`;
}

/** Sparkline of a per-stream series. */
function _aSpark(series, color) {
    const w = 320, h = 70, pad = 6;
    const vals = series.map(p => Number(p.value) || 0);
    if (!vals.length) return '<p class="arena-voice-empty">No stream history in the window.</p>';
    const max = Math.max(...vals, 1), min = 0;
    const x = (i) => vals.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (vals.length - 1);
    const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${x(0).toFixed(1)},${h - pad} ${pts} ${x(vals.length - 1).toFixed(1)},${h - pad}`;
    return `<svg class="arena-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="--fc:${_aEsc(color)}">
        <polygon class="arena-spark-area" points="${area}"></polygon>
        <polyline points="${pts}"></polyline>
        ${vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5"><title>${_aEsc(series[i].title || '')} · ${_aEsc(_aDate(series[i].date))}: ${_aEsc(_aNum(v))}</title></circle>`).join('')}
    </svg>
    <div class="arena-spark-caption"><span>${_aEsc(_aDate(series[0].date))}</span><span>peak ${_aEsc(_aNum(max))}</span><span>${_aEsc(_aDate(series[series.length - 1].date))}</span></div>`;
}

function _aChannelLink(u) { return `/${encodeURIComponent(u.username)}`; }
function _aFighterLink(u) { return `/arena/${encodeURIComponent(u.username)}`; }
function _aConsoleLink(u) { return `/arena/live/${encodeURIComponent(u.username)}`; }
function _aBeefLink(b) { return `/arena/beef/${b.id}`; }
function _aTopicLink(t) { return `/arena/topic/${t.id}`; }
function _aVodLink(vodId, sec) { return vodId ? `/vod/${vodId}?t=${Math.max(0, Math.floor(sec || 0))}` : null; }
function _aA(href, inner, cls = '', title = '') { return `<a class="${cls}" href="${_aEsc(href)}" ${title ? `title="${_aEsc(title)}"` : ''} onclick="return handleLinkClick(event, '${_aEsc(href)}')">${inner}</a>`; }
function _aPlay(vodId, sec, label = '') { const h = _aVodLink(vodId, sec); return h ? _aA(h, `<i class="fa-solid fa-play"></i>${label ? ` ${_aEsc(label)}` : ''}`, 'arena-play', 'Hear them say it (jumps to the VOD)') : ''; }
function _aLevelPill(level) { return `<span class="arena-lvl" title="Trash Level — earned by talking shit on the board and in beefs">TL ${_aEsc(level ?? 1)}</span>`; }
function _aBriefChip(f, extra = '') {
    return _aA(_aFighterLink(f.user), `${_aPortrait(f, 'xs')}<span><strong>${_aEsc(f.fighter_name)}${f.live ? ' <span class="arena-live-pill">LIVE</span>' : ''}</strong><small>${f.rank ? `#${f.rank} · ` : ''}${_aLevelPill(f.level)}${extra}</small></span>`, 'arena-chip');
}

// ── Page entry ───────────────────────────────────────────────

async function loadArenaPage(segments = []) {
    _aStopTimers();
    const root = document.getElementById('arena-root');
    if (!root) return;
    const [, first, second] = segments;
    try {
        if (first === 'beef' && second) return await _aRenderBeef(root, Number(second));
        if (first === 'topic' && second) return await _aRenderTopic(root, Number(second));
        if (first === 'live' && second) return await _aRenderConsole(root, second);
        if (first) return await _aRenderFighter(root, first);
        return await _aRenderHome(root);
    } catch (err) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-plug-circle-xmark"></i><p>${_aEsc(err?.message || 'The arena lights went out.')}</p></div>`;
    }
}

// ── Home ─────────────────────────────────────────────────────

async function _aRenderHome(root) {
    root.innerHTML = _aSpinner('Reading the room…');
    const [boardData, beefs, live, roster] = await Promise.all([api('/arena/board'), api('/arena/beefs'), api('/arena/live').catch(() => ({ live: [] })), api('/arena/fighters')]);
    _arenaRoster = roster;
    root.innerHTML = `
        <div class="arena-hero">
            <div>
                <h1><i class="fa-solid fa-hand-fist"></i> Arena</h1>
                <p class="arena-lede">Nobody clicks "fight" here. Say a fighter's name on mic while you're talking shit and the beef opens itself. Talk on a board topic and your Trash Level climbs. Chat picks sides, hypes, starts topics and posts bounties.</p>
            </div>
            <div class="arena-hero-actions">
                ${_aMe() ? `<button class="btn btn-primary" id="arena-new-topic-btn"><i class="fa-solid fa-plus"></i> Start a topic</button>` : ''}
                <span class="arena-note">${roster.ai ? '<i class="fa-solid fa-ear-listen"></i> AI ears on' : '<i class="fa-solid fa-ear-deaf"></i> AI off — keyword judging'}</span>
            </div>
        </div>
        <section class="arena-pulse" id="arena-pulse">${_aPulse(boardData.pulse)}</section>
        <section class="arena-live" id="arena-live">${_aRenderLive(live.live || [])}</section>
        <section class="arena-beefs" id="arena-beefs">${_aRenderBeefs(beefs)}</section>
        <section class="arena-board" id="arena-board">${_aRenderBoard(boardData)}</section>
        <section class="arena-ladders">
            <div class="arena-ladder">
                <h2><i class="fa-solid fa-fire"></i> Trash Level ladder <small>XP from beef hits, cleared angles, conquered topics, chat hype</small></h2>
                ${_aLevelsList(boardData.levels || [])}
            </div>
            <div class="arena-ladder">
                <h2><i class="fa-solid fa-crown"></i> Chat clout <small>viewers who pick the winning side</small></h2>
                ${_aCloutList(boardData.clout || [])}
            </div>
        </section>
        <section class="arena-leaderboard">
            <div class="arena-board-head">
                <h2><i class="fa-solid fa-ranking-star"></i> Power ladder <small>${roster.fighters.length} fighters · stats from real streams</small></h2>
                <input type="search" id="arena-search" placeholder="Find a fighter…" autocomplete="off">
            </div>
            <div class="arena-list" id="arena-list"></div>
        </section>
        <section class="arena-rules">
            <h3>How the Arena works</h3>
            <ul>
                <li><b>Beefs.</b> Say another fighter's name on stream while talking shit → a beef opens and they go on the clock (15 min if they're live, 24 h if not; the clock resets every time a side answers). Silence is a forfeit. Best mouth after 24 h wins. Beat someone ranked 4+ spots above you and it's an <b>upset</b>.</li>
                <li><b>The board.</b> Topics, debates, phrase challenges and bounties come from chat (<code>!topic</code>, <code>!bounty</code>) and from the community pulse — the AI reads global chat, transcripts and the AI timeline every 30 min. Click a topic, talk on it, clear its angles → XP → Trash Level.</li>
                <li><b>Chat.</b> <code>!hype</code> boosts your streamer · <code>!side &lt;name&gt;</code> picks a side (clout if you're right) · <code>!topic &lt;text&gt;</code> · <code>!bounty &lt;user&gt;</code> · <code>!beef</code> · <code>!board</code> · <code>!arena</code>.</li>
                <li><b>Language.</b> Nothing gets censored for being offensive. The only lines that don't count: real threats, anything sexual about minors, and doxxing.</li>
            </ul>
        </section>`;
    _aRenderList(roster.fighters);
    _aBindHome(root);
    document.getElementById('arena-search')?.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        _aRenderList(!q ? roster.fighters : roster.fighters.filter(f => [f.persona.fighter_name, f.user.display_name, f.user.username, f.persona.class, f.persona.element].filter(Boolean).some(s => s.toLowerCase().includes(q))));
    });
    document.getElementById('arena-new-topic-btn')?.addEventListener('click', () => _aTopicComposer());
    _aEvery(20000, async () => {
        try {
            const [b, l, bd] = await Promise.all([api('/arena/beefs'), api('/arena/live'), api('/arena/board')]);
            const beefsEl = document.getElementById('arena-beefs'), liveEl = document.getElementById('arena-live'), boardEl = document.getElementById('arena-board'), pulseEl = document.getElementById('arena-pulse');
            if (beefsEl) beefsEl.innerHTML = _aRenderBeefs(b);
            if (liveEl) liveEl.innerHTML = _aRenderLive(l.live || []);
            if (boardEl) boardEl.innerHTML = _aRenderBoard(bd);
            if (pulseEl) pulseEl.innerHTML = _aPulse(bd.pulse);
            _aBindHome(root);
        } catch { /* keep the last render */ }
    });
    _aEvery(1000, () => _aTickClocks(root));
}

function _aPulse(p) {
    if (!p || !p.text) return `<div class="arena-pulse-inner"><span class="arena-pulse-kicker"><i class="fa-solid fa-heart-pulse"></i> Pulse</span><span class="arena-pulse-text">The community is quiet. Start something.</span></div>`;
    return `<div class="arena-pulse-inner">
        <span class="arena-pulse-kicker"><i class="fa-solid fa-heart-pulse fa-beat"></i> Pulse</span>
        <span class="arena-pulse-text">${_aEsc(p.text)}</span>
        <span class="arena-pulse-meta">${p.sources ? _aEsc(p.sources) + ' · ' : ''}read ${_aEsc(_aAgo(p.at))}</span>
    </div>`;
}

function _aRenderLive(live) {
    if (!live.length) return `<h2><span class="arena-live-dot"></span> On the mic now <small>nobody from the roster is live</small></h2><p class="arena-note">When a fighter goes live with transcription on, the Arena listens for name-drops and board topics.</p>`;
    return `<h2><span class="arena-live-dot"></span> On the mic now <small>${live.length} live · the Arena is listening</small></h2>
    <div class="arena-mic-grid">${live.map(f => `
        <div class="arena-mic-card ${f.transcribed ? '' : 'is-quiet'}" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            ${_aA(_aChannelLink(f.user), f.thumbnail_url ? `<img class="arena-live-thumb" src="${_aEsc(f.thumbnail_url)}" alt="">` : _aPortrait(f, 'sm'), 'arena-mic-thumb')}
            <div class="arena-mic-body">
                <div class="arena-mic-head">
                    ${_aA(_aFighterLink(f.user), `<strong>${_aEsc(f.persona.fighter_name)}</strong>`)}
                    <span class="arena-mic-meta">#${f.rank} · PWR ${f.ratings.power} · ${_aLevelPill(f.level)} · <i class="fa-solid fa-eye"></i> ${_aNum(f.stream.viewer_count)}</span>
                </div>
                ${f.hot_mic ? `<q class="arena-mic-line">${_aEsc(f.hot_mic.text)}</q>` : `<span class="arena-mic-line arena-mic-line-empty">${f.transcribed ? 'listening…' : 'no transcript yet — mic stats need transcription on'}</span>`}
                <div class="arena-mic-tags">
                    ${f.active_topic ? _aA(_aTopicLink(f.active_topic), `<i class="fa-solid fa-comment-dots"></i> on: ${_aEsc(f.active_topic.text)}`, 'arena-tag') : '<span class="arena-tag arena-tag-dim">no board topic</span>'}
                    ${f.open_beefs ? `<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-fire"></i> ${f.open_beefs} beef${f.open_beefs > 1 ? 's' : ''} open</span>` : ''}
                    ${_aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> ears', 'arena-tag')}
                </div>
            </div>
        </div>`).join('')}</div>`;
}

// ── Beefs ────────────────────────────────────────────────────

function _aTug(b, { big = false } = {}) {
    const ca = b.a.user.profile_color || '#8b5cf6', cb = b.b.user.profile_color || '#e74c3c';
    return `<div class="arena-tug ${big ? 'arena-tug-big' : ''}" title="${_aEsc(`${b.a.fighter_name} ${b.a.total} — ${b.b.total} ${b.b.fighter_name}`)}">
        <span class="arena-tug-a" style="width:${b.share_a}%;--fc:${_aEsc(ca)}"><b>${b.share_a >= 12 ? `${b.share_a}%` : ''}</b></span>
        <span class="arena-tug-b" style="width:${100 - b.share_a}%;--fc:${_aEsc(cb)}"><b>${100 - b.share_a >= 12 ? `${100 - b.share_a}%` : ''}</b></span>
    </div>`;
}
function _aClockTag(b) {
    if (b.status !== 'open' || !b.on_clock) return '';
    const who = b.on_clock === 'a' ? b.a : b.b;
    return `<span class="arena-clock ${b.clock_seconds_left < 120 ? 'is-urgent' : ''}" data-until="${_aEsc(b.clock_until)}" data-who="${_aEsc(who.fighter_name)}"><i class="fa-solid fa-stopwatch"></i> ${_aEsc(who.fighter_name)} has <b>${_aClock(b.clock_seconds_left)}</b> to answer${b.clock_is_live_window ? '' : ' (offline clock)'}</span>`;
}
function _aTickClocks(root) {
    root.querySelectorAll('.arena-clock[data-until]').forEach(el => {
        const left = Math.max(0, Math.round((Date.parse(el.dataset.until) - Date.now()) / 1000));
        const b = el.querySelector('b'); if (b) b.textContent = _aClock(left);
        el.classList.toggle('is-urgent', left < 120);
        if (left === 0) el.innerHTML = `<i class="fa-solid fa-hourglass-end"></i> ${_aEsc(el.dataset.who)} ran out of time…`;
    });
}
function _aBeefTags(b) {
    const tags = [];
    if (b.rematch) tags.push('<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-rotate-left"></i> REMATCH</span>');
    if (b.bounty) tags.push('<span class="arena-tag arena-tag-gold"><i class="fa-solid fa-sack-dollar"></i> BOUNTY</span>');
    if (b.upset) tags.push('<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-bolt"></i> UPSET</span>');
    if (b.streaks?.a >= 2) tags.push(`<span class="arena-tag">${_aEsc(b.a.fighter_name)} on a ${b.streaks.a}-beef streak</span>`);
    if (b.streaks?.b >= 2) tags.push(`<span class="arena-tag">${_aEsc(b.b.fighter_name)} on a ${b.streaks.b}-beef streak</span>`);
    if (b.history?.fights) tags.push(`<span class="arena-tag arena-tag-dim">history ${b.history.wins_1}–${b.history.wins_2} in ${b.history.fights}</span>`);
    return tags.join('');
}
function _aBeefCard(b) {
    const open = b.status === 'open';
    const winner = !open && b.winner_user_id ? (b.winner_user_id === b.a.user.id ? b.a : b.b) : null;
    return `<div class="arena-beef ${open ? 'is-open' : 'is-done'}" data-beef="${b.id}">
        <div class="arena-beef-head">
            ${_aA(_aBeefLink(b), `<span class="arena-beef-headline">${_aEsc((open ? b.headline : b.result_headline || b.headline) || `${b.a.fighter_name} vs ${b.b.fighter_name}`)}</span>`)}
            <span class="arena-beef-tags">${_aBeefTags(b)}${!open ? `<span class="arena-tag ${winner ? 'arena-tag-gold' : 'arena-tag-dim'}">${winner ? `${_aEsc(winner.fighter_name)} won${b.resolution === 'forfeit' ? ' by forfeit' : ''}` : 'draw'}</span>` : ''}</span>
        </div>
        <div class="arena-beef-sides">
            ${_aA(_aFighterLink(b.a.user), `${_aPortrait(b.a, 'sm')}<span><strong>${_aEsc(b.a.fighter_name)}${b.a.live ? ' <span class="arena-live-pill">LIVE</span>' : ''}</strong><small>#${b.a.rank || '–'} · ${b.a.hits} hits · crowd ${b.a.crowd}/${b.rules.crowd_max}</small></span>`, 'arena-beef-side arena-beef-side-a')}
            <span class="arena-beef-vs">${open ? 'VS' : 'FINAL'}</span>
            ${_aA(_aFighterLink(b.b.user), `${_aPortrait(b.b, 'sm')}<span><strong>${_aEsc(b.b.fighter_name)}${b.b.live ? ' <span class="arena-live-pill">LIVE</span>' : ''}</strong><small>#${b.b.rank || '–'} · ${b.b.hits} hits · crowd ${b.b.crowd}/${b.rules.crowd_max}</small></span>`, 'arena-beef-side arena-beef-side-b')}
        </div>
        ${_aTug(b)}
        <div class="arena-beef-foot">
            ${open ? _aClockTag(b) : `<span class="arena-note">ended ${_aEsc(_aAgo(b.resolved_at))}</span>`}
            ${open ? `<span class="arena-beef-actions">
                <button class="btn btn-ghost btn-sm arena-hype-btn" data-beef="${b.id}" data-side="a" title="Hype ${_aEsc(b.a.fighter_name)}"><i class="fa-solid fa-fire"></i> ${_aEsc(b.a.fighter_name)}</button>
                <button class="btn btn-ghost btn-sm arena-hype-btn" data-beef="${b.id}" data-side="b" title="Hype ${_aEsc(b.b.fighter_name)}"><i class="fa-solid fa-fire"></i> ${_aEsc(b.b.fighter_name)}</button>
                <span class="arena-sides-tally" title="who chat thinks wins"><i class="fa-solid fa-people-group"></i> ${b.sides.a}–${b.sides.b}</span>
            </span>` : ''}
        </div>
        ${b.feed?.length ? `<q class="arena-beef-last">${_aEsc(b.feed[b.feed.length - 1].announcer || b.feed[b.feed.length - 1].text || '')}</q>` : ''}
    </div>`;
}
function _aRenderBeefs(beefs) {
    const open = beefs.open || [], done = beefs.resolved || [];
    return `<h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs <small>${open.length ? `${open.length} open` : 'none open — say a name on mic'}</small></h2>
        ${open.length ? `<div class="arena-beef-grid">${open.map(_aBeefCard).join('')}</div>` : `<div class="arena-beef-empty"><i class="fa-solid fa-microphone-lines"></i><p>No beef right now. A streamer only has to say another fighter's name while talking shit — the ears do the rest.</p></div>`}
        ${done.length ? `<details class="arena-done"><summary>Settled beefs <small>${done.length}</small></summary><div class="arena-beef-grid">${done.slice(0, 6).map(_aBeefCard).join('')}</div></details>` : ''}`;
}

async function _aHype(beefId, side, btn) {
    try {
        const r = await api(`/arena/beefs/${beefId}/hype`, { method: 'POST', body: { side } });
        _aToast(r.added ? `🔥 Hyped! crowd ${r.crowd}/10 (${r.hypers} hyping)` : `You already hyped this side (${r.hypers} hyping)`, r.added ? 'success' : 'info');
        if (btn) btn.classList.add('is-hyped');
    } catch (err) { _aToast(err?.message || 'Hype failed', 'error'); }
}
async function _aSide(beefId, side) {
    try { const r = await api(`/arena/beefs/${beefId}/side`, { method: 'POST', body: { side } }); _aToast(`🗳️ Side picked. Crowd: ${r.a}–${r.b}. Pick right → clout.`, 'success'); return r; }
    catch (err) { _aToast(err?.message || 'Failed', 'error'); }
}
function _aBindHome(root) {
    root.querySelectorAll('.arena-hype-btn').forEach(btn => btn.onclick = (e) => { e.preventDefault(); _aHype(btn.dataset.beef, btn.dataset.side, btn); });
    root.querySelectorAll('.arena-topic-hype').forEach(btn => btn.onclick = async (e) => {
        e.preventDefault();
        try { const r = await api(`/arena/board/topics/${btn.dataset.topic}/hype`, { method: 'POST', body: { user_id: Number(btn.dataset.user) } }); _aToast(r.added ? `🔥 Hyped (${r.hypers} hyping)` : 'Already hyped', r.added ? 'success' : 'info'); btn.classList.add('is-hyped'); }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); }
    });
    root.querySelectorAll('.arena-debate-side').forEach(btn => btn.onclick = async (e) => {
        e.preventDefault();
        try { const r = await api(`/arena/board/topics/${btn.dataset.topic}/side`, { method: 'POST', body: { side: btn.dataset.side } }); _aToast(`🗳️ You're with ${btn.dataset.label}. ${r.a}–${r.b}`, 'success'); const t = btn.closest('.arena-topic'); if (t) { const tally = t.querySelector('.arena-debate-tally'); if (tally) tally.innerHTML = _aDebateTally(r); } }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); }
    });
    root.querySelectorAll('.arena-topic-join').forEach(btn => btn.onclick = async (e) => {
        e.preventDefault();
        try { await api(`/arena/board/topics/${btn.dataset.topic}/join`, { method: 'POST' }); _aToast('🎤 You\'re on it. Start talking on stream — the ears are listening.', 'success'); navigate(`/arena/topic/${btn.dataset.topic}`); }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); }
    });
    _aBindSpeak(root);
}

// ── Board ────────────────────────────────────────────────────

function _aDebateTally(s) { return `<span class="arena-debate-bar"><span style="width:${s.share_a}%"></span></span><span class="arena-debate-nums">${s.a} · ${s.b}</span>`; }
function _aHeat(t, hotThreshold) {
    const pct = Math.min(100, Math.round((t.heat / Math.max(hotThreshold * 2, 1)) * 100));
    return `<span class="arena-heat ${t.hot ? 'is-hot' : ''}" title="heat: talk + hype + joins in the last hours"><i class="fa-solid fa-fire"></i> ${t.hot ? 'HOT' : ''} ${t.heat}<span class="arena-heat-bar"><span style="width:${pct}%"></span></span></span>`;
}
function _aTopicTitle(t) {
    if (t.kind === 'debate') return `<span class="arena-debate-title"><b>${_aEsc(t.side_a)}</b> <em>vs</em> <b>${_aEsc(t.side_b)}</b></span>`;
    if (t.kind === 'phrase') return `Work “<b>${_aEsc(t.phrase)}</b>” into your stream`;
    if (t.kind === 'bounty') return `Bounty on <b>${_aEsc(t.target?.fighter_name || '?')}</b> — double XP for talking shit about them`;
    return _aEsc(t.text);
}
function _aTopicCard(t, hot, { me } = {}) {
    const k = ARENA_KIND[t.kind] || ARENA_KIND.topic;
    const onIt = me && t.talking_now.some(f => f.user.id === me.id);
    const onRoster = me && _arenaRoster?.fighters?.some(f => f.user.id === me.id);
    return `<div class="arena-topic arena-topic-${t.kind} ${t.hot ? 'is-hot' : ''}" data-topic="${t.id}">
        <div class="arena-topic-head">
            <span class="arena-kind"><i class="fa-solid ${k.icon}"></i> ${k.label}</span>
            ${_aHeat(t, hot)}
            <span class="arena-topic-by">${t.created_by === 'ai' ? '<i class="fa-solid fa-heart-pulse"></i> pulse' : `<i class="fa-solid fa-user"></i> ${_aEsc(t.creator_name || t.created_by)}`}${t.expires_at ? ` · <span class="arena-expires" data-until="${_aEsc(t.expires_at)}">${_aEsc(_aClock((Date.parse(t.expires_at) - Date.now()) / 1000))} left</span>` : ''}</span>
        </div>
        ${t.headline ? `<div class="arena-topic-headline">${_aEsc(t.headline)}</div>` : ''}
        ${_aA(_aTopicLink(t), `<div class="arena-topic-text">${_aTopicTitle(t)}</div>`, 'arena-topic-link')}
        ${t.hint ? `<p class="arena-topic-hint">${_aEsc(t.hint)}</p>` : ''}
        ${t.kind === 'debate' ? `<div class="arena-debate">
            <button class="btn btn-ghost btn-sm arena-debate-side" data-topic="${t.id}" data-side="a" data-label="${_aEsc(t.side_a)}">${_aEsc(t.side_a)}</button>
            <span class="arena-debate-tally">${_aDebateTally(t.sides || { a: 0, b: 0, share_a: 50 })}</span>
            <button class="btn btn-ghost btn-sm arena-debate-side" data-topic="${t.id}" data-side="b" data-label="${_aEsc(t.side_b)}">${_aEsc(t.side_b)}</button>
        </div>` : ''}
        <div class="arena-topic-foot">
            <span class="arena-topic-who">${t.talking_now.length ? `<span class="arena-live-dot arena-live-dot-sm"></span> ${t.talking_now.map(f => _aA(_aFighterLink(f.user), _aPortrait(f, 'xs'), '', `${f.fighter_name} is on this`)).join('')}` : ''}${t.members.filter(m => !m.active).slice(0, 6).map(m => _aA(_aFighterLink(m.user), _aPortrait(m, 'xs'), 'is-dim', `${m.fighter_name} · ${m.cleared}/${t.angles.length || 3} angles`)).join('')}</span>
            <span class="arena-topic-stats">${t.hits} hits · ${t.conquered} conquered${t.angles?.length ? ` · ${t.angles.length} angles` : ''}</span>
            <span class="arena-topic-actions">
                ${t.talking_now.length && me && !onIt ? t.talking_now.slice(0, 2).map(f => `<button class="btn btn-ghost btn-sm arena-topic-hype" data-topic="${t.id}" data-user="${f.user.id}"><i class="fa-solid fa-fire"></i> ${_aEsc(f.fighter_name)}</button>`).join('') : ''}
                ${onRoster && t.kind !== 'bounty' ? (onIt ? '<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-microphone"></i> you\'re on it</span>' : `<button class="btn btn-primary btn-sm arena-topic-join" data-topic="${t.id}"><i class="fa-solid fa-microphone"></i> Talk on this</button>`) : ''}
            </span>
        </div>
    </div>`;
}
function _aRenderBoard(bd) {
    const me = _aMe();
    const open = bd.open || [], resolved = bd.resolved || [];
    return `<div class="arena-board-head">
            <h2><i class="fa-solid fa-comments"></i> The board <small>${open.length} open · sorted by heat</small></h2>
            ${me ? `<button class="btn btn-ghost btn-sm" id="arena-board-new"><i class="fa-solid fa-plus"></i> Topic</button>` : '<span class="arena-note">sign in (or type <code>!topic</code> in any chat) to add one</span>'}
        </div>
        ${open.length ? `<div class="arena-topic-grid">${open.map(t => _aTopicCard(t, bd.hot_threshold || 12, { me })).join('')}</div>` : '<p class="arena-note">The board is empty — the pulse fills it in a moment, or start a topic.</p>'}
        ${resolved.length ? `<details class="arena-done"><summary>Recently settled <small>${resolved.length}</small></summary><div class="arena-resolved">${resolved.map(t => `<div class="arena-resolved-row">${_aA(_aTopicLink(t), `<span class="arena-kind">${_aEsc((ARENA_KIND[t.kind] || ARENA_KIND.topic).label)}</span> ${_aTopicTitle(t)}`)}<span class="arena-note">${t.resolved?.headline ? _aEsc(t.resolved.headline) : t.winner_side ? `${_aEsc(t.winner_side === 'a' ? t.side_a : t.side_b)} won` : 'closed'}</span></div>`).join('')}</div></details>` : ''}`;
}
function _aTopicComposer() {
    const box = document.createElement('div');
    box.className = 'arena-lightbox';
    box.innerHTML = `<button class="arena-lightbox-close" aria-label="Close">&times;</button>
        <div class="arena-lightbox-inner arena-composer">
            <h3><i class="fa-solid fa-comment-dots"></i> Put a topic on the board</h3>
            <p class="arena-note">Something the streamers should talk shit about. The AI cuts it into 3 angles; anyone who clears them levels up. One line, up to 140 characters.</p>
            <textarea id="arena-composer-text" maxlength="140" rows="3" placeholder="e.g. Streamers who read donations in a baby voice"></textarea>
            <div class="arena-composer-actions"><button class="btn btn-primary" id="arena-composer-go">Post it</button></div>
        </div>`;
    const close = () => box.remove();
    box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('.arena-lightbox-close')) close(); });
    box.querySelector('#arena-composer-go').addEventListener('click', async () => {
        const text = box.querySelector('#arena-composer-text').value.trim();
        if (!text) return;
        try { const r = await api('/arena/board/topics', { method: 'POST', body: { text } }); close(); _aToast('📌 On the board.', 'success'); navigate(`/arena/topic/${r.topic.id}`); }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); }
    });
    document.body.appendChild(box);
    box.querySelector('textarea').focus();
}
document.addEventListener('click', (e) => { if (e.target.closest('#arena-board-new')) { e.preventDefault(); _aTopicComposer(); } });

// ── Ladders ──────────────────────────────────────────────────

function _aLevelsList(rows) {
    if (!rows.length) return '<p class="arena-note">Nobody has XP yet. Talk on a topic or start a beef.</p>';
    return `<div class="arena-mini-list">${rows.map((r, i) => `<div class="arena-mini-row">
        <span class="arena-rank ${i < 3 ? `arena-rank-${i + 1}` : ''}">${i + 1}</span>
        ${_aA(_aFighterLink(r.user), `${_aPortrait(r, 'xs')}<span><strong>${_aEsc(r.fighter_name)}</strong><small>${r.xp} XP · ${r.beef_hits} beef hits · ${r.angles_cleared} angles · ${r.topics_conquered} conquered</small></span>`, 'arena-chip')}
        <span class="arena-lvl arena-lvl-big">LVL ${r.level}</span>
    </div>`).join('')}</div>`;
}
function _aCloutList(rows) {
    if (!rows.length) return '<p class="arena-note">Pick sides in beefs and debates (<code>!side</code>) — call it right and you show up here.</p>';
    return `<div class="arena-mini-list">${rows.map((r, i) => `<div class="arena-mini-row">
        <span class="arena-rank ${i < 3 ? `arena-rank-${i + 1}` : ''}">${i + 1}</span>
        <span class="arena-chip"><span><strong>${r.username ? _aA(_aChannelLink(r), _aEsc(r.name)) : _aEsc(r.name)}</strong><small>${r.wins}/${r.picks} right · ${r.accuracy}%${r.streak >= 2 ? ` · ${r.streak} streak` : ''}</small></span></span>
        <span class="arena-lvl">${r.wins} W</span>
    </div>`).join('')}</div>`;
}

function _aRenderList(fighters) {
    const el = document.getElementById('arena-list');
    if (!el) return;
    if (!fighters.length) { el.innerHTML = '<div class="arena-empty"><p>No fighter matches that.</p></div>'; return; }
    el.innerHTML = fighters.map(f => `
        <div class="arena-row ${f.live ? 'is-live' : ''}" data-user="${_aEsc(f.user.username)}" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            <span class="arena-rank ${f.rank <= 3 ? `arena-rank-${f.rank}` : ''}">${f.rank}</span>
            ${_aPortrait(f, 'sm')}
            <span class="arena-row-main">
                <strong>${_aEsc(f.persona.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''} ${_aLevelPill(f.level?.level)}<i class="fa-solid fa-chevron-right arena-chevron"></i></strong>
                <span class="arena-row-sub">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · ${_aEsc(f.persona.element)}${f.voice?.has_data ? ` · <i class="fa-solid fa-microphone" title="has transcript data"></i> Mic ${f.ratings.mic}` : ''}</span>
                <em class="arena-row-taunt">“${_aEsc(f.persona.taunt)}”</em>
            </span>
            <span class="arena-row-stats">
                <span class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></span>
                <span class="arena-record" title="beef record">${f.record.wins}W–${f.record.losses}L</span>
            </span>
            <div class="arena-row-expand">
                <div>${_aRadar(f.ratings, f.user.profile_color || '#8b5cf6', 180)}<div class="arena-mini-record">${f.category ? _aEsc(f.category) + ' · ' : ''}last live ${_aEsc(f.last_live_at ? _aDate(f.last_live_at) : '—')}</div></div>
                <div>
                    <p class="arena-row-lore">${_aEsc(f.persona.lore)}</p>
                    <div class="arena-quips">${ARENA_STATS.map(k => `<div class="arena-quip"><b>${_aEsc(ARENA_STAT_LABEL[k])} ${f.ratings[k]}</b><span>${_aEsc((f.persona.stat_quips || {})[k] || '')}</span></div>`).join('')}</div>
                    ${f.persona.signature_move ? `<div class="arena-mini-record"><b>Signature:</b> ${_aEsc(f.persona.signature_move.name)} — ${_aEsc(f.persona.signature_move.description)}</div>` : ''}
                </div>
                <div class="arena-row-expand-actions">
                    ${_aA(_aFighterLink(f.user), '<i class="fa-solid fa-id-card"></i> Full profile', 'btn btn-primary')}
                    ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> Listen in', 'btn btn-ghost') : ''}
                    ${_aSpeakBtn(f.persona.taunt, 'btn btn-ghost')}
                </div>
            </div>
        </div>`).join('');
    el.querySelectorAll('.arena-row').forEach(row => row.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        row.classList.toggle('is-open');
    }));
    _aBindSpeak(el);
}

// ── Beef detail ──────────────────────────────────────────────

function _aFeedLine(e, b) {
    const side = e.side === 'a' ? b.a : b.b;
    const sys = e.kind && e.kind !== 'hit';
    return `<div class="arena-feed-line ${sys ? 'is-system' : `is-${e.side}`}">
        ${sys ? '' : _aA(_aFighterLink(side.user), _aPortrait(side, 'xs'))}
        <div class="arena-feed-body">
            ${e.announcer ? `<div class="arena-feed-announcer"><i class="fa-solid fa-bullhorn"></i> ${_aEsc(e.announcer)}</div>` : ''}
            ${e.text ? `<q>${_aEsc(e.text)}</q>` : ''}
            <small>${sys ? _aEsc(e.kind) : `${_aEsc(side.fighter_name)}${e.quality != null ? ` · ${e.quality}/10` : ''}${e.about ? ` · ${_aEsc(e.about)}` : ''}${e.bonus ? ` · ${_aEsc(e.bonus)}` : ''}`} · ${_aEsc(_aAgo(e.at))} ${_aPlay(e.vod_id, e.sec)} ${e.text ? _aSpeakBtn(e.text, '') : ''}</small>
        </div>
    </div>`;
}
async function _aRenderBeef(root, id) {
    root.innerHTML = _aSpinner('Pulling the receipts…');
    const b = await api(`/arena/beefs/${id}`);
    const open = b.status === 'open';
    const winner = !open && b.winner_user_id ? (b.winner_user_id === b.a.user.id ? b.a : b.b) : null;
    const draw = () => {
        root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')} ${_aA(_aFighterLink(b.a.user), _aEsc(b.a.fighter_name))} · ${_aA(_aFighterLink(b.b.user), _aEsc(b.b.fighter_name))}</div>
        <div class="arena-beef-page">
            <div class="arena-beef-hero">
                <div class="arena-beef-tags">${_aBeefTags(b)}${!open ? `<span class="arena-tag ${winner ? 'arena-tag-gold' : 'arena-tag-dim'}">${winner ? `${_aEsc(winner.fighter_name)} won${b.resolution === 'forfeit' ? ' by forfeit' : b.resolution === 'score' ? ' on points' : ''}` : 'draw'}</span>` : '<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-fire"></i> OPEN</span>'}</div>
                <h1>${_aEsc((open ? b.headline : b.result_headline || b.headline) || `${b.a.fighter_name} vs ${b.b.fighter_name}`)} ${_aSpeakBtn((open ? b.headline : b.result_headline || b.headline) || '')}</h1>
                ${b.opener_line ? `<p class="arena-beef-opener">It started with: <q>${_aEsc(b.opener_line)}</q></p>` : ''}
            </div>
            <div class="arena-beef-tape">
                ${['a', 'b'].map(s => { const f = b[s]; return `<div class="arena-beef-tape-side arena-beef-tape-${s}" style="--fc:${_aEsc(f.user.profile_color || (s === 'a' ? '#8b5cf6' : '#e74c3c'))}">
                    ${_aA(_aFighterLink(f.user), _aPortrait(f, 'md'))}
                    <h2>${_aEsc(f.fighter_name)}${f.live ? ' <span class="arena-live-pill">LIVE</span>' : ''}</h2>
                    <div class="arena-beef-tape-meta">#${f.rank || '–'} · ${_aLevelPill(f.level)}${b.streaks?.[s] >= 2 ? ` · ${b.streaks[s]}-beef streak` : ''}</div>
                    <div class="arena-beef-tape-nums"><span><b>${f.hits}</b><small>hits</small></span><span><b>${f.score}</b><small>quality</small></span><span><b>${f.crowd}</b><small>crowd /${b.rules.crowd_max}</small></span><span><b>${f.total}</b><small>total</small></span></div>
                    ${open ? `<div class="arena-beef-tape-actions"><button class="btn btn-primary btn-sm arena-hype-btn" data-beef="${b.id}" data-side="${s}"><i class="fa-solid fa-fire"></i> Hype</button><button class="btn btn-ghost btn-sm arena-side-btn" data-beef="${b.id}" data-side="${s}"><i class="fa-solid fa-flag"></i> I'm with ${_aEsc(f.fighter_name.split(' ')[0])}</button></div>` : ''}
                    ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> listen in', 'arena-tag') : ''}
                </div>`; }).join('')}
            </div>
            ${_aTug(b, { big: true })}
            <div class="arena-beef-status">
                ${open ? _aClockTag(b) : ''}
                <span class="arena-sides-tally" id="arena-sides-tally"><i class="fa-solid fa-people-group"></i> chat says ${b.sides.a}–${b.sides.b} (${b.sides.share_a}% ${_aEsc(b.a.fighter_name)})</span>
                ${b.ends_at && open ? `<span class="arena-note"><i class="fa-solid fa-hourglass-half"></i> hard end in ${_aEsc(_aClock((Date.parse(b.ends_at) - Date.now()) / 1000))}</span>` : ''}
            </div>
            <div class="arena-beef-cols">
                <section class="arena-feed">
                    <h3><i class="fa-solid fa-bullhorn"></i> Ringside <small>every judged hit, newest last</small></h3>
                    ${b.feed.length ? b.feed.map(e => _aFeedLine(e, b)).join('') : '<p class="arena-note">Nothing judged yet.</p>'}
                </section>
                <aside class="arena-beef-aside">
                    ${b.history?.fights ? `<section><h3><i class="fa-solid fa-receipt"></i> Receipts <small>${b.history.wins_1}–${b.history.wins_2} in ${b.history.fights} earlier beef${b.history.fights > 1 ? 's' : ''}</small></h3>
                        ${b.history.receipts.map(r => { const f = r.side_user_id === b.a.user.id ? b.a : b.b; return `<div class="arena-receipt"><q>${_aEsc(r.text)}</q><small>${_aEsc(f.fighter_name)} · ${r.quality}/10 · ${_aA(_aBeefLink({ id: r.beef_id }), `beef #${r.beef_id}`)} ${_aPlay(r.vod_id, r.sec)}</small></div>`; }).join('') || '<p class="arena-note">No quotable receipts.</p>'}</section>` : '<section><h3><i class="fa-solid fa-receipt"></i> Receipts</h3><p class="arena-note">First time these two have beef.</p></section>'}
                    <section><h3><i class="fa-solid fa-gavel"></i> Rules</h3><ul class="arena-rules-list">
                        <li>Answer on your own stream within <b>${b.rules.response_live_min} min</b> if you're live, <b>${b.rules.response_offline_hours} h</b> if not — or forfeit.</li>
                        <li>Every judged answer resets the other side's clock. Beef hard-ends after ${b.rules.max_hours} h; higher total wins.</li>
                        <li>Total = hit quality (AI-judged 1–10) + crowd hype (max ${b.rules.crowd_max}). Chat's side pick is clout, not score.</li>
                        <li>Beat someone ranked 4+ spots above you → <b>upset</b>. Same two again → <b>rematch</b> (+ rivalry receipts).</li>
                    </ul></section>
                </aside>
            </div>
        </div>`;
        root.querySelectorAll('.arena-hype-btn').forEach(btn => btn.onclick = () => _aHype(b.id, btn.dataset.side, btn));
        root.querySelectorAll('.arena-side-btn').forEach(btn => btn.onclick = async () => { const r = await _aSide(b.id, btn.dataset.side); if (r) { const t = document.getElementById('arena-sides-tally'); if (t) t.innerHTML = `<i class="fa-solid fa-people-group"></i> chat says ${r.a}–${r.b} (${r.share_a}% ${_aEsc(b.a.fighter_name)})`; } });
        _aBindSpeak(root);
    };
    draw();
    _aEvery(1000, () => _aTickClocks(root));
    if (open) _aEvery(12000, async () => { try { const fresh = await api(`/arena/beefs/${id}`); if (JSON.stringify(fresh.feed) !== JSON.stringify(b.feed) || fresh.status !== b.status || fresh.share_a !== b.share_a) { Object.assign(b, fresh); draw(); } } catch { /* */ } });
}

// ── Topic detail ─────────────────────────────────────────────

async function _aRenderTopic(root, id) {
    root.innerHTML = _aSpinner('Opening the topic…');
    let t = await api(`/arena/board/topics/${id}`);
    const me = _aMe();
    const draw = () => {
        const k = ARENA_KIND[t.kind] || ARENA_KIND.topic;
        const onIt = me && t.talking_now.some(f => f.user.id === me.id);
        const onRoster = me && (_arenaRoster?.fighters?.some(f => f.user.id === me.id) ?? true);
        const members = t.members || [];
        root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')}</div>
        <div class="arena-topic-page arena-topic-${t.kind} ${t.hot ? 'is-hot' : ''}">
            <div class="arena-topic-head">
                <span class="arena-kind"><i class="fa-solid ${k.icon}"></i> ${k.label}</span>
                ${_aHeat(t, 12)}
                <span class="arena-topic-by">${t.created_by === 'ai' ? '<i class="fa-solid fa-heart-pulse"></i> from the pulse' : `started by ${_aEsc(t.creator_name || t.created_by)}`} · ${_aEsc(_aAgo(t.created_at))}${t.expires_at && t.status === 'open' ? ` · <span class="arena-expires" data-until="${_aEsc(t.expires_at)}">${_aEsc(_aClock((Date.parse(t.expires_at) - Date.now()) / 1000))} left</span>` : ''}${t.status !== 'open' ? ` · <b>${_aEsc(t.status)}</b>` : ''}</span>
            </div>
            ${t.headline ? `<div class="arena-topic-headline">${_aEsc(t.headline)} ${_aSpeakBtn(t.headline, '')}</div>` : ''}
            <h1 class="arena-topic-text">${_aTopicTitle(t)}</h1>
            ${t.hint ? `<p class="arena-topic-hint">${_aEsc(t.hint)}</p>` : ''}
            ${t.source_note ? `<p class="arena-note"><i class="fa-solid fa-satellite-dish"></i> ${_aEsc(t.source_note)}</p>` : ''}
            ${t.resolved?.headline ? `<div class="arena-topic-result"><i class="fa-solid fa-flag-checkered"></i> ${_aEsc(t.resolved.headline)}</div>` : ''}
            ${t.kind === 'debate' ? `<div class="arena-debate arena-debate-big">
                <button class="btn btn-ghost arena-debate-side" data-topic="${t.id}" data-side="a" data-label="${_aEsc(t.side_a)}" ${t.status !== 'open' ? 'disabled' : ''}>${_aEsc(t.side_a)}</button>
                <span class="arena-debate-tally">${_aDebateTally(t.sides || { a: 0, b: 0, share_a: 50 })}</span>
                <button class="btn btn-ghost arena-debate-side" data-topic="${t.id}" data-side="b" data-label="${_aEsc(t.side_b)}" ${t.status !== 'open' ? 'disabled' : ''}>${_aEsc(t.side_b)}</button>
                <p class="arena-note">Streamers: say which side you're on and argue it on mic. Chat: pick a side — the side with more talk + more chat wins when the clock runs out, and right picks earn clout.</p>
            </div>` : ''}
            ${t.kind === 'bounty' && t.target ? `<div class="arena-bounty-target">${_aBriefChip(t.target, ' · the mark')}<span class="arena-note">Any fighter who lands judged shit talk on ${_aEsc(t.target.fighter_name)} while this is open gets <b>double XP</b>. The mark can answer back on their own stream.</span></div>` : ''}
            <div class="arena-topic-cta">
                ${onRoster && t.status === 'open' && t.kind !== 'bounty' ? (onIt ? `<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-microphone"></i> You're on this — talk on stream, the ears are listening</span> <button class="btn btn-ghost btn-sm" id="arena-topic-leave">Leave topic</button> ${_aA(_aConsoleLink(me), '<i class="fa-solid fa-ear-listen"></i> my ears', 'btn btn-ghost btn-sm')}` : `<button class="btn btn-primary" id="arena-topic-join"><i class="fa-solid fa-microphone"></i> Talk on this</button><span class="arena-note">Sets it as your active topic. Go live with transcription on and just talk — every 30 s the judge scores what you said.</span>`) : ''}
                ${!me ? '<span class="arena-note">Sign in to talk on this (streamers) or hype whoever\'s on it.</span>' : ''}
            </div>
            ${t.angles?.length ? `<section class="arena-angles"><h3><i class="fa-solid fa-diagram-project"></i> Angles <small>clear all ${t.angles.length} to conquer the topic (+60 XP)</small></h3>
                <div class="arena-angle-grid">${t.angles.map(a => `<div class="arena-angle"><b>${a.idx + 1}. ${_aEsc(a.text)}</b><span>${_aEsc(a.hint || '')}</span></div>`).join('')}</div></section>` : (t.kind === 'topic' ? '<p class="arena-note">Angles get cut the moment someone joins.</p>' : '')}
            ${members.length ? `<section class="arena-members"><h3><i class="fa-solid fa-microphone-lines"></i> Who's talking <small>${t.talking_now.length} live on it</small></h3>
                ${members.map(m => { const prog = (t.progress || {})[m.user.id] || []; return `<div class="arena-member ${m.active ? 'is-active' : ''}">
                    ${_aBriefChip(m, ` · ${m.cleared}/${t.angles.length || '?'} angles · ${m.score} pts${m.conquered_at ? ' · <b>conquered</b>' : ''}`)}
                    <div class="arena-member-progress">${(t.angles || []).map(a => { const p = prog.find(x => x.angle_idx === a.idx) || { progress: 0 }; return `<span class="arena-progress ${p.cleared ? 'is-cleared' : ''}" title="${_aEsc(a.text)}: ${p.progress}%"><span class="arena-progress-fill" style="width:${p.progress}%"></span></span>`; }).join('')}</div>
                    ${me && m.user.id !== me.id && t.status === 'open' ? `<button class="btn btn-ghost btn-sm arena-topic-hype" data-topic="${t.id}" data-user="${m.user.id}"><i class="fa-solid fa-fire"></i> Hype</button>` : ''}
                </div>`; }).join('')}</section>` : ''}
            ${t.best_lines?.length ? `<section class="arena-best-lines"><h3><i class="fa-solid fa-quote-left"></i> Best lines <small>as heard on stream</small></h3>
                ${t.best_lines.map(l => `<div class="arena-quote"><div><q>${_aEsc(l.text)}</q><small>${_aA(_aFighterLink(l.user), _aEsc(l.fighter_name))}${l.angle_idx >= 0 && t.angles[l.angle_idx] ? ` · angle ${l.angle_idx + 1}` : ''}</small></div><div class="arena-quote-actions">${_aPlay(l.vod_id, l.sec)} ${_aSpeakBtn(l.text, '')}</div></div>`).join('')}</section>` : ''}
        </div>`;
        document.getElementById('arena-topic-join')?.addEventListener('click', async () => { try { const r = await api(`/arena/board/topics/${t.id}/join`, { method: 'POST' }); t = r.topic; _aToast('🎤 You\'re on it. Go talk.', 'success'); draw(); } catch (err) { _aToast(err?.message || 'Failed', 'error'); } });
        document.getElementById('arena-topic-leave')?.addEventListener('click', async () => { try { await api(`/arena/board/topics/${t.id}/leave`, { method: 'POST' }); t = await api(`/arena/board/topics/${id}`); draw(); } catch (err) { _aToast(err?.message || 'Failed', 'error'); } });
        _aBindHome(root);
    };
    draw();
    _aEvery(15000, async () => { try { const fresh = await api(`/arena/board/topics/${id}`); if (JSON.stringify(fresh) !== JSON.stringify(t)) { t = fresh; draw(); } } catch { /* */ } });
}

// ── Live console ("the ears") ────────────────────────────────

async function _aRenderConsole(root, username) {
    root.innerHTML = _aSpinner('Putting the ears on…');
    let c = await api(`/arena/console/${encodeURIComponent(username)}`);
    const draw = () => {
        const f = c.fighter, L = c.listener || {}, lvl = c.level || {};
        const me = _aMe(), mine = me && me.id === f.user.id;
        const xpPct = lvl.xp_per_level ? Math.round((lvl.xp_into_level / lvl.xp_per_level) * 100) : 0;
        root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')} ${_aA(_aFighterLink(f.user), _aEsc(f.fighter_name))} ${c.live ? _aA(_aChannelLink(f.user), '<i class="fa-solid fa-tv"></i> watch', '') : ''}</div>
        <div class="arena-console" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            <div class="arena-console-head">
                ${_aPortrait(f, 'sm')}
                <div>
                    <h1>${_aEsc(f.fighter_name)} ${c.live ? '<span class="arena-live-pill">LIVE</span>' : '<span class="arena-tag arena-tag-dim">offline</span>'}</h1>
                    <div class="arena-console-status ${L.listening ? 'is-on' : ''}">
                        <i class="fa-solid ${L.listening ? 'fa-ear-listen' : 'fa-ear-deaf'}"></i>
                        ${!c.live ? 'Not live — the ears only work on a live, transcribed stream.' : !c.transcribed ? 'Live, but no transcript in the last 30 min. Turn on audio transcription in the dashboard and the Arena hears you.' : L.listening ? `Listening. ${L.pending_topic_words || 0} words buffered for the topic judge · ${L.mention_buffers || 0} name-drop buffer${L.mention_buffers === 1 ? '' : 's'} open${L.last_judge_at ? ` · last judged ${_aEsc(_aAgo(L.last_judge_at))}` : ''}` : 'Live and transcribed — the listener picks this stream up on its next 15 s tick.'}
                    </div>
                </div>
                <div class="arena-console-level">
                    <span class="arena-lvl arena-lvl-big">TRASH LVL ${lvl.level || 1}</span>
                    <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${xpPct}%"></span></span>
                    <small>${lvl.xp_into_level || 0}/${lvl.xp_per_level || 50} XP to level ${(lvl.level || 1) + 1} · ${lvl.recent_xp || 0} this week</small>
                </div>
            </div>
            <div class="arena-console-cols">
                <section class="arena-console-main">
                    <h3><i class="fa-solid fa-microphone"></i> Hot mic <small>last lines the ears heard</small></h3>
                    <div class="arena-mic-feed">${c.hot_mic?.length ? c.hot_mic.map(l => `<div class="arena-mic-line-row"><span class="arena-mic-time">${_aStamp(l.sec)}</span><span>${_aEsc(l.text)}</span>${_aPlay(l.vod_id, l.sec)}</div>`).join('') : '<p class="arena-note">Nothing heard yet.</p>'}</div>
                    ${L.last_beef_judgement ? `<div class="arena-judgement ${L.last_beef_judgement.aimed_at_target ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Beef judge (${_aEsc(_aAgo(L.last_beef_judgement.at))}):</b> ${L.last_beef_judgement.aimed_at_target ? `HIT · ${L.last_beef_judgement.quality}/10 · ${_aEsc(L.last_beef_judgement.about || '')}${L.last_beef_judgement.opened ? ' · <b>beef opened</b>' : ''}${L.last_beef_judgement.bounty ? ' · <b>bounty collected</b>' : ''}` : `no beef — ${_aEsc(L.last_beef_judgement.about || 'name dropped but not aimed at them')}`}${L.last_beef_judgement.flagged ? ' · <span class="arena-tag arena-tag-dim">line not counted (threat/minor/dox)</span>' : ''}</div>` : ''}
                    ${L.last_topic_judgement ? `<div class="arena-judgement ${L.last_topic_judgement.applied ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Topic judge (${_aEsc(_aAgo(L.last_topic_judgement.at))}):</b> ${L.last_topic_judgement.applied ? `angle ${L.last_topic_judgement.angle_idx + 1} · ${L.last_topic_judgement.quality}/10 · +${L.last_topic_judgement.progress_gain || 0}% → ${L.last_topic_judgement.progress}%${L.last_topic_judgement.cleared_angle ? ' · <b>angle cleared</b>' : ''}${L.last_topic_judgement.conquered ? ' · <b>TOPIC CONQUERED</b>' : ''}` : `off topic — ${_aEsc(L.last_topic_judgement.about || 'keep it on the angles')}`}</div>` : ''}
                </section>
                <aside class="arena-console-aside">
                    <section>
                        <h3><i class="fa-solid fa-comment-dots"></i> Active topic</h3>
                        ${c.active_topic ? `${_aA(_aTopicLink(c.active_topic), `<b>${_aTopicTitle(c.active_topic)}</b>`)}
                            <div class="arena-angle-list">${(c.active_topic.angles || []).map(a => { const p = (c.active_topic.my_progress || []).find(x => x.angle_idx === a.idx) || { progress: 0 }; return `<div class="arena-angle-row ${p.cleared_at ? 'is-cleared' : ''}"><span class="arena-progress"><span class="arena-progress-fill" style="width:${Math.round(p.progress || 0)}%"></span></span><span><b>${a.idx + 1}.</b> ${_aEsc(a.text)} <small>${Math.round(p.progress || 0)}%${p.cleared_at ? ' ✓' : ''}</small></span></div>`; }).join('')}</div>` : `<p class="arena-note">${mine ? 'No active topic. Pick one on the board and talk on it.' : 'Not on a board topic.'}</p>${mine ? _aA('/arena', 'Open the board', 'btn btn-ghost btn-sm') : ''}`}
                    </section>
                    <section>
                        <h3><i class="fa-solid fa-fire-flame-curved"></i> Open beefs</h3>
                        ${c.open_beefs?.length ? c.open_beefs.map(b => `<div class="arena-console-beef">${_aA(_aBeefLink(b), `<b>${_aEsc(b.headline || `${b.a.fighter_name} vs ${b.b.fighter_name}`)}</b>`)}${_aTug(b)}${_aClockTag(b)}</div>`).join('') : `<p class="arena-note">None. ${mine ? 'Say another fighter\'s name while talking shit and one opens.' : ''}</p>`}
                    </section>
                    ${c.bounty_on_me ? `<section><h3><i class="fa-solid fa-sack-dollar"></i> Bounty on ${_aEsc(f.fighter_name)}</h3>${_aA(_aTopicLink(c.bounty_on_me), _aEsc(c.bounty_on_me.headline || c.bounty_on_me.text))}<p class="arena-note">Everyone gets double XP for talking shit about ${mine ? 'you' : 'them'} until it expires. ${mine ? 'Answer on mic.' : ''}</p></section>` : ''}
                    <section><h3><i class="fa-solid fa-circle-info"></i> How it's judged</h3><ul class="arena-rules-list"><li>Every 15 s the ears read new transcript lines.</li><li>A fighter's name in a line opens a 45 s window; ≥20 words go to the beef judge.</li><li>Otherwise lines pool for the topic judge (also ≥20 words, ≥30 s apart).</li><li>Offensive language is fine. Threats, minors, doxxing → line ignored.</li></ul></section>
                </aside>
            </div>
        </div>`;
    };
    draw();
    _aEvery(1000, () => _aTickClocks(root));
    _aEvery(10000, async () => { try { const fresh = await api(`/arena/console/${encodeURIComponent(username)}`); const lvlUp = (fresh.level?.level || 1) > (c.level?.level || 1); c = fresh; draw(); if (lvlUp) _aLevelUp(c.level.level); } catch { /* */ } });
}

// ── Fighter profile ──────────────────────────────────────────

function _aVoiceCard(f) {
    const v = f.voice || {};
    const q = f.quotes;
    const color = f.user.profile_color || '#8b5cf6';
    if (!v.has_data) {
        return `<div class="arena-voice" style="--fc:${_aEsc(color)}"><div class="arena-voice-head"><h3><i class="fa-solid fa-microphone-slash"></i> On the mic</h3></div><p class="arena-voice-empty">No transcript data yet — the audio transcription picks this up on their next streams. Until then, MIC is rated at the floor and the Arena can't hear them.</p></div>`;
    }
    const quotes = (q && q.picks && q.picks.length) ? q.picks : [];
    return `<div class="arena-voice" style="--fc:${_aEsc(color)}">
        <div class="arena-voice-head">
            <h3><i class="fa-solid fa-microphone"></i> On the mic <span class="arena-power" style="margin-left:6px"><b style="font-size:1.1rem">${f.ratings.mic}</b><small>MIC</small></span></h3>
            ${q?.mic_style ? `<span class="arena-voice-style">${_aEsc(q.mic_style)}</span>` : ''}
        </div>
        ${q?.voice_verdict ? `<p class="arena-voice-verdict">${_aEsc(q.voice_verdict)}</p>` : ''}
        <div class="arena-voice-meters">
            <div class="arena-voice-meter"><b>${_aEsc(v.talk_ratio_pct)}%</b><span>of stream time talking</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(_aNum(v.speech_minutes))} min</b><span>of speech heard (90d)</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.wpm)}</b><span>words per minute</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.hype_per_hour)}</b><span>hype words / hour</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.laughs_per_hour)}</b><span>laughs / hour</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.streams_heard)}</b><span>streams transcribed</span></div>
        </div>
        ${v.top_sounds && v.top_sounds.length ? `<div class="arena-sounds"><span title="what the stream sounds like, from the audio-event detector"><i class="fa-solid fa-wave-square"></i> soundscape</span>${v.top_sounds.map(s => `<span>${_aEsc(s.label)} ×${s.n}</span>`).join('')}</div>` : ''}
        ${quotes.length ? `<div class="arena-quotes">${quotes.map(p => `
            <div class="arena-quote">
                <div><q>${_aEsc(p.text)}</q><small>${_aEsc(p.why || '')}${p.vod_id ? ` · at ${_aStamp(p.start_sec)}` : ''}</small></div>
                <div class="arena-quote-actions">${_aPlay(p.vod_id, p.start_sec)} ${_aSpeakBtn(p.text, '')}</div>
            </div>`).join('')}</div>` : '<p class="arena-voice-empty">Quotes appear once enough lines have been transcribed.</p>'}
        ${q?._fallback ? '<p class="arena-note">Quotes picked by heuristic — the AI curates these once enabled.</p>' : ''}
    </div>`;
}

function _aLevelCard(f) {
    const l = f.level || {};
    const pct = l.xp_per_level ? Math.round((l.xp_into_level / l.xp_per_level) * 100) : 0;
    return `<div class="arena-level-card">
        <div class="arena-level-head"><span class="arena-lvl arena-lvl-big">TRASH LVL ${l.level || 1}</span><span class="arena-note">${l.xp || 0} XP · ${l.recent_xp || 0} this week${f.ratings.talk_bonus ? ` · <b>+${f.ratings.talk_bonus} POWER</b> from the mouth` : ''}</span></div>
        <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${pct}%"></span></span>
        <div class="arena-level-nums"><span><b>${l.beef_hits || 0}</b><small>beef hits</small></span><span><b>${l.angles_cleared || 0}</b><small>angles cleared</small></span><span><b>${l.topics_conquered || 0}</b><small>topics conquered</small></span><span><b>${f.record.wins}–${f.record.losses}${f.record.draws ? `–${f.record.draws}` : ''}</b><small>beef record</small></span></div>
        ${l.best_line ? `<div class="arena-quote"><div><q>${_aEsc(l.best_line.text)}</q><small>best line on record · ${l.best_line.score}/10</small></div><div class="arena-quote-actions">${_aPlay(l.best_line.vod_id, l.best_line.sec)} ${_aSpeakBtn(l.best_line.text, '')}</div></div>` : ''}
    </div>`;
}

async function _aRenderFighter(root, username) {
    root.innerHTML = _aSpinner('Pulling the fighter file…');
    const f = await api(`/arena/fighters/${encodeURIComponent(username)}`);
    if (f.not_on_roster) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-user-slash"></i><p><strong>${_aEsc(f.user.display_name)}</strong> is not on the roster yet — ${_aEsc(f.reason)}.</p>${_aA('/arena', 'Back to the Arena', 'btn')}</div>`;
        return;
    }
    const p = f.persona, color = f.user.profile_color || '#8b5cf6';
    const beefs = f.beefs || [], rivalries = f.rivalries || [];
    root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')} ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> Listen in live', '') : ''}</div>
        <div class="arena-profile" style="--fc:${_aEsc(color)}">
            <div class="arena-profile-portrait" id="arena-profile-portrait">
                ${_aPortrait(f, 'lg')}
                ${f.image_pending ? '<div class="arena-portrait-pending"><i class="fa-solid fa-wand-magic-sparkles fa-fade"></i> painting portrait…</div>' : ''}
                <div class="arena-profile-rank">#${f.rank} <small>of ${f.roster_size}</small></div>
                ${f.active_topic ? `<div class="arena-mini-record"><i class="fa-solid fa-comment-dots"></i> Talking on: ${_aA(_aTopicLink(f.active_topic), _aEsc(f.active_topic.text))}</div>` : ''}
            </div>
            <div class="arena-profile-main">
                <div class="arena-profile-name">
                    <h1>${_aEsc(p.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</h1>
                    <p class="arena-title">${_aEsc(p.title)}</p>
                    <p class="arena-handle">${_aA(_aChannelLink(f.user), `${_aEsc(f.user.display_name)} · @${_aEsc(f.user.username)}`)} · ${_aEsc(p.class)} · ${_aEsc(p.element)}</p>
                </div>
                <div class="arena-profile-power">
                    <div class="arena-power arena-power-lg"><b>${f.ratings.power}</b><small>POWER</small></div>
                    ${f.ratings.talk_bonus ? `<div class="arena-talk-bonus" title="Mouth bonus — recent Trash Level XP and beef wins, decays over a week"><i class="fa-solid fa-microphone-lines"></i> +${f.ratings.talk_bonus} mouth</div>` : ''}
                    <div class="arena-record arena-record-lg" title="beef record">${f.record.wins}W – ${f.record.losses}L</div>
                </div>
                ${_aLevelCard(f)}
                <div class="arena-profile-stats">
                    ${_aRadar(f.ratings, color)}
                    <div class="arena-quips">${ARENA_STATS.map(k => `<div class="arena-quip is-clickable" data-stat="${k}" title="Tap for the breakdown"><b>${_aEsc(ARENA_STAT_LABEL[k])} ${f.ratings[k]} <i class="fa-solid fa-magnifying-glass-chart" style="font-size:0.7em;opacity:0.6"></i></b><span>${_aEsc((p.stat_quips || {})[k] || '')}</span></div>`).join('')}</div>
                    <div id="arena-stat-detail"></div>
                </div>
                <div class="arena-lore">
                    <p class="arena-lore-text">${_aEsc(p.lore)}</p>
                    <div class="arena-moves">
                        <div class="arena-move"><span class="arena-move-kind">Signature</span><b>${_aEsc(p.signature_move?.name)}</b><span>${_aEsc(p.signature_move?.description)}</span></div>
                        <div class="arena-move"><span class="arena-move-kind">Special</span><b>${_aEsc(p.special?.name)}</b><span>${_aEsc(p.special?.description)}</span></div>
                        <div class="arena-move arena-move-weak"><span class="arena-move-kind">Weakness</span><b>${_aEsc(p.weakness)}</b></div>
                    </div>
                    <div class="arena-flavor">
                        <span><i class="fa-solid fa-comment"></i> “${_aEsc(p.taunt)}” ${_aSpeakBtn(p.taunt)}</span>
                        <span><i class="fa-solid fa-music"></i> ${_aEsc(p.entrance_music)}</span>
                        <span><i class="fa-solid fa-quote-left"></i> ${_aEsc(p.catchphrase)}</span>
                    </div>
                    ${f.persona_is_fallback ? '<p class="arena-note">Stats-only profile — AI lore appears once the AI is enabled.</p>' : ''}
                </div>
                ${_aVoiceCard(f)}
                <div class="arena-numbers">
                    ${[['Hours live (90d)', f.raw.hours], ['Peak viewers', f.raw.peak_viewers], ['Avg viewers', f.raw.avg_viewers], ['Chat msgs / hr', f.raw.messages_per_hour], ['Followers', f.raw.followers], ['Clips', f.raw.clips], ['All-time hours', f.raw.all_time_hours], ['All-time peak', f.raw.all_time_peak]]
                        .map(([l, v]) => `<div class="arena-number"><b>${_aEsc(_aNum(v))}</b><span>${_aEsc(l)}</span></div>`).join('')}
                </div>
            </div>
        </div>
        ${rivalries.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-skull-crossbones"></i> Rivalries</h2><div class="arena-rivalries">${rivalries.map(r => `<div class="arena-rivalry ${r.open ? 'is-open' : ''}">${_aBriefChip(r.opponent, ` · ${r.wins}–${r.losses} in ${r.fights}${r.open ? ' · <b>beef open</b>' : ''}`)}${r.receipts.map(x => `<q class="arena-receipt-mini">${_aEsc(x.text)}</q>`).join('')}</div>`).join('')}</div></section>` : ''}
        ${beefs.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><div class="arena-beef-grid">${beefs.map(_aBeefCard).join('')}</div></section>` : `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><p class="arena-note">No beef on record. Someone only has to say their name…</p></section>`}`;
    _aBindSpeak(root);
    _aBindHome(root);
    _aEvery(1000, () => _aTickClocks(root));

    root.querySelectorAll('.arena-quip.is-clickable').forEach(el => el.addEventListener('click', async () => {
        const stat = el.dataset.stat;
        const box = document.getElementById('arena-stat-detail');
        if (box.dataset.stat === stat) { box.innerHTML = ''; box.dataset.stat = ''; return; }
        box.dataset.stat = stat;
        box.innerHTML = `<div class="arena-stat-detail">${_aSpinner('Crunching…')}</div>`;
        try {
            const d = await api(`/arena/fighters/${encodeURIComponent(username)}/stat/${stat}`);
            if (box.dataset.stat !== stat) return;
            box.innerHTML = `<div class="arena-stat-detail" style="--fc:${_aEsc(color)}">
                <div class="arena-stat-detail-head">
                    <h3>${_aEsc(d.label)} ${d.rating} <small>· #${d.position} of ${d.roster_size} · ${_aEsc(_aNum(d.value))} ${_aEsc(d.unit)}</small></h3>
                    <button class="arena-stat-detail-close" title="Close">&times;</button>
                </div>
                <p class="arena-weight">${_aEsc(d.desc)} · ${Math.round(d.weight * 100)}% of POWER · rating = your percentile across the roster</p>
                ${_aSpark(d.series, color)}
                ${d.top.length ? `<div class="arena-stat-top"><span class="arena-weight">Top of the ladder:</span>${d.top.map((t, i) => _aA(_aFighterLink(t.user), `#${i + 1} ${_aEsc(t.fighter_name)} <b>${_aEsc(_aNum(t.value))}</b>`)).join('')}</div>` : ''}
            </div>`;
            box.querySelector('.arena-stat-detail-close').addEventListener('click', () => { box.innerHTML = ''; box.dataset.stat = ''; });
        } catch (err) { box.innerHTML = `<div class="arena-stat-detail">${_aEsc(err?.message || 'Failed')}</div>`; }
    }));

    const portrait = root.querySelector('.arena-portrait-lg');
    if (portrait && f.image_url) portrait.addEventListener('click', () => _aLightbox(f));

    if (f.image_pending || (!f.image_url && f.image_generation === 'ai')) {
        let tries = 0;
        _arenaImagePoll = setInterval(async () => {
            if (++tries > 20 || currentPage !== 'arena') return _aStopTimers();
            try {
                const fresh = await api(`/arena/fighters/${encodeURIComponent(username)}?generate=0`);
                if (fresh.image_url) {
                    const holder = document.getElementById('arena-profile-portrait');
                    if (holder) {
                        const old = holder.querySelector('.arena-portrait'); if (old) old.outerHTML = _aPortrait(fresh, 'lg');
                        holder.querySelector('.arena-portrait-pending')?.remove();
                        holder.querySelector('.arena-portrait-lg')?.addEventListener('click', () => _aLightbox(fresh));
                    }
                    clearInterval(_arenaImagePoll); _arenaImagePoll = null;
                }
            } catch { /* */ }
        }, 6000);
    }
}

function _aLightbox(f) {
    const box = document.createElement('div');
    box.className = 'arena-lightbox';
    box.innerHTML = `
        <button class="arena-lightbox-close" aria-label="Close">&times;</button>
        <div class="arena-lightbox-inner">
            <img src="${_aEsc(f.image_url)}" alt="">
            <div class="arena-lightbox-text">
                <h3>${_aEsc(f.persona.fighter_name)}</h3>
                <p>${_aEsc(f.persona.title)}</p>
                <p>How this was painted: the AI wrote the persona from the stream's own data, described the <em>scene</em> of the latest thumbnail (never the person), and an image model drew a fictional character from that.${f.image_model ? ` Model: <code>${_aEsc(f.image_model)}</code>.` : ''}</p>
                ${f.image_prompt ? `<div class="arena-lightbox-prompt">${_aEsc(f.image_prompt)}</div>` : ''}
            </div>
        </div>`;
    const close = () => box.remove();
    box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('.arena-lightbox-close')) close(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    document.body.appendChild(box);
}

function _aLevelUp(level) {
    const el = document.createElement('div');
    el.className = 'arena-levelup';
    el.innerHTML = `<i class="fa-solid fa-arrow-up"></i> TRASH LEVEL ${level}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
}

window.loadArenaPage = loadArenaPage;
