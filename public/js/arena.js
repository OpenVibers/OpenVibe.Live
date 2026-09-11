/**
 * OpenVibe.Live — Arena tab — BATTLE CAM mode (pure mic)
 *
 * Routes (handled from app.js):
 *   /arena                     live cams · the shit-talk feed · beefs · the ladder
 *   /arena/beef/<id>           one beef: tug-of-war, clock, ringside feed, receipts
 *   /arena/live/<username>     the ears: what the listener hears from a live fighter (auto-refresh)
 *   /arena/<username>          fighter profile (mic stats, voice + quotes, level, receipts, beefs, rivalries)
 *
 * Nothing here starts a fight and nothing in chat counts. Everything on this page is what
 * fighters SAID ON MIC (server/arena/listener.js → mic.js / beef.js). All text is transcribed or
 * AI-written and rendered through _aEsc — never trusted as HTML.
 */
'use strict';

let ARENA_STATS = ['heat', 'aim', 'kills', 'mouth', 'clapback', 'stamina', 'pace'];
let ARENA_STAT_LABEL = { heat: 'Heat', aim: 'Aim', kills: 'Kills', mouth: 'Mouth', clapback: 'Clapback', stamina: 'Stamina', pace: 'Pace' };
let _arenaRoster = null;
let _arenaTimers = [];
let _arenaImagePoll = null;
let _arenaFeedTop = 0;

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
    if (u.avatar_url) return `<div class="arena-portrait arena-portrait-${size} arena-portrait-avatar" style="--fc:${_aEsc(color)}"><img src="${_aEsc(u.avatar_url)}" alt="" loading="lazy"><span class="arena-portrait-glow"></span></div>`;
    return `<div class="arena-portrait arena-portrait-${size} arena-portrait-initial" style="--fc:${_aEsc(color)}"><span>${_aEsc(_aInitial(u))}</span></div>`;
}

