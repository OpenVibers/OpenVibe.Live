/**
 * OpenVibe.Live — Arena tab (speech-driven beefs + the community shit-talking board)
 *
 * Routes (handled from app.js):
 *   /arena                     pulse · on the mic now · open beefs · the board · ladders
 *   /arena/beef/<id>           one beef: tug-of-war, clock, announcer feed, receipts, sides
 *   /arena/topic/<id>          one board subject: lore, moments (chat + on-mic with VOD links), fighters on it
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
    topic: { label: 'Subject', icon: 'fa-comment-dots' },
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

// ── Speech: hear a line in that person's OpenVibe chat voice ──
// /api/arena/voice/<user>?t=… returns the audio synthesized once in their equipped cosmetic voice (or
// their per-identity chat voice); the server caches the file and the browser caches the URL for a
// week, so a repeat click never re-synthesizes. Browser speech is only the offline fallback.
let _arenaAudio = null;
function _aStopSpeaking() {
    try { if (_arenaAudio) { _arenaAudio.pause(); _arenaAudio.src = ''; } } catch { /* */ }
    _arenaAudio = null;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* */ }
    document.querySelectorAll('.is-speaking').forEach(el => el.classList.remove('is-speaking'));
}
function _aVoiceUrl(who, text) { return `/api/arena/voice/${encodeURIComponent(who || 'announcer')}?t=${encodeURIComponent(String(text).slice(0, 240))}`; }
function _aSpeak(text, btn, who) {
    if (!text) return;
    if (btn && btn.classList.contains('is-speaking')) { _aStopSpeaking(); return; }
    _aStopSpeaking();
    if (btn) btn.classList.add('is-speaking');
    const done = () => { if (btn) btn.classList.remove('is-speaking'); if (_arenaAudio === a) _arenaAudio = null; };
    const a = new Audio(_aVoiceUrl(who, text));
    _arenaAudio = a;
    a.onended = done;
    a.onerror = () => {
        // Engine down / budget hit → browser voice so the button still does something.
        if (_arenaAudio !== a) return;
        _arenaAudio = null;
        try {
            if (!window.speechSynthesis) return done();
            const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.pitch = 0.9;
            u.onend = u.onerror = done;
            speechSynthesis.speak(u);
        } catch { done(); }
    };
    a.play().catch(() => a.onerror && a.onerror());
}
function _aSpeakBtn(text, cls = 'arena-speak', who = null) { return `<button type="button" class="${cls}" data-speak="${_aEsc(text)}" data-voice="${_aEsc(who || '')}" title="${who ? `Hear it in ${_aEsc(who)}'s chat voice` : 'Hear the announcer'}"><i class="fa-solid fa-volume-high"></i></button>`; }
function _aBindSpeak(root) {
    root.querySelectorAll('[data-speak]').forEach(btn => btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _aSpeak(btn.dataset.speak, btn, btn.dataset.voice || null); }));
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

/**
 * A fighter's radar — their AI characteristics (six stats named after their own bits, read from
 * their chat history + channel), drawn correctly: value v ∈ [0, 99] sits at radius R·v/99 on its
 * axis, rings at 33/66/99, axis lines, a value pill at each vertex. Falls back to the objective
 * seven only when the persona has no custom stats yet.
 */
function _aCustomRadar(f, color, size = 240) {
    const cs = (f.persona && Array.isArray(f.persona.custom_stats) ? f.persona.custom_stats : []).filter(x => x && x.name && Number.isFinite(Number(x.value))).slice(0, 8);
    const axes = cs.length >= 3 ? cs.map(x => ({ name: String(x.name).slice(0, 16), value: Math.max(0, Math.min(99, Number(x.value))), quip: x.quip || '' })) : ARENA_STATS.map(k => ({ name: ARENA_STAT_LABEL[k], value: Math.max(0, Math.min(99, Number(f.ratings?.[k]) || 0)), quip: (f.persona?.stat_quips || {})[k] || '' }));
    const N = axes.length, c = size / 2, R = size / 2 - 62;
    const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const pt = (i, v) => [c + (R * v / 99) * Math.cos(ang(i)), c + (R * v / 99) * Math.sin(ang(i))];
    const poly = (v) => axes.map((_, i) => pt(i, v).map(n => n.toFixed(1)).join(',')).join(' ');
    const shape = axes.map((a, i) => pt(i, a.value).map(n => n.toFixed(1)).join(',')).join(' ');
    const id = `rg${Math.floor(Math.random() * 1e6)}`;
    return `<svg class="arena-radar arena-radar-v2" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="stats radar">
        <defs><radialGradient id="${id}" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="${_aEsc(color)}" stop-opacity="0.55"/><stop offset="100%" stop-color="${_aEsc(color)}" stop-opacity="0.12"/></radialGradient></defs>
        ${[33, 66, 99].map(v => `<polygon points="${poly(v)}" class="arena-radar-ring"></polygon>`).join('')}
        ${axes.map((_, i) => { const [x, y] = pt(i, 99); return `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="arena-radar-axis"></line>`; }).join('')}
        <polygon points="${shape}" class="arena-radar-fill" style="fill:url(#${id});stroke:${_aEsc(color)}"></polygon>
        ${axes.map((a, i) => { const [x, y] = pt(i, a.value); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="arena-radar-dot" style="fill:${_aEsc(color)}"><title>${_aEsc(a.name)} ${a.value}${a.quip ? ` — ${_aEsc(a.quip)}` : ''}</title></circle>`; }).join('')}
        ${axes.map((a, i) => { const cos = Math.cos(ang(i)), sin = Math.sin(ang(i)); const lx = c + (R + 22) * cos, ly = c + (R + 22) * sin; const anchor = Math.abs(cos) < 0.25 ? 'middle' : (cos > 0 ? 'start' : 'end'); const name = a.name.length > 13 ? a.name.slice(0, 12) + '…' : a.name; return `<g class="arena-radar-label"><text x="${lx.toFixed(1)}" y="${(ly + (sin < -0.3 ? -6 : sin > 0.3 ? 2 : -4)).toFixed(1)}" text-anchor="${anchor}">${_aEsc(name)}</text><text x="${lx.toFixed(1)}" y="${(ly + (sin < -0.3 ? 7 : sin > 0.3 ? 15 : 9)).toFixed(1)}" text-anchor="${anchor}" class="arena-radar-val" style="fill:${_aEsc(color)}">${a.value}</text><title>${_aEsc(a.name)} ${a.value}${a.quip ? ` — ${_aEsc(a.quip)}` : ''}</title></g>`; }).join('')}
    </svg>`;
}
function _aCustomQuips(f) {
    const cs = (f.persona && Array.isArray(f.persona.custom_stats) ? f.persona.custom_stats : []);
    if (!cs.length) return '';
    return `<div class="arena-quips arena-quips-custom">${cs.map(x => `<div class="arena-quip"><b>${_aEsc(x.name)} ${Number(x.value)}</b><span>${_aEsc(x.quip || '')}</span></div>`).join('')}</div>`;
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
        if (first === 'chatter' && second) return await _aRenderChatter(root, decodeURIComponent(second));
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
                <p class="arena-lede">Nobody clicks "fight" here. Say a fighter's name on mic while you're talking shit and the beef opens itself. Say something the site is on about and it lands on the board as lore. Chat piles on, hypes, starts subjects and posts bounties. Nobody votes.</p>
            </div>
            <div class="arena-hero-actions">
                ${_aMe() ? `<button class="btn btn-primary" id="arena-new-topic-btn"><i class="fa-solid fa-plus"></i> Start a topic</button>` : ''}
                <span class="arena-note">${roster.ai ? '<i class="fa-solid fa-ear-listen"></i> AI ears on' : '<i class="fa-solid fa-ear-deaf"></i> AI off — keyword judging'}</span>
            </div>
        </div>
        <section class="arena-pulse" id="arena-pulse">${_aPulse(boardData.pulse, boardData)}</section>
        <section class="arena-me" id="arena-me">${_aMe() ? _aSpinner('Loading your arena…') : `<div class="arena-me-guest"><i class="fa-solid fa-user-plus"></i> <b>Sign in</b> and every line you type about a subject on the board is XP, a yap level, a card — and OpenCoins on each level-up.</div>`}</section>
        <section class="arena-live" id="arena-live">${_aRenderLive(live.live || [])}</section>
        <section class="arena-beefs" id="arena-beefs">${_aRenderBeefs(beefs)}</section>
        <section class="arena-board" id="arena-board">${_aRenderBoard(boardData)}</section>
        <section class="arena-ladders">
            <div class="arena-ladder">
                <h2><i class="fa-solid fa-fire"></i> Trash Level ladder <small>XP from beef hits, judged moments on subjects, chat hype</small></h2>
                ${_aLevelsList(boardData.levels || [])}
                ${(boardData.fighters_week || []).length ? `<div class="arena-yap-week"><span class="arena-note"><i class="fa-solid fa-crown" style="color:#f5c542"></i> this week:</span> ${boardData.fighters_week.map((f, i) => _aA(_aFighterLink(f.user), `${i === 0 ? '👑 ' : ''}${_aEsc(f.fighter_name)} <b>+${f.gained}</b>`, 'arena-tag')).join(' ')}</div>` : ''}
            </div>
            <div class="arena-ladder arena-ladder-yap" id="arena-yappers">
                ${_aYappersSection(boardData)}
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
                <li><b>The board.</b> Subjects show up on their own from what chat and streamers are saying (the AI reads global chat + live mics every few minutes). Each subject has <b>threads</b> — the angles people are actually arguing. Every chat or on-mic line that touches one becomes a <b>moment</b>; the story gets rewritten as it escalates. Nobody joins anything: the ears detect who's on what. Streamers' judged lines → XP → Trash Level; chatters' lines → yap XP. Bounties come from chat (<code>!bounty</code>).</li>
                <li><b>Start one.</b> Signed-in users can put up one subject per 24 h (per person and per connection); the AI rewrites it into a proper headline. No voting anywhere — you don't pick sides, you pile on.</li>
                <li><b>Chat.</b> <code>!hype</code> boosts your streamer · <code>!topic &lt;text&gt;</code> · <code>!bounty &lt;user&gt;</code> · <code>!beef</code> · <code>!board</code> · <code>!arena</code>.</li>
                <li><b>Language.</b> Nothing gets censored for being offensive. The only lines that don't count: real threats, anything sexual about minors, and doxxing.</li>
            </ul>
        </section>`;
    _aRenderList(roster.fighters);
    _aBindHome(root);
    if (_aMe()) _aRenderMe().catch(() => { const el = document.getElementById('arena-me'); if (el) el.innerHTML = ''; });
    document.getElementById('arena-search')?.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        _aRenderList(!q ? roster.fighters : roster.fighters.filter(f => [f.persona.fighter_name, f.user.display_name, f.user.username, f.persona.class, f.persona.element].filter(Boolean).some(s => s.toLowerCase().includes(q))));
    });
    document.getElementById('arena-new-topic-btn')?.addEventListener('click', () => _aTopicComposer());
    _aEvery(20000, async () => {
        try {
            const [b, l, bd] = await Promise.all([api('/arena/beefs'), api('/arena/live'), api('/arena/board')]);
            const beefsEl = document.getElementById('arena-beefs'), liveEl = document.getElementById('arena-live'), boardEl = document.getElementById('arena-board'), pulseEl = document.getElementById('arena-pulse'), yapEl = document.getElementById('arena-yappers');
            if (yapEl) { const prevTop = yapEl.dataset.top; yapEl.innerHTML = _aYappersSection(bd); if (prevTop && bd.yappers?.[0] && prevTop !== bd.yappers[0].key) _aFlash(yapEl, 'new #1 yapper'); yapEl.dataset.top = bd.yappers?.[0]?.key || ''; }
            if (beefsEl) beefsEl.innerHTML = _aRenderBeefs(b);
            if (liveEl) liveEl.innerHTML = _aRenderLive(l.live || []);
            if (boardEl) boardEl.innerHTML = _aRenderBoard(bd);
            if (pulseEl) pulseEl.innerHTML = _aPulse(bd.pulse, bd);
            _aBindHome(root);
        } catch { /* keep the last render */ }
    });
    _aEvery(1000, () => _aTickClocks(root));
}

