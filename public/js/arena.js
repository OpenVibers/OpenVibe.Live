/**
 * OpenVibe.Live — Arena tab (streamer vs streamer)
 *
 * Routes (handled from app.js):
 *   /arena                         main event + live matchups + leaderboard (rows expand)
 *   /arena/<username>              fighter profile (stats drill down, voice + quotes, portrait lightbox)
 *   /arena/battle/<a>/<b>          head-to-head battle (rounds, tale of the tape, walkouts, crowd vote)
 *
 * Talks to /api/arena/* (server/arena). Everything renders with escaped template strings —
 * persona/quote text is AI-written or transcribed and must never be trusted as HTML.
 */
'use strict';

const ARENA_STATS = ['hype', 'grind', 'chat', 'loyalty', 'clutch', 'vibe', 'mic'];
const ARENA_STAT_LABEL = { hype: 'Hype', grind: 'Grind', chat: 'Chat', loyalty: 'Loyalty', clutch: 'Clutch', vibe: 'Vibe', mic: 'Mic' };
let _arenaRoster = null;       // cached leaderboard payload
let _arenaLiveTimer = null;
let _arenaImagePoll = null;
let _arenaBattleTimers = [];
let _arenaUtterance = null;

function _aEsc(s) { return typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _aNum(n) { n = Number(n) || 0; return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Number.isInteger(n) ? n : n.toFixed(1)); }
function _aInitial(u) { return (u.display_name || u.username || '?').trim().charAt(0).toUpperCase(); }
function _aStamp(sec) { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:` : '') + `${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`; }
function _aDate(d) { try { return new Date(String(d).replace(' ', 'T') + (String(d).endsWith('Z') ? '' : 'Z')).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return String(d || ''); } }

function _aStopTimers() {
    if (_arenaLiveTimer) { clearInterval(_arenaLiveTimer); _arenaLiveTimer = null; }
    if (_arenaImagePoll) { clearInterval(_arenaImagePoll); _arenaImagePoll = null; }
    for (const t of _arenaBattleTimers) clearTimeout(t);
    _arenaBattleTimers = [];
    _aStopSpeaking();
    if (typeof _aTalkStop === 'function') _aTalkStop();
}

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
    const u = f.user;
    const color = u.profile_color || '#8b5cf6';
    if (f.image_url) {
        return `<div class="arena-portrait arena-portrait-${size}" style="--fc:${_aEsc(color)}"><img src="${_aEsc(f.image_url)}" alt="" loading="lazy"></div>`;
    }
    if (u.avatar_url) {
        return `<div class="arena-portrait arena-portrait-${size} arena-portrait-avatar" style="--fc:${_aEsc(color)}"><img src="${_aEsc(u.avatar_url)}" alt="" loading="lazy"><span class="arena-portrait-glow"></span></div>`;
    }
    return `<div class="arena-portrait arena-portrait-${size} arena-portrait-initial" style="--fc:${_aEsc(color)}"><span>${_aEsc(_aInitial(u))}</span></div>`;
}

function _aRatingBars(r, { clickable = false } = {}) {
    return `<div class="arena-bars">${ARENA_STATS.map(k => `
        <div class="arena-bar ${clickable ? 'is-clickable' : ''}" data-stat="${k}" title="${_aEsc(ARENA_STAT_LABEL[k])}">
            <span class="arena-bar-label">${_aEsc(ARENA_STAT_LABEL[k])}</span>
            <span class="arena-bar-track"><span class="arena-bar-fill" style="width:${Math.max(0, Math.min(100, r[k] || 0))}%"></span></span>
            <span class="arena-bar-val">${r[k] ?? '–'}</span>
        </div>`).join('')}</div>`;
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
function _aBattleLink(a, b) { return `/arena/battle/${encodeURIComponent(a.username)}/${encodeURIComponent(b.username)}`; }
function _aA(href, inner, cls = '') { return `<a class="${cls}" href="${_aEsc(href)}" onclick="return handleLinkClick(event, '${_aEsc(href)}')">${inner}</a>`; }

// ── Page entry ───────────────────────────────────────────────

async function loadArenaPage(segments = []) {
    _aStopTimers();
    const root = document.getElementById('arena-root');
    if (!root) return;
    const [, first, second, third] = segments;
    try {
        if (first === 'battle' && second && third) return await _aRenderBattle(root, second, third);
        if (first === 'talk') return second ? await _aRenderSession(root, second) : await _aRenderTalk(root);
        if (first && first !== 'battle') return await _aRenderFighter(root, first);
        return await _aRenderHome(root);
    } catch (err) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-plug-circle-xmark"></i><p>${_aEsc(err?.message || 'The arena lights went out.')}</p></div>`;
    }
}

function _aSpinner(text) { return `<div class="arena-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>${_aEsc(text)}</span></div>`; }

// ── Home: main event + live matchups + leaderboard ───────────

async function _aRenderHome(root) {
    root.innerHTML = _aSpinner('Loading the roster…');
    const [data, live] = await Promise.all([api('/arena/fighters'), api('/arena/live').catch(() => null)]);
    _arenaRoster = data;
    const fighters = data.fighters || [];
    if (!fighters.length) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-hand-fist"></i><p>No fighters yet — the roster fills with everyone who has streamed in the last 45 days.</p></div>`;
        return;
    }
    root.innerHTML = `
        <div class="arena-hero">
            <div>
                <h1><i class="fa-solid fa-hand-fist"></i> The Arena</h1>
                <p class="page-subtitle">Every streamer, ranked by the numbers and roasted by the AI. Tap a fighter to expand, pick two to fight, and let chat decide the last round.</p>
            </div>
            <div class="arena-hero-actions">
                <button class="btn btn-primary" id="arena-random"><i class="fa-solid fa-dice"></i> Random battle</button>
                ${data.ai ? '' : '<span class="arena-note" title="AI is off — stats and templated commentary only">AI commentary off</span>'}
            </div>
        </div>
        <section id="arena-main-event" class="arena-main-event" style="display:none"></section>
        <section id="arena-talk-card" class="arena-talk-card" style="display:none"></section>
        <section id="arena-live" class="arena-live"></section>
        <section class="arena-board">
            <div class="arena-board-head">
                <h2>Leaderboard</h2>
                <input id="arena-search" type="search" placeholder="Find a fighter…" autocomplete="off">
            </div>
            <div class="arena-list" id="arena-list"></div>
        </section>`;
    _aRenderLive(live);
    _aRenderList(fighters);
    api('/arena/main-event').then(me => _aRenderMainEvent(me)).catch(() => {});
    api('/arena/talk?generate=0').then(t => _aRenderTalkCard(t)).catch(() => {});
    document.getElementById('arena-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        _aRenderList(q ? fighters.filter(f => [f.user.username, f.user.display_name, f.persona.fighter_name, f.persona.class, f.persona.element].some(s => String(s || '').toLowerCase().includes(q))) : fighters);
    });
    document.getElementById('arena-random').addEventListener('click', () => {
        if (fighters.length < 2) return;
        const a = fighters[Math.floor(Math.random() * fighters.length)];
        let b = a; while (b === a) b = fighters[Math.floor(Math.random() * fighters.length)];
        navigate(_aBattleLink(a.user, b.user));
    });
    _arenaLiveTimer = setInterval(async () => {
        if (currentPage !== 'arena' || !document.getElementById('arena-live')) return _aStopTimers();
        try { _aRenderLive(await api('/arena/live')); } catch { /* keep last */ }
    }, 30000);
}