/** A fighter's radar: the seven mic stats, or their AI characteristics when the persona has them. */
function _aCustomRadar(f, color, size = 240, { objective = false } = {}) {
    const axes = ARENA_STATS.map(k => ({ name: ARENA_STAT_LABEL[k], value: Math.max(0, Math.min(99, Number(f.ratings?.[k]) || 0)), quip: _arenaRoster?.stat_meta?.[k]?.desc || '' }));
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

function _aChannelLink(u, slot = null) { return typeof channelPath === 'function' ? channelPath(u.username, slot) : `/@${encodeURIComponent(u.username)}`; }
function _aFighterLink(u) { return `/arena/${encodeURIComponent(u.username)}`; }
function _aConsoleLink(u) { return `/arena/live/${encodeURIComponent(u.username)}`; }
function _aBeefLink(b) { return `/arena/beef/${b.id}`; }
function _aVodLink(vodId, sec) { return vodId ? `/vod/${vodId}?t=${Math.max(0, Math.floor(sec || 0))}` : null; }
function _aA(href, inner, cls = '', title = '') { return `<a class="${cls}" href="${_aEsc(href)}" ${title ? `title="${_aEsc(title)}"` : ''} onclick="return handleLinkClick(event, '${_aEsc(href)}')">${inner}</a>`; }
function _aPlay(vodId, sec, label = '') { const h = _aVodLink(vodId, sec); return h ? _aA(h, `<i class="fa-solid fa-play"></i>${label ? ` ${_aEsc(label)}` : ''}`, 'arena-play', 'Hear them say it (jumps to the VOD)') : ''; }
function _aLevelPill(level) { return `<span class="arena-lvl" title="Trash Level — XP from what you say on mic, nothing else">TL ${_aEsc(level ?? 1)}</span>`; }
function _aBriefChip(f, extra = '') {
    return _aA(_aFighterLink(f.user), `${_aPortrait(f, 'xs')}<span><strong>${_aEsc(f.fighter_name)}${f.live ? ' <span class="arena-live-pill">LIVE</span>' : ''}</strong><small>${f.rank ? `#${f.rank} · ` : ''}${_aLevelPill(f.level)}${extra}</small></span>`, 'arena-chip');
}
function _aQ(q) { return `<span class="arena-q ${q >= 8 ? 'is-fire' : q >= 6 ? 'is-hot' : ''}" title="judge score">${q}/10</span>`; }
function _aAim(m) {
    if (m.target) return _aA(_aFighterLink(m.target.user), `<i class="fa-solid fa-crosshairs"></i> ${_aEsc(m.target.fighter_name)}`, 'arena-aim is-fighter', 'called out on mic — this fed a beef');
    if (m.aimed_at && m.aimed_at !== 'nobody') return `<span class="arena-aim"><i class="fa-solid fa-bullseye"></i> at ${_aEsc(m.aimed_at)}</span>`;
    return '';
}

// ── Page entry ───────────────────────────────────────────────

async function loadArenaPage(segments = []) {
    _aStopTimers();
    const root = document.getElementById('arena-root');
    if (!root) return;
    const [, first, second] = segments;
    try {
        if (first === 'beef' && second) return await _aRenderBeef(root, Number(second));
        if (first === 'live' && second) return await _aRenderConsole(root, second);
        if (first === 'topic' || first === 'chatter') return _aGone(root);
        if (first) return await _aRenderFighter(root, first);
        return await _aRenderHome(root);
    } catch (err) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-plug-circle-xmark"></i><p>${_aEsc(err?.message || 'The arena lights went out.')}</p></div>`;
    }
}
function _aGone(root) {
    root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-microphone-lines"></i><p>That part of the Arena is gone. It's <b>pure mic</b> now — no boards, no topics, no chat levels. Everything that counts is said on stream.</p>${_aA('/arena', 'Back to the cams', 'btn btn-primary')}</div>`;
}

// ── Home: Battle Cam ─────────────────────────────────────────

async function _aRenderHome(root) {
    root.innerHTML = _aSpinner('Putting the ears on…');
    const [feed, beefs, live, roster] = await Promise.all([api('/arena/feed?limit=40').catch(() => ({ feed: [] })), api('/arena/beefs'), api('/arena/live').catch(() => ({ live: [] })), api('/arena/fighters')]);
    _arenaRoster = roster;
    if (Array.isArray(roster.stats) && roster.stats.length) { ARENA_STATS = roster.stats; ARENA_STAT_LABEL = Object.fromEntries(roster.stats.map(k => [k, roster.stat_meta?.[k]?.label || k])); }
    _arenaFeedTop = feed.feed?.[0]?.id || 0;
    root.innerHTML = `
        <div class="arena-hero arena-hero-cam">
            <div>
                <h1><i class="fa-solid fa-microphone-lines"></i> Battle Cam</h1>
                <p class="arena-lede">Pure mic. No personas, no AI characters, no chat points, no votes. This page is the shit talk that was actually said on stream — judged, scored, and replayable at the second it happened. Call another streamer out on mic and the beef opens itself; they're on the clock, silence is a forfeit. Talk shit at chat, at the mods, at the world, and it lands in the feed and levels you up.</p>
            </div>
            <div class="arena-hero-actions">
                <span class="arena-note">${roster.ai ? '<i class="fa-solid fa-ear-listen"></i> AI judge on' : '<i class="fa-solid fa-ear-deaf"></i> AI off — keyword judging'}</span>
                ${_aMe() ? _aA('/broadcast', '<i class="fa-solid fa-tower-broadcast"></i> Get on a cam', 'btn btn-primary') : ''}
            </div>
        </div>
        <section class="arena-me" id="arena-me">${_aMe() ? _aSpinner('Checking your beefs…') : `<div class="arena-me-guest"><i class="fa-solid fa-microphone"></i> <b>Sign in</b>, go live with transcription on, and the Arena hears you. Say a name. See what happens.</div>`}</section>
        <section class="arena-live arena-cams" id="arena-live">${_aRenderCams(live.live || [])}</section>
        <section class="arena-beefs" id="arena-beefs">${_aRenderBeefs(beefs)}</section>
        <section class="arena-feed-section" id="arena-feed">${_aRenderFeed(feed.feed || [])}</section>
        <section class="arena-leaderboard">
            <div class="arena-board-head">
                <h2><i class="fa-solid fa-ranking-star"></i> The ladder <small>${roster.fighters.length} fighters · every number from the mic</small></h2>
                <input type="search" id="arena-search" placeholder="Find a fighter…" autocomplete="off">
            </div>
            <div class="arena-list" id="arena-list"></div>
        </section>
        <section class="arena-rules">
            <h3>How Battle Cam works</h3>
            <ul>
                <li><b>The ears.</b> Every 15 s the Arena reads the live transcription of every fighter's cam. That is the only input. Chat can <code>!hype</code> a side of a beef and that is all chat can do.</li>
                <li><b>Callouts → beefs.</b> Say another fighter's name (however the mic hears it) while talking shit → the ears lock on, the judge scores it, the beef opens and they're on the clock: <b>15 min if live, 24 h if not</b>. Every answer flips the clock. Silence is a forfeit. Best mouth after 24 h wins. Beat someone ranked 4+ spots above you → <b>upset</b>.</li>
                <li><b>Free shit talk.</b> Not aimed at a fighter? Still judged. Ranting at chat, the mods, other platforms, the game — if it's actually shit talk it lands in the feed with a score and pays Trash Level XP. Gameplay narration and small talk score nothing.</li>
                <li><b>The ladder.</b> Seven ratings, all mic: <b>Heat</b> (how good the shit talk is) · <b>Aim</b> (callouts per hour on mic) · <b>Kills</b> (beefs won) · <b>Mouth</b> (share of stream spent talking) · <b>Clapback</b> (answering when called out) · <b>Stamina</b> (minutes of speech) · <b>Pace</b> (words per minute). Percentiles across the roster → POWER, plus a mouth bonus for recent XP and wins.</li>
                <li><b>Language.</b> Nothing is censored for being offensive. The only lines that don't count: real threats, anything sexual about minors, and doxxing.</li>
            </ul>
        </section>`;
    _aRenderList(roster.fighters);
    _aBindHome(root);
    if (_aMe()) _aRenderMe().catch(() => { const el = document.getElementById('arena-me'); if (el) el.innerHTML = ''; });
    document.getElementById('arena-search')?.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        _aRenderList(!q ? roster.fighters : roster.fighters.filter(f => [f.user.display_name, f.user.username].filter(Boolean).some(s => s.toLowerCase().includes(q))));
    });
    _aEvery(12000, async () => {
        try {
            const [b, l, fd] = await Promise.all([api('/arena/beefs'), api('/arena/live'), api('/arena/feed?limit=40')]);
            const beefsEl = document.getElementById('arena-beefs'), liveEl = document.getElementById('arena-live'), feedEl = document.getElementById('arena-feed');
            if (beefsEl) beefsEl.innerHTML = _aRenderBeefs(b);
            if (liveEl) liveEl.innerHTML = _aRenderCams(l.live || []);
            if (feedEl) { const top = fd.feed?.[0]?.id || 0; feedEl.innerHTML = _aRenderFeed(fd.feed || [], { fresh: top > _arenaFeedTop ? fd.feed.filter(m => m.id > _arenaFeedTop).length : 0 }); if (top > _arenaFeedTop) _aFlash(feedEl, 'new line on the mic'); _arenaFeedTop = top; }
            _aBindHome(root);
        } catch { /* keep the last render */ }
    });
    _aEvery(1000, () => _aTickClocks(root));
}