async function _aRenderMe() {
    const el = document.getElementById('arena-me');
    if (!el) return;
    let me = await api('/arena/me');
    // Daily check-in: first visit of the day pays XP (+ streak). One call, idempotent.
    if (!me.checked_in) { try { const r = await api('/arena/checkin', { method: 'POST' }); if (!r.already) { _aToast(`+${r.gained} XP — daily check-in${r.streak >= 2 ? ` · ${r.streak}-day streak` : ''}${r.leveled_up ? ` · LEVEL ${r.level}!` : ''}`, 'success'); if (r.leveled_up) _aLevelUp(r.level); me = await api('/arena/me'); } } catch { /* */ } }
    const c = me.chatter, pct = c.xp_for_next ? Math.round((c.xp_into_level / c.xp_for_next) * 100) : 100;
    el.innerHTML = `<div class="arena-me-inner">
        <div class="arena-me-left">${_aYapRing(c, 56)}<div><div class="arena-me-name"><b>${_aEsc(c.name)}</b> ${me.progress ? _aTierBadge(me.progress.tier) : ''} <span class="arena-lvl">YAP ${c.level} · ${_aEsc((c.card && c.card.title) || c.title)}</span>${c.streak >= 2 ? `<span class="arena-tag arena-tag-hot arena-streak"><i class="fa-solid fa-fire"></i> ${c.streak}-day streak</span>` : ''}</div>
            <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${pct}%"></span></span>
            <small class="arena-note">${c.xp_into_level}/${c.xp_for_next} to level ${c.level + 1} · <b>+${me.xp_today} XP today</b>${me.progress?.tier?.next ? ` · ${me.progress.tier.next.xp - me.progress.xp} to ${_aEsc(me.progress.tier.next.name)}` : ''} · ${me.progress ? `${me.progress.earned}/${me.progress.total} achievements` : ''} · ${me.coins_from_arena} OpenCoins from levels</small></div></div>
        <div class="arena-me-right">
            ${me.on_clock.length ? me.on_clock.map(b => `<div class="arena-me-alert">${_aA(_aBeefLink(b), `<i class="fa-solid fa-stopwatch"></i> <b>${_aEsc((b.a.user.id === c.user?.id ? b.b : b.a).fighter_name)}</b> has words for you — answer on stream`)} ${_aClockTag(b)}</div>`).join('') : ''}
            ${me.fighter ? `<div class="arena-me-row"><i class="fa-solid fa-hand-fist"></i> Fighter #${me.fighter.rank} · PWR ${me.fighter.power} · TL ${me.fighter.level.level} · ${me.fighter.record.wins}W–${me.fighter.record.losses}L ${me.fighter.live ? _aA(_aConsoleLink(me.fighter.user), '<i class="fa-solid fa-ear-listen"></i> your ears', 'arena-tag arena-tag-hot') : ''}</div>` : ''}
            ${me.subjects.length ? `<div class="arena-me-row"><i class="fa-solid fa-comments"></i> You're in: ${me.subjects.map(s => _aA(`/arena/topic/${s.id}`, `${_aEsc(s.headline || s.text)} <b>${s.moments}</b>`, 'arena-thread')).join(' ')}</div>` : `<div class="arena-me-row arena-note"><i class="fa-solid fa-keyboard"></i> Type about ${me.hot_now.length ? me.hot_now.map(h => _aA(`/arena/topic/${h.id}`, _aEsc(h.headline), 'arena-thread')).join(' ') : 'any subject on the board'} in chat — every line that lands is XP.</div>`}
            ${me.progress ? `<div class="arena-me-row arena-me-ach">${me.progress.achievements.filter(a => !a.earned_at).slice(0, 3).map(a => `<span class="arena-ach is-locked is-mini" title="${_aEsc(a.desc)}"><span class="arena-ach-icon">${a.icon}</span><span class="arena-ach-name">${_aEsc(a.name)}</span><span class="arena-ach-hint">${_aEsc(a.desc)} · +${a.xp} XP${a.coins ? ` · +${a.coins} coins` : ''}</span></span>`).join('')}</div>` : ''}
            ${_aA(_aChatterLink(c.key), 'your page <i class="fa-solid fa-arrow-right"></i>', 'arena-subject-open')}
        </div>
    </div>`;
    _aEvery(1000, () => _aTickClocks(el));
}

function _aPulse(p, boardData) {
    const open = boardData?.open || [];
    const hot = open.filter(t => t.hot).length;
    const mentions = open.reduce((n, t) => n + (t.mentions?.total || 0), 0);
    const talking = open.reduce((n, t) => n + (t.talking_now?.length || 0), 0);
    const text = p && p.text ? p.text : (open.length ? `${open.length} subject${open.length > 1 ? 's' : ''} on the board and ${mentions} mention${mentions === 1 ? '' : 's'} so far. Nobody's said anything worth a headline yet.` : 'Dead quiet. Say something stupid on mic and watch the board fill up.');
    return `<div class="arena-pulse-inner">
        <div class="arena-pulse-icon"><i class="fa-solid fa-heart-pulse ${p && p.text ? 'fa-beat' : ''}"></i><span>PULSE</span></div>
        <div class="arena-pulse-body">
            <div class="arena-pulse-text">${_aEsc(text)}</div>
            <div class="arena-pulse-meta">
                <span class="arena-pulse-stat"><b>${open.length}</b> subjects</span>
                <span class="arena-pulse-stat ${hot ? 'is-hot' : ''}"><b>${hot}</b> hot</span>
                <span class="arena-pulse-stat"><b>${mentions}</b> mentions</span>
                <span class="arena-pulse-stat"><b>${talking}</b> on mic about it</span>
                <span class="arena-pulse-when">${p && p.at ? `read ${_aEsc(_aAgo(p.at))} from ${(p.sources || []).map(x => x === 'on_mic' ? 'live mics' : 'chat').join(' + ') || 'the site'}` : 'the AI reads chat + live mics every few minutes'}</span>
            </div>
        </div>
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
                    ${f.active_topic ? _aA(_aTopicLink(f.active_topic), `<i class="fa-solid fa-comment-dots"></i> on: ${_aEsc(f.active_topic.text)}`, 'arena-tag') : '<span class="arena-tag arena-tag-dim">no subject yet</span>'}
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
function _aBindHome(root) {
    root.querySelectorAll('.arena-hype-btn').forEach(btn => btn.onclick = (e) => { e.preventDefault(); _aHype(btn.dataset.beef, btn.dataset.side, btn); });
    root.querySelectorAll('.arena-topic-hype').forEach(btn => btn.onclick = async (e) => {
        e.preventDefault();
        try { const r = await api(`/arena/board/topics/${btn.dataset.topic}/hype`, { method: 'POST', body: { user_id: Number(btn.dataset.user) } }); _aToast(r.added ? `🔥 Hyped (${r.hypers} hyping)` : 'Already hyped', r.added ? 'success' : 'info'); btn.classList.add('is-hyped'); }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); }
    });
    _aBindSpeak(root);
}

// ── Board ────────────────────────────────────────────────────

function _aHeat(t, hotThreshold) {
    const pct = Math.min(100, Math.round((t.heat / Math.max(hotThreshold * 2, 1)) * 100));
    return `<span class="arena-heat ${t.hot ? 'is-hot' : ''}" title="heat: on-mic ×3 + chat + hype + fighters talking, last hour"><i class="fa-solid fa-fire"></i> ${t.hot ? 'HOT' : ''} ${t.heat}<span class="arena-heat-bar"><span style="width:${pct}%"></span></span></span>`;
}
function _aTopicTitle(t) {
    if (t.kind === 'bounty') return `Bounty on <b>${_aEsc(t.target?.fighter_name || '?')}</b>`;
    return _aEsc(t.text);
}
function _aMomentLine(m, { compact = false } = {}) {
    const icon = m.kind === 'chat' ? 'fa-keyboard' : 'fa-microphone';
    return `<div class="arena-moment ${m.kind === 'chat' ? 'is-chat' : 'is-mic'} ${m.quality != null ? 'is-judged' : ''}">
        <i class="fa-solid ${icon}" title="${m.kind === 'chat' ? 'said in chat' : 'said on mic'}"></i>
        <div class="arena-moment-body">
            <q>${_aEsc(m.text)}</q>
            <small><b>${_aEsc(m.username || 'anon')}</b>${m.quality != null ? ` · ${m.quality}/10` : ''}${compact ? '' : ` · ${_aEsc(_aAgo(m.at))}`} ${_aPlay(m.vod_id, m.sec)}</small>
        </div>
    </div>`;
}
function _aAvatarStack(list, max = 5) {
    return `<span class="arena-stack">${list.slice(0, max).map(f => _aA(_aFighterLink(f.user), _aPortrait(f, 'xs'), '', `${f.fighter_name}${f.live ? ' · LIVE' : ''}`)).join('')}${list.length > max ? `<span class="arena-stack-more">+${list.length - max}</span>` : ''}</span>`;
}
function _aMentionChips(t) {
    return `<span class="arena-chips">
        <span class="arena-chip-stat" title="chat lines about it"><i class="fa-solid fa-keyboard"></i> ${t.mentions.chat}</span>
        <span class="arena-chip-stat" title="on-mic moments"><i class="fa-solid fa-microphone"></i> ${t.mentions.mic}</span>
        <span class="arena-chip-stat" title="chatters involved"><i class="fa-solid fa-users"></i> ${t.chatters}</span>
        ${t.talking_now.length ? `<span class="arena-chip-stat is-live" title="fighters on it right now"><span class="arena-live-dot arena-live-dot-sm"></span> ${t.talking_now.length} on mic</span>` : ''}
    </span>`;
}
function _aThreadChips(t, { max = 4, link = true } = {}) {
    const th = (t.threads || []).slice(0, max);
    if (!th.length) return '';
    return `<div class="arena-threads">${th.map(x => link ? _aA(`${_aTopicLink(t)}#thread-${x.id}`, `<span class="arena-thread"><i class="fa-solid fa-angle-right"></i> ${_aEsc(x.name)}${x.moments ? ` <b>${x.moments}</b>` : ''}</span>`) : `<span class="arena-thread"><i class="fa-solid fa-angle-right"></i> ${_aEsc(x.name)}${x.moments ? ` <b>${x.moments}</b>` : ''}</span>`).join('')}${(t.threads || []).length > max ? `<span class="arena-thread is-more">+${t.threads.length - max}</span>` : ''}</div>`;
}
function _aSubjectCard(t, hot, { featured = false } = {}) {
    const k = ARENA_KIND[t.kind] || ARENA_KIND.topic;
    return `<div class="arena-subject ${featured ? 'is-featured' : ''} ${t.hot ? 'is-hot' : ''} arena-topic-${t.kind}" data-topic="${t.id}">
        <div class="arena-subject-head">
            ${_aHeat(t, hot)}
            <span class="arena-topic-by">${t.kind === 'bounty' ? '<i class="fa-solid fa-sack-dollar"></i> bounty · ' : ''}${t.created_by === 'community' ? `<i class="fa-solid fa-satellite-dish"></i> ${_aEsc(t.source_note || 'the site')}` : `<i class="fa-solid fa-user"></i> ${_aEsc(t.creator_name || t.created_by)}`} · ${_aEsc(_aAgo(t.last_mention_at || t.created_at))}</span>
        </div>
        ${_aA(_aTopicLink(t), `<h3 class="arena-subject-headline">${_aEsc(t.headline || t.text)}</h3>`, 'arena-topic-link')}
        <div class="arena-subject-sub"><b>${_aTopicTitle(t)}</b>${t.tagline ? ` — ${_aEsc(t.tagline)}` : ''}</div>
        ${_aThreadChips(t)}
        ${t.last_moment ? `<q class="arena-subject-last"><i class="fa-solid ${t.last_moment.kind === 'chat' ? 'fa-keyboard' : 'fa-microphone'}"></i> <b>${_aEsc(t.last_moment.username || 'anon')}</b>: ${_aEsc(t.last_moment.text)}</q>` : `<span class="arena-note">${_aEsc(t.hint || 'nobody has said anything yet')}</span>`}
        <div class="arena-subject-foot">
            ${_aMentionChips(t)}
            ${t.fighters.length ? _aAvatarStack(t.fighters, 4) : ''}
            ${_aA(_aTopicLink(t), 'open <i class="fa-solid fa-arrow-right"></i>', 'arena-subject-open')}
        </div>
    </div>`;
}
function _aRenderBoard(bd) {
    const me = _aMe();
    const open = bd.open || [], archive = bd.archive || [];
    return `<div class="arena-board-head">
            <h2><i class="fa-solid fa-comments"></i> The board <small>what the site is on about · ${open.length} subject${open.length === 1 ? '' : 's'} · say one on mic or type it in chat and it counts</small></h2>
            ${me ? `<button class="btn btn-ghost btn-sm" id="arena-board-new"><i class="fa-solid fa-plus"></i> Start a subject</button>` : '<span class="arena-note">sign in to start one (or <code>!topic</code> in any chat)</span>'}
        </div>
        ${open.length ? `<div class="arena-subject-grid">${open.map((t, i) => _aSubjectCard(t, bd.hot_threshold || 12, { featured: i === 0 })).join('')}</div>` : '<p class="arena-note">Empty for now — the AI reads chat and live mics every few minutes; the moment people are on about something, it shows up here.</p>'}
        ${archive.length ? `<details class="arena-done"><summary>Cooled off <small>${archive.length}</small></summary><div class="arena-topic-feed is-archive">${archive.map(t => `<div class="arena-topic-row is-archived">
            <div class="arena-topic-row-main">${_aA(_aTopicLink(t), `<strong>${_aEsc(t.headline || t.text)}</strong>`, 'arena-topic-link')}<div class="arena-topic-row-sub">${_aTopicTitle(t)} · ${t.mentions.total} mentions · ${_aEsc(_aAgo(t.last_activity_at))}${t.resolved?.headline ? ` · ${_aEsc(t.resolved.headline)}` : ''}</div></div>
        </div>`).join('')}</div></details>` : ''}`;
}
function _aTopicComposer() {
    const box = document.createElement('div');
    box.className = 'arena-lightbox';
    box.innerHTML = `<button class="arena-lightbox-close" aria-label="Close">&times;</button>
        <div class="arena-lightbox-inner arena-composer">
            <h3><i class="fa-solid fa-comment-dots"></i> Start a subject</h3>
            <p class="arena-note">What should the site be arguing about? Type the dumb version — the AI rewrites it into a headline, works out the words people use for it and pulls in everything already said about it. One per 24 h.</p>
            <textarea id="arena-composer-text" maxlength="140" rows="3" placeholder="e.g. goosely's tent, people who say 'bud', the cat enema thing"></textarea>
            <div class="arena-composer-actions"><button class="btn btn-primary" id="arena-composer-go">Put it up</button></div>
        </div>`;
    const close = () => box.remove();
    box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('.arena-lightbox-close')) close(); });
    box.querySelector('#arena-composer-go').addEventListener('click', async () => {
        const text = box.querySelector('#arena-composer-text').value.trim();
        if (!text) return;
        const btn = box.querySelector('#arena-composer-go'); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Cooking…';
        try { const r = await api('/arena/board/topics', { method: 'POST', body: { text } }); close(); _aToast(r.folded ? `📌 Already a thing — folded into “${r.topic.headline || r.topic.text}” as a thread` : `📌 On the board: ${r.topic.headline || r.topic.text}`, 'success'); navigate(`/arena/topic/${r.topic.id}`); }
        catch (err) { _aToast(err?.message || 'Failed', 'error'); btn.disabled = false; btn.textContent = 'Put it up'; }
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
        ${_aA(_aFighterLink(r.user), `${_aPortrait(r, 'xs')}<span><strong>${_aEsc(r.fighter_name)}</strong><small>${r.xp} XP · ${r.beef_hits} beef hits · ${r.topic_moments} moments · ${r.topics_joined} subjects</small></span>`, 'arena-chip')}
        <span class="arena-lvl arena-lvl-big">LVL ${r.level}</span>
    </div>`).join('')}</div>`;
}
function _aChatterLink(key) { return `/arena/chatter/${encodeURIComponent(key)}`; }
function _aYapRing(y, size = 44) {
    const pct = y.xp_for_next ? Math.max(0.04, Math.min(1, y.xp_into_level / y.xp_for_next)) : 1;
    const r = (size / 2) - 3, c = 2 * Math.PI * r;
    const color = y.user?.profile_color || (y.kind === 'relay' ? '#60a5fa' : y.kind === 'anon' ? '#9ca3af' : '#f97316');
    return `<span class="arena-yap-ring" style="--yc:${_aEsc(color)};width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="arena-yap-ring-bg"></circle><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="arena-yap-ring-fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}"></circle></svg><b>${y.level}</b></span>`;
}
function _aYapKind(y) { return y.kind === 'relay' ? `<span class="arena-tag arena-tag-dim" title="relayed from ${_aEsc(y.platform || 'another platform')}"><i class="fa-solid fa-satellite-dish"></i> ${_aEsc(y.platform || 'relay')}</span>` : y.kind === 'anon' ? '<span class="arena-tag arena-tag-dim" title="anonymous viewer"><i class="fa-solid fa-user-secret"></i> anon</span>' : ''; }
function _aYapCard(y, i) {
    const card = y.card || {};
    return `<div class="arena-yap-card ${i === 0 ? 'is-top' : ''}" style="--yc:${_aEsc(y.user?.profile_color || '#f97316')}">
        <div class="arena-yap-rank">${i + 1}</div>
        ${_aYapRing(y, i === 0 ? 64 : 52)}
        <div class="arena-yap-main">
            <div class="arena-yap-name">${_aA(_aChatterLink(y.key), `<strong>${_aEsc(y.name)}</strong>`)} ${_aYapKind(y)} ${y.streak >= 2 ? `<span class="arena-tag arena-tag-hot arena-streak" title="days in a row"><i class="fa-solid fa-fire"></i> ${y.streak}</span>` : ''}</div>
            <div class="arena-yap-title">${_aEsc(card.title || y.title)} <small>· ${card.title ? `${_aEsc(y.title)} · ` : ''}${y.xp} XP</small></div>
            ${card.blurb ? `<p class="arena-yap-blurb">${_aEsc(card.blurb)}</p>` : (y.best_line ? `<q class="arena-yap-line">${_aEsc(y.best_line.text)}</q>` : '')}
            <div class="arena-yap-stats"><span><b>${y.moments}</b> moments</span><span><b>${y.subjects}</b> subjects</span>${y.quoted ? `<span><b>${y.quoted}</b> quoted in lore</span>` : ''}${y.gained != null ? `<span><b>+${y.gained}</b> this week</span>` : ''}</div>
        </div>
    </div>`;
}
function _aYappersSection(bd) {
    const rows = bd.yappers || [], week = bd.yappers_week || [];
    return `<h2><i class="fa-solid fa-keyboard"></i> Yappers <small>${bd.yappers_total || rows.length} chatters with a yap level · accounts, anons and relayed chatters alike</small></h2>
        ${rows.length ? `<div class="arena-yap-podium">${rows.slice(0, 3).map(_aYapCard).join('')}</div>
        ${rows.length > 3 ? `<div class="arena-mini-list">${rows.slice(3).map((y, i) => `<div class="arena-mini-row arena-yap-row">
            <span class="arena-rank">${i + 4}</span>
            ${_aYapRing(y, 34)}
            <span class="arena-chip"><span><strong>${_aA(_aChatterLink(y.key), _aEsc(y.name))} ${_aYapKind(y)}</strong><small>${_aEsc((y.card && y.card.title) || y.title)} · lvl ${y.level} · ${y.moments} moment${y.moments === 1 ? '' : 's'} on ${y.subjects} subject${y.subjects === 1 ? '' : 's'}${y.streak >= 2 ? ` · 🔥 ${y.streak}` : ''}</small></span></span>
            <span class="arena-lvl">${y.xp} XP</span>
        </div>`).join('')}</div>` : ''}
        ${week.length ? `<div class="arena-yap-week"><span class="arena-note"><i class="fa-solid fa-bolt"></i> hottest this week:</span> ${week.slice(0, 5).map(y => _aA(_aChatterLink(y.key), `${_aEsc(y.name)} <b>+${y.gained}</b>`, 'arena-tag')).join(' ')}</div>` : ''}` : '<p class="arena-note">Type about a subject on the board in any chat — your lines become moments, you get XP, a yap level and a card. Anons and relayed chatters too; OpenVibe accounts also get OpenCoins on every level-up.</p>'}`;
}
function _aFlash(el, text) {
    const f = document.createElement('div'); f.className = 'arena-flash'; f.textContent = text; el.prepend(f); setTimeout(() => f.remove(), 2200);
}