function _aRenderMainEvent(me) {
    const el = document.getElementById('arena-main-event');
    if (!el || !me || !me.a) return;
    const side = (f, s) => _aA(_aBattleLink(me.a.user, me.b.user), `${_aPortrait(f, 'sm')}<div><strong>${_aEsc(f.persona.fighter_name)}</strong><span>${_aEsc(f.user.display_name)} · #${f.rank} · PWR ${f.ratings.power}</span></div>`, `arena-me-side is-${s}`);
    const render = (votes, outcome, yourVote) => {
        el.style.display = '';
        el.innerHTML = `
            <div class="arena-main-event-head">
                <h2><i class="fa-solid fa-star"></i> Main event · ${_aEsc(me.day)}</h2>
                ${_aA(_aBattleLink(me.a.user, me.b.user), '<i class="fa-solid fa-play"></i> Watch the fight', 'btn btn-ghost')}
            </div>
            <div class="arena-main-event-body">
                ${side(me.a, 'a')}
                <div class="arena-me-center">
                    <div class="arena-me-score">${outcome.a} – ${outcome.b}</div>
                    <div class="arena-me-vote">
                        <button data-side="a" class="${yourVote === 'a' ? 'is-picked' : ''}">Back ${_aEsc(me.a.persona.fighter_name.split(' ')[0])}</button>
                        <button data-side="b" class="${yourVote === 'b' ? 'is-picked' : ''}">Back ${_aEsc(me.b.persona.fighter_name.split(' ')[0])}</button>
                    </div>
                    <div class="arena-me-tally">${votes.a + votes.b} vote${votes.a + votes.b === 1 ? '' : 's'} · ${outcome.winner ? `${_aEsc((outcome.winner === 'a' ? me.a : me.b).persona.fighter_name)} leads` : 'dead even'}</div>
                </div>
                ${side(me.b, 'b')}
            </div>
            <p class="arena-me-intro"><i class="fa-solid fa-microphone-lines"></i> ${_aEsc(me.commentary?.intro || '')}</p>`;
        el.querySelectorAll('.arena-me-vote button').forEach(btn => btn.addEventListener('click', async () => {
            btn.disabled = true;
            try { const r = await api(`/arena/battle/${encodeURIComponent(me.a.user.username)}/${encodeURIComponent(me.b.user.username)}/vote`, { method: 'POST', body: { side: btn.dataset.side } }); render(r.votes, r.outcome, r.your_side); }
            catch (err) { btn.disabled = false; if (typeof showToast === 'function') showToast(err?.message || 'Vote failed', 'error'); }
        }));
    };
    render(me.votes, me.outcome, me.your_vote || null);
}

function _aRenderLive(live) {
    const el = document.getElementById('arena-live');
    if (!el) return;
    if (!live || !live.live_count) { el.innerHTML = ''; return; }
    const card = (f, side) => `
        <a class="arena-live-fighter arena-live-${side}" href="${_aEsc(_aChannelLink(f.user))}" onclick="return handleLinkClick(event, '${_aEsc(_aChannelLink(f.user))}')">
            ${f.thumbnail_url ? `<img class="arena-live-thumb" src="${_aEsc(f.thumbnail_url)}?t=${Date.now()}" alt="">` : _aPortrait(f, 'sm')}
            <div class="arena-live-meta">
                <strong>${_aEsc(f.persona.fighter_name)}</strong>
                <span>${_aEsc(f.user.display_name)} · <i class="fa-solid fa-eye"></i> ${_aNum(f.stream.viewer_count)} · PWR ${f.ratings.power}</span>
                ${f.hot_mic ? `<span title="Hot mic — last thing the transcript heard"><i class="fa-solid fa-microphone"></i> “${_aEsc(f.hot_mic.text.length > 70 ? f.hot_mic.text.slice(0, 70) + '…' : f.hot_mic.text)}”</span>` : ''}
            </div>
        </a>`;
    el.innerHTML = `
        <h2><span class="arena-live-dot"></span> Live battles <small>${live.live_count} fighter${live.live_count === 1 ? '' : 's'} live now</small></h2>
        <div class="arena-live-grid">
            ${live.matchups.map(m => `
                <div class="arena-live-match">
                    ${card(m.a, 'a')}
                    ${_aA(_aBattleLink(m.a.user, m.b.user), 'VS<small>fight</small>', 'arena-live-vs')}
                    ${card(m.b, 'b')}
                </div>`).join('')}
            ${live.waiting ? `<div class="arena-live-match arena-live-waiting">${card(live.waiting, 'a')}<div class="arena-live-vs arena-live-vs-idle">?<small>waiting for a challenger</small></div></div>` : ''}
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
                <strong>${_aEsc(f.persona.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}<i class="fa-solid fa-chevron-right arena-chevron"></i></strong>
                <span class="arena-row-sub">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · ${_aEsc(f.persona.element)}${f.voice?.has_data ? ` · <i class="fa-solid fa-microphone" title="has transcript data"></i> Mic ${f.ratings.mic}` : ''}</span>
                <em class="arena-row-taunt">“${_aEsc(f.persona.taunt)}”</em>
            </span>
            <span class="arena-row-stats">
                <span class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></span>
                <span class="arena-record">${f.record.wins}W–${f.record.losses}L</span>
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
                    <button class="btn btn-ghost arena-row-fight" data-user="${_aEsc(f.user.username)}"><i class="fa-solid fa-hand-fist"></i> Fight someone</button>
                    ${_aSpeakBtn(f.persona.taunt, 'btn btn-ghost')}
                </div>
            </div>
        </div>`).join('');
    el.querySelectorAll('.arena-row').forEach(row => row.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        row.classList.toggle('is-open');
    }));
    el.querySelectorAll('.arena-row-fight').forEach(btn => btn.addEventListener('click', () => {
        const me = fighters.find(f => f.user.username === btn.dataset.user);
        const pool = fighters.filter(f => f !== me);
        if (!me || !pool.length) return;
        navigate(_aBattleLink(me.user, pool[Math.floor(Math.random() * pool.length)].user));
    }));
    _aBindSpeak(el);
}

// ── Fighter profile ──────────────────────────────────────────