async function _aRenderMe() {
    const el = document.getElementById('arena-me');
    if (!el) return;
    const me = await api('/arena/me');
    if (!me.on_roster) { el.innerHTML = `<div class="arena-me-guest"><i class="fa-solid fa-microphone-slash"></i> You're not on the roster yet — the Arena only knows what the transcription hears. Go live with audio transcription on and say something worth judging.</div>`; return; }
    const f = me.fighter, l = f.level, pct = l.xp_per_level ? Math.round((l.xp_into_level / l.xp_per_level) * 100) : 0;
    el.innerHTML = `<div class="arena-me-inner">
        <div class="arena-me-left">${_aPortrait(f, 'sm')}<div><div class="arena-me-name"><b>${_aEsc(f.fighter_name)}</b> <span class="arena-lvl">TRASH LVL ${l.level}</span> <span class="arena-note">#${f.rank} · PWR ${f.power} · ${f.record.wins}W–${f.record.losses}L</span></div>
            <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${pct}%"></span></span>
            <small class="arena-note">${l.xp_into_level}/${l.xp_per_level} to level ${l.level + 1} · <b>+${l.recent_xp} XP</b> this week · ${f.mic.moments} judged lines (30d) · avg ${f.mic.avg_quality}/10</small></div></div>
        <div class="arena-me-right">
            ${me.on_clock.length ? me.on_clock.map(b => `<div class="arena-me-alert">${_aA(_aBeefLink(b), `<i class="fa-solid fa-stopwatch"></i> <b>${_aEsc((b.a.user.id === f.user.id ? b.b : b.a).fighter_name)}</b> called you out — answer on your own cam`)} ${_aClockTag(b)}</div>`).join('') : `<div class="arena-me-row arena-note"><i class="fa-solid fa-circle-check"></i> Nobody has you on the clock.</div>`}
            ${me.moments.length ? `<div class="arena-me-row"><i class="fa-solid fa-quote-left"></i> last judged: <q>${_aEsc(me.moments[0].text)}</q> ${_aQ(me.moments[0].quality)}</div>` : ''}
            <div class="arena-me-row">${_aA(_aFighterLink(f.user), 'your fighter page <i class="fa-solid fa-arrow-right"></i>', 'arena-subject-open')} ${me.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> your ears', 'arena-tag arena-tag-hot') : ''}</div>
        </div>
    </div>`;
}

