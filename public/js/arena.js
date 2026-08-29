/**
 * OpenVibe.Live — Arena tab (streamer vs streamer)
 *
 * Routes (handled from app.js):
 *   /arena                         leaderboard + live matchups
 *   /arena/<username>              fighter profile
 *   /arena/battle/<a>/<b>          head-to-head battle
 *
 * Talks to /api/arena/* (server/arena). Everything renders with DOM building or
 * escaped template strings — persona text is AI-written and must never be trusted as HTML.
 */
'use strict';

const ARENA_STATS = ['hype', 'grind', 'chat', 'loyalty', 'clutch', 'vibe'];
const ARENA_STAT_LABEL = { hype: 'Hype', grind: 'Grind', chat: 'Chat', loyalty: 'Loyalty', clutch: 'Clutch', vibe: 'Vibe' };
let _arenaRoster = null;       // cached leaderboard payload
let _arenaLiveTimer = null;
let _arenaImagePoll = null;
let _arenaBattleTimers = [];

function _aEsc(s) { return typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _aNum(n) { n = Number(n) || 0; return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }
function _aInitial(u) { return (u.display_name || u.username || '?').trim().charAt(0).toUpperCase(); }

function _aStopTimers() {
    if (_arenaLiveTimer) { clearInterval(_arenaLiveTimer); _arenaLiveTimer = null; }
    if (_arenaImagePoll) { clearInterval(_arenaImagePoll); _arenaImagePoll = null; }
    for (const t of _arenaBattleTimers) clearTimeout(t);
    _arenaBattleTimers = [];
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

function _aRatingBars(r) {
    return `<div class="arena-bars">${ARENA_STATS.map(k => `
        <div class="arena-bar" title="${_aEsc(ARENA_STAT_LABEL[k])}">
            <span class="arena-bar-label">${_aEsc(ARENA_STAT_LABEL[k])}</span>
            <span class="arena-bar-track"><span class="arena-bar-fill" style="width:${Math.max(0, Math.min(100, r[k]))}%"></span></span>
            <span class="arena-bar-val">${r[k]}</span>
        </div>`).join('')}</div>`;
}

/** Hexagon radar chart as inline SVG (no library). */
function _aRadar(r, color, size = 180) {
    const c = size / 2, R = size / 2 - 28; // leave room for the labels outside the outer ring
    const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / ARENA_STATS.length;
    const pt = (i, v) => { const rr = R * (v / 99); return [c + rr * Math.cos(angle(i)), c + rr * Math.sin(angle(i))]; };
    const ring = (v) => ARENA_STATS.map((_, i) => pt(i, v).map(x => x.toFixed(1)).join(',')).join(' ');
    const poly = ARENA_STATS.map((k, i) => pt(i, r[k]).map(x => x.toFixed(1)).join(',')).join(' ');
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

function _aChannelLink(u) { return `/${encodeURIComponent(u.username)}`; }

// ── Page entry ───────────────────────────────────────────────

async function loadArenaPage(segments = []) {
    _aStopTimers();
    const root = document.getElementById('arena-root');
    if (!root) return;
    const [, first, second, third] = segments;
    try {
        if (first === 'battle' && second && third) return await _aRenderBattle(root, second, third);
        if (first && first !== 'battle') return await _aRenderFighter(root, first);
        return await _aRenderHome(root);
    } catch (err) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-plug-circle-xmark"></i><p>${_aEsc(err?.message || 'The arena lights went out.')}</p></div>`;
    }
}

function _aSpinner(text) { return `<div class="arena-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><span>${_aEsc(text)}</span></div>`; }

// ── Home: live matchups + leaderboard ────────────────────────

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
                <p class="page-subtitle">Every streamer, ranked by the numbers and roasted by the AI. Pick two, watch them fight, and let chat decide the last round.</p>
            </div>
            <div class="arena-hero-actions">
                <button class="btn btn-primary" id="arena-random"><i class="fa-solid fa-dice"></i> Random battle</button>
                ${data.ai ? '' : '<span class="arena-note" title="AI is off — stats and templated commentary only">AI commentary off</span>'}
            </div>
        </div>
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
    document.getElementById('arena-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        _aRenderList(q ? fighters.filter(f => [f.user.username, f.user.display_name, f.persona.fighter_name, f.persona.class].some(s => String(s || '').toLowerCase().includes(q))) : fighters);
    });
    document.getElementById('arena-random').addEventListener('click', () => {
        if (fighters.length < 2) return;
        const a = fighters[Math.floor(Math.random() * fighters.length)];
        let b = a; while (b === a) b = fighters[Math.floor(Math.random() * fighters.length)];
        navigate(`/arena/battle/${encodeURIComponent(a.user.username)}/${encodeURIComponent(b.user.username)}`);
    });
    _arenaLiveTimer = setInterval(async () => {
        if (currentPage !== 'arena' || !document.getElementById('arena-live')) return _aStopTimers();
        try { _aRenderLive(await api('/arena/live')); } catch { /* keep last */ }
    }, 30000);
}

