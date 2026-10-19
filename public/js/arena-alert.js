/**
 * OpenVibe.Live — Arena v4: ARENA ALERT, the drama desk (server/arena/drama.js)
 *
 * Routes (from loadArenaPage in arena.js, which also owns the shared helpers _aEsc, _aA, _aAgo…):
 *   /arena                 the desk: masthead + ticker, the top story, BREAKING, Lolcow Index, Clout Rankings,
 *                          Beef Watch, Hot Mic, the cams on air
 *   /arena/drama/<id>      one story
 *   /arena/<username>      the rap sheet on top of the fighter page
 *
 * Every story comes from something measured on the site (a stream's length, its viewer and chat snapshots, sounds and
 * speech on its timeline, a beef's verdict); headlines may be AI-written from those facts. All text goes through _aEsc.
 */
'use strict';

const AA_KIND = {
    rage_quit: ['RAGE QUIT', '🚪'], viewer_crash: ['VIEWER CRASH', '📉'], viewer_spike: ['BLOWING UP', '📈'], chat_explosion: ['CHAT GOES FERAL', '💬'],
    meltdown: ['MELTDOWN', '😤'], tears: ['TEARS', '😭'], marathon: ['MARATHON', '⏰'], ghost_town: ['GHOST TOWN', '👻'], the_return: ['THE RETURN', '👀'],
    title_drama: ['TITLE DRAMA', '🍿'], peak_record: ['NEW PEAK', '🏆'], fell_off: ['FELL OFF?', '🕳️'], streak: ['NO DAYS OFF', '🔥'],
    quote_of_day: ['QUOTE OF THE DAY', '🎤'], beef_open: ['BEEF', '🥩'], beef_win: ['COOKED', '🍳'], beef_forfeit: ['DUCKED', '🐔'],
};
const AA_REACT = [['fire', '🔥'], ['skull', '💀'], ['clown', '🤡'], ['w', 'W'], ['l', 'L']];
let _aaTickerTop = 0;

