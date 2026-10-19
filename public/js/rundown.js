/**
 * OpenVibe.Live — The Rundown: what streamers talked about, written up (server/rundown/, docs/rundown.md).
 *
 * Routes (loadRundownPage(segments) from app.js):
 *   /rundown                 the front page: on air now, the latest episodes and takes, trending topics, who's been talking
 *   /rundown/topics          every topic
 *   /rundown/t/<slug>        one topic and every take on it
 *   /rundown/e/<streamId>    one stream written up as an episode
 *   /rundown/<username>      a streamer's episodes, topics, lines and crossovers
 *
 * Everything shown comes from the desk, which reads streams' speech-to-text: a take is what a streamer said about a
 * topic, a quote is their own words (checked against the transcript), the desk's quip is the desk's. All text goes
 * through _rdEsc; every link through handleLinkClick.
 */
'use strict';

const RD_KIND = {
    news: ['News', '#f59e0b'], games: ['Games', '#a78bfa'], tech: ['Tech', '#22d3ee'], life: ['Life', '#34d399'], music: ['Music', '#f472b6'],
    sports: ['Sports', '#fb923c'], money: ['Money', '#a3e635'], internet: ['Internet', '#60a5fa'], chat: ['Chat', '#94a3b8'], other: ['Other', '#94a3b8'],
};
const RD_REACT = [['fire', '🔥', 'Fire'], ['lol', '😂', 'Funny'], ['dead', '💀', 'I\'m dead'], ['cap', '🧢', 'Cap'], ['facts', '💯', 'Facts']];
let _rdAudio = null;
let _rdNext = null;