function _aRenderLive(live) {
    const el = document.getElementById('arena-live');
    if (!el) return;
    if (!live || !live.live_count) { el.innerHTML = ''; return; }
    const card = (f, side) => `
        <a class="arena-live-fighter arena-live-${side}" href="${_aChannelLink(f.user)}" onclick="return handleLinkClick(event, '${_aEsc(_aChannelLink(f.user))}')">
            ${f.thumbnail_url ? `<img class="arena-live-thumb" src="${_aEsc(f.thumbnail_url)}?t=${Date.now()}" alt="">` : _aPortrait(f, 'sm')}
            <div class="arena-live-meta">
                <strong>${_aEsc(f.persona.fighter_name)}</strong>
                <span>${_aEsc(f.user.display_name)} · <i class="fa-solid fa-eye"></i> ${_aNum(f.stream.viewer_count)} · PWR ${f.ratings.power}</span>
            </div>
        </a>`;
    el.innerHTML = `
        <h2><span class="arena-live-dot"></span> Live battles <small>${live.live_count} fighter${live.live_count === 1 ? '' : 's'} live now</small></h2>
        <div class="arena-live-grid">
            ${live.matchups.map(m => `
                <div class="arena-live-match">
                    ${card(m.a, 'a')}
                    <a class="arena-live-vs" href="/arena/battle/${encodeURIComponent(m.a.user.username)}/${encodeURIComponent(m.b.user.username)}" onclick="return handleLinkClick(event, '/arena/battle/${_aEsc(encodeURIComponent(m.a.user.username))}/${_aEsc(encodeURIComponent(m.b.user.username))}')">VS<small>fight</small></a>
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
        <a class="arena-row ${f.live ? 'is-live' : ''}" href="/arena/${encodeURIComponent(f.user.username)}" onclick="return handleLinkClick(event, '/arena/${_aEsc(encodeURIComponent(f.user.username))}')">
            <span class="arena-rank ${f.rank <= 3 ? `arena-rank-${f.rank}` : ''}">${f.rank}</span>
            ${_aPortrait(f, 'sm')}
            <span class="arena-row-main">
                <strong>${_aEsc(f.persona.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</strong>
                <span class="arena-row-sub">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · ${_aEsc(f.persona.element)}</span>
                <em class="arena-row-taunt">“${_aEsc(f.persona.taunt)}”</em>
            </span>
            <span class="arena-row-stats">
                <span class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></span>
                <span class="arena-record">${f.record.wins}W–${f.record.losses}L</span>
            </span>
        </a>`).join('');
}

// ── Fighter profile ──────────────────────────────────────────

async function _aRenderFighter(root, username) {
    root.innerHTML = _aSpinner('Pulling the fighter file…');
    const f = await api(`/arena/fighters/${encodeURIComponent(username)}`);
    if (f.not_on_roster) {
        root.innerHTML = `<div class="arena-empty"><i class="fa-solid fa-user-slash"></i><p><strong>${_aEsc(f.user.display_name)}</strong> is not on the roster yet — ${_aEsc(f.reason)}.</p><a class="btn" href="/arena" onclick="return handleLinkClick(event, '/arena')">Back to the Arena</a></div>`;
        return;
    }
    const p = f.persona, color = f.user.profile_color || '#8b5cf6';
    root.innerHTML = `
        <div class="arena-back"><a href="/arena" onclick="return handleLinkClick(event, '/arena')"><i class="fa-solid fa-arrow-left"></i> Arena</a></div>
        <div class="arena-profile" style="--fc:${_aEsc(color)}">
            <div class="arena-profile-portrait" id="arena-profile-portrait">
                ${_aPortrait(f, 'lg')}
                ${f.image_pending ? '<div class="arena-portrait-pending"><i class="fa-solid fa-wand-magic-sparkles fa-fade"></i> painting portrait…</div>' : ''}
                <div class="arena-profile-rank">#${f.rank} <small>of ${f.roster_size}</small></div>
            </div>
            <div class="arena-profile-main">
                <div class="arena-profile-name">
                    <h1>${_aEsc(p.fighter_name)} ${f.live ? '<span class="arena-live-pill">LIVE</span>' : ''}</h1>
                    <p class="arena-title">${_aEsc(p.title)}</p>
                    <p class="arena-handle"><a href="${_aChannelLink(f.user)}" onclick="return handleLinkClick(event, '${_aEsc(_aChannelLink(f.user))}')">${_aEsc(f.user.display_name)} · @${_aEsc(f.user.username)}</a> · ${_aEsc(p.class)} · ${_aEsc(p.element)}</p>
                </div>
                <div class="arena-profile-power">
                    <div class="arena-power arena-power-lg"><b>${f.ratings.power}</b><small>POWER</small></div>
                    <div class="arena-record arena-record-lg">${f.record.wins}W – ${f.record.losses}L</div>
                </div>
                <div class="arena-profile-stats">
                    ${_aRadar(f.ratings, color)}
                    <div class="arena-quips">${ARENA_STATS.map(k => `<div class="arena-quip"><b>${_aEsc(ARENA_STAT_LABEL[k])} ${f.ratings[k]}</b><span>${_aEsc((p.stat_quips || {})[k] || '')}</span></div>`).join('')}</div>
                </div>
                <div class="arena-lore">
                    <p class="arena-lore-text">${_aEsc(p.lore)}</p>
                    <div class="arena-moves">
                        <div class="arena-move"><span class="arena-move-kind">Signature</span><b>${_aEsc(p.signature_move?.name)}</b><span>${_aEsc(p.signature_move?.description)}</span></div>
                        <div class="arena-move"><span class="arena-move-kind">Special</span><b>${_aEsc(p.special?.name)}</b><span>${_aEsc(p.special?.description)}</span></div>
                        <div class="arena-move arena-move-weak"><span class="arena-move-kind">Weakness</span><b>${_aEsc(p.weakness)}</b></div>
                    </div>
                    <div class="arena-flavor">
                        <span><i class="fa-solid fa-comment"></i> “${_aEsc(p.taunt)}”</span>
                        <span><i class="fa-solid fa-music"></i> ${_aEsc(p.entrance_music)}</span>
                        <span><i class="fa-solid fa-quote-left"></i> ${_aEsc(p.catchphrase)}</span>
                    </div>
                    ${f.persona_is_fallback ? '<p class="arena-note">Stats-only profile — AI lore appears once the AI is enabled.</p>' : ''}
                </div>
                <div class="arena-numbers">
                    ${[['Hours live (90d)', f.raw.hours], ['Peak viewers', f.raw.peak_viewers], ['Avg viewers', f.raw.avg_viewers], ['Chat msgs / hr', f.raw.messages_per_hour], ['Followers', f.raw.followers], ['Clips', f.raw.clips], ['All-time hours', f.raw.all_time_hours], ['All-time peak', f.raw.all_time_peak]]
                        .map(([l, v]) => `<div class="arena-number"><b>${_aEsc(_aNum(v))}</b><span>${_aEsc(l)}</span></div>`).join('')}
                </div>
            </div>
        </div>
        <section class="arena-challenge">
            <h2>Pick an opponent</h2>
            <div class="arena-opponents" id="arena-opponents">${_aSpinner('Scouting…')}</div>
        </section>`;
    // Opponent picker
    try {
        const data = _arenaRoster || await api('/arena/fighters');
        _arenaRoster = data;
        const others = (data.fighters || []).filter(o => o.user.id !== f.user.id);
        const el = document.getElementById('arena-opponents');
        el.innerHTML = others.map(o => `
            <a class="arena-opponent" href="/arena/battle/${encodeURIComponent(f.user.username)}/${encodeURIComponent(o.user.username)}" onclick="return handleLinkClick(event, '/arena/battle/${_aEsc(encodeURIComponent(f.user.username))}/${_aEsc(encodeURIComponent(o.user.username))}')">
                ${_aPortrait(o, 'xs')}
                <span><strong>${_aEsc(o.persona.fighter_name)}</strong><small>#${o.rank} · PWR ${o.ratings.power}${o.live ? ' · LIVE' : ''}</small></span>
            </a>`).join('') || '<p class="arena-note">Nobody else on the roster yet.</p>';
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
                    if (holder) holder.innerHTML = `${_aPortrait(fresh, 'lg')}<div class="arena-profile-rank">#${fresh.rank} <small>of ${fresh.roster_size}</small></div>`;
                    clearInterval(_arenaImagePoll); _arenaImagePoll = null;
                }
            } catch { /* */ }
        }, 6000);
    }
}