function _aaUser(u) { return u ? _aA(_aFighterLink(u), _aEsc(u.display_name || u.username), 'aa-name') : ''; }
function _aaAvatar(u, size = 40) {
    if (!u) return '';
    const inner = u.avatar_url ? `<img src="${_aEsc(u.avatar_url)}" alt="" loading="lazy" width="${size}" height="${size}">` : `<span>${_aEsc(_aInitial(u))}</span>`;
    return _aA(_aFighterLink(u), inner, 'aa-av', u.display_name || u.username);
}
function _aaSirens(n) { return `<span class="aa-sirens" aria-label="alert level ${n} of 5">${'🚨'.repeat(Math.max(1, Math.min(5, n)))}</span>`; }
function _aaWatch(s) {
    if (s.vod_id) return _aA(videoHref('vod', s.vod_id, Math.max(0, Math.floor(s.sec || 0))), '<i class="fa-solid fa-play"></i> Watch it happen', 'aa-watch');
    if (s.user && s.kind !== 'fell_off') return _aA(_aChannelLink(s.user), '<i class="fa-solid fa-tower-broadcast"></i> Their channel', 'aa-watch');
    return '';
}
function _aaReactions(s) {
    return `<div class="aa-react" data-story="${s.id}" role="group" aria-label="React">${AA_REACT.map(([k, label]) => `<button type="button" class="aa-react-btn${s.my_reaction === k ? ' is-mine' : ''}" data-react="${k}" aria-pressed="${s.my_reaction === k}"><span class="aa-react-i">${label}</span><span class="aa-react-n">${_aNum(s.reactions?.[k] || 0)}</span></button>`).join('')}</div>`;
}
function _aaStory(s, { big = false } = {}) {
    const [badge, icon] = AA_KIND[s.kind] || [String(s.kind || '').toUpperCase(), '🚨'];
    return `<article class="aa-story aa-alert-${s.alert} aa-kind-${_aEsc(s.kind)}${big ? ' aa-story-big' : ''}" id="aa-story-${s.id}">
        <div class="aa-story-head"><span class="aa-badge">${icon} ${_aEsc(badge)}</span>${_aaSirens(s.alert)}<time class="aa-time" datetime="${_aEsc(s.happened_at)}">${_aEsc(_aAgo(s.happened_at))}</time></div>
        <div class="aa-story-body">
            <div class="aa-who">${_aaAvatar(s.user, big ? 72 : 44)}${s.other ? `<span class="aa-vs">VS</span>${_aaAvatar(s.other, big ? 72 : 44)}` : ''}</div>
            <div class="aa-story-text">
                <h3 class="aa-headline">${_aA(`/arena/drama/${s.id}`, _aEsc(s.headline))}</h3>
                ${s.blurb ? `<p class="aa-blurb">${_aEsc(s.blurb)}</p>` : ''}
                ${s.quote ? `<blockquote class="aa-quote"><span>${_aEsc(s.quote)}</span> ${_aSpeakBtn(s.quote, 'arena-speak', s.user?.username)}</blockquote>` : ''}
                <p class="aa-byline">${_aaUser(s.user)}${s.other ? ` · ${_aaUser(s.other)}` : ''}</p>
            </div>
        </div>
        <div class="aa-story-foot">${_aaReactions(s)}${_aaWatch(s)}${s.ai ? '<span class="aa-ai" title="Headline written by AI from the measured facts">AI desk</span>' : ''}</div>
    </article>`;
}
function _aaTicker(stories) {
    if (!stories.length) return '';
    const items = stories.slice(0, 12).map((s) => `<span class="aa-tick">${_aEsc((AA_KIND[s.kind] || ['', '🚨'])[1])} ${_aEsc(s.headline)}</span>`).join('');
    return `<div class="aa-ticker" aria-label="Latest headlines"><span class="aa-ticker-label">BREAKING</span><div class="aa-ticker-viewport"><div class="aa-ticker-track">${items}${items}</div></div></div>`;
}
function _aaCow(index) {
    if (!index.length) return `<p class="aa-quiet">Nobody has been cooked this week. Yet.</p>`;
    return `<ol class="aa-board">${index.slice(0, 10).map((c, i) => `<li class="aa-row">
        <span class="aa-rank${i === 0 ? ' is-crown' : ''}">${i === 0 ? '🐄' : i + 1}</span>${_aaAvatar(c.user, 32)}
        <span class="aa-row-main">${_aaUser(c.user)}<span class="aa-meter" style="--m:${c.meter}%"><span></span></span><span class="aa-row-sub">${Object.entries(c.kinds).map(([k, n]) => `${_aEsc((AA_KIND[k] || [k])[0].toLowerCase())}${n > 1 ? ` ×${n}` : ''}`).join(' · ')}</span></span>
        <span class="aa-score" title="Cow points this week">${c.meter}</span></li>`).join('')}</ol>`;
}
function _aaMove(c) {
    if (c.move == null) return '<span class="aa-move is-new">NEW</span>';
    if (c.move > 0) return `<span class="aa-move is-up">▲${c.move}</span>`;
    if (c.move < 0) return `<span class="aa-move is-down">▼${-c.move}</span>`;
    return '<span class="aa-move">–</span>';
}
function _aaClout(rankings) {
    if (!rankings.length) return `<p class="aa-quiet">Nobody streamed this week.</p>`;
    return `<ol class="aa-board">${rankings.slice(0, 12).map((c) => `<li class="aa-row">
        <span class="aa-rank">${c.rank}</span>${_aaAvatar(c.user, 32)}
        <span class="aa-row-main">${_aaUser(c.user)} ${_aaMove(c)}<span class="aa-row-sub">${c.facts.hours}h live · peak ${c.facts.peak} · ${_aNum(c.facts.messages)} chat${c.facts.beef_wins ? ` · ${c.facts.beef_wins} beef W` : ''}</span>${c.tags.length ? `<span class="aa-tags">${c.tags.map((t) => `<span class="aa-tag aa-tag-${_aEsc(t.toLowerCase().replace(/\s+/g, '-'))}">${_aEsc(t)}</span>`).join('')}</span>` : ''}</span>
        <span class="aa-score" title="Clout this week">${_aNum(c.clout)}</span></li>`).join('')}</ol>`;
}
function _aaHotMic(feed) {
    if (!feed.length) return `<p class="aa-quiet">The ears have not caught anything spicy yet.</p>`;
    return `<ul class="aa-mic">${feed.slice(0, 8).map((m) => `<li><q>${_aEsc(m.text)}</q> <span class="aa-row-sub">${m.user ? _aaUser(m.user) : ''}${m.aimed_at ? ` → ${_aEsc(m.aimed_at)}` : ''} · ${_aQ(m.quality)} ${_aPlay(m.vod_id, m.sec)}</span></li>`).join('')}</ul>`;
}
function _aaBeefs(beefs) {
    const open = beefs.open || [], done = (beefs.resolved || []).slice(0, 3);
    const line = (b) => `<li>${_aA(_aBeefLink(b), `<b>${_aEsc(b.a.user.display_name || b.a.user.username)}</b> <span class="aa-vs">VS</span> <b>${_aEsc(b.b.user.display_name || b.b.user.username)}</b>`)} ${b.status === 'open' ? _aClockTag(b) : `<span class="aa-row-sub">${b.winner_user_id ? `${_aEsc(((b.winner_user_id === b.a.user.id ? b.a : b.b).user.display_name) || (b.winner_user_id === b.a.user.id ? b.a : b.b).user.username)} won` : 'draw'}</span>`}</li>`;
    return `${open.length ? `<ul class="aa-beefs">${open.map(line).join('')}</ul>` : '<p class="aa-quiet">No open beef. One name said on mic changes that.</p>'}${done.length ? `<p class="aa-row-sub aa-settled">Settled</p><ul class="aa-beefs">${done.map(line).join('')}</ul>` : ''}`;
}
function _aaBindReactions(root) {
    root.querySelectorAll('.aa-react').forEach((group) => {
        if (group.dataset.bound) return;
        group.dataset.bound = '1';
        group.addEventListener('click', async (e) => {
            const btn = e.target.closest('.aa-react-btn');
            if (!btn) return;
            const id = group.dataset.story;
            try {
                const r = await api(`/arena/drama/${id}/react`, { method: 'POST', body: { reaction: btn.dataset.react } });
                group.querySelectorAll('.aa-react-btn').forEach((b) => {
                    const mine = b === btn;
                    b.classList.toggle('is-mine', mine);
                    b.setAttribute('aria-pressed', String(mine));
                    const n = b.querySelector('.aa-react-n');
                    if (n) n.textContent = _aNum(r.reactions?.[b.dataset.react] || 0);
                });
                btn.classList.add('is-pop');
                setTimeout(() => btn.classList.remove('is-pop'), 400);
            } catch (err) { _aToast(err?.message || 'Could not react', 'error'); }
        });
    });
    _aBindSpeak(root);
}