function _aVoiceCard(f) {
    const v = f.voice || {};
    const q = f.quotes;
    const color = f.user.profile_color || '#8b5cf6';
    if (!v.has_data) {
        return `<div class="arena-voice" style="--fc:${_aEsc(color)}"><div class="arena-voice-head"><h3><i class="fa-solid fa-microphone-slash"></i> On the mic</h3></div><p class="arena-voice-empty">No transcript data yet — the audio transcription picks this up on their next streams. Until then, MIC is rated at the floor.</p></div>`;
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
                <div class="arena-quote-actions">
                    ${p.vod_id ? `<a href="/vod/${p.vod_id}?t=${p.start_sec}" onclick="return handleLinkClick(event, '/vod/${p.vod_id}?t=${p.start_sec}')" title="Hear them say it (jumps to the VOD)"><i class="fa-solid fa-play"></i></a>` : ''}
                    ${_aSpeakBtn(p.text, '')}
                </div>
            </div>`).join('')}</div>` : '<p class="arena-voice-empty">Quotes appear once enough lines have been transcribed.</p>'}
        ${q?._fallback ? '<p class="arena-note">Quotes picked by heuristic — the AI curates these once enabled.</p>' : ''}
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
    const recent = f.recent_battles || [];
    root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')}</div>
        <div class="arena-profile" style="--fc:${_aEsc(color)}">
            <div class="arena-profile-portrait" id="arena-profile-portrait">
                ${_aPortrait(f, 'lg')}
                ${f.image_pending ? '<div class="arena-portrait-pending"><i class="fa-solid fa-wand-magic-sparkles fa-fade"></i> painting portrait…</div>' : ''}
                <div class="arena-profile-rank">#${f.rank} <small>of ${f.roster_size}</small></div>
                ${f.rivalry ? `<div class="arena-mini-record"><i class="fa-solid fa-fire"></i> Rivalry: ${_aA(_aBattleLink(f.user, f.rivalry.opponent), _aEsc(f.rivalry.fighter_name))} (${f.rivalry.wins}–${f.rivalry.losses} in ${f.rivalry.fights} fights)</div>` : ''}
            </div>
            <div class="arena-profile-main">
                <div class="arena-profile-name">
                    <h1>${_aEsc(p.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</h1>
                    <p class="arena-title">${_aEsc(p.title)}</p>
                    <p class="arena-handle">${_aA(_aChannelLink(f.user), `${_aEsc(f.user.display_name)} · @${_aEsc(f.user.username)}`)} · ${_aEsc(p.class)} · ${_aEsc(p.element)}</p>
                </div>
                <div class="arena-profile-power">
                    <div class="arena-power arena-power-lg"><b>${f.ratings.power}</b><small>POWER</small></div>
                    ${f.ratings.talk_bonus ? `<div class="arena-talk-bonus" title="Trash Talk bonus — earned on /arena/talk, decays over a week"><i class="fa-solid fa-microphone-lines"></i> +${f.ratings.talk_bonus} trash talk</div>` : ''}
                    <div class="arena-record arena-record-lg">${f.record.wins}W – ${f.record.losses}L</div>
                </div>
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
        ${(f.trash_talk || []).length ? `<section class="arena-challenge"><h2><i class="fa-solid fa-microphone-lines"></i> Trash talk record</h2><div class="arena-talk-list">${f.trash_talk.map(e => _aTalkEntry(e, { compact: true })).join('')}</div></section>` : ''}
        ${recent.length ? `<section class="arena-challenge"><h2>Recent fights</h2><div class="arena-opponents">${recent.map(b => _aA(_aBattleLink(f.user, b.opponent), `${_aPortrait({ user: b.opponent }, 'xs')}<span><strong>${b.result === 'win' ? '<span style="color:var(--success)">W</span>' : b.result === 'loss' ? '<span style="color:var(--danger)">L</span>' : 'D'} vs ${_aEsc(b.opponent_fighter_name)}</strong><small>${_aEsc(b.day)} · rounds ${b.rounds_won}/${b.rounds_total}</small></span>`, 'arena-opponent')).join('')}</div></section>` : ''}
        <section class="arena-challenge">
            <h2>Pick an opponent</h2>
            <div class="arena-opponents" id="arena-opponents">${_aSpinner('Scouting…')}</div>
        </section>`;
    _aBindSpeak(root);

    // Stat drill-down
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

    // Portrait lightbox ("how this was painted")
    const portrait = root.querySelector('.arena-portrait-lg');
    if (portrait && f.image_url) portrait.addEventListener('click', () => _aLightbox(f));

    // Opponent picker
    try {
        const data = _arenaRoster || await api('/arena/fighters');
        _arenaRoster = data;
        const others = (data.fighters || []).filter(o => o.user.id !== f.user.id);
        const el = document.getElementById('arena-opponents');
        el.innerHTML = others.map(o => _aA(_aBattleLink(f.user, o.user), `${_aPortrait(o, 'xs')}<span><strong>${_aEsc(o.persona.fighter_name)}</strong><small>#${o.rank} · PWR ${o.ratings.power}${o.live ? ' · LIVE' : ''}</small></span>`, 'arena-opponent')).join('') || '<p class="arena-note">Nobody else on the roster yet.</p>';
    } catch { /* */ }

    // Poll for the AI portrait while it is being painted.
    if (f.image_pending || (!f.image_url && f.image_generation === 'ai')) {
        let tries = 0;
        _arenaImagePoll = setInterval(async () => {
            if (++tries > 20 || currentPage !== 'arena') return _aStopTimers();
            try {
                const fresh = await api(`/arena/fighters/${encodeURIComponent(username)}?generate=0`);
                if (fresh.image_url) {
                    const holder = document.getElementById('arena-profile-portrait');
                    if (holder) {
                        holder.querySelector('.arena-portrait')?.outerHTML && (holder.querySelector('.arena-portrait').outerHTML = _aPortrait(fresh, 'lg'));
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

// ── Battle ───────────────────────────────────────────────────

function _aTape(A, B) {
    const rows = [
        ['Rank', `#${A.rank}`, `#${B.rank}`, A.rank < B.rank ? 'a' : B.rank < A.rank ? 'b' : null],
        ['Power', A.ratings.power, B.ratings.power],
        ['Hours live (90d)', A.raw.hours, B.raw.hours],
        ['Peak viewers', A.raw.peak_viewers, B.raw.peak_viewers],
        ['Avg viewers', A.raw.avg_viewers, B.raw.avg_viewers],
        ['Chat msgs / hr', A.raw.messages_per_hour, B.raw.messages_per_hour],
        ['Followers', A.raw.followers, B.raw.followers],
        ['Clips', A.raw.clips, B.raw.clips],
        ['Talk time %', A.raw.voice?.talk_ratio_pct ?? 0, B.raw.voice?.talk_ratio_pct ?? 0],
        ['Hype words / hr', A.raw.voice?.hype_per_hour ?? 0, B.raw.voice?.hype_per_hour ?? 0],
        ['Record', `${A.record.wins}–${A.record.losses}`, `${B.record.wins}–${B.record.losses}`, A.record.wins > B.record.wins ? 'a' : B.record.wins > A.record.wins ? 'b' : null],
    ];
    return `<details class="arena-tape"><summary><i class="fa-solid fa-scale-balanced"></i> Tale of the tape</summary><table>
        <thead><tr><th>${_aEsc(A.persona.fighter_name)}</th><th></th><th>${_aEsc(B.persona.fighter_name)}</th></tr></thead>
        <tbody>${rows.map(([label, a, b, better]) => {
            const win = better !== undefined ? better : (Number(a) > Number(b) ? 'a' : Number(b) > Number(a) ? 'b' : null);
            return `<tr><td class="${win === 'a' ? 'is-better' : ''}">${_aEsc(_aNum(a) === 'NaN' ? a : (typeof a === 'number' ? _aNum(a) : a))}</td><td class="arena-tape-label">${_aEsc(label)}</td><td class="${win === 'b' ? 'is-better' : ''}">${_aEsc(typeof b === 'number' ? _aNum(b) : b)}</td></tr>`;
        }).join('')}</tbody></table></details>`;
}

async function _aRenderBattle(root, a, b) {
    root.innerHTML = `<div class="arena-loading arena-loading-battle"><i class="fa-solid fa-bolt fa-beat"></i><span>Fighters are entering the arena…</span><small>the announcer is warming up</small></div>`;
    const battle = await api(`/arena/battle/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    const A = battle.a, B = battle.b;
    const side = (f, s) => `
        <div class="arena-side arena-side-${s} ${battle.outcome.winner === s ? 'is-winner' : ''}" style="--fc:${_aEsc(f.user.profile_color || (s === 'a' ? '#8b5cf6' : '#ec4899'))}">
            ${_aA(_aFighterLink(f.user), _aPortrait(f, 'md'))}
            <h2>${_aEsc(f.persona.fighter_name)}</h2>
            <p class="arena-title">${_aEsc(f.persona.title)}</p>
            <p class="arena-handle">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · #${f.rank}</p>
            <div class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></div>
            ${_aRatingBars(f.ratings)}
            <p class="arena-side-taunt">“${_aEsc(f.persona.taunt)}” ${_aSpeakBtn(f.persona.taunt)}</p>
            ${f.walkout ? `<p class="arena-walkout"><i class="fa-solid fa-microphone"></i> Walkout line: <q>${_aEsc(f.walkout.text)}</q> ${f.walkout.vod_id ? `<a href="/vod/${f.walkout.vod_id}?t=${f.walkout.start_sec}" onclick="return handleLinkClick(event, '/vod/${f.walkout.vod_id}?t=${f.walkout.start_sec}')" title="Hear them say it"><i class="fa-solid fa-play"></i> hear it</a>` : ''}</p>` : ''}
        </div>`;
    const h = battle.history || { fights: 0 };
    root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')} <span class="arena-note">Battle of ${_aEsc(battle.day)} — same matchup, same rounds all day; the crowd vote is the last round.</span></div>
        <div class="arena-battle">
            ${side(A, 'a')}
            <div class="arena-center">
                <div class="arena-vs">VS</div>
                <div class="arena-scoreboard" id="arena-scoreboard"><span id="arena-score-a">0</span><span class="arena-score-sep">–</span><span id="arena-score-b">0</span></div>
                <div class="arena-history">${h.fights ? `All-time: ${_aEsc(A.persona.fighter_name)} ${h.a_wins} – ${h.b_wins} ${_aEsc(B.persona.fighter_name)} (${h.fights} fight${h.fights === 1 ? '' : 's'})` : 'First meeting'}</div>
                <div class="arena-commentary" id="arena-commentary"></div>
                <div class="arena-vote" id="arena-vote"></div>
                ${_aTape(A, B)}
                <div class="arena-battle-actions">
                    <button class="btn btn-ghost" id="arena-share"><i class="fa-solid fa-link"></i> Share</button>
                    ${_aA(_aBattleLink(B.user, A.user), '<i class="fa-solid fa-right-left"></i> Swap corners', 'btn btn-ghost')}
                    <button class="btn btn-ghost" id="arena-rematch"><i class="fa-solid fa-dice"></i> Random rematch</button>
                    <button class="btn btn-ghost" id="arena-replay"><i class="fa-solid fa-rotate-left"></i> Replay</button>
                </div>
            </div>
            ${side(B, 'b')}
        </div>`;
    _aBindSpeak(root);
    _aPlayBattle(battle);
    document.getElementById('arena-share').addEventListener('click', async () => {
        const url = `${location.origin}${_aBattleLink(A.user, B.user)}`;
        try { await navigator.clipboard.writeText(url); document.getElementById('arena-share').innerHTML = '<i class="fa-solid fa-check"></i> Copied'; } catch { prompt('Battle link', url); }
    });
    document.getElementById('arena-replay').addEventListener('click', () => { for (const t of _arenaBattleTimers) clearTimeout(t); _arenaBattleTimers = []; _aPlayBattle(battle); });
    document.getElementById('arena-rematch').addEventListener('click', async () => {
        const data = _arenaRoster || await api('/arena/fighters');
        _arenaRoster = data;
        const pool = (data.fighters || []).filter(f => f.user.id !== A.user.id);
        if (!pool.length) return;
        navigate(_aBattleLink(A.user, pool[Math.floor(Math.random() * pool.length)].user));
    });
}

/** Reveal rounds one by one, then the finisher, verdict and the crowd vote. */
function _aPlayBattle(battle) {
    const A = battle.a, B = battle.b, c = battle.commentary;
    const box = document.getElementById('arena-commentary');
    const sa = document.getElementById('arena-score-a'), sb = document.getElementById('arena-score-b');
    box.innerHTML = ''; sa.textContent = '0'; sb.textContent = '0';
    document.getElementById('arena-vote').innerHTML = '';
    let a = 0, b = 0;
    const line = (html, cls = '', detail = null) => {
        const d = document.createElement('div');
        d.className = `arena-line ${cls}${detail ? ' is-expandable' : ''}`;
        d.innerHTML = html + (detail ? `<div class="arena-line-detail">${detail}</div>` : '');
        if (detail) d.addEventListener('click', () => d.classList.toggle('is-open'));
        box.appendChild(d); box.scrollTop = box.scrollHeight;
    };
    const at = (ms, fn) => _arenaBattleTimers.push(setTimeout(fn, ms));
    let t = 0;
    line(`<i class="fa-solid fa-microphone-lines"></i> ${_aEsc(c.intro)}`, 'arena-line-intro');
    battle.rounds.forEach((r, i) => {
        t += 1400;
        at(t, () => {
            const winner = r.winner === 'a' ? A : B;
            if (r.winner === 'a') a++; else b++;
            sa.textContent = a; sb.textContent = b;
            const meta = battle.stat_meta?.[r.stat];
            const detail = `${_aEsc(ARENA_STAT_LABEL[r.stat])} rating ${A.ratings[r.stat]} vs ${B.ratings[r.stat]} (${_aEsc(meta?.desc || '')}) · roll ${r.a} vs ${r.b}, margin ${r.margin}${r.upset ? ' · the lower rating won this one' : ''} · tap to collapse`;
            line(`<span class="arena-round-tag">R${i + 1} · ${_aEsc(r.label)}</span> ${_aEsc(c.rounds[i] || `${winner.persona.fighter_name} takes it.`)} <span class="arena-round-score">${r.a}–${r.b}${r.upset ? ' · UPSET' : ''}</span>`, `arena-line-${r.winner}${r.upset ? ' arena-line-upset' : ''}`, detail);
            document.querySelector(`.arena-side-${r.winner}`)?.classList.add('is-hit');
            setTimeout(() => document.querySelector(`.arena-side-${r.winner}`)?.classList.remove('is-hit'), 600);
        });
    });
    t += 1400;
    at(t, () => line(`<i class="fa-solid fa-burst"></i> ${_aEsc(c.finisher)}`, 'arena-line-finisher'));
    t += 1200;
    at(t, () => {
        line(`<i class="fa-solid fa-gavel"></i> ${_aEsc(c.verdict)} ${_aSpeakBtn(`${c.intro} ${c.rounds.join(' ')} ${c.finisher} ${c.verdict}`)}`, 'arena-line-verdict');
        _aBindSpeak(box);
        _aRenderVote(battle);
    });
}

function _aRenderVote(battle) {
    const el = document.getElementById('arena-vote');
    if (!el) return;
    const A = battle.a, B = battle.b;
    const render = (votes, outcome, yourVote) => {
        const total = votes.a + votes.b;
        const pa = total ? Math.round((votes.a / total) * 100) : 50;
        const crowdLine = outcome.crowd ? `Crowd round → <b>${_aEsc((outcome.crowd === 'a' ? A : B).persona.fighter_name)}</b>` : 'Crowd round is still open — no votes yet';
        const finalLine = outcome.winner
            ? `<b>${_aEsc((outcome.winner === 'a' ? A : B).persona.fighter_name)}</b> wins ${outcome.a}–${outcome.b}${outcome.tiebreak ? ' (tiebreak: Power)' : ''}`
            : 'Dead even — your vote decides it';
        el.innerHTML = `
            <div class="arena-vote-head">Who are you backing?</div>
            <div class="arena-vote-buttons">
                <button class="arena-vote-btn arena-vote-a ${yourVote === 'a' ? 'is-picked' : ''}" data-side="a">${_aEsc(A.persona.fighter_name)}</button>
                <button class="arena-vote-btn arena-vote-b ${yourVote === 'b' ? 'is-picked' : ''}" data-side="b">${_aEsc(B.persona.fighter_name)}</button>
            </div>
            <div class="arena-vote-bar"><span style="width:${pa}%"></span></div>
            <div class="arena-vote-tally"><span>${votes.a} vote${votes.a === 1 ? '' : 's'}</span><span>${votes.b} vote${votes.b === 1 ? '' : 's'}</span></div>
            <div class="arena-vote-result">${crowdLine}<br>${finalLine}</div>`;
        document.getElementById('arena-score-a').textContent = outcome.a;
        document.getElementById('arena-score-b').textContent = outcome.b;
        document.querySelectorAll('.arena-side').forEach(s => s.classList.remove('is-winner'));
        if (outcome.winner) document.querySelector(`.arena-side-${outcome.winner}`)?.classList.add('is-winner');
        el.querySelectorAll('.arena-vote-btn').forEach(btn => btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const r = await api(`/arena/battle/${encodeURIComponent(A.user.username)}/${encodeURIComponent(B.user.username)}/vote`, { method: 'POST', body: { side: btn.dataset.side } });
                render(r.votes, r.outcome, r.your_side);
            } catch (err) {
                btn.disabled = false;
                if (typeof showToast === 'function') showToast(err?.message || 'Vote failed', 'error');
            }
        }));
    };
    render(battle.votes, battle.outcome, battle.your_vote || null);
}

// ── Trash Talk ───────────────────────────────────────────────

const ARENA_TALK_SCORES = [['spice', 'Spice', 'fa-pepper-hot'], ['wit', 'Wit', 'fa-brain'], ['on_topic', 'On topic', 'fa-bullseye'], ['delivery', 'Delivery', 'fa-microphone'], ['crowd', 'Crowd', 'fa-people-group']];
let _arenaTalkTimers = [];
function _aTalkStop() { for (const t of _arenaTalkTimers) clearInterval(t); _arenaTalkTimers = []; }

function _aStampClass(stamp) { return `arena-stamp arena-stamp--${String(stamp || '').toLowerCase()}`; }
function _aCountdown(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return 'new topic any moment';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h ? `${h}h ${m}m left` : `${m}m left`;
}

/** Topic card on the Arena home. */
function _aRenderTalkCard(t) {
    const el = document.getElementById('arena-talk-card');
    if (!el || !t || !t.topic) return;
    const top = t.entries && t.entries[0];
    el.style.display = '';
    el.innerHTML = `
        <div class="arena-talk-card-head"><h2><i class="fa-solid fa-microphone-lines"></i> Trash Talk <small>${_aEsc(_aCountdown(t.topic.ends_at))}</small></h2>${_aA('/arena/talk', `<i class="fa-solid fa-fire"></i> ${t.can_enter ? 'Enter now' : 'Open'}`, 'btn btn-primary')}</div>
        <p class="arena-talk-topic">“${_aEsc(t.topic.topic)}”</p>
        <div class="arena-talk-card-foot">
            <span>${t.entries?.length ? `${t.entries.length} entr${t.entries.length === 1 ? 'y' : 'ies'}` : 'No entries yet — be first'}${top ? ` · leading: <b>${_aEsc(top.fighter_name)}</b> ${top.total}/50 <span class="${_aStampClass(top.stamp)}">${_aEsc(top.stamp)}</span>` : ''}</span>
            <span class="arena-note">Streamers talk on the mic or type it · the AI judges · chat types <code>!hype</code> · up to +${t.rules?.bonus_max || 12} POWER</span>
        </div>`;
}

function _aScoreBars(scores, { animate = false } = {}) {
    if (!scores) return '';
    return `<div class="arena-talk-scores ${animate ? 'is-animated' : ''}">${ARENA_TALK_SCORES.map(([k, label, icon], i) => `
        <div class="arena-talk-score" style="--i:${i}">
            <span class="arena-talk-score-label"><i class="fa-solid ${icon}"></i> ${_aEsc(label)}</span>
            <span class="arena-talk-score-track"><span class="arena-talk-score-fill" style="width:${Math.min(100, (Number(scores[k]) || 0) * 10)}%"></span></span>
            <b>${Number(scores[k]) || 0}</b>
        </div>`).join('')}</div>`;
}

function _aTalkEntry(e, { compact = false, mine = false, hypeable = true } = {}) {
    const flagged = e.flagged;
    const jump = e.vod_id && e.start_sec != null ? `<a class="arena-talk-hear" href="/vod/${e.vod_id}?t=${e.start_sec}" onclick="return handleLinkClick(event, '/vod/${e.vod_id}?t=${e.start_sec}')" title="Hear them say it"><i class="fa-solid fa-play"></i> hear it</a>` : '';
    return `<div class="arena-talk-entry ${flagged ? 'is-flagged' : ''} ${mine ? 'is-mine' : ''}" data-id="${e.id}">
        <div class="arena-talk-entry-head">
            ${e.user ? _aA(_aFighterLink(e.user), `${_aPortrait({ user: e.user, image_url: e.image_url }, 'xs')}<span><strong>${_aEsc(e.fighter_name)}</strong><small>${_aEsc(e.user.display_name)}${e.rank ? ` · #${e.rank}` : ''} · ${e.source === 'mic' ? '<i class="fa-solid fa-microphone"></i> live mic' : '<i class="fa-solid fa-keyboard"></i> typed'}${e.topic ? ` · <em>${_aEsc(e.topic)}</em>` : ''}</small></span>`, 'arena-talk-who') : ''}
            <div class="arena-talk-total"><b>${e.total}</b><small>/50</small> <span class="${_aStampClass(e.stamp)}">${_aEsc(e.stamp || '')}</span></div>
        </div>
        ${e.text ? `<blockquote class="arena-talk-text">${_aEsc(e.text)} ${_aSpeakBtn(e.text)} ${jump}</blockquote>` : '<p class="arena-talk-void"><i class="fa-solid fa-ban"></i> Voided by the judge — crossed the line.</p>'}
        ${e.verdict ? `<p class="arena-talk-verdict"><i class="fa-solid fa-gavel"></i> ${_aEsc(e.verdict)}</p>` : ''}
        ${!compact ? _aScoreBars(e.scores) : ''}
        ${!compact && e.note && (mine || !flagged) ? `<p class="arena-talk-note">Judge's note: ${_aEsc(e.note)}</p>` : ''}
        ${!compact && !flagged ? `<div class="arena-talk-hype"><button class="btn btn-ghost btn-sm arena-hype-btn" data-id="${e.id}" ${!hypeable || !e.hype_open ? 'disabled' : ''}><i class="fa-solid fa-fire"></i> Hype</button><span class="arena-talk-hype-count">${e.crowd_uniques} hyped · Crowd ${e.scores?.crowd ?? 0}/10</span><span class="arena-note">or type <code>!hype</code> in their chat</span></div>` : ''}
    </div>`;
}

async function _aRenderTalk(root) {
    _aTalkStop();
    root.innerHTML = _aSpinner('Setting up the ring…');
    const t = await api('/arena/talk');
    const topic = t.topic;
    const me = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    const rules = t.rules || {};
    root.innerHTML = `
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> Arena')}</div>
        <div class="arena-talk-hero">
            <div class="arena-talk-hero-main">
                <div class="arena-talk-kicker"><i class="fa-solid fa-microphone-lines"></i> Trash Talk · topic changes every ${rules.topic_slot_hours || 6} h · <span id="arena-talk-countdown">${_aEsc(_aCountdown(topic.ends_at))}</span></div>
                <h1 class="arena-talk-topic-big">“${_aEsc(topic.topic)}”</h1>
                ${topic.hint ? `<p class="arena-talk-hint"><i class="fa-solid fa-lightbulb"></i> ${_aEsc(topic.hint)}</p>` : ''}
            </div>
            <div class="arena-talk-how">
                <h3>How it works</h3>
                <ol>
                    <li><b>Streamers</b> on the roster answer the topic — on the <b>live mic</b> (we transcribe what you say on stream) or by <b>typing</b> it.</li>
                    <li>The <b>AI judge</b> scores Spice, Wit, On-topic and Delivery (0–10 each). Slurs or cruelty void the entry.</li>
                    <li><b>Viewers</b> add the fifth score: type <code>!hype</code> in that streamer's chat (or tap Hype here). 3 people = 1 point, up to 10.</li>
                    <li>Your total (/50) becomes a <b>Trash Talk bonus</b> on POWER — up to +${rules.bonus_max || 12}, fading over ${rules.bonus_days || 7} days.</li>
                </ol>
                <p class="arena-note">Chat commands: <code>!talk</code> topic · <code>!hype</code> · <code>!arena</code> card · <code>!vote a|b</code> main event · <code>!fight &lt;user&gt;</code></p>
            </div>
        </div>
        <section class="arena-sessions-live" id="arena-live-sessions" style="display:none"></section>
        <section id="arena-session-card"></section>
        <section class="arena-talk-enter" id="arena-talk-enter"></section>
        <section class="arena-board">
            <div class="arena-board-head"><h2>This topic's entries <small class="arena-note">${t.entries.length} so far</small></h2>${t.ai ? '' : '<span class="arena-note">AI judge is off — heuristic scoring</span>'}</div>
            <div class="arena-talk-list" id="arena-talk-entries">${t.entries.length ? t.entries.map(e => _aTalkEntry(e, { mine: me && e.user.id === me.id })).join('') : '<div class="arena-empty"><i class="fa-solid fa-microphone-slash"></i><p>Nobody has talked yet. The mic is right there.</p></div>'}</div>
        </section>
        ${t.hall_of_trash?.length ? `<section class="arena-board"><div class="arena-board-head"><h2><i class="fa-solid fa-trophy"></i> Hall of Trash <small class="arena-note">best lines, last 30 days</small></h2></div><div class="arena-talk-list">${t.hall_of_trash.map(e => _aTalkEntry(e, { compact: true })).join('')}</div></section>` : ''}`;
    _aBindSpeak(root);
    _aBindHype(root);
    _aRenderTalkEnter(t, me);
    _aRenderSessionCard(t, me);
    api('/arena/talk/sessions').then(r => _aRenderLiveSessions(r.sessions || [])).catch(() => {});
    _arenaTalkTimers.push(setInterval(() => { const el = document.getElementById('arena-talk-countdown'); if (el) el.textContent = _aCountdown(topic.ends_at); }, 30000));
}

function _aBindHype(root) {
    root.querySelectorAll('.arena-hype-btn').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const r = await api(`/arena/talk/${btn.dataset.id}/hype`, { method: 'POST' });
            const entry = btn.closest('.arena-talk-entry');
            entry.querySelector('.arena-talk-hype-count').textContent = `${r.crowd_uniques} hyped · Crowd ${r.crowd}/10`;
            entry.querySelector('.arena-talk-total').innerHTML = `<b>${r.total}</b><small>/50</small> <span class="${_aStampClass(r.stamp)}">${_aEsc(r.stamp)}</span>`;
            const crowdFill = entry.querySelectorAll('.arena-talk-score-fill')[4]; if (crowdFill) crowdFill.style.width = `${Math.min(100, r.crowd * 10)}%`;
            const crowdNum = entry.querySelectorAll('.arena-talk-score b')[4]; if (crowdNum) crowdNum.textContent = r.crowd;
            btn.innerHTML = r.added ? '<i class="fa-solid fa-fire"></i> Hyped!' : '<i class="fa-solid fa-check"></i> Already hyped';
            entry.classList.add('is-hit'); setTimeout(() => entry.classList.remove('is-hit'), 600);
        } catch (err) { btn.disabled = false; if (typeof showToast === 'function') showToast(err?.message || 'Hype failed', 'error'); }
    }));
}

/** The entry panel: live mic (countdown + hot-mic feed) or typed, then the score reveal. */
function _aRenderTalkEnter(t, me) {
    const el = document.getElementById('arena-talk-enter');
    if (!el) return;
    if (!me) { el.innerHTML = `<div class="arena-talk-gate"><i class="fa-solid fa-right-to-bracket"></i> <b>Streamers:</b> sign in to enter. <b>Viewers:</b> hype an entry below, or type <code>!hype</code> in the streamer's chat.</div>`; return; }
    if (!t.on_roster) { el.innerHTML = `<div class="arena-talk-gate"><i class="fa-solid fa-hand-fist"></i> You're not on the roster yet — stream once and you're in. Until then: hype away.</div>`; return; }
    if (t.my_entry) { el.innerHTML = `<div class="arena-talk-gate is-done"><i class="fa-solid fa-circle-check"></i> You're in this round — <b>${t.my_entry.total}/50 · ${_aEsc(t.my_entry.stamp)}</b>. Next topic in ${_aEsc(_aCountdown(t.topic.ends_at))}. Tell chat to <code>!hype</code>.</div>`; return; }
    const mic = t.mic || {};
    el.innerHTML = `
        <div class="arena-talk-panel">
            <div class="arena-talk-panel-head"><h2><i class="fa-solid fa-fire"></i> Your turn</h2><span class="arena-note">one entry per topic</span></div>
            <div class="arena-talk-modes">
                <button class="arena-talk-mode ${mic.available ? 'active' : ''}" data-mode="mic" ${mic.available ? '' : 'disabled'} title="${mic.available ? 'Say it on stream — we transcribe it' : mic.reason === 'not_live' ? 'Go live to use the live mic' : 'Live, but no transcription yet — talk for a few seconds and reload, or type it'}"><i class="fa-solid fa-microphone"></i> Live mic${mic.available ? '' : mic.reason === 'not_live' ? ' <small>(go live)</small>' : ' <small>(no transcript yet)</small>'}</button>
                <button class="arena-talk-mode ${mic.available ? '' : 'active'}" data-mode="text"><i class="fa-solid fa-keyboard"></i> Type it</button>
            </div>
            <div class="arena-talk-mode-body" id="arena-talk-mode-body"></div>
            <div class="arena-talk-result" id="arena-talk-result"></div>
        </div>`;
    const body = document.getElementById('arena-talk-mode-body');
    const renderMode = (mode) => {
        el.querySelectorAll('.arena-talk-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        if (mode === 'text') {
            body.innerHTML = `<textarea id="arena-talk-text" maxlength="${t.rules.text_max}" rows="3" placeholder="Talk your talk… (${t.rules.text_max} characters, PG-13, petty not cruel)"></textarea>
                <div class="arena-talk-actions"><span class="arena-note" id="arena-talk-count">0 / ${t.rules.text_max}</span><button class="btn btn-primary" id="arena-talk-submit"><i class="fa-solid fa-gavel"></i> Send it to the judge</button></div>`;
            const ta = document.getElementById('arena-talk-text');
            ta.addEventListener('input', () => { document.getElementById('arena-talk-count').textContent = `${ta.value.length} / ${t.rules.text_max}`; });
            document.getElementById('arena-talk-submit').addEventListener('click', () => submit('text', ta.value));
        } else {
            body.innerHTML = `<div class="arena-mic">
                <div class="arena-mic-status" id="arena-mic-status"><span class="arena-mic-dot"></span> Ready. Press start, then say it on stream — you have ${t.rules.mic_window_sec}s.</div>
                <div class="arena-mic-feed" id="arena-mic-feed"><span class="arena-note">Hot mic — what the transcription hears shows up here (a few seconds behind).</span></div>
                <div class="arena-talk-actions"><button class="btn btn-primary" id="arena-mic-start"><i class="fa-solid fa-microphone"></i> I'm about to cook</button><button class="btn btn-ghost" id="arena-mic-drop" disabled><i class="fa-solid fa-hand-point-down"></i> Drop the mic</button></div>
            </div>`;
            let poll = null;
            document.getElementById('arena-mic-start').addEventListener('click', async () => {
                try {
                    await api('/arena/talk/mic/start', { method: 'POST' });
                    document.getElementById('arena-mic-start').disabled = true; document.getElementById('arena-mic-drop').disabled = false;
                    const status = document.getElementById('arena-mic-status'), feed = document.getElementById('arena-mic-feed');
                    status.classList.add('is-live');
                    poll = setInterval(async () => {
                        try {
                            const f = await api('/arena/talk/mic/feed');
                            if (!f.active) return;
                            status.innerHTML = `<span class="arena-mic-dot"></span> LIVE MIC · ${f.remaining_sec}s left · ${f.lines.length} line${f.lines.length === 1 ? '' : 's'} heard`;
                            if (f.lines.length) feed.innerHTML = f.lines.map(l => `<div class="arena-mic-line"><span>${_aStamp(l.at)}</span>${_aEsc(l.text)}</div>`).join('');
                            if (f.remaining_sec <= 0) { clearInterval(poll); poll = null; submit('mic'); }
                        } catch { /* */ }
                    }, 2500);
                    _arenaTalkTimers.push(poll);
                } catch (err) { if (typeof showToast === 'function') showToast(err?.message || 'Could not start', 'error'); }
            });
            document.getElementById('arena-mic-drop').addEventListener('click', () => { if (poll) { clearInterval(poll); poll = null; } submit('mic'); });
        }
    };
    const submit = async (mode, text) => {
        const res = document.getElementById('arena-talk-result');
        el.querySelectorAll('button').forEach(b => b.disabled = true);
        res.innerHTML = `<div class="arena-loading"><i class="fa-solid fa-gavel fa-shake"></i><span>The judge is reading…</span></div>`;
        try {
            const r = await api('/arena/talk/submit', { method: 'POST', body: { mode, text } });
            const e = r.entry;
            body.innerHTML = '';
            res.innerHTML = `<div class="arena-talk-reveal ${e.flagged ? 'is-flagged' : ''}">
                <div class="arena-talk-reveal-head"><span class="arena-talk-reveal-total"><b id="arena-reveal-total">0</b><small>/50</small></span><span class="${_aStampClass(e.stamp)} arena-stamp--big" id="arena-reveal-stamp">${_aEsc(e.stamp)}</span></div>
                <blockquote class="arena-talk-text">${_aEsc(e.text || '')}</blockquote>
                ${_aScoreBars(e.scores || { spice: 0, wit: 0, on_topic: 0, delivery: 0, crowd: 0 }, { animate: true })}
                <p class="arena-talk-verdict"><i class="fa-solid fa-gavel"></i> ${_aEsc(e.verdict || '')}</p>
                ${e.note ? `<p class="arena-talk-note">Judge's note: ${_aEsc(e.note)}</p>` : ''}
                <p class="arena-note">${e.flagged ? 'This entry was voided and is hidden from others.' : `Now tell chat to type <code>!hype</code> — every 3 people add a Crowd point. Bonus lands on your POWER within a minute.`}</p>
            </div>`;
            const totalEl = document.getElementById('arena-reveal-total');
            const start = performance.now(), dur = 1400;
            const tick = (now) => { const p = Math.min(1, (now - start) / dur); totalEl.textContent = (e.total * (1 - Math.pow(1 - p, 3))).toFixed(p < 1 ? 1 : 0); if (p < 1) requestAnimationFrame(tick); else totalEl.textContent = e.total; };
            requestAnimationFrame(tick);
            const list = document.getElementById('arena-talk-entries');
            if (list) { const empty = list.querySelector('.arena-empty'); if (empty) empty.remove(); list.insertAdjacentHTML('afterbegin', _aTalkEntry(e, { mine: true, hypeable: false })); _aBindSpeak(list); _aBindHype(list); }
        } catch (err) {
            res.innerHTML = `<div class="arena-talk-gate is-error"><i class="fa-solid fa-triangle-exclamation"></i> ${_aEsc(err?.message || 'The judge walked out.')}</div>`;
            el.querySelectorAll('button').forEach(b => b.disabled = false);
        }
    };
    el.querySelectorAll('.arena-talk-mode').forEach(b => b.addEventListener('click', () => renderMode(b.dataset.mode)));
    renderMode(mic.available ? 'mic' : 'text');
}

// ── Live trash-talk sessions ─────────────────────────────────

function _aSessionLink(u) { return `/arena/talk/${encodeURIComponent(u.username)}`; }

function _aRenderLiveSessions(list) {
    const el = document.getElementById('arena-live-sessions');
    if (!el) return;
    if (!list.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `<h2><span class="arena-live-dot"></span> Talking trash right now</h2><div class="arena-session-strip">${list.map(s => _aA(_aSessionLink(s.user), `<span class="arena-live-dot"></span><span><strong>${_aEsc(s.fighter_name)}</strong><small>${_aEsc(s.topic || '…')} · ${s.progress}%</small></span><span class="arena-session-lvl">LVL ${s.level}</span>`, 'arena-session-chip')).join('')}</div>`;
}

/** Streamer-side card on /arena/talk: start a live session, or jump to the running one. */
async function _aRenderSessionCard(t, me) {
    const el = document.getElementById('arena-session-card');
    if (!el || !me || !t.on_roster) return;
    let view = null;
    try { view = await api(`/arena/talk/session/${encodeURIComponent(me.username)}`); } catch { view = null; }
    const live = view?.session && view.session.status === 'live';
    const mic = t.mic || {};
    el.innerHTML = `<div class="arena-talk-panel">
        <div class="arena-talk-panel-head"><h2><i class="fa-solid fa-tower-broadcast"></i> Live session <span class="arena-note" style="font-weight:400">power-level by talking trash on stream</span></h2>${live ? '<span class="arena-session-status"><span class="arena-live-dot"></span> live now</span>' : ''}</div>
        <p class="arena-note" style="margin:0 0 10px">Start a session while you're live and the transcription does the rest: talk trash on the current topic, the judge scores it every ~30 s, the bar fills, the topic changes when you've cleared it, and every cleared topic counts for your POWER. Viewers push it with <code>!hype</code>.</p>
        <div class="arena-session-controls">
            ${live ? _aA(_aSessionLink(me), '<i class="fa-solid fa-satellite-dish"></i> Open your live console', 'btn btn-primary')
                : `<button class="btn btn-primary" id="arena-session-start" ${mic.available ? '' : 'disabled'} title="${mic.available ? '' : mic.reason === 'not_live' ? 'Go live first' : 'Live, but no transcription yet — talk for a few seconds and reload'}"><i class="fa-solid fa-play"></i> Start live session${mic.available ? '' : mic.reason === 'not_live' ? ' <small>(go live first)</small>' : ' <small>(waiting for transcription)</small>'}</button>`}
            ${view?.session && !live ? `<span class="arena-note">Last session: level ${view.session.level}, ${view.session.topics_cleared} topic${view.session.topics_cleared === 1 ? '' : 's'} cleared${view.session.end_reason ? ` (${_aEsc(String(view.session.end_reason).replace('_', ' '))})` : ''}</span>` : ''}
        </div>
    </div>`;
    el.querySelector('#arena-session-start')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { await api('/arena/talk/session/start', { method: 'POST' }); navigate(_aSessionLink(me)); }
        catch (err) { e.target.disabled = false; if (typeof showToast === 'function') showToast(err?.message || 'Could not start', 'error'); }
    });
}

async function _aRenderSession(root, username) {
    _aTalkStop();
    root.innerHTML = _aSpinner('Tuning in…');
    let v;
    try { v = await api(`/arena/talk/session/${encodeURIComponent(username)}`); }
    catch (err) { root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-user-slash"></i><p>${_aEsc(err?.message || 'No such fighter')}</p></div>`; return; }
    const me = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    const mine = !!(me && me.id === v.user.id);
    if (!v.session) {
        root.innerHTML = `<div class="arena-back">${_aA('/arena/talk', '<i class="fa-solid fa-arrow-left"></i> Trash Talk')}</div><div class="arena-empty"><i class="fa-solid fa-microphone-slash"></i><p><strong>${_aEsc(v.fighter_name)}</strong> hasn't run a live trash-talk session yet.${mine ? ' Start one from the Trash Talk page while you are live.' : ''}</p>${_aA('/arena/talk', 'Back', 'btn')}</div>`;
        return;
    }
    let last = null;
    const render = (s) => {
        const t = s.active_topic;
        const live = s.status === 'live';
        const xpInLevel = s.xp - (s.level - 1) * s.xp_per_level;
        const prev = last; last = s;
        if (prev && s.level > prev.level) _aLevelUp(s.level);
        const clearedFlash = prev && s.topics_cleared > prev.topics_cleared;
        const lines = s.recent_lines || [];
        const newestAt = prev ? Math.max(0, ...(prev.recent_lines || []).map(l => l.at)) : -1;
        root.innerHTML = `
            <div class="arena-back">${_aA('/arena/talk', '<i class="fa-solid fa-arrow-left"></i> Trash Talk')} ${_aA(_aFighterLink(v.user), `<i class="fa-solid fa-id-card"></i> ${_aEsc(v.fighter_name)}`)}</div>
            <div class="arena-session">
                <div class="arena-session-main">
                    <div class="arena-session-head">
                        <div class="arena-session-who">${_aPortrait({ user: v.user, image_url: v.image_url }, 'sm')}<div><strong>${_aEsc(v.fighter_name)}</strong><div class="arena-session-status ${live ? '' : 'is-ended'}">${live ? '<span class="arena-live-dot"></span> talking trash live' : `session ended${s.end_reason ? ' · ' + _aEsc(String(s.end_reason).replace('_', ' ')) : ''}`}</div></div></div>
                        <div class="arena-session-level"><div><b>LVL ${s.level}</b><small>TRASH LEVEL</small></div><div class="arena-xp"><div class="arena-xp-track"><span class="arena-xp-fill" style="width:${Math.min(100, (xpInLevel / s.xp_per_level) * 100)}%"></span></div><div class="arena-xp-label">${s.xp} XP · ${s.next_level_xp - s.xp} to next</div></div></div>
                    </div>
                    ${t ? `<div class="arena-session-topic ${clearedFlash ? 'is-cleared-flash' : ''}">
                        <div class="arena-session-topic-kicker">Topic ${t.idx + 1} · ${_aEsc(t.tone || '')} <span>${live ? 'talk about this — the judge listens every ~30 s' : 'session over'}</span></div>
                        <h2>“${_aEsc(t.topic)}”</h2>
                        ${t.hint ? `<p class="arena-session-hint"><i class="fa-solid fa-lightbulb"></i> ${_aEsc(t.hint)}</p>` : ''}
                        <div class="arena-progress"><span class="arena-progress-fill" style="width:${t.progress}%"></span></div>
                        <div class="arena-progress-label"><span>${t.progress}% cleared · ${t.hits} hit${t.hits === 1 ? '' : 's'} · ${t.hypers} hyping</span><span>${t.progress >= 100 ? 'CLEARED' : `${100 - t.progress}% to the next topic`}</span></div>
                        ${t.last_judgement ? `<div class="arena-session-verdict"><span class="${t.last_judgement.is_trash_talk ? 'is-hit' : 'is-miss'}">${t.last_judgement.is_trash_talk ? '<i class="fa-solid fa-fire"></i> that was trash talk' : '<i class="fa-solid fa-ellipsis"></i> not trash talk (yet)'}</span> · quality ${t.last_judgement.quality}/10 · “${_aEsc(t.last_judgement.about || '')}”${t.last_judgement.fallback ? ' · heuristic judge' : ''}</div>` : (live ? '<div class="arena-session-verdict"><span class="is-miss"><i class="fa-solid fa-ear-listen"></i> listening…</span> say something spicy</div>' : '')}
                        ${t.best_line ? `<p class="arena-talk-note">Best line so far: “${_aEsc(t.best_line)}” ${t.best_vod_id ? `<a class="arena-talk-hear" href="/vod/${t.best_vod_id}?t=${t.best_line_sec}" onclick="return handleLinkClick(event, '/vod/${t.best_vod_id}?t=${t.best_line_sec}')"><i class="fa-solid fa-play"></i> hear it</a>` : ''}</p>` : ''}
                        <div class="arena-session-controls">
                            ${mine && live ? `<button class="btn btn-ghost" id="arena-session-skip"><i class="fa-solid fa-forward"></i> Skip topic</button><button class="btn btn-ghost" id="arena-session-stop"><i class="fa-solid fa-stop"></i> End session</button>` : ''}
                            ${!mine && live ? `<button class="btn btn-primary" id="arena-session-hype"><i class="fa-solid fa-fire"></i> Hype</button><span class="arena-note">or type <code>!hype</code> in their chat</span>` : ''}
                            ${_aA(_aChannelLink(v.user), '<i class="fa-solid fa-tv"></i> Watch the stream', 'btn btn-ghost')}
                        </div>
                    </div>` : ''}
                    <div class="arena-session-feed">
                        <div class="arena-session-feed-head"><span><i class="fa-solid fa-microphone"></i> Hot mic</span><span>${s.lines_seen} lines · ${_aNum(s.words_seen)} words this session</span></div>
                        ${lines.length ? lines.map(l => `<div class="arena-session-line ${l.at > newestAt ? 'is-new' : ''}"><span>${_aStamp(l.at)}</span><span>${_aEsc(l.text)}</span>${l.vod_id ? `<a href="/vod/${l.vod_id}?t=${Math.max(0, l.sec - 2)}" onclick="return handleLinkClick(event, '/vod/${l.vod_id}?t=${Math.max(0, l.sec - 2)}')" title="Hear it"><i class="fa-solid fa-play"></i></a>` : '<span></span>'}</div>`).join('') : '<p class="arena-voice-empty">Nothing heard yet — the transcription runs a few seconds behind.</p>'}
                    </div>
                </div>
                <div class="arena-session-side">
                    <div class="arena-session-stats"><div class="arena-session-stat"><b>${s.topics_cleared}</b><span>topics cleared</span></div><div class="arena-session-stat"><b>${s.xp}</b><span>xp</span></div><div class="arena-session-stat"><b>${v.talk_bonus || 0}</b><span>power bonus</span></div></div>
                    <div class="arena-session-card"><h3><i class="fa-solid fa-tags"></i> What they talked about</h3>${s.talked_about.length ? `<div class="arena-about">${s.talked_about.map(a => `<span class="${a.hit ? 'is-hit' : ''}" title="topic ${a.topic_idx + 1}">${_aEsc(a.text)}</span>`).join('')}</div>` : '<p class="arena-voice-empty">Tags appear after the first judged chunk.</p>'}</div>
                    <div class="arena-session-card"><h3><i class="fa-solid fa-list-check"></i> Topics this session</h3>${s.cleared_topics.length ? `<div class="arena-cleared-list">${s.cleared_topics.slice().reverse().map(c => `<div class="arena-cleared ${c.status === 'skipped' ? 'is-skipped' : ''}"><b>${c.status === 'cleared' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-forward"></i>'} ${_aEsc(c.topic)}</b>${c.best_line ? `<q>${_aEsc(c.best_line)}</q> ${c.best_vod_id ? `<a class="arena-talk-hear" href="/vod/${c.best_vod_id}?t=${c.best_line_sec}" onclick="return handleLinkClick(event, '/vod/${c.best_vod_id}?t=${c.best_line_sec}')"><i class="fa-solid fa-play"></i></a>` : ''}` : ''}<small>${c.status === 'cleared' ? `cleared · score ${c.score} · ${c.hits} hit${c.hits === 1 ? '' : 's'}` : 'skipped'}</small></div>`).join('')}</div>` : '<p class="arena-voice-empty">No topics cleared yet.</p>'}</div>
                </div>
            </div>`;
        root.querySelector('#arena-session-skip')?.addEventListener('click', async () => { try { await api('/arena/talk/session/skip', { method: 'POST' }); refresh(); } catch (err) { if (typeof showToast === 'function') showToast(err?.message, 'error'); } });
        root.querySelector('#arena-session-stop')?.addEventListener('click', async () => { if (!confirm('End your trash-talk session?')) return; try { await api('/arena/talk/session/stop', { method: 'POST' }); refresh(); } catch (err) { if (typeof showToast === 'function') showToast(err?.message, 'error'); } });
        root.querySelector('#arena-session-hype')?.addEventListener('click', async (e) => {
            e.target.disabled = true;
            try { const r = await api(`/arena/talk/session/${encodeURIComponent(v.user.username)}/hype`, { method: 'POST' }); e.target.innerHTML = r.added ? '<i class="fa-solid fa-fire"></i> Hyped!' : '<i class="fa-solid fa-check"></i> Already hyped'; refresh(); }
            catch (err) { e.target.disabled = false; if (typeof showToast === 'function') showToast(err?.message || 'Hype failed', 'error'); }
        });
    };
    const refresh = async () => {
        if (currentPage !== 'arena') return _aTalkStop();
        try { const nv = await api(`/arena/talk/session/${encodeURIComponent(username)}`); if (nv.session) { v = nv; render(nv.session); } } catch { /* keep */ }
    };
    render(v.session);
    if (v.session.status === 'live') _arenaTalkTimers.push(setInterval(refresh, 4000));
}

function _aLevelUp(level) {
    const el = document.createElement('div');
    el.className = 'arena-levelup';
    el.innerHTML = `<i class="fa-solid fa-arrow-up"></i> TRASH LEVEL ${level}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
}

window.loadArenaPage = loadArenaPage;