// ── Battle ───────────────────────────────────────────────────

async function _aRenderBattle(root, a, b) {
    root.innerHTML = `<div class="arena-loading arena-loading-battle"><i class="fa-solid fa-bolt fa-beat"></i><span>Fighters are entering the arena…</span><small>the announcer is warming up</small></div>`;
    const battle = await api(`/arena/battle/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    const A = battle.a, B = battle.b, c = battle.commentary;
    const side = (f, s) => `
        <div class="arena-side arena-side-${s} ${battle.outcome.winner === s ? 'is-winner' : ''}" style="--fc:${_aEsc(f.user.profile_color || (s === 'a' ? '#8b5cf6' : '#ec4899'))}">
            <a href="/arena/${encodeURIComponent(f.user.username)}" onclick="return handleLinkClick(event, '/arena/${_aEsc(encodeURIComponent(f.user.username))}')">${_aPortrait(f, 'md')}</a>
            <h2>${_aEsc(f.persona.fighter_name)}</h2>
            <p class="arena-title">${_aEsc(f.persona.title)}</p>
            <p class="arena-handle">${_aEsc(f.user.display_name)} · ${_aEsc(f.persona.class)} · #${f.rank}</p>
            <div class="arena-power"><b>${f.ratings.power}</b><small>PWR</small></div>
            ${_aRatingBars(f.ratings)}
            <p class="arena-side-taunt">“${_aEsc(f.persona.taunt)}”</p>
        </div>`;
    root.innerHTML = `
        <div class="arena-back"><a href="/arena" onclick="return handleLinkClick(event, '/arena')"><i class="fa-solid fa-arrow-left"></i> Arena</a> <span class="arena-note">Battle of ${_aEsc(battle.day)} — same matchup, same result all day; the crowd vote is the last round.</span></div>
        <div class="arena-battle">
            ${side(A, 'a')}
            <div class="arena-center">
                <div class="arena-vs">VS</div>
                <div class="arena-scoreboard" id="arena-scoreboard"><span id="arena-score-a">0</span><span class="arena-score-sep">–</span><span id="arena-score-b">0</span></div>
                <div class="arena-commentary" id="arena-commentary"></div>
                <div class="arena-vote" id="arena-vote"></div>
                <div class="arena-battle-actions">
                    <button class="btn btn-ghost" id="arena-share"><i class="fa-solid fa-link"></i> Share</button>
                    <a class="btn btn-ghost" href="/arena/battle/${encodeURIComponent(b)}/${encodeURIComponent(a)}" onclick="return handleLinkClick(event, '/arena/battle/${_aEsc(encodeURIComponent(b))}/${_aEsc(encodeURIComponent(a))}')"><i class="fa-solid fa-right-left"></i> Swap corners</a>
                    <button class="btn btn-ghost" id="arena-rematch"><i class="fa-solid fa-dice"></i> Random rematch</button>
                </div>
            </div>
            ${side(B, 'b')}
        </div>`;
    _aPlayBattle(battle);
    document.getElementById('arena-share').addEventListener('click', async () => {
        const url = `${location.origin}/arena/battle/${encodeURIComponent(A.user.username)}/${encodeURIComponent(B.user.username)}`;
        try { await navigator.clipboard.writeText(url); document.getElementById('arena-share').innerHTML = '<i class="fa-solid fa-check"></i> Copied'; } catch { prompt('Battle link', url); }
    });
    document.getElementById('arena-rematch').addEventListener('click', async () => {
        const data = _arenaRoster || await api('/arena/fighters');
        _arenaRoster = data;
        const pool = (data.fighters || []).filter(f => f.user.id !== A.user.id);
        if (!pool.length) return;
        const o = pool[Math.floor(Math.random() * pool.length)];
        navigate(`/arena/battle/${encodeURIComponent(A.user.username)}/${encodeURIComponent(o.user.username)}`);
    });
}

/** Reveal rounds one by one, then the finisher, verdict and the crowd vote. */
function _aPlayBattle(battle) {
    const A = battle.a, B = battle.b, c = battle.commentary;
    const box = document.getElementById('arena-commentary');
    const sa = document.getElementById('arena-score-a'), sb = document.getElementById('arena-score-b');
    let a = 0, b = 0;
    const line = (html, cls = '') => { const d = document.createElement('div'); d.className = `arena-line ${cls}`; d.innerHTML = html; box.appendChild(d); box.scrollTop = box.scrollHeight; };
    const at = (ms, fn) => _arenaBattleTimers.push(setTimeout(fn, ms));
    let t = 0;
    line(`<i class="fa-solid fa-microphone-lines"></i> ${_aEsc(c.intro)}`, 'arena-line-intro');
    battle.rounds.forEach((r, i) => {
        t += 1400;
        at(t, () => {
            const winner = r.winner === 'a' ? A : B;
            if (r.winner === 'a') a++; else b++;
            sa.textContent = a; sb.textContent = b;
            line(`<span class="arena-round-tag">R${i + 1} · ${_aEsc(r.label)}</span> ${_aEsc(c.rounds[i] || `${winner.persona.fighter_name} takes it.`)} <span class="arena-round-score">${r.a}–${r.b}${r.upset ? ' · UPSET' : ''}</span>`, `arena-line-${r.winner}${r.upset ? ' arena-line-upset' : ''}`);
            document.querySelector(`.arena-side-${r.winner}`)?.classList.add('is-hit');
            setTimeout(() => document.querySelector(`.arena-side-${r.winner}`)?.classList.remove('is-hit'), 600);
        });
    });
    t += 1400;
    at(t, () => line(`<i class="fa-solid fa-burst"></i> ${_aEsc(c.finisher)}`, 'arena-line-finisher'));
    t += 1200;
    at(t, () => {
        line(`<i class="fa-solid fa-gavel"></i> ${_aEsc(c.verdict)}`, 'arena-line-verdict');
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

window.loadArenaPage = loadArenaPage;