// ── Chatter (yapper) page ────────────────────────────────────
async function _aRenderChatter(root, key) {
    root.innerHTML = _aSpinner('Pulling the yap sheet…');
    let y;
    try { y = await api(`/arena/chatter/${encodeURIComponent(key)}`); } catch (err) { root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-user-secret"></i><p>${_aEsc(err?.message || 'No yap profile yet')}</p>${_aA('/arena', 'Back to the Arena', 'btn')}</div>`; return; }
    const card = y.card || {};
    const next = y.titles.find(t => t.level > y.level);
    root.innerHTML = `
    <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')} ${y.user ? _aA(_aChannelLink(y.user), `<i class="fa-solid fa-user"></i> @${_aEsc(y.user.username)}`) : ''}</div>
    <div class="arena-yap-page" style="--yc:${_aEsc(y.user?.profile_color || '#f97316')}">
        <div class="arena-yap-hero">
            ${_aYapRing(y, 96)}
            <div class="arena-yap-hero-main">
                <h1>${_aEsc(y.name)} ${_aYapKind(y)}</h1>
                <div class="arena-yap-hero-title"><span class="arena-lvl arena-lvl-big">YAP LVL ${y.level} · ${_aEsc(y.title)}</span>${card.title ? `<span class="arena-yap-card-title">“${_aEsc(card.title)}”</span>` : ''}${card.archetype ? `<span class="arena-tag">${_aEsc(card.archetype)}</span>` : ''}</div>
                <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${y.xp_for_next ? Math.round((y.xp_into_level / y.xp_for_next) * 100) : 100}%"></span></span>
                <small class="arena-note">${y.xp} XP · ${y.xp_into_level}/${y.xp_for_next} to level ${y.level + 1}${next ? ` · next title <b>${_aEsc(next.title)}</b> at level ${next.level}` : ''} · rank #${y.rank}${y.coins ? ' · OpenCoins on every level-up' : ' · sign in to bank OpenCoins for your levels'}</small>
                <div class="arena-yap-stats"><span><b>${y.moments}</b> moments</span><span><b>${y.subjects}</b> subjects</span><span><b>${y.subjects_started}</b> started</span><span><b>${y.quoted}</b> quoted in lore</span><span><b>${y.hypes}</b> hypes</span><span><b>${y.streak}</b> day streak <small>(best ${y.best_streak})</small></span></div>
            </div>
        </div>
        ${_aProgressPanel(y.progress)}
        ${card.blurb ? `<section class="arena-yap-cardbox"><h3><i class="fa-solid fa-id-badge"></i> Yap card <small>AI-written from their chat history${y.card_at ? ` · ${_aEsc(_aAgo(y.card_at))}` : ''}</small></h3><p>${_aEsc(card.blurb)}</p>${card.catchphrase ? `<q class="arena-yap-line">${_aEsc(card.catchphrase)}</q>` : ''}${card.known_for?.length ? `<div class="arena-keywords"><span class="arena-note">known for:</span>${card.known_for.map(k => `<span>${_aEsc(k)}</span>`).join('')}</div>` : ''}</section>` : `<p class="arena-note">The AI writes a yap card at level ${3}+ from their chat history — keep yapping.</p>`}
        ${y.chat_ai?.overview ? `<section class="arena-yap-cardbox"><h3><i class="fa-solid fa-brain"></i> What the chat AI has on them</h3><p>${_aEsc(y.chat_ai.overview)}</p></section>` : ''}
        <div class="arena-topic-cols">
            <section class="arena-moments"><h3><i class="fa-solid fa-stream"></i> Their moments <small>${y.recent_moments.length}</small></h3>${y.recent_moments.length ? `<div class="arena-moment-list">${y.recent_moments.map(m => `<div class="arena-moment is-chat"><i class="fa-solid fa-keyboard"></i><div class="arena-moment-body"><q>${_aEsc(m.text)}</q><small>on ${_aA(`/arena/topic/${m.topic_id}`, _aEsc(m.subject_headline || m.subject))} · ${_aEsc(_aAgo(m.at))}</small></div></div>`).join('')}</div>` : '<p class="arena-note">Nothing yet.</p>'}</section>
            <aside class="arena-topic-aside">
                <section><h3><i class="fa-solid fa-comments"></i> Subjects they pile on</h3>${y.top_subjects.length ? `<div class="arena-mini-list">${y.top_subjects.map((t, i) => `<div class="arena-mini-row"><span class="arena-rank">${i + 1}</span><span class="arena-chip"><span><strong>${_aA(`/arena/topic/${t.id}`, _aEsc(t.headline || t.text))}</strong><small>${_aEsc(t.status)}</small></span></span><span class="arena-lvl">${t.moments}</span></div>`).join('')}</div>` : '<p class="arena-note">None yet.</p>'}</section>
                <section><h3><i class="fa-solid fa-ranking-star"></i> Titles</h3><div class="arena-mini-list">${y.titles.map(t => `<div class="arena-mini-row ${t.level <= y.level ? 'is-earned' : ''}"><span class="arena-rank">${t.level}</span><span class="arena-chip"><span><strong>${_aEsc(t.title)}</strong><small>${t.xp} XP</small></span></span><span>${t.level <= y.level ? '<i class="fa-solid fa-check" style="color:#4ade80"></i>' : ''}</span></div>`).join('')}</div></section>
                <section><h3><i class="fa-solid fa-coins"></i> How XP works</h3><ul class="arena-rules-list"><li>A chat line that lands on a subject: +3 (+6 when it's HOT), +4 the first time you touch a subject.</li><li>Starting a subject: +15. Getting quoted in a subject's lore: +10. Hyping: +1.</li><li>Show up daily: +5 × streak (up to 7).</li><li>Level = 1 + √(XP ÷ 25). OpenVibe accounts bank <b>level × 10 OpenCoins</b> on every level-up; anons and relayed chatters keep the level and the title.</li></ul></section>
            </aside>
        </div>
    </div>`;
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
                <strong>${_aEsc(f.persona.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''} ${_aTierBadge(f.tier)} ${_aLevelPill(f.level?.level)}<i class="fa-solid fa-chevron-right arena-chevron"></i></strong>
                <span class="arena-row-sub">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · ${_aEsc(f.persona.element)}${f.voice?.has_data ? ` · <i class="fa-solid fa-microphone" title="has transcript data"></i> Mic ${f.ratings.mic}` : ''}</span>
                <em class="arena-row-taunt">“${_aEsc(f.persona.taunt)}”</em>
            </span>
            <span class="arena-row-stats">
                <span class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></span>
                <span class="arena-record" title="beef record">${f.record.wins}W–${f.record.losses}L</span>
            </span>
            <div class="arena-row-expand">
                <div>${_aCustomRadar(f, f.user.profile_color || '#8b5cf6', 220)}<div class="arena-mini-record">${(f.persona.custom_stats || []).length ? 'AI characteristics · ' : ''}${f.category ? _aEsc(f.category) + ' · ' : ''}last live ${_aEsc(f.last_live_at ? _aDate(f.last_live_at) : '—')}</div></div>
                <div>
                    <p class="arena-row-lore is-clamp">${_aEsc(f.persona.lore)}</p>
                    ${(f.persona.taunts || []).length ? `<div class="arena-row-taunts">${f.persona.taunts.slice(0, 2).map(t => `<em>“${_aEsc(t)}” ${_aSpeakBtn(t, '', f.user.username)}</em>`).join('')}${f.persona.typing_style ? `<small><i class="fa-solid fa-keyboard"></i> ${_aEsc(f.persona.typing_style)}</small>` : ''}</div>` : ''}
                    ${(f.persona.custom_stats || []).length ? _aCustomQuips(f) : `<div class="arena-quips">${ARENA_STATS.map(k => `<div class="arena-quip"><b>${_aEsc(ARENA_STAT_LABEL[k])} ${f.ratings[k]}</b><span>${_aEsc((f.persona.stat_quips || {})[k] || '')}</span></div>`).join('')}</div>`}
                    ${f.persona.signature_move ? `<div class="arena-mini-record"><b>Signature:</b> ${_aEsc(f.persona.signature_move.name)} — ${_aEsc(f.persona.signature_move.description)}</div>` : ''}
                </div>
                <div class="arena-row-expand-actions">
                    ${_aA(_aFighterLink(f.user), '<i class="fa-solid fa-id-card"></i> Full profile', 'btn btn-primary')}
                    ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> Listen in', 'btn btn-ghost') : ''}
                    ${_aSpeakBtn(f.persona.taunt, 'btn btn-ghost', f.user.username)}
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
            <small>${sys ? _aEsc(e.kind) : `${_aEsc(side.fighter_name)}${e.quality != null ? ` · ${e.quality}/10` : ''}${e.about ? ` · ${_aEsc(e.about)}` : ''}${e.bonus ? ` · ${_aEsc(e.bonus)}` : ''}`} · ${_aEsc(_aAgo(e.at))} ${_aPlay(e.vod_id, e.sec)} ${e.text ? _aSpeakBtn(e.text, '', side.user.username) : ''}</small>
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
                    ${open ? `<div class="arena-beef-tape-actions"><button class="btn btn-primary btn-sm arena-hype-btn" data-beef="${b.id}" data-side="${s}"><i class="fa-solid fa-fire"></i> Hype ${_aEsc(f.fighter_name.split(' ')[0])}</button></div>` : ''}
                    ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> listen in', 'arena-tag') : ''}
                </div>`; }).join('')}
            </div>
            ${_aTug(b, { big: true })}
            <div class="arena-beef-status">
                ${open ? _aClockTag(b) : ''}
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
                        <li>Total = hit quality (AI-judged 1–10) + crowd hype (max ${b.rules.crowd_max}). No voting — hype is the only thing chat adds.</li>
                        <li>Beat someone ranked 4+ spots above you → <b>upset</b>. Same two again → <b>rematch</b> (+ rivalry receipts).</li>
                    </ul></section>
                </aside>
            </div>
        </div>`;
        root.querySelectorAll('.arena-hype-btn').forEach(btn => btn.onclick = () => _aHype(b.id, btn.dataset.side, btn));
        _aBindSpeak(root);
    };
    draw();
    _aEvery(1000, () => _aTickClocks(root));
    if (open) _aEvery(12000, async () => { try { const fresh = await api(`/arena/beefs/${id}`); if (JSON.stringify(fresh.feed) !== JSON.stringify(b.feed) || fresh.status !== b.status || fresh.share_a !== b.share_a) { Object.assign(b, fresh); draw(); } } catch { /* */ } });
}

// ── Topic detail ─────────────────────────────────────────────

async function _aRenderTopic(root, id) {
    root.innerHTML = _aSpinner('Opening the subject…');
    let t = await api(`/arena/board/topics/${id}`);
    const me = _aMe();
    let thread = (location.hash.match(/#thread-(\d+)/) || [])[1] ? Number((location.hash.match(/#thread-(\d+)/) || [])[1]) : 0;
    const draw = () => {
        const k = ARENA_KIND[t.kind] || ARENA_KIND.topic;
        const moments = (t.moments || []).filter(m => !thread || m.thread_id === thread);
        const cur = (t.threads || []).find(x => x.id === thread);
        root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')}</div>
        <div class="arena-topic-page arena-topic-${t.kind} ${t.hot ? 'is-hot' : ''} ${t.status !== 'open' ? 'is-archived' : ''}">
            <div class="arena-topic-head">
                <span class="arena-kind"><i class="fa-solid ${k.icon}"></i> ${k.label}${t.status !== 'open' ? ` · ${_aEsc(t.status)}` : ''}</span>
                ${t.status === 'open' ? _aHeat(t, 12) : ''}
                <span class="arena-topic-by">${t.created_by === 'community' ? `<i class="fa-solid fa-satellite-dish"></i> ${_aEsc(t.source_note || 'the site')}` : `started by ${_aEsc(t.creator_name || t.created_by)}`} · ${_aEsc(_aAgo(t.created_at))}${t.expires_at && t.status === 'open' ? ` · <span class="arena-expires" data-until="${_aEsc(t.expires_at)}">${_aEsc(_aClock((Date.parse(t.expires_at) - Date.now()) / 1000))} left</span>` : ''}</span>
            </div>
            <h1 class="arena-topic-headline-big">${_aEsc(t.headline || t.text)} ${_aSpeakBtn(t.headline || t.text, '')}</h1>
            <div class="arena-subject-sub"><b>${_aTopicTitle(t)}</b>${t.tagline ? ` — ${_aEsc(t.tagline)}` : ''}</div>
            ${t.submitted_text && t.submitted_text.toLowerCase() !== t.text.toLowerCase() ? `<p class="arena-note">as typed by ${_aEsc(t.creator_name || 'someone')}: “${_aEsc(t.submitted_text)}”</p>` : ''}
            ${t.resolved?.headline ? `<div class="arena-topic-result"><i class="fa-solid fa-flag-checkered"></i> ${_aEsc(t.resolved.headline)}</div>` : ''}
            ${t.kind === 'bounty' && t.target ? `<div class="arena-bounty-target">${_aBriefChip(t.target, ' · the mark')}<span class="arena-note">Any fighter who lands judged shit talk on ${_aEsc(t.target.fighter_name)} while this is open gets <b>double XP</b>.</span></div>` : ''}
            <div class="arena-strip">
                ${_aMentionChips(t)}
                ${t.fighters.length ? `<span class="arena-strip-people">${_aAvatarStack(t.fighters, 6)} <small>${t.fighters.length} fighter${t.fighters.length === 1 ? '' : 's'} heard on it</small></span>` : '<small class="arena-note">no fighter has said it on mic yet — the ears auto-detect it the moment one does</small>'}
            </div>
            ${t.lore ? `<section class="arena-story"><h3><i class="fa-solid fa-book-skull"></i> Story so far <small>${t.lore_updated_at ? _aEsc(_aAgo(t.lore_updated_at)) : ''}</small></h3><p class="arena-lore-p">${_aEsc(t.lore)}</p></section>` : ''}
            <div class="arena-tabs">
                <button class="arena-tab ${!thread ? 'is-on' : ''}" data-thread="0">All <b>${(t.moments || []).length}</b></button>
                ${(t.threads || []).map(x => `<button class="arena-tab ${thread === x.id ? 'is-on' : ''}" data-thread="${x.id}" id="thread-${x.id}" title="${_aEsc(x.hint || '')}">${_aEsc(x.name)} <b>${x.moments}</b></button>`).join('')}
            </div>
            ${cur && cur.hint ? `<p class="arena-note arena-tab-hint"><i class="fa-solid fa-angle-right"></i> ${_aEsc(cur.hint)}</p>` : ''}
            <div class="arena-topic-cols">
                <section class="arena-moments">
                    <h3><i class="fa-solid fa-stream"></i> ${cur ? _aEsc(cur.name) : 'Moments'} <small>${moments.length} · chat and on-mic, newest first</small></h3>
                    ${moments.length ? `<div class="arena-moment-list">${moments.map(m => _aMomentLine(m)).join('')}</div>` : '<p class="arena-note">Nothing on this thread yet.</p>'}
                </section>
                <aside class="arena-topic-aside">
                    ${t.fighters.length ? `<section><h3><i class="fa-solid fa-microphone-lines"></i> Heard on mic</h3>${t.fighters.map(f => `<div class="arena-member ${f.active ? 'is-active' : ''}">${_aBriefChip(f, ` · ${f.moments} on-mic${f.score ? ` · ${f.score} pts` : ''}`)}${f.best ? `<q class="arena-receipt-mini">${_aEsc(f.best.text)}</q>` : ''}${me && f.user.id !== me.id && t.status === 'open' ? `<button class="btn btn-ghost btn-sm arena-topic-hype" data-topic="${t.id}" data-user="${f.user.id}"><i class="fa-solid fa-fire"></i> Hype</button>` : ''}</div>`).join('')}</section>` : ''}
                    <section><h3><i class="fa-solid fa-keyboard"></i> Loudest in chat</h3>${t.top_chatters?.length ? `<div class="arena-mini-list">${t.top_chatters.map((c, i) => `<div class="arena-mini-row"><span class="arena-rank">${i + 1}</span><span class="arena-chip"><span><strong>${c.chatter_key ? _aA(_aChatterLink(c.chatter_key), _aEsc(c.username)) : _aEsc(c.username)}</strong>${c.level ? `<small>yap ${c.level} · ${_aEsc(c.title)}</small>` : ''}</span></span><span class="arena-lvl">${c.n}</span></div>`).join('')}</div>` : '<p class="arena-note">Nobody yet. Type about it in any chat.</p>'}</section>
                    ${t.best_lines?.length ? `<section><h3><i class="fa-solid fa-quote-left"></i> Best on mic</h3>${t.best_lines.map(l => `<div class="arena-quote"><div><q>${_aEsc(l.text)}</q><small>${_aEsc(l.username || 'anon')} · ${l.quality}/10</small></div><div class="arena-quote-actions">${_aPlay(l.vod_id, l.sec)} ${_aSpeakBtn(l.text, '', l.username)}</div></div>`).join('')}</section>` : ''}
                    <section><h3><i class="fa-solid fa-circle-info"></i> How it works</h3><ul class="arena-rules-list"><li>Say it on mic or type it in chat — it lands here on its own. No joining.</li><li>Threads are the angles inside the subject; new ones appear as the argument moves.</li><li>Chat lines = yap XP · on-mic lines are judged for streamer XP.</li></ul></section>
                </aside>
            </div>
        </div>`;
        root.querySelectorAll('.arena-tab').forEach(b => b.onclick = () => { thread = Number(b.dataset.thread) || 0; draw(); });
        _aBindHome(root);
    };
    draw();
    _aEvery(15000, async () => { try { const fresh = await api(`/arena/board/topics/${id}`); if (JSON.stringify(fresh) !== JSON.stringify(t)) { t = fresh; draw(); } } catch { /* */ } });
}

// ── Live console ("the ears") ────────────────────────────────

function f0(c) { return c?.fighter?.user?.id; }
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
                    ${L.focus ? `<div class="arena-focus"><i class="fa-solid fa-crosshairs fa-beat"></i> <b>Locked on ${_aEsc(L.focus.target || 'a fighter')}</b> <small>${_aEsc(L.focus.how)} name-drop · ${L.focus.hits} hit${L.focus.hits === 1 ? '' : 's'} · ${L.focus.pending_words} words waiting for the judge · lock <span class="arena-clock" data-until="${new Date(Date.now() + L.focus.lock_seconds_left * 1000).toISOString()}" data-who="the lock"><b>${_aClock(L.focus.lock_seconds_left)}</b></span></small>${L.focus.context ? `<div class="arena-focus-ctx">so far: ${_aEsc(L.focus.context)}</div>` : ''}<p class="arena-note">Everything said now goes to the beef judge as a continuation — no need to say the name again. Two chunks about something else and the ears let go.</p></div>` : ''}
                    <div class="arena-mic-feed">${c.hot_mic?.length ? c.hot_mic.map(l => `<div class="arena-mic-line-row"><span class="arena-mic-time">${_aStamp(l.sec)}</span><span>${_aEsc(l.text)}</span>${_aPlay(l.vod_id, l.sec)}</div>`).join('') : '<p class="arena-note">Nothing heard yet.</p>'}</div>
                    ${L.last_beef_judgement ? `<div class="arena-judgement ${L.last_beef_judgement.aimed_at_target ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Beef judge (${_aEsc(_aAgo(L.last_beef_judgement.at))}):</b> ${L.last_beef_judgement.aimed_at_target ? `HIT${L.last_beef_judgement.named === false ? ' (continuation, name not said)' : ''} · ${L.last_beef_judgement.quality}/10 · ${_aEsc(L.last_beef_judgement.about || '')}${L.last_beef_judgement.opened ? ' · <b>beef opened</b>' : ''}${L.last_beef_judgement.bounty ? ' · <b>bounty collected</b>' : ''}` : L.last_beef_judgement.about_target ? `still about them, not shit talk — ${_aEsc(L.last_beef_judgement.about || '')}` : `moved on — ${_aEsc(L.last_beef_judgement.about || 'not about them')}`}${L.last_beef_judgement.flagged ? ' · <span class="arena-tag arena-tag-dim">line not counted (threat/minor/dox)</span>' : ''}</div>` : ''}
                    ${L.last_topic_judgement ? `<div class="arena-judgement ${L.last_topic_judgement.applied ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Subject judge (${_aEsc(_aAgo(L.last_topic_judgement.at))}) · ${_aEsc(L.last_topic_judgement.topic || '')}:</b> ${L.last_topic_judgement.applied ? `MOMENT · ${L.last_topic_judgement.quality}/10 · +${L.last_topic_judgement.xp} XP · ${_aEsc(L.last_topic_judgement.about || '')}` : `not about it — ${_aEsc(L.last_topic_judgement.about || 'say the subject')}`}</div>` : ''}
                </section>
                <aside class="arena-console-aside">
                    <section>
                        <h3><i class="fa-solid fa-comment-dots"></i> Active topic</h3>
                        ${c.active_topic ? `${_aA(_aTopicLink(c.active_topic), `<b>${_aEsc(c.active_topic.headline || c.active_topic.text)}</b>`)}
                            <p class="arena-lore-p is-clamp">${_aEsc(c.active_topic.lore || c.active_topic.tagline || c.active_topic.hint || '')}</p>
                            ${c.active_topic.keywords?.length ? `<div class="arena-keywords">${c.active_topic.keywords.slice(0, 6).map(k => `<span>${_aEsc(k)}</span>`).join('')}</div>` : ''}
                            <small class="arena-note">${(c.active_topic.fighters || []).find(f => f.user.id === f0(c))?.moments || 0} of your on-mic moments on it</small>` : `<p class="arena-note">${mine ? 'Nothing detected yet — say any board subject on mic and the ears file it here.' : 'Not heard on a board subject yet.'}</p>${mine ? _aA('/arena', 'See the board', 'btn btn-ghost btn-sm') : ''}`}
                    </section>
                    <section>
                        <h3><i class="fa-solid fa-fire-flame-curved"></i> Open beefs</h3>
                        ${c.open_beefs?.length ? c.open_beefs.map(b => `<div class="arena-console-beef">${_aA(_aBeefLink(b), `<b>${_aEsc(b.headline || `${b.a.fighter_name} vs ${b.b.fighter_name}`)}</b>`)}${_aTug(b)}${_aClockTag(b)}</div>`).join('') : `<p class="arena-note">None. ${mine ? 'Say another fighter\'s name while talking shit and one opens.' : ''}</p>`}
                    </section>
                    ${c.bounty_on_me ? `<section><h3><i class="fa-solid fa-sack-dollar"></i> Bounty on ${_aEsc(f.fighter_name)}</h3>${_aA(_aTopicLink(c.bounty_on_me), _aEsc(c.bounty_on_me.headline || c.bounty_on_me.text))}<p class="arena-note">Everyone gets double XP for talking shit about ${mine ? 'you' : 'them'} until it expires. ${mine ? 'Answer on mic.' : ''}</p></section>` : ''}
                    <section><h3><i class="fa-solid fa-circle-info"></i> How it's judged</h3><ul class="arena-rules-list"><li>Every 15 s the ears read new transcript lines.</li><li>A fighter's name (however the transcriber spells it — split, glued, misheard) locks the ears on them; ≥20 words go to the beef judge, and everything after counts as a continuation until they move on.</li><li>Saying a board subject's keywords adds a moment on it and auto-joins you; ≥20 words about it go to the subject judge (≥30 s apart).</li><li>Offensive language is fine. Threats, minors, doxxing → line ignored.</li></ul></section>
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
                <div class="arena-quote-actions">${_aPlay(p.vod_id, p.start_sec)} ${_aSpeakBtn(p.text, '', f.user.username)}</div>
            </div>`).join('')}</div>` : '<p class="arena-voice-empty">Quotes appear once enough lines have been transcribed.</p>'}
        ${q?._fallback ? '<p class="arena-note">Quotes picked by heuristic — the AI curates these once enabled.</p>' : ''}
    </div>`;
}

function _aTierBadge(t, cls = '') { return t ? `<span class="arena-tier ${cls}" style="--tc:${_aEsc(t.color)}" title="${_aEsc(t.name)} tier${t.next ? ` · ${t.progress}% to ${_aEsc(t.next.name)}` : ''}"><i class="fa-solid fa-shield-halved"></i> ${_aEsc(t.name)}</span>` : ''; }
function _aProgressPanel(pr, { compact = false } = {}) {
    if (!pr) return '';
    const t = pr.tier;
    const earned = pr.achievements.filter(a => a.earned_at), locked = pr.achievements.filter(a => !a.earned_at);
    return `<section class="arena-progress-panel">
        <div class="arena-progress-head">
            ${_aTierBadge(t, 'arena-tier-big')}
            <div class="arena-progress-bar"><div class="arena-tier-track">${pr.tiers.map((x, i) => `<span class="arena-tier-step ${i <= t.index ? 'is-done' : ''} ${i === t.index ? 'is-now' : ''}" style="--tc:${_aEsc(x.color)}" title="${_aEsc(x.name)} · ${x.min} XP"></span>`).join('')}</div>
                <small class="arena-note"><b>${pr.xp} XP</b> all-time · ${t.next ? `${t.next.xp - pr.xp} more to <b style="color:${_aEsc(t.next.color)}">${_aEsc(t.next.name)}</b>` : 'top tier'} · <b>+${pr.week_xp}</b> this week · ${pr.earned}/${pr.total} unlocked</small></div>
        </div>
        <div class="arena-ach-grid">${[...earned, ...locked].slice(0, compact ? 8 : 40).map(a => `<div class="arena-ach ${a.earned_at ? 'is-earned' : 'is-locked'}" title="${_aEsc(a.desc)} · +${a.xp} XP${a.coins ? ` · +${a.coins} OpenCoins` : ''}${a.earned_at ? ` · ${_aEsc(_aAgo(a.earned_at))}` : ''}"><span class="arena-ach-icon">${a.icon}</span><span class="arena-ach-name">${_aEsc(a.name)}</span>${a.earned_at ? '' : `<span class="arena-ach-hint">${_aEsc(a.desc)}</span>`}</div>`).join('')}</div>
        ${pr.history.length ? `<details class="arena-done arena-history" ${compact ? '' : 'open'}><summary><i class="fa-solid fa-scroll"></i> History <small>${pr.history.length}</small></summary><div class="arena-history-list">${pr.history.slice(0, compact ? 6 : 30).map(e => `<div class="arena-history-row"><span class="arena-history-kind ${_aEsc(e.kind)}"><i class="fa-solid ${({ beef: 'fa-fire-flame-curved', beef_over: 'fa-flag-checkered', level: 'fa-arrow-up', tier: 'fa-shield-halved', achievement: 'fa-medal', subject: 'fa-comment-dots', quoted: 'fa-quote-left' })[e.kind] || 'fa-circle'}"></i></span><span class="arena-history-body">${e.url ? _aA(e.url, `<b>${_aEsc(e.title)}</b>`) : `<b>${_aEsc(e.title)}</b>`}${e.detail ? `<small>${_aEsc(e.detail)}</small>` : ''}</span><span class="arena-history-when">${_aEsc(_aAgo(e.created_at))}</span></div>`).join('')}</div></details>` : ''}
    </section>`;
}

function _aLevelCard(f) {
    const l = f.level || {};
    const pct = l.xp_per_level ? Math.round((l.xp_into_level / l.xp_per_level) * 100) : 0;
    return `<div class="arena-level-card">
        <div class="arena-level-head"><span class="arena-lvl arena-lvl-big">TRASH LVL ${l.level || 1}</span><span class="arena-note">${l.xp || 0} XP · ${l.recent_xp || 0} this week${f.ratings.talk_bonus ? ` · <b>+${f.ratings.talk_bonus} POWER</b> from the mouth` : ''}</span></div>
        <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${pct}%"></span></span>
        <div class="arena-level-nums"><span><b>${l.beef_hits || 0}</b><small>beef hits</small></span><span><b>${l.topic_moments || 0}</b><small>moments</small></span><span><b>${l.topics_joined || 0}</b><small>subjects</small></span><span><b>${f.record.wins}–${f.record.losses}${f.record.draws ? `–${f.record.draws}` : ''}</b><small>beef record</small></span></div>
        ${l.best_line ? `<div class="arena-quote"><div><q>${_aEsc(l.best_line.text)}</q><small>best line on record · ${l.best_line.score}/10</small></div><div class="arena-quote-actions">${_aPlay(l.best_line.vod_id, l.best_line.sec)} ${_aSpeakBtn(l.best_line.text, '', f.user.username)}</div></div>` : ''}
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
                ${f.active_topic ? `<div class="arena-mini-record"><i class="fa-solid fa-comment-dots"></i> Last heard on: ${_aA(_aTopicLink(f.active_topic), _aEsc(f.active_topic.text))}</div>` : ''}
            </div>
            <div class="arena-profile-main">
                <div class="arena-profile-name">
                    <h1>${_aEsc(p.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</h1>
                    <p class="arena-title">${_aEsc(p.title)}</p>
                    <p class="arena-handle">${_aA(_aChannelLink(f.user), `${_aEsc(f.user.display_name)} · @${_aEsc(f.user.username)}`)} · ${_aEsc(p.class)} · ${_aEsc(p.element)}</p>
                </div>
                <div class="arena-profile-power">
                    <div class="arena-power arena-power-lg"><b>${f.ratings.power}</b><small>POWER</small></div>
                    ${f.progress ? _aTierBadge(f.progress.tier, 'arena-tier-big') : ''}
                    ${f.ratings.talk_bonus ? `<div class="arena-talk-bonus" title="Mouth bonus — recent Trash Level XP and beef wins, decays over a week"><i class="fa-solid fa-microphone-lines"></i> +${f.ratings.talk_bonus} mouth</div>` : ''}
                    <div class="arena-record arena-record-lg" title="beef record">${f.record.wins}W – ${f.record.losses}L</div>
                </div>
                ${_aProgressPanel(f.progress)}
                ${_aLevelCard(f)}
                <div class="arena-profile-custom">
                    <div>${_aCustomRadar(f, color, 280)}<div class="arena-mini-record">${(p.custom_stats || []).length ? 'their characteristics — AI-read from their chat history + channel' : 'objective stats (the AI characteristics appear once the persona is generated)'}</div></div>
                    ${(p.custom_stats || []).length ? _aCustomQuips(f) : ''}
                </div>
                <section class="arena-sheet">
                    <h3><i class="fa-solid fa-file-invoice"></i> Rap sheet</h3>
                    <p class="arena-sheet-lore">${_aEsc(p.lore)}</p>
                    <div class="arena-sheet-rows">
                        <div class="arena-sheet-row"><span class="arena-sheet-k">Signature</span><span><b>${_aEsc(p.signature_move?.name)}</b> — ${_aEsc(p.signature_move?.description)}</span></div>
                        <div class="arena-sheet-row"><span class="arena-sheet-k">Special</span><span><b>${_aEsc(p.special?.name)}</b> — ${_aEsc(p.special?.description)}</span></div>
                        <div class="arena-sheet-row is-weak"><span class="arena-sheet-k">Weakness</span><span>${_aEsc(p.weakness)}</span></div>
                        <div class="arena-sheet-row"><span class="arena-sheet-k">Walk-out</span><span><i class="fa-solid fa-music"></i> ${_aEsc(p.entrance_music)}</span></div>
                        <div class="arena-sheet-row"><span class="arena-sheet-k">Catchphrase</span><span>“${_aEsc(p.catchphrase)}”</span></div>
                        ${p.typing_style ? `<div class="arena-sheet-row"><span class="arena-sheet-k">Types like</span><span>${_aEsc(p.typing_style)}</span></div>` : ''}
                    </div>
                    ${f.persona_is_fallback ? '<p class="arena-note">Stats-only profile — the AI writes the rest once it has data.</p>' : ''}
                </section>
                <section class="arena-taunts">
                    <h3><i class="fa-solid fa-comment-dots"></i> Ragebait <small>in their own typing voice · 🔊 reads it in their chat voice</small></h3>
                    <div class="arena-bubbles">${[p.taunt, ...(p.taunts || [])].filter(Boolean).map(x => `<div class="arena-bubble"><span class="arena-bubble-who">${_aEsc(f.user.display_name || f.user.username)}</span><span class="arena-bubble-text">${_aEsc(x)}</span>${_aSpeakBtn(x, 'arena-bubble-speak', f.user.username)}</div>`).join('')}</div>
                </section>
                ${_aVoiceCard(f)}
                <div class="arena-profile-stats is-bars">
                    <div class="arena-bars-head"><b>The numbers</b> <small>percentile across the roster · these make POWER · tap one</small></div>
                    <div class="arena-numgrid">${ARENA_STATS.map(k => `<div class="arena-num is-clickable" data-stat="${k}" title="${_aEsc((p.stat_quips || {})[k] || ARENA_STAT_LABEL[k])}"><span class="arena-num-label">${_aEsc(ARENA_STAT_LABEL[k])}</span><span class="arena-num-track"><span class="arena-num-fill" style="width:${Math.max(0, Math.min(100, f.ratings[k] || 0))}%;background:${_aEsc(color)}"></span></span><span class="arena-num-val">${f.ratings[k] ?? '–'}</span></div>`).join('')}</div>
                    <div id="arena-stat-detail"></div>
                </div>
                <div class="arena-numbers arena-numbers-compact">
                    ${[['Hours (90d)', f.raw.hours], ['Peak', f.raw.peak_viewers], ['Avg', f.raw.avg_viewers], ['Msgs/hr', f.raw.messages_per_hour], ['Followers', f.raw.followers], ['Clips', f.raw.clips]]
                        .map(([l, v]) => `<div class="arena-number"><b>${_aEsc(_aNum(v))}</b><span>${_aEsc(l)}</span></div>`).join('')}
                </div>
            </div>
        </div>
        ${rivalries.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-skull-crossbones"></i> Rivalries</h2><div class="arena-rivalries">${rivalries.map(r => `<div class="arena-rivalry ${r.open ? 'is-open' : ''}">${_aBriefChip(r.opponent, ` · ${r.wins}–${r.losses} in ${r.fights}${r.open ? ' · <b>beef open</b>' : ''}`)}${r.receipts.map(x => `<q class="arena-receipt-mini">${_aEsc(x.text)}</q>`).join('')}</div>`).join('')}</div></section>` : ''}
        ${beefs.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><div class="arena-beef-grid">${beefs.map(_aBeefCard).join('')}</div></section>` : `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><p class="arena-note">No beef on record. Someone only has to say their name…</p></section>`}`;
    _aBindSpeak(root);
    _aBindHome(root);
    _aEvery(1000, () => _aTickClocks(root));

    root.querySelectorAll('.arena-num.is-clickable, .arena-quip.is-clickable').forEach(el => el.addEventListener('click', async () => {
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
                <p>How this was painted: the AI wrote the persona from the stream's own data, then an image model restyled real frames from their streams — their setup, gear, lighting, silhouette — into a character-select caricature.${f.image_model ? ` Model: <code>${_aEsc(f.image_model)}</code>.` : ''}</p>
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