function _aRenderCams(live) {
    if (!live.length) return `<h2><span class="arena-live-dot"></span> Live cams <small>nobody from the roster is live</small></h2><p class="arena-note">When a fighter goes live with transcription on, the ears pick them up here — name-drops open beefs, free shit talk hits the feed.</p>`;
    return `<h2><span class="arena-live-dot"></span> Live cams <small>${live.length} on · the ears are listening</small></h2>
    <div class="arena-cam-grid">${live.map(f => {
        const lock = f.ears && f.ears.focus;
        return `<div class="arena-cam ${f.transcribed ? '' : 'is-quiet'} ${lock ? 'is-locked' : ''}" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            ${_aA(_aChannelLink(f.user, f.stream.slug || f.stream.managed_stream_id), `${f.thumbnail_url ? `<img class="arena-live-thumb" src="${_aEsc(f.thumbnail_url)}" alt="">` : _aPortrait(f, 'md')}<span class="arena-cam-rec"><span class="arena-live-dot arena-live-dot-sm"></span> LIVE · <i class="fa-solid fa-eye"></i> ${_aNum(f.stream.viewer_count)}</span>`, 'arena-cam-thumb')}
            <div class="arena-cam-body">
                <div class="arena-mic-head">
                    ${_aA(_aFighterLink(f.user), `<strong>${_aEsc(f.user.display_name || f.user.username)}</strong>`)}
                    <span class="arena-mic-meta">#${f.rank} · PWR ${f.ratings.power} · ${_aLevelPill(f.level)} · ${f.record.wins}W–${f.record.losses}L</span>
                </div>
                ${lock ? `<div class="arena-cam-lock"><i class="fa-solid fa-crosshairs fa-beat"></i> locked on <b>${_aEsc(lock.target || 'a fighter')}</b> · ${lock.hits} hit${lock.hits === 1 ? '' : 's'}</div>` : ''}
                ${f.last_moment ? `<div class="arena-cam-last"><q>${_aEsc(f.last_moment.text)}</q><small>${_aQ(f.last_moment.quality)} ${_aAim(f.last_moment)} · ${_aEsc(_aAgo(f.last_moment.at))} ${_aPlay(f.last_moment.vod_id, f.last_moment.sec)}</small></div>` : (f.hot_mic ? `<q class="arena-mic-line">${_aEsc(f.hot_mic.text)}</q>` : `<span class="arena-mic-line arena-mic-line-empty">${f.transcribed ? 'listening…' : 'no transcript yet — the cam needs audio transcription on'}</span>`)}
                <div class="arena-mic-tags">
                    ${f.open_beefs ? `<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-fire"></i> ${f.open_beefs} beef${f.open_beefs > 1 ? 's' : ''} open</span>` : '<span class="arena-tag arena-tag-dim">no beef open</span>'}
                    ${f.ears ? `<span class="arena-tag arena-tag-dim" title="words buffered for the judge"><i class="fa-solid fa-ear-listen"></i> ${f.ears.pending_words} words pending</span>` : ''}
                    ${_aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> ears', 'arena-tag')}
                </div>
            </div>
        </div>`; }).join('')}</div>`;
}

// ── The feed ─────────────────────────────────────────────────

function _aMomentRow(m) {
    return `<div class="arena-mic-moment ${m.kind === 'beef_hit' ? 'is-beef' : ''} ${m.quality >= 8 ? 'is-fire' : ''}" data-id="${m.id}">
        ${_aA(_aFighterLink(m.user), _aPortrait(m, 'xs'))}
        <div class="arena-mic-moment-body">
            <div class="arena-mic-moment-head">${_aA(_aFighterLink(m.user), `<b>${_aEsc(m.fighter_name)}</b>`)}${m.live ? ' <span class="arena-live-pill">LIVE</span>' : ''} ${_aAim(m)} ${_aQ(m.quality)} <small>${_aEsc(_aAgo(m.at))}</small></div>
            <q>${_aEsc(m.text)}</q>
            ${m.announcer ? `<div class="arena-feed-announcer"><i class="fa-solid fa-bullhorn"></i> ${_aEsc(m.announcer)}</div>` : ''}
            <small class="arena-mic-moment-foot">${m.about ? `${_aEsc(m.about)} · ` : ''}${m.kind === 'beef_hit' && m.beef_id ? `${_aA(_aBeefLink({ id: m.beef_id }), '<i class="fa-solid fa-fire-flame-curved"></i> beef', 'arena-tag arena-tag-hot')} ` : ''}${_aPlay(m.vod_id, m.sec)} ${_aSpeakBtn(m.text, '', m.user.username)}</small>
        </div>
    </div>`;
}
function _aRenderFeed(feed, { fresh = 0 } = {}) {
    return `<h2><i class="fa-solid fa-satellite-dish"></i> Shit talk on record <small>what was actually said on stream, newest first · ${feed.length ? `${feed.length} lines` : 'nothing yet'}${fresh ? ` · <b class="arena-fresh">+${fresh} new</b>` : ''}</small></h2>
        ${feed.length ? `<div class="arena-mic-feed-list">${feed.map(_aMomentRow).join('')}</div>` : `<div class="arena-beef-empty"><i class="fa-solid fa-microphone-lines"></i><p>Quiet. The moment a fighter on a live cam talks shit — at anyone — it lands here with a score.</p></div>`}`;
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
        ${open.length ? `<div class="arena-beef-grid">${open.map(_aBeefCard).join('')}</div>` : `<div class="arena-beef-empty"><i class="fa-solid fa-microphone-lines"></i><p>No beef right now. A fighter only has to call another one out on mic — the ears do the rest.</p></div>`}
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
    _aBindSpeak(root);
}
function _aFlash(el, text) {
    const f = document.createElement('div'); f.className = 'arena-flash'; f.textContent = text; el.prepend(f); setTimeout(() => f.remove(), 2200);
}

// ── Ladder ───────────────────────────────────────────────────

function _aRenderList(fighters) {
    const el = document.getElementById('arena-list');
    if (!el) return;
    if (!fighters.length) { el.innerHTML = '<div class="arena-empty"><p>No fighter matches that.</p></div>'; return; }
    el.innerHTML = fighters.map(f => `
        <div class="arena-row ${f.live ? 'is-live' : ''}" data-user="${_aEsc(f.user.username)}" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            <span class="arena-rank ${f.rank <= 3 ? `arena-rank-${f.rank}` : ''}">${f.rank}</span>
            ${_aPortrait(f, 'sm')}
            <span class="arena-row-main">
                <strong>${_aEsc(f.user.display_name || f.user.username)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''} ${_aLevelPill(f.level?.level)}<i class="fa-solid fa-chevron-right arena-chevron"></i></strong>
                <span class="arena-row-sub">${f.mic ? `<i class="fa-solid fa-microphone" title="judged lines, 30 days"></i> ${f.mic.moments} lines · avg ${f.mic.avg_quality}/10 · ${f.mic.bangers} bangers · ${f.mic.beef_hits} callouts` : ''}${f.voice?.has_data ? ` · ${_aNum(f.voice.speech_minutes)} min on mic` : ''}</span>
                ${f.last_line ? `<em class="arena-row-taunt">“${_aEsc(f.last_line.text)}”${f.last_line.aimed_at ? ` <small>— at ${_aEsc(f.last_line.aimed_at)}</small>` : ''}</em>` : '<em class="arena-row-taunt arena-note">nothing judged yet</em>'}
            </span>
            <span class="arena-row-stats">
                <span class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></span>
                <span class="arena-record" title="beef record">${f.record.wins}W–${f.record.losses}L</span>
            </span>
            <div class="arena-row-expand">
                <div>${_aCustomRadar(f, f.user.profile_color || '#8b5cf6', 220, { objective: true })}<div class="arena-mini-record">the seven mic stats · last live ${_aEsc(f.last_live_at ? _aDate(f.last_live_at) : '—')}</div></div>
                <div>
                    <div class="arena-quips">${ARENA_STATS.map(k => `<div class="arena-quip"><b>${_aEsc(ARENA_STAT_LABEL[k])} ${f.ratings[k]}</b><span>${_aEsc(_arenaRoster?.stat_meta?.[k]?.desc || '')}</span></div>`).join('')}</div>
                </div>
                <div class="arena-row-expand-actions">
                    ${_aA(_aFighterLink(f.user), '<i class="fa-solid fa-satellite-dish"></i> Their lines', 'btn btn-primary')}
                    ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> Listen in', 'btn btn-ghost') : ''}
                    ${f.last_line ? _aSpeakBtn(f.last_line.text, 'btn btn-ghost', f.user.username) : ''}
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
    const sys = e.kind && !['hit', 'open', 'respond'].includes(e.kind);
    return `<div class="arena-feed-line ${sys ? 'is-system' : `is-${e.side}`}">
        ${sys ? '' : _aA(_aFighterLink(side.user), _aPortrait(side, 'xs'))}
        <div class="arena-feed-body">
            ${e.announcer ? `<div class="arena-feed-announcer"><i class="fa-solid fa-bullhorn"></i> ${_aEsc(e.announcer)}</div>` : ''}
            ${e.text ? `<q>${_aEsc(e.text)}</q>` : ''}
            <small>${sys ? _aEsc(e.kind) : `${_aEsc(side.fighter_name)}${e.kind === 'open' ? ' · opened it' : e.kind === 'respond' ? ' · answered' : ''}${e.quality != null ? ` · ${e.quality}/10` : ''}${e.about ? ` · ${_aEsc(e.about)}` : ''}`} · ${_aEsc(_aAgo(e.at))} ${_aPlay(e.vod_id, e.sec)} ${e.text ? _aSpeakBtn(e.text, '', side.user.username) : ''}</small>
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
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Battle Cam')} ${_aA(_aFighterLink(b.a.user), _aEsc(b.a.fighter_name))} · ${_aA(_aFighterLink(b.b.user), _aEsc(b.b.fighter_name))}</div>
        <div class="arena-beef-page">
            <div class="arena-beef-hero">
                <div class="arena-beef-tags">${_aBeefTags(b)}${!open ? `<span class="arena-tag ${winner ? 'arena-tag-gold' : 'arena-tag-dim'}">${winner ? `${_aEsc(winner.fighter_name)} won${b.resolution === 'forfeit' ? ' by forfeit' : b.resolution === 'score' ? ' on points' : ''}` : 'draw'}</span>` : '<span class="arena-tag arena-tag-hot"><i class="fa-solid fa-fire"></i> OPEN</span>'}</div>
                <h1>${_aEsc((open ? b.headline : b.result_headline || b.headline) || `${b.a.fighter_name} vs ${b.b.fighter_name}`)} ${_aSpeakBtn((open ? b.headline : b.result_headline || b.headline) || '')}</h1>
                ${b.opener_line ? `<p class="arena-beef-opener">It started on mic with: <q>${_aEsc(b.opener_line)}</q></p>` : ''}
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
                        <li>Answer on your own cam within <b>${b.rules.response_live_min} min</b> if you're live, <b>${b.rules.response_offline_hours} h</b> if not — or forfeit.</li>
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

// ── Live console ("the ears") ────────────────────────────────

async function _aRenderConsole(root, username) {
    root.innerHTML = _aSpinner('Putting the ears on…');
    let c = await api(`/arena/console/${encodeURIComponent(username)}`);
    const draw = () => {
        const f = c.fighter, L = c.listener || {}, lvl = c.level || {}, m = c.mic || {};
        const me = _aMe(), mine = me && me.id === f.user.id;
        const xpPct = lvl.xp_per_level ? Math.round((lvl.xp_into_level / lvl.xp_per_level) * 100) : 0;
        const J = L.last_mic_judgement;
        root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Battle Cam')} ${_aA(_aFighterLink(f.user), _aEsc(f.fighter_name))} ${c.live ? _aA(_aChannelLink(f.user), '<i class="fa-solid fa-tv"></i> watch', '') : ''}</div>
        <div class="arena-console" style="--fc:${_aEsc(f.user.profile_color || '#8b5cf6')}">
            <div class="arena-console-head">
                ${_aPortrait(f, 'sm')}
                <div>
                    <h1>${_aEsc(f.fighter_name)} ${c.live ? '<span class="arena-live-pill">LIVE</span>' : '<span class="arena-tag arena-tag-dim">offline</span>'}</h1>
                    <div class="arena-console-status ${L.listening ? 'is-on' : ''}">
                        <i class="fa-solid ${L.listening ? 'fa-ear-listen' : 'fa-ear-deaf'}"></i>
                        ${!c.live ? 'Not live — the ears only work on a live, transcribed cam.' : !c.transcribed ? 'Live, but no transcript in the last 30 min. Turn on audio transcription in the dashboard and the Arena hears you.' : L.listening ? `Listening. ${L.pending_mic_words || 0} words buffered for the mic judge${L.focus ? ` · locked on ${_aEsc(L.focus.target)}` : ''}${L.last_judge_at ? ` · last judged ${_aEsc(_aAgo(L.last_judge_at))}` : ''}` : 'Live and transcribed — the listener picks this cam up on its next 15 s tick.'}
                    </div>
                </div>
                <div class="arena-console-level">
                    <span class="arena-lvl arena-lvl-big">TRASH LVL ${lvl.level || 1}</span>
                    <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${xpPct}%"></span></span>
                    <small>${lvl.xp_into_level || 0}/${lvl.xp_per_level || 50} XP to level ${(lvl.level || 1) + 1} · ${lvl.recent_xp || 0} this week · ${m.moments || 0} judged lines (30d)</small>
                </div>
            </div>
            <div class="arena-console-cols">
                <section class="arena-console-main">
                    <h3><i class="fa-solid fa-microphone"></i> Hot mic <small>last lines the ears heard</small></h3>
                    ${L.focus ? `<div class="arena-focus"><i class="fa-solid fa-crosshairs fa-beat"></i> <b>Locked on ${_aEsc(L.focus.target || 'a fighter')}</b> <small>${_aEsc(L.focus.how)} name-drop · ${L.focus.hits} hit${L.focus.hits === 1 ? '' : 's'} · ${L.focus.pending_words} words waiting for the judge · lock <span class="arena-clock" data-until="${new Date(Date.now() + L.focus.lock_seconds_left * 1000).toISOString()}" data-who="the lock"><b>${_aClock(L.focus.lock_seconds_left)}</b></span></small>${L.focus.context ? `<div class="arena-focus-ctx">so far: ${_aEsc(L.focus.context)}</div>` : ''}<p class="arena-note">Everything said now goes to the beef judge as a continuation — no need to say the name again. Two chunks about something else and the ears let go.</p></div>` : ''}
                    <div class="arena-mic-feed">${c.hot_mic?.length ? c.hot_mic.map(l => `<div class="arena-mic-line-row"><span class="arena-mic-time">${_aStamp(l.sec)}</span><span>${_aEsc(l.text)}</span>${_aPlay(l.vod_id, l.sec)}</div>`).join('') : '<p class="arena-note">Nothing heard yet.</p>'}</div>
                    ${L.last_beef_judgement ? `<div class="arena-judgement ${L.last_beef_judgement.aimed_at_target ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Beef judge (${_aEsc(_aAgo(L.last_beef_judgement.at))}):</b> ${L.last_beef_judgement.aimed_at_target ? `HIT${L.last_beef_judgement.named === false ? ' (continuation, name not said)' : ''} · ${L.last_beef_judgement.quality}/10 · ${_aEsc(L.last_beef_judgement.about || '')}${L.last_beef_judgement.opened ? ' · <b>beef opened</b>' : ''}` : L.last_beef_judgement.about_target ? `still about them, not shit talk — ${_aEsc(L.last_beef_judgement.about || '')}` : `moved on — ${_aEsc(L.last_beef_judgement.about || 'not about them')}`}${L.last_beef_judgement.flagged ? ' · <span class="arena-tag arena-tag-dim">line not counted (threat/minor/dox)</span>' : ''}</div>` : ''}
                    ${J ? `<div class="arena-judgement ${J.is_trash_talk ? 'is-hit' : ''}"><b><i class="fa-solid fa-gavel"></i> Mic judge (${_aEsc(_aAgo(J.at))}):</b> ${J.is_trash_talk ? `SHIT TALK · ${J.quality}/10${J.aimed_at ? ` · at ${_aEsc(J.aimed_at)}` : ''} · ${_aEsc(J.about || '')}${J.opened ? ' · <b>callout — beef opened</b>' : J.target_id ? ' · <b>callout — fed the beef</b>' : ''}` : `not shit talk — ${_aEsc(J.about || 'gameplay / small talk')}`}${J.flagged ? ' · <span class="arena-tag arena-tag-dim">line not counted (threat/minor/dox)</span>' : ''}</div>` : ''}
                </section>
                <aside class="arena-console-aside">
                    <section>
                        <h3><i class="fa-solid fa-satellite-dish"></i> Their last lines in the feed</h3>
                        ${c.recent_moments?.length ? `<div class="arena-mic-feed-list is-compact">${c.recent_moments.map(_aMomentRow).join('')}</div>` : `<p class="arena-note">${mine ? 'Nothing judged yet — talk your shit.' : 'Nothing judged yet.'}</p>`}
                    </section>
                    <section>
                        <h3><i class="fa-solid fa-fire-flame-curved"></i> Open beefs</h3>
                        ${c.open_beefs?.length ? c.open_beefs.map(b => `<div class="arena-console-beef">${_aA(_aBeefLink(b), `<b>${_aEsc(b.headline || `${b.a.fighter_name} vs ${b.b.fighter_name}`)}</b>`)}${_aTug(b)}${_aClockTag(b)}</div>`).join('') : `<p class="arena-note">None. ${mine ? 'Say another fighter\'s name while talking shit and one opens.' : ''}</p>`}
                    </section>
                    <section><h3><i class="fa-solid fa-circle-info"></i> How it's judged</h3><ul class="arena-rules-list"><li>Every 15 s the ears read new transcript lines.</li><li>A fighter's name (however the mic hears it — split, glued, misheard) locks the ears on them; ≥20 words go to the beef judge, and everything after counts as a continuation until they move on.</li><li>Not locked? ≥20 words go to the mic judge: is it shit talk, how good, and at whom. If "whom" is a fighter, it's a callout and feeds a beef anyway.</li><li>Offensive language is fine. Threats, minors, doxxing → line ignored.</li></ul></section>
                </aside>
            </div>
        </div>`;
        _aBindSpeak(root);
    };
    draw();
    _aEvery(1000, () => _aTickClocks(root));
    _aEvery(10000, async () => { try { const fresh = await api(`/arena/console/${encodeURIComponent(username)}`); const lvlUp = (fresh.level?.level || 1) > (c.level?.level || 1); c = fresh; draw(); if (lvlUp) _aLevelUp(c.level.level); } catch { /* */ } });
}

// ── Fighter profile ──────────────────────────────────────────

function _aVoiceCard(f) {
    const v = f.voice || {};
    const color = f.user.profile_color || '#8b5cf6';
    if (!v.has_data) {
        return `<div class="arena-voice" style="--fc:${_aEsc(color)}"><div class="arena-voice-head"><h3><i class="fa-solid fa-microphone-slash"></i> On the mic</h3></div><p class="arena-voice-empty">No transcript data yet — the audio transcription picks this up on their next streams. Until then the Arena can't hear them.</p></div>`;
    }
    return `<div class="arena-voice" style="--fc:${_aEsc(color)}">
        <div class="arena-voice-head"><h3><i class="fa-solid fa-microphone"></i> On the mic <span class="arena-power" style="margin-left:6px"><b style="font-size:1.1rem">${f.ratings.mouth}</b><small>MOUTH</small></span></h3></div>
        <div class="arena-voice-meters">
            <div class="arena-voice-meter"><b>${_aEsc(v.talk_ratio_pct)}%</b><span>of stream time talking</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(_aNum(v.speech_minutes))} min</b><span>of speech heard (90d)</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.wpm)}</b><span>words per minute</span></div>
            <div class="arena-voice-meter"><b>${_aEsc(v.streams_heard)}</b><span>streams transcribed</span></div>
        </div>
    </div>`;
}

function _aLevelCard(f) {
    const l = f.level || {}, m = f.mic || {};
    const pct = l.xp_per_level ? Math.round((l.xp_into_level / l.xp_per_level) * 100) : 0;
    return `<div class="arena-level-card">
        <div class="arena-level-head"><span class="arena-lvl arena-lvl-big">TRASH LVL ${l.level || 1}</span><span class="arena-note">${l.xp || 0} XP · ${l.recent_xp || 0} this week${f.ratings.talk_bonus ? ` · <b>+${f.ratings.talk_bonus} POWER</b> from the mouth` : ''}</span></div>
        <span class="arena-xp-track"><span class="arena-xp-fill" style="width:${pct}%"></span></span>
        <div class="arena-level-nums"><span><b>${m.moments || 0}</b><small>judged lines (30d)</small></span><span><b>${m.avg_quality ?? 0}</b><small>avg score</small></span><span><b>${m.bangers || 0}</b><small>bangers (7+)</small></span><span><b>${l.beef_hits || 0}</b><small>beef hits</small></span><span><b>${m.answered || 0}/${m.targeted || 0}</b><small>answered when called out</small></span><span><b>${f.record.wins}–${f.record.losses}${f.record.draws ? `–${f.record.draws}` : ''}</b><small>beef record</small></span></div>
        ${l.best_line ? `<div class="arena-quote"><div><q>${_aEsc(l.best_line.text)}</q><small>best line on record · ${l.best_line.score}/10</small></div><div class="arena-quote-actions">${_aPlay(l.best_line.vod_id, l.best_line.sec)} ${_aSpeakBtn(l.best_line.text, '', f.user.username)}</div></div>` : ''}
    </div>`;
}

async function _aRenderFighter(root, username) {
    root.innerHTML = _aSpinner('Pulling their lines…');
    const f = await api(`/arena/fighters/${encodeURIComponent(username)}`);
    if (f.not_on_roster) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-microphone-slash"></i><p><strong>${_aEsc(f.user.display_name)}</strong> is not on the roster — ${_aEsc(f.reason)}.</p>${_aA('/arena', 'Back to the cams', 'btn')}</div>`;
        return;
    }
    const color = f.user.profile_color || '#8b5cf6';
    const name = f.user.display_name || f.user.username;
    const beefs = f.beefs || [], rivalries = f.rivalries || [], moments = f.moments || [], best = f.best_lines || [];
    root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Battle Cam')} ${f.live ? _aA(_aConsoleLink(f.user), '<i class="fa-solid fa-ear-listen"></i> Listen in live', '') : ''}</div>
        <div class="arena-profile" style="--fc:${_aEsc(color)}">
            <div class="arena-profile-portrait" id="arena-profile-portrait">
                ${_aPortrait(f, 'lg')}
                <div class="arena-profile-rank">#${f.rank} <small>of ${f.roster_size}</small></div>
            </div>
            <div class="arena-profile-main">
                <div class="arena-profile-name">
                    <h1>${_aEsc(name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</h1>
                    <p class="arena-handle">${_aA(_aChannelLink(f.user), `@${_aEsc(f.user.username)}`)} · ${f.record.wins}W–${f.record.losses}L · ${f.mic ? `${f.mic.moments} judged lines in 30 days` : ''}</p>
                </div>
                <div class="arena-profile-power">
                    <div class="arena-power arena-power-lg"><b>${f.ratings.power}</b><small>POWER</small></div>
                    ${f.ratings.talk_bonus ? `<div class="arena-talk-bonus" title="Mouth bonus — recent Trash Level XP and beef wins, decays over a week"><i class="fa-solid fa-microphone-lines"></i> +${f.ratings.talk_bonus} mouth</div>` : ''}
                    <div class="arena-record arena-record-lg" title="beef record">${f.record.wins}W – ${f.record.losses}L</div>
                </div>
                ${_aLevelCard(f)}
                ${best.length ? `<section class="arena-receipts-section"><h3><i class="fa-solid fa-fire"></i> Best shit talk <small>their highest-scored lines</small></h3><div class="arena-mic-feed-list">${best.map(_aMomentRow).join('')}</div></section>` : ''}
                <section class="arena-receipts-section">
                    <h3><i class="fa-solid fa-satellite-dish"></i> On record <small>their judged lines, newest first</small></h3>
                    ${moments.length ? `<div class="arena-mic-feed-list">${moments.map(_aMomentRow).join('')}</div>` : '<p class="arena-note">Nothing judged yet. The ears are waiting.</p>'}
                </section>
                <div class="arena-profile-stats is-bars">
                    <div class="arena-bars-head"><b>The mic stats</b> <small>percentile across the roster · these make POWER · tap one</small></div>
                    <div class="arena-numgrid">${ARENA_STATS.map(k => `<div class="arena-num is-clickable" data-stat="${k}" title="${_aEsc(_arenaRoster?.stat_meta?.[k]?.desc || ARENA_STAT_LABEL[k])}"><span class="arena-num-label">${_aEsc(ARENA_STAT_LABEL[k])}</span><span class="arena-num-track"><span class="arena-num-fill" style="width:${Math.max(0, Math.min(100, f.ratings[k] || 0))}%;background:${_aEsc(color)}"></span></span><span class="arena-num-val">${f.ratings[k] ?? '–'}</span></div>`).join('')}</div>
                    <div id="arena-stat-detail"></div>
                </div>
                <div class="arena-profile-custom">
                    <div>${_aCustomRadar(f, color, 280, { objective: true })}<div class="arena-mini-record">the seven mic stats</div></div>
                </div>
                ${_aVoiceCard(f)}
            </div>
        </div>
        ${rivalries.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-skull-crossbones"></i> Rivalries</h2><div class="arena-rivalries">${rivalries.map(r => `<div class="arena-rivalry ${r.open ? 'is-open' : ''}">${_aBriefChip(r.opponent, ` · ${r.wins}–${r.losses} in ${r.fights}${r.open ? ' · <b>beef open</b>' : ''}`)}${r.receipts.map(x => `<q class="arena-receipt-mini">${_aEsc(x.text)}</q>`).join('')}</div>`).join('')}</div></section>` : ''}
        ${beefs.length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><div class="arena-beef-grid">${beefs.map(_aBeefCard).join('')}</div></section>` : `<section class="arena-challenge"><h2><i class="fa-solid fa-fire-flame-curved"></i> Beefs</h2><p class="arena-note">No beef on record. Someone only has to say their name…</p></section>`}`;
    _aBindSpeak(root);
    _aBindHome(root);
    _aEvery(1000, () => _aTickClocks(root));

    root.querySelectorAll('.arena-num.is-clickable').forEach(el => el.addEventListener('click', async () => {
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
}

function _aLevelUp(level) {
    const el = document.createElement('div');
    el.className = 'arena-levelup';
    el.innerHTML = `<i class="fa-solid fa-arrow-up"></i> TRASH LEVEL ${level}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
}

window.loadArenaPage = loadArenaPage;