// ── Helpers ──────────────────────────────────────────────────
function _rdEsc(s) { return typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _rdA(href, inner, cls = '', label = '') { return `<a class="${cls}" href="${_rdEsc(href)}"${label ? ` aria-label="${_rdEsc(label)}"` : ''} onclick="return handleLinkClick(event, '${_rdEsc(href)}')">${inner}</a>`; }
function _rdTime(d) { return new Date(String(d || '').includes('T') ? d : String(d || '').replace(' ', 'T') + 'Z'); }
function _rdAgo(d) {
    if (!d) return '';
    const m = Math.round((Date.now() - _rdTime(d).getTime()) / 60000);
    if (!Number.isFinite(m)) return '';
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}
function _rdDay(d) { try { return _rdTime(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return ''; } }
function _rdStamp(sec) { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`; }
function _rdLength(min) { min = Number(min) || 0; return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`; }
function _rdName(u) { return u ? (u.display_name || u.username) : ''; }
function _rdUserHref(u) { return `/rundown/${encodeURIComponent(u.username)}`; }
function _rdChannelHref(u) { return typeof channelPath === 'function' ? channelPath(u.username) : `/@${encodeURIComponent(u.username)}`; }
function _rdAv(u, size = 36) {
    if (!u) return '';
    const inner = u.avatar_url ? `<img src="${_rdEsc(u.avatar_url)}" alt="" loading="lazy" width="${size}" height="${size}">` : `<span>${_rdEsc(_rdName(u).trim().charAt(0).toUpperCase() || '?')}</span>`;
    return _rdA(_rdUserHref(u), inner, 'rd-av', _rdName(u)).replace('class="rd-av"', `class="rd-av" style="--rd-av:${size}px;--rd-c:${_rdEsc(u.profile_color || '#64748b')}"`);
}
function _rdUser(u) { return u ? _rdA(_rdUserHref(u), _rdEsc(_rdName(u)), 'rd-user') : ''; }
function _rdTopicChip(t, extra = '') {
    if (!t) return '';
    const [label, color] = RD_KIND[t.kind] || RD_KIND.other;
    return _rdA(`/rundown/t/${encodeURIComponent(t.slug)}`, `${_rdEsc(t.title)}${extra}`, 'rd-chip', `${label}: ${t.title}`).replace('class="rd-chip"', `class="rd-chip" style="--rd-k:${color}"`);
}
function _rdWatch(vodId, sec, label = 'Watch') { return vodId ? _rdA(`/vod/${vodId}?t=${Math.max(0, Math.floor(sec || 0))}`, `<i class="fa-solid fa-play" aria-hidden="true"></i> ${_rdEsc(label)}${sec ? ` <span class="rd-stamp">${_rdStamp(sec)}</span>` : ''}`, 'rd-watch') : ''; }
function _rdParas(text) { return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${_rdEsc(p)}</p>`).join(''); }
function _rdMe() { return (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null; }
function _rdEmpty(icon, text, action = '') { return `<div class="rd-empty"><i class="fa-solid ${icon}" aria-hidden="true"></i><p>${text}</p>${action}</div>`; }

function _rdSpeakBtn(text, user) { return user ? `<button type="button" class="rd-speak" data-rd-speak="${_rdEsc(text)}" data-rd-voice="${_rdEsc(user.username)}" aria-label="Hear it in ${_rdEsc(_rdName(user))}'s chat voice"><i class="fa-solid fa-volume-high" aria-hidden="true"></i></button>` : ''; }
function _rdSpeak(btn) {
    if (_rdAudio) { _rdAudio.pause(); _rdAudio = null; document.querySelectorAll('.rd-speak.is-speaking').forEach((b) => b.classList.remove('is-speaking')); }
    if (btn.classList.contains('was-speaking')) { btn.classList.remove('was-speaking'); return; }
    const a = new Audio(`/api/rundown/voice/${encodeURIComponent(btn.dataset.rdVoice)}?t=${encodeURIComponent(btn.dataset.rdSpeak)}`);
    _rdAudio = a;
    btn.classList.add('is-speaking');
    const done = () => { btn.classList.remove('is-speaking'); if (_rdAudio === a) _rdAudio = null; };
    a.onended = done; a.onerror = done;
    a.play().catch(done);
}

function _rdReactions(type, id, reactions = {}, mine = null) {
    return `<div class="rd-react" role="group" aria-label="React">${RD_REACT.map(([k, icon, label]) => {
        const n = Number(reactions[k] || 0);
        return `<button type="button" class="rd-react-btn${mine === k ? ' is-mine' : ''}" data-rd-react="${type}:${id}:${k}" aria-pressed="${mine === k}" aria-label="${_rdEsc(label)}${n ? `, ${n}` : ''}"><span aria-hidden="true">${icon}</span>${n ? `<b>${n}</b>` : ''}</button>`;
    }).join('')}</div>`;
}

// ── Cards ────────────────────────────────────────────────────
function _rdQuote(q, user, vodId) {
    return `<blockquote class="rd-quote"><p>“${_rdEsc(q.text)}”</p>${q.en ? `<p class="rd-quote-en">${_rdEsc(q.en)}</p>` : ''}
        <footer>— ${_rdUser(user)} ${_rdSpeakBtn(q.text, user)} ${_rdWatch(vodId, q.sec, 'Hear it')}</footer></blockquote>`;
}
function _rdTake(s, { topic = true, user = true } = {}) {
    const mentions = (s.mentions || []).map(_rdUser).join(', ');
    return `<article class="rd-card rd-take" id="rd-take-${s.id}">
        <div class="rd-card-top">${topic ? _rdTopicChip(s.topic) : ''}<time datetime="${_rdEsc(s.said_at)}">${_rdEsc(_rdAgo(s.said_at))}</time></div>
        <div class="rd-take-body">
            ${user ? `<div class="rd-take-who">${_rdAv(s.user, 40)}</div>` : ''}
            <div class="rd-take-text">
                <h3 class="rd-h3">${_rdEsc(s.title)}</h3>
                ${user ? `<p class="rd-by">${_rdUser(s.user)}</p>` : ''}
                <p class="rd-what">${_rdEsc(s.what)}</p>
                ${s.take ? `<p class="rd-their"><span>Their take</span> ${_rdEsc(s.take)}</p>` : ''}
                ${(s.quotes || []).map((q) => _rdQuote(q, s.user, s.vod_id)).join('')}
                ${s.quip ? `<p class="rd-quip"><span class="rd-desk">The desk</span> ${_rdEsc(s.quip)}</p>` : ''}
                ${mentions ? `<p class="rd-cross"><i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i> Brought up ${mentions}</p>` : ''}
            </div>
        </div>
        <div class="rd-card-foot">${_rdReactions('segment', s.id, s.reactions, s.my_reaction)}${_rdWatch(s.vod_id, s.sec)}</div>
    </article>`;
}
function _rdEpisodeCard(e, { user = true } = {}) {
    const href = `/rundown/e/${e.stream_id}`;
    const chapters = (e.chapters || []).slice(0, 4);
    return `<article class="rd-card rd-episode">
        <div class="rd-card-top"><span class="rd-kicker">Episode</span><time datetime="${_rdEsc(e.aired_at)}">${_rdEsc(_rdDay(e.aired_at))}${e.minutes ? ` · ${_rdLength(e.minutes)}` : ''}</time></div>
        <div class="rd-take-body">
            ${user ? `<div class="rd-take-who">${_rdAv(e.user, 48)}</div>` : ''}
            <div class="rd-take-text">
                <h3 class="rd-h3 rd-ep-title">${_rdA(href, _rdEsc(e.title))}</h3>
                ${user ? `<p class="rd-by">${_rdUser(e.user)}</p>` : ''}
                ${e.logline ? `<p class="rd-logline">${_rdEsc(e.logline)}</p>` : ''}
                ${chapters.length ? `<ol class="rd-chapters">${chapters.map((c) => `<li>${e.vod_id ? _rdA(`/vod/${e.vod_id}?t=${c.sec}`, `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`) : `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`} ${_rdEsc(c.title)}</li>`).join('')}</ol>` : ''}
                ${(e.topics || []).length ? `<div class="rd-chips">${e.topics.slice(0, 5).map((t) => _rdTopicChip(t)).join('')}</div>` : ''}
            </div>
        </div>
        <div class="rd-card-foot">${_rdReactions('episode', e.stream_id, e.reactions, e.my_reaction)}${_rdA(href, 'Read the episode <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>', 'rd-read')}</div>
    </article>`;
}
function _rdItem(x) { return x.type === 'episode' ? _rdEpisodeCard(x) : _rdTake(x); }

// ── The front page ───────────────────────────────────────────
function _rdMast(counts, active = 'latest') {
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const tally = counts ? [[counts.topics, 'topic'], [counts.takes, 'take'], [counts.episodes, 'episode']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(' · ') : '';
    const tab = (id, href, label) => _rdA(href, label, `rd-tab${active === id ? ' is-on' : ''}`).replace('<a ', `<a${active === id ? ' aria-current="page"' : ''} `);
    return `<header class="rd-mast">
        <div class="rd-mast-line"><span>${_rdEsc(today)}</span>${tally ? `<span>${_rdEsc(tally)}</span>` : ''}</div>
        <h1 class="rd-title">The Rundown</h1>
        <p class="rd-tagline">What streamers talked about, written up: the topics, their takes in their own words, and every stream as an episode.</p>
        <nav class="rd-tabs" aria-label="The Rundown">${tab('latest', '/rundown', 'Latest')}${tab('topics', '/rundown/topics', 'Topics')}</nav>
    </header>`;
}
function _rdOnAir(list) {
    if (!list.length) return '';
    return `<section class="rd-onair" aria-labelledby="rd-onair-h"><h2 id="rd-onair-h" class="rd-h2"><span class="rd-dot" aria-hidden="true"></span> On air now</h2>
        <ul class="rd-onair-list">${list.map((x) => `<li>${_rdA(_rdChannelHref(x.user), `${x.user.avatar_url ? `<img src="${_rdEsc(x.user.avatar_url)}" alt="" width="32" height="32" loading="lazy">` : `<span class="rd-onair-i">${_rdEsc(_rdName(x.user).charAt(0).toUpperCase())}</span>`}<span class="rd-onair-t"><b>${_rdEsc(_rdName(x.user))}</b><small>${x.talking_about ? `talking about ${_rdEsc(x.talking_about)}` : _rdEsc(x.stream_title || 'live now')}</small></span>`, 'rd-onair-item')}</li>`).join('')}</ul></section>`;
}
function _rdTrending(list) {
    return `<section class="rd-box" aria-labelledby="rd-trend-h"><h2 id="rd-trend-h" class="rd-h2">Trending topics <small>this week</small></h2>
        ${list.length ? `<ol class="rd-trend">${list.map((t, i) => `<li><span class="rd-trend-n" aria-hidden="true">${i + 1}</span><div>${_rdTopicChip(t)}
            <p class="rd-trend-meta"><span class="rd-stack" aria-hidden="true">${(t.people || []).map((p) => `<i style="--rd-c:${_rdEsc(p.profile_color || '#64748b')}">${p.avatar_url ? `<img src="${_rdEsc(p.avatar_url)}" alt="" width="20" height="20" loading="lazy">` : _rdEsc(_rdName(p).charAt(0).toUpperCase())}</i>`).join('')}</span>
            ${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'}</p></div></li>`).join('')}</ol>` : '<p class="rd-quiet">No topics yet this week.</p>'}
        ${_rdA('/rundown/topics', 'Every topic <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>', 'rd-more-link')}
    </section>`;
}
function _rdVoices(list) {
    if (!list.length) return '';
    return `<section class="rd-box" aria-labelledby="rd-voices-h"><h2 id="rd-voices-h" class="rd-h2">Who's been talking</h2>
        <ul class="rd-voices">${list.map((v) => `<li>${_rdAv(v.user, 36)}<div><p class="rd-voice-name">${_rdUser(v.user)} <small>${_rdEsc(_rdAgo(v.last_seen))}</small></p>
            ${(v.top_topics || []).length ? `<div class="rd-chips rd-chips-sm">${v.top_topics.map((t) => _rdTopicChip(t)).join('')}</div>` : ''}</div></li>`).join('')}</ul></section>`;
}
function _rdAbout() {
    const me = _rdMe();
    return `<section class="rd-box rd-about" aria-labelledby="rd-about-h"><h2 id="rd-about-h" class="rd-h2">How the desk works</h2>
        <p>The desk reads what streamers say on stream (speech to text) and writes up what they talked about: the topic, their take, a line or two in their own words, and a quip of its own. Game sounds, videos and songs are never quoted as theirs. When a stream ends, it becomes an episode.</p>
        ${me ? `<p>${_rdA(`/rundown/${encodeURIComponent(me.username)}`, 'Your page')} · <button type="button" class="rd-link" data-rd-optout="1">Keep me out of The Rundown</button></p>` : ''}
    </section>`;
}
async function _rdHome(root) {
    const d = await api('/rundown');
    _rdNext = d.next;
    const feed = d.latest || [];
    root.innerHTML = `${_rdMast(d.counts, 'latest')}${_rdOnAir(d.on_air || [])}
        <div class="rd-grid">
            <section class="rd-main" aria-labelledby="rd-latest-h"><h2 id="rd-latest-h" class="rd-h2">The latest</h2>
                <div id="rd-feed">${feed.length ? feed.map(_rdItem).join('') : _rdEmpty('fa-newspaper', 'The desk is reading this week\'s streams. The first takes and episodes show up here within minutes.')}</div>
                ${_rdNext ? '<button type="button" class="btn btn-secondary rd-loadmore" data-rd-more="1">More</button>' : ''}
            </section>
            <aside class="rd-side">${_rdTrending(d.trending || [])}${_rdVoices(d.voices || [])}${_rdAbout()}</aside>
        </div>`;
    document.title = 'The Rundown · OpenVibe.Live';
}
async function _rdMore(btn) {
    if (!_rdNext) return;
    btn.disabled = true;
    try {
        const d = await api(`/rundown/latest?before=${encodeURIComponent(_rdNext)}`);
        _rdNext = d.next;
        document.getElementById('rd-feed')?.insertAdjacentHTML('beforeend', (d.items || []).map(_rdItem).join(''));
        if (!_rdNext) btn.remove(); else btn.disabled = false;
    } catch { btn.disabled = false; }
}

// ── Topics ───────────────────────────────────────────────────
async function _rdTopics(root, query) {
    const sort = query.get('sort') === 'most' ? 'most' : 'recent';
    const kind = RD_KIND[query.get('kind')] ? query.get('kind') : '';
    const d = await api(`/rundown/topics?sort=${sort}${kind ? `&kind=${kind}` : ''}`);
    const href = (o) => { const p = new URLSearchParams({ ...(sort === 'most' ? { sort } : {}), ...(kind ? { kind } : {}), ...o }); for (const [k, v] of [...p]) if (!v) p.delete(k); const s = p.toString(); return `/rundown/topics${s ? `?${s}` : ''}`; };
    root.innerHTML = `${_rdMast(null, 'topics')}
        <div class="rd-filters">
            <div class="rd-seg" role="group" aria-label="Sort">${_rdA(href({ sort: '' }), 'Most recent', `rd-seg-btn${sort === 'recent' ? ' is-on' : ''}`)}${_rdA(href({ sort: 'most' }), 'Most talked about', `rd-seg-btn${sort === 'most' ? ' is-on' : ''}`)}</div>
            <div class="rd-chips" role="group" aria-label="Kind">${_rdA(href({ kind: '' }), 'All', `rd-chip${kind ? '' : ' is-on'}`)}${Object.entries(RD_KIND).map(([k, [label, color]]) => _rdA(href({ kind: k }), label, `rd-chip${kind === k ? ' is-on' : ''}`).replace('class="rd-chip', `style="--rd-k:${color}" class="rd-chip`)).join('')}</div>
        </div>
        ${d.topics.length ? `<div class="rd-topic-grid">${d.topics.map((t) => `<article class="rd-card rd-topic-card">
            ${_rdTopicChip(t)}
            ${t.headline ? `<h3 class="rd-h3">${_rdA(`/rundown/t/${encodeURIComponent(t.slug)}`, _rdEsc(t.headline))}</h3>` : ''}
            ${t.summary ? `<p class="rd-what">${_rdEsc(t.summary)}</p>` : ''}
            <p class="rd-trend-meta"><span class="rd-stack" aria-hidden="true">${(t.people || []).map((p) => `<i style="--rd-c:${_rdEsc(p.profile_color || '#64748b')}">${p.avatar_url ? `<img src="${_rdEsc(p.avatar_url)}" alt="" width="20" height="20" loading="lazy">` : _rdEsc(_rdName(p).charAt(0).toUpperCase())}</i>`).join('')}</span>
            ${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'} · ${_rdEsc(_rdAgo(t.last_seen_at))}</p>
        </article>`).join('')}</div>` : _rdEmpty('fa-comments', kind ? 'No topics of that kind yet.' : 'No topics yet: the desk is reading this week\'s streams.')}`;
    document.title = 'Topics · The Rundown · OpenVibe.Live';
}
async function _rdTopic(root, slug) {
    const d = await api(`/rundown/t/${encodeURIComponent(slug)}`);
    const t = d.topic;
    const [label, color] = RD_KIND[t.kind] || RD_KIND.other;
    root.innerHTML = `<article class="rd-page" style="--rd-k:${color}">
        <p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')} / ${_rdA('/rundown/topics', 'Topics')}</p>
        <header class="rd-page-head"><span class="rd-kicker rd-kicker-k">${_rdEsc(label)}</span><h1 class="rd-h1">${_rdEsc(t.title)}</h1>
            ${t.headline ? `<p class="rd-deck">${_rdEsc(t.headline)}</p>` : ''}
            <p class="rd-meta">${t.streamers} streamer${t.streamers === 1 ? '' : 's'} · ${t.takes} take${t.takes === 1 ? '' : 's'} · first came up ${_rdEsc(_rdDay(t.first_seen_at))}${t.last_seen_at !== t.first_seen_at ? `, last ${_rdEsc(_rdAgo(t.last_seen_at))}` : ''}</p></header>
        ${t.summary ? `<div class="rd-summary"><span class="rd-desk">The desk</span>${_rdParas(t.summary)}</div>` : ''}
        <h2 class="rd-h2">Every take</h2>
        ${(d.takes || []).map((s) => _rdTake(s, { topic: false })).join('') || _rdEmpty('fa-comment', 'No takes on this topic right now.')}
        ${(d.related || []).length ? `<h2 class="rd-h2">Came up alongside</h2><div class="rd-chips">${d.related.map((r) => _rdTopicChip(r)).join('')}</div>` : ''}
    </article>`;
    document.title = `${t.title} · The Rundown · OpenVibe.Live`;
}

// ── An episode ───────────────────────────────────────────────
async function _rdEpisode(root, id) {
    const d = await api(`/rundown/e/${encodeURIComponent(id)}`);
    const e = d.episode, s = d.stream, u = s.user;
    const title = e ? e.title : (s.is_live ? `${_rdName(u)} is live` : `${_rdName(u)}'s stream`);
    root.innerHTML = `<article class="rd-page">
        <p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')} / ${u ? _rdA(_rdUserHref(u), _rdEsc(_rdName(u))) : ''}</p>
        <header class="rd-page-head rd-ep-head">
            <div class="rd-ep-who">${_rdAv(u, 56)}<div><span class="rd-kicker">${s.is_live ? '<span class="rd-dot" aria-hidden="true"></span> On air now' : 'Episode'}</span><p class="rd-by">${_rdUser(u)} · ${_rdEsc(_rdDay(s.started_at))}${e && e.minutes ? ` · ${_rdLength(e.minutes)}` : ''}</p></div></div>
            <h1 class="rd-h1">${_rdEsc(title)}</h1>
            ${e && e.logline ? `<p class="rd-deck">${_rdEsc(e.logline)}</p>` : ''}
            <p class="rd-actions">${e ? _rdWatch(e.vod_id, 0, 'Watch the stream') : ''}${s.is_live && u ? _rdA(_rdChannelHref(u), '<i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Watch live', 'rd-watch') : ''}</p>
        </header>
        ${e && e.recap ? `<div class="rd-recap">${_rdParas(e.recap)}</div>` : (s.is_live ? '<p class="rd-quiet">The episode is written when the stream ends. Here is what the desk has heard so far.</p>' : '')}
        ${e && e.chapters.length ? `<section aria-labelledby="rd-ch-h"><h2 id="rd-ch-h" class="rd-h2">Chapters</h2><ol class="rd-chapters rd-chapters-big">${e.chapters.map((c) => `<li>${e.vod_id ? _rdA(`/vod/${e.vod_id}?t=${c.sec}`, `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`) : `<span class="rd-stamp">${_rdStamp(c.sec)}</span>`} ${c.segment_id ? `<a href="#rd-take-${c.segment_id}">${_rdEsc(c.title)}</a>` : _rdEsc(c.title)}</li>`).join('')}</ol></section>` : ''}
        ${e ? `<div class="rd-card-foot rd-ep-react">${_rdReactions('episode', e.stream_id, e.reactions, e.my_reaction)}</div>` : ''}
        <h2 class="rd-h2">What they talked about</h2>
        ${(d.segments || []).map((x) => _rdTake(x, { user: false })).join('') || _rdEmpty('fa-microphone-lines', 'Nothing written up from this stream.')}
        ${(d.more || []).length ? `<h2 class="rd-h2">More from ${_rdEsc(_rdName(u))}</h2>${d.more.map((x) => _rdEpisodeCard(x, { user: false })).join('')}` : ''}
    </article>`;
    document.title = `${title} · The Rundown · OpenVibe.Live`;
}

// ── A streamer ───────────────────────────────────────────────
async function _rdStreamer(root, username) {
    const d = await api(`/rundown/s/${encodeURIComponent(username)}`);
    const u = d.user;
    const mine = _rdMe() && _rdMe().username && _rdMe().username.toLowerCase() === u.username.toLowerCase();
    const head = `<p class="rd-crumbs">${_rdA('/rundown', 'The Rundown')}</p>
        <header class="rd-page-head rd-streamer-head">${_rdAv(u, 72)}<div><h1 class="rd-h1">${_rdEsc(_rdName(u))}</h1>
            <p class="rd-meta">${d.opted_out ? 'Kept out of The Rundown' : `${d.episodes.length} episode${d.episodes.length === 1 ? '' : 's'} · ${d.topics.length} topic${d.topics.length === 1 ? '' : 's'}`} · ${_rdA(_rdChannelHref(u), 'Channel')}</p>
            ${mine ? `<p><button type="button" class="rd-link" data-rd-optout="${d.opted_out ? '0' : '1'}">${d.opted_out ? 'Come back to The Rundown' : 'Keep me out of The Rundown'}</button></p>` : ''}</div></header>`;
    if (d.opted_out) { root.innerHTML = `<article class="rd-page">${head}${_rdEmpty('fa-eye-slash', `${_rdEsc(_rdName(u))} keeps themselves out of The Rundown.`)}</article>`; return; }
    root.innerHTML = `<article class="rd-page">${head}
        ${d.topics.length ? `<section aria-labelledby="rd-st-t"><h2 id="rd-st-t" class="rd-h2">What they talk about</h2><div class="rd-chips">${d.topics.map((t) => _rdTopicChip(t, t.takes > 1 ? ` <b>${t.takes}</b>` : '')).join('')}</div></section>` : ''}
        ${d.lines.length ? `<section aria-labelledby="rd-st-l"><h2 id="rd-st-l" class="rd-h2">Best lines</h2><div class="rd-lines">${d.lines.flatMap((s) => (s.quotes || []).slice(0, 1).map((q) => `<figure class="rd-line"><blockquote>“${_rdEsc(q.text)}”</blockquote>${q.en ? `<p class="rd-quote-en">${_rdEsc(q.en)}</p>` : ''}<figcaption>${_rdTopicChip(s.topic)} ${_rdSpeakBtn(q.text, u)} ${_rdWatch(s.vod_id, q.sec, 'Hear it')}</figcaption></figure>`)).join('')}</div></section>` : ''}
        <section aria-labelledby="rd-st-e"><h2 id="rd-st-e" class="rd-h2">Episodes</h2>${d.episodes.map((e) => _rdEpisodeCard(e, { user: false })).join('') || _rdEmpty('fa-film', 'No episodes yet. Every stream with talk in it becomes one.')}</section>
        ${d.crossovers.length ? `<section aria-labelledby="rd-st-c"><h2 id="rd-st-c" class="rd-h2">Crossovers</h2>${d.crossovers.map((s) => _rdTake(s)).join('')}</section>` : ''}
    </article>`;
    document.title = `${_rdName(u)} · The Rundown · OpenVibe.Live`;
}

// ── Router and events ────────────────────────────────────────
async function loadRundownPage(segments = []) {
    const root = document.getElementById('rundown-root');
    if (!root) return;
    const [, first, second] = segments;
    try {
        if (first === 'topics') return await _rdTopics(root, new URLSearchParams(location.search));
        if (first === 't' && second) return await _rdTopic(root, decodeURIComponent(second));
        if (first === 'e' && second) return await _rdEpisode(root, second);
        if (first) return await _rdStreamer(root, decodeURIComponent(first));
        return await _rdHome(root);
    } catch (err) {
        const missing = err && err.status === 404;
        root.innerHTML = _rdEmpty(missing ? 'fa-magnifying-glass' : 'fa-plug-circle-xmark', _rdEsc(missing ? 'Nothing here. It may have been taken down, or it never existed.' : (err && err.message) || 'The Rundown could not load.'), _rdA('/rundown', 'Back to The Rundown', 'btn btn-primary'));
    }
}

document.addEventListener('click', async (e) => {
    const root = document.getElementById('rundown-root');
    if (!root || !root.contains(e.target)) return;
    const speak = e.target.closest('[data-rd-speak]');
    if (speak) { e.preventDefault(); if (speak.classList.contains('is-speaking')) speak.classList.add('was-speaking'); _rdSpeak(speak); return; }
    const more = e.target.closest('[data-rd-more]');
    if (more) { e.preventDefault(); _rdMore(more); return; }
    const react = e.target.closest('[data-rd-react]');
    if (react) {
        e.preventDefault();
        const [type, id, reaction] = react.dataset.rdReact.split(':');
        try {
            const r = await api('/rundown/react', { method: 'POST', body: { type, id: Number(id), reaction } });
            const group = react.closest('.rd-react');
            if (group) group.outerHTML = _rdReactions(type, id, r.reactions, r.mine);
        } catch (err) { if (typeof toast === 'function') toast(err.message || 'Could not react', 'error'); }
        return;
    }
    const opt = e.target.closest('[data-rd-optout]');
    if (opt) {
        e.preventDefault();
        const out = opt.dataset.rdOptout === '1';
        if (out && !confirm('Keep yourself out of The Rundown? Everything written about your streams is hidden and the desk stops reading them. You can come back any time.')) return;
        try { await api('/rundown/opt-out', { method: 'PUT', body: { out } }); if (typeof toast === 'function') toast(out ? 'You are out of The Rundown.' : 'Welcome back to The Rundown.', 'success'); loadRundownPage(location.pathname.split('/').filter(Boolean)); }
        catch (err) { if (typeof toast === 'function') toast(err.message || 'That did not work', 'error'); }
    }
});