async function _aRenderAlertHome(root) {
    root.innerHTML = _aSpinner('Checking the timeline for drama…');
    const safe = (p, d) => p.catch(() => d);
    const [drama, cow, clout, beefs, live, feed] = await Promise.all([
        api('/arena/drama?limit=30'), safe(api('/arena/lolcow'), { index: [] }), safe(api('/arena/clout'), { rankings: [] }),
        safe(api('/arena/beefs'), { open: [], recent: [] }), safe(api('/arena/live'), { live: [] }), safe(api('/arena/feed?limit=12'), { feed: [] }),
    ]);
    const stories = drama.stories || [];
    const dayAgo = Date.now() - 86400000;
    const top = [...stories].filter((s) => new Date(String(s.happened_at).replace(' ', 'T') + 'Z').getTime() >= dayAgo).sort((a, b) => b.alert - a.alert || b.id - a.id)[0] || stories[0] || null;
    _aaTickerTop = stories[0]?.id || 0;
    const rest = stories.filter((s) => !top || s.id !== top.id);
    root.innerHTML = `<div class="aa">
        <header class="aa-mast">
            <div class="aa-mast-row">
                <h1 class="aa-title"><span class="aa-siren" aria-hidden="true">🚨</span> ARENA <span>ALERT</span></h1>
                <span class="aa-onair"><span class="arena-live-dot arena-live-dot-sm"></span> ${(live.live || []).length ? `${live.live.length} ON AIR` : 'WATCHING'}</span>
            </div>
            <p class="aa-sub">Rage quits, meltdowns, viewer crashes, beefs and L's from every stream on OpenVibe. Measured on the site, timestamped, then roasted.</p>
            ${_aaTicker(stories)}
        </header>
        ${(live.live || []).length ? `<section class="arena-live arena-cams aa-cams" id="arena-live">${_aRenderCams(live.live)}</section>` : ''}
        ${top ? `<section class="aa-top" aria-label="Top story">${_aaStory(top, { big: true })}</section>` : ''}
        <div class="aa-grid">
            <section class="aa-feed" aria-labelledby="aa-feed-h">
                <h2 id="aa-feed-h" class="aa-h">BREAKING</h2>
                <div id="aa-feed-list">${rest.length ? rest.map((s) => _aaStory(s)).join('') : (top ? '' : `<div class="aa-quiet aa-quiet-big"><b>The desk is listening.</b> The next rage quit, viewer crash or meltdown on any stream lands here within five minutes.</div>`)}</div>
                ${stories.length >= 30 ? `<button type="button" class="btn aa-more" id="aa-more" data-before="${stories[stories.length - 1].id}">Older drama</button>` : ''}
            </section>
            <aside class="aa-side">
                <section class="aa-box aa-box-cow" aria-labelledby="aa-cow-h"><h2 id="aa-cow-h" class="aa-h">🐄 Lolcow Index <small>this week</small></h2>${_aaCow(cow.index || [])}</section>
                <section class="aa-box aa-box-clout" aria-labelledby="aa-clout-h"><h2 id="aa-clout-h" class="aa-h">📈 Clout Rankings <small>last 7 days</small></h2>${_aaClout(clout.rankings || [])}</section>
                <section class="aa-box" aria-labelledby="aa-beef-h"><h2 id="aa-beef-h" class="aa-h">🥩 Beef Watch</h2>${_aaBeefs(beefs)}</section>
                <section class="aa-box" aria-labelledby="aa-mic-h"><h2 id="aa-mic-h" class="aa-h">🎤 Hot Mic</h2>${_aaHotMic(feed.feed || [])}</section>
            </aside>
        </div>
        <section class="aa-how">
            <h2 class="aa-h">How the desk works</h2>
            <ul>
                <li><b>Measured, not made up.</b> Every five minutes the desk reads what happened on every stream: how long it lasted, its viewer and chat counts minute by minute, what the mic heard (speech and sounds like yelling or crying), titles, records and beefs. Each story states those numbers.</li>
                <li><b>Lolcow Index.</b> Rage quits, viewer crashes, meltdowns, tears, ghost-town streams, dramatic titles, falling off and losing beefs add cow points (newer counts more). The top cow wears the crown.</li>
                <li><b>Clout Rankings.</b> Hours live, viewers, chat, new followers, records, comebacks and beef wins over the last 7 days, with this week's moves. COOKED means your cow meter is 70+.</li>
                <li><b>Beefs.</b> Call another streamer out on mic and the beef opens itself; they are on the clock. Silence is a forfeit, and a forfeit is a story.</li>
                <li><b>React.</b> 🔥 💀 🤡 W or L, one per story. Streamers who would rather not be covered can ${_aMe() ? `<button type="button" class="aa-link" id="aa-optout">keep themselves out of the Arena</button>` : 'sign in and keep themselves out of the Arena'}.</li>
            </ul>
        </section>
    </div>`;
    _aaBindReactions(root);
    _aBindHome(root);
    document.getElementById('aa-more')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            const older = await api(`/arena/drama?limit=30&before=${encodeURIComponent(btn.dataset.before)}`);
            const list = document.getElementById('aa-feed-list');
            list.insertAdjacentHTML('beforeend', (older.stories || []).map((s) => _aaStory(s)).join(''));
            _aaBindReactions(root);
            if ((older.stories || []).length < 30) btn.remove(); else { btn.dataset.before = older.stories[older.stories.length - 1].id; btn.disabled = false; }
        } catch { btn.disabled = false; }
    });
    document.getElementById('aa-optout')?.addEventListener('click', _aaOptOutDialog);
    _aEvery(30000, async () => {
        try {
            const d = await api('/arena/drama?limit=10');
            const fresh = (d.stories || []).filter((s) => s.id > _aaTickerTop);
            if (!fresh.length) return;
            _aaTickerTop = d.stories[0].id;
            const list = document.getElementById('aa-feed-list');
            if (list) { list.insertAdjacentHTML('afterbegin', fresh.map((s) => _aaStory(s)).join('')); _aaBindReactions(root); _aFlash(list, `${fresh.length} new stor${fresh.length === 1 ? 'y' : 'ies'}`); }
        } catch { /* keep the last render */ }
    });
    _aEvery(1000, () => _aTickClocks(root));
}

async function _aaOptOutDialog() {
    try {
        const cur = await api('/arena/opt-out');
        const out = !cur.opted_out;
        const ok = confirm(out ? 'Keep yourself out of the Arena? No new stories will be written about you and your old ones come down. You can come back any time.' : 'Come back into the Arena? New stories about your streams will be written again.');
        if (!ok) return;
        await api('/arena/opt-out', { method: 'PUT', body: { out } });
        _aToast(out ? 'You are out of the Arena.' : 'Welcome back to the Arena.', 'success');
        loadArenaPage(['arena']);
    } catch (err) { _aToast(err?.message || 'Could not change that', 'error'); }
}

async function _aRenderStory(root, id) {
    root.innerHTML = _aSpinner('Pulling the receipts…');
    const s = await api(`/arena/drama/${encodeURIComponent(id)}`);
    const more = s.user ? await api(`/arena/drama?limit=6&user=${encodeURIComponent(s.user.username)}`).catch(() => ({ stories: [] })) : { stories: [] };
    const facts = Object.entries(s.facts || {}).filter(([k, v]) => v != null && typeof v !== 'object' && k !== 'other');
    root.innerHTML = `<div class="aa">
        <div class="arena-back">${_aA('/arena', '<i class="fa-solid fa-arrow-left"></i> ARENA ALERT')}</div>
        ${_aaStory(s, { big: true })}
        ${facts.length ? `<section class="aa-box aa-facts"><h2 class="aa-h">The receipts</h2><dl>${facts.map(([k, v]) => `<div><dt>${_aEsc(k.replace(/_/g, ' '))}</dt><dd>${_aEsc(String(v))}</dd></div>`).join('')}</dl></section>` : ''}
        ${(more.stories || []).filter((x) => x.id !== s.id).length ? `<section class="aa-feed"><h2 class="aa-h">More on ${_aEsc(s.user.display_name || s.user.username)}</h2>${more.stories.filter((x) => x.id !== s.id).map((x) => _aaStory(x)).join('')}</section>` : ''}
    </div>`;
    _aaBindReactions(root);
}

/** The rap sheet: shown above the fighter page at /arena/<username>. */
async function _aRenderRapSheet(el, username) {
    if (!el) return;
    let r;
    try { r = await api(`/arena/rap/${encodeURIComponent(username)}`); } catch { el.innerHTML = ''; return; }
    if (r.opted_out) { el.innerHTML = `<div class="aa-box aa-quiet">${_aEsc(r.user.display_name || r.user.username)} keeps themselves out of the Arena.</div>`; return; }
    const counts = Object.entries(r.counts || {}).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `<section class="aa-rap aa-box">
        <h2 class="aa-h">📁 Rap sheet</h2>
        <div class="aa-rap-stats">
            <div><b>${r.cow ? r.cow.meter : 0}</b><span>cow meter</span></div>
            <div><b>${r.clout ? `#${r.clout.rank}` : '–'}</b><span>clout rank</span></div>
            <div><b>${r.record.w}–${r.record.l}</b><span>beefs W–L</span></div>
            <div><b>${r.stories.length}</b><span>stories</span></div>
        </div>
        ${counts.length ? `<p class="aa-row-sub">${counts.map(([k, n]) => `${_aEsc((AA_KIND[k] || [k])[0].toLowerCase())} ×${n}`).join(' · ')}</p>` : '<p class="aa-quiet">Clean record. For now.</p>'}
        ${r.stories.slice(0, 5).map((s) => _aaStory(s)).join('')}
    </section>`;
    _aaBindReactions(el);
}
